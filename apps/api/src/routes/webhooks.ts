import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { getGithubWebhookSecret } from '../config/github.js';
import { prisma } from '../lib/prisma.js';
import {
  findWebhookDelivery,
  recordWebhookDelivery,
  findPipelineRunByGithubRunId,
  findCandidateDispatchedRuns,
  updatePipelineRun,
  createPipelineRun,
} from '../db/pipelines.js';
import { getGithubService } from '../services/github.service.js';
import {
  extractFileFromZip,
  parseAndNormalizeGitleaksReport,
} from '../services/gitleaks.service.js';
import { recordSecurityScan } from '../db/scans.js';

export const webhooksRouter = Router();

/**
 * Validates the HMAC-SHA256 signature from GitHub using the raw request buffer.
 * Performs a constant-time comparison to prevent timing attacks.
 */
function verifyWebhookSignature(req: Request & { rawBody?: Buffer }, secret: string): boolean {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || typeof signature !== 'string') {
    return false;
  }

  const rawBody = req.rawBody;
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expectedSignature = `sha256=${hmac.digest('hex')}`;

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

// POST /api/webhooks/github - Ingests GitHub webhooks for workflow runs
webhooksRouter.post('/github', async (req: Request & { rawBody?: Buffer }, res: Response) => {
  try {
    const webhookSecret = getGithubWebhookSecret();

    // Fail closed: Webhook processing must be rejected if secret is not configured
    if (!webhookSecret) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'GitHub webhook secret is not configured on this server.',
      });
      return;
    }

    // Verify HMAC-SHA256 signature
    const isValidSignature = verifyWebhookSignature(req, webhookSecret);
    if (!isValidSignature) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing GitHub webhook signature.',
      });
      return;
    }

    const event = req.headers['x-github-event'];
    const deliveryId = req.headers['x-github-delivery'];

    if (!event || typeof event !== 'string' || !deliveryId || typeof deliveryId !== 'string') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing X-GitHub-Event or X-GitHub-Delivery header.',
      });
      return;
    }

    // Concurrency-safe atomic idempotency claim:
    // 1. Fast-path check: return immediately if delivery is already known
    const existing = await findWebhookDelivery(deliveryId);
    if (existing) {
      res.status(200).json({
        status: 'ignored',
        message: 'Delivery already processed.',
        deliveryId,
      });
      return;
    }

    // 2. Concurrency claim: atomic insert ensures simultaneous duplicate deliveries
    // will fail on unique primary key constraint without race conditions.
    const delivery = await recordWebhookDelivery(deliveryId, event, req.body?.action);
    if (!delivery) {
      res.status(200).json({
        status: 'ignored',
        message: 'Delivery already processed.',
        deliveryId,
      });
      return;
    }

    // Handle initial webhook ping
    if (event === 'ping') {
      res.status(200).json({ message: 'pong', zen: req.body?.zen });
      return;
    }

    // Process workflow_run events
    if (event === 'workflow_run') {
      const payload = req.body;
      const workflowRun = payload.workflow_run;
      const repository = payload.repository;
      const installation = payload.installation;

      if (!workflowRun || !repository) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Malformed workflow_run webhook payload.',
        });
        return;
      }

      // Verify repository matches an active SecureDeploy project association
      const projectRepo = await prisma.projectRepository.findFirst({
        where: {
          repoId: BigInt(repository.id),
        },
        include: {
          project: true,
          installation: true,
        },
      });

      if (!projectRepo) {
        // Repository not tracked in SecureDeploy; acknowledge safely without modifying database
        res.status(200).json({
          status: 'ignored',
          message: 'Repository is not associated with any SecureDeploy project.',
        });
        return;
      }

      // Verify installation ID matches the association if present
      if (installation?.id && projectRepo.installation.installationId !== BigInt(installation.id)) {
        res.status(200).json({
          status: 'ignored',
          message: 'Installation ID mismatch for repository association.',
        });
        return;
      }

      const runIdBigInt = BigInt(workflowRun.id);
      let pipeline = await findPipelineRunByGithubRunId(runIdBigInt);

      if (!pipeline) {
        // Query candidate unconfirmed dispatched runs with strict authoritative criteria
        const candidates = await findCandidateDispatchedRuns({
          projectRepositoryId: projectRepo.id,
          workflowFile: workflowRun.path || '',
          gitRef: workflowRun.head_branch || '',
          commitSha: workflowRun.head_sha || null,
          runCreatedAt: workflowRun.created_at ? new Date(workflowRun.created_at) : null,
        });

        if (candidates.length === 1) {
          // Unambiguous 1-to-1 match: exactly one pending dispatch matches all authoritative metadata
          pipeline = candidates[0];
        } else if (candidates.length > 1) {
          // Ambiguous match: multiple concurrent dispatches exist for the identical ref and commit.
          // Per requirements: Do NOT guess or update an arbitrary pipeline record.
          // Leave the pending dispatches unconfirmed and record the observed GitHub run as a distinct run.
          pipeline = null;
        }
      }

      // Map GitHub status to internal lifecycle state
      let mappedStatus = 'QUEUED';
      if (workflowRun.status === 'in_progress') {
        mappedStatus = 'IN_PROGRESS';
      } else if (workflowRun.status === 'completed') {
        mappedStatus = 'COMPLETED';
      } else if (workflowRun.status === 'queued') {
        mappedStatus = 'QUEUED';
      }

      const startedAt = workflowRun.run_started_at
        ? new Date(workflowRun.run_started_at)
        : undefined;
      const completedAt =
        workflowRun.status === 'completed' && workflowRun.updated_at
          ? new Date(workflowRun.updated_at)
          : undefined;

      let targetPipelineId = pipeline?.id;
      if (pipeline) {
        await updatePipelineRun(pipeline.id, {
          status: mappedStatus,
          conclusion: workflowRun.conclusion || null,
          githubRunId: runIdBigInt,
          githubRunNumber: workflowRun.run_number || null,
          githubRunAttempt: workflowRun.run_attempt || 1,
          htmlUrl: workflowRun.html_url || null,
          commitSha: workflowRun.head_sha || null,
          startedAt,
          completedAt,
        });
      } else {
        // Either external run (e.g. push / manual GitHub UI) OR ambiguous concurrent dispatch:
        // Persist the observed GitHub run directly with its real githubRunId, without guessing or corrupting pending dispatches
        const createdRun = await createPipelineRun({
          projectId: projectRepo.projectId,
          projectRepositoryId: projectRepo.id,
          triggeredById: projectRepo.project.ownerId,
          workflowFile: workflowRun.path || 'unknown.yml',
          gitRef: workflowRun.head_branch || 'main',
          commitSha: workflowRun.head_sha || null,
          status: mappedStatus,
          conclusion: workflowRun.conclusion || null,
          githubRunId: runIdBigInt,
          githubRunNumber: workflowRun.run_number || null,
          githubRunAttempt: workflowRun.run_attempt || 1,
          htmlUrl: workflowRun.html_url || null,
          startedAt,
          completedAt,
        });
        targetPipelineId = createdRun.id;
      }

      // If workflow has completed, inspect GitHub Actions artifacts for Gitleaks security reports
      if (workflowRun.status === 'completed' && targetPipelineId && projectRepo.installation) {
        try {
          const githubService = getGithubService();
          const instIdNum = Number(projectRepo.installation.installationId);
          const artifactRes = await githubService.listWorkflowRunArtifacts(
            instIdNum,
            projectRepo.repoOwner,
            projectRepo.repoName,
            workflowRun.id
          );

          const gitleaksArtifact = artifactRes.artifacts.find(
            (a) => a.name === 'gitleaks-report' || a.name === 'gitleaks-report.json'
          );

          if (gitleaksArtifact && !gitleaksArtifact.expired) {
            const zipBuffer = await githubService.downloadWorkflowRunArtifact(
              instIdNum,
              projectRepo.repoOwner,
              projectRepo.repoName,
              gitleaksArtifact.id
            );

            const reportJsonStr = extractFileFromZip(zipBuffer, 'gitleaks-report.json');
            if (reportJsonStr) {
              const normalized = parseAndNormalizeGitleaksReport(reportJsonStr, {
                reportReference: `artifact:${gitleaksArtifact.id}`,
              });
              await recordSecurityScan(targetPipelineId, normalized);
            }
          }
        } catch {
          // Failure to download or parse artifacts should not crash the webhook acknowledgment
        }
      }

      res.status(200).json({
        success: true,
        event,
        action: payload.action,
        runId: workflowRun.id,
      });
      return;
    }

    // Default response for unhandled events
    res.status(200).json({
      status: 'acknowledged',
      event,
    });
  } catch {
    // Fail safely without leaking internal stack trace
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process webhook event safely.',
    });
  }
});
