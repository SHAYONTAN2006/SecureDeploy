import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { createUser, deleteUser } from '../db/users.js';
import { createProject } from '../db/projects.js';
import { upsertInstallation, linkProjectRepository } from '../db/github.js';
import { setGithubServiceMock, type GithubServiceApi } from '../services/github.service.js';
import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '../middleware/auth.js';

function createTestAuthMiddleware(user: AuthUser) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: AuthUser }).user = user;
    if (req.session) {
      req.session.userId = user.id;
    }
    next();
  };
}

describe('CI/CD Pipeline Orchestration API & Webhooks (/api/projects/:projectId/pipelines & /api/webhooks/github)', () => {
  const testRunId = crypto.randomBytes(4).toString('hex');
  const createdUserIds: string[] = [];
  const webhookSecret = 'test-webhook-secret-32-chars-long-strictly';

  let userA: AuthUser;
  let userB: AuthUser;
  let projectAId: string;
  let projectBId: string;
  let installationAId: string;

  let appA: ReturnType<typeof createApp>;
  let appB: ReturnType<typeof createApp>;
  let unauthApp: ReturnType<typeof createApp>;

  const originalAppId = process.env.GITHUB_APP_ID;
  const originalKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;

  const mockGithubService: GithubServiceApi = {
    getInstallationDetails: vi.fn(),
    listInstallationRepositories: vi.fn(),
    getRepository: vi.fn(),
    getInstallationAccessToken: vi.fn().mockResolvedValue('ghs_mock_token'),
    getRef: vi
      .fn()
      .mockImplementation((_instId: number, _owner: string, _repo: string, ref: string) => {
        if (ref === 'main') {
          return Promise.resolve({
            ref: 'main',
            sha: 'abcdef1234567890abcdef1234567890abcdef12',
          });
        }
        if (ref === 'release/v1.0') {
          return Promise.resolve({
            ref: 'release/v1.0',
            sha: '1234567890abcdef1234567890abcdef12345678',
          });
        }
        throw new Error(`Ref not found: ${ref}`);
      }),
    getWorkflow: vi
      .fn()
      .mockImplementation((_instId: number, _owner: string, _repo: string, workflowId: string) => {
        if (workflowId === 'deploy.yml' || workflowId === '.github/workflows/deploy.yml') {
          return Promise.resolve({
            id: 554433,
            name: 'Deploy Production',
            path: '.github/workflows/deploy.yml',
            state: 'active',
          });
        }
        throw new Error(`Workflow not found: ${workflowId}`);
      }),
    dispatchWorkflow: vi
      .fn()
      .mockImplementation((_instId: number, _owner: string, _repo: string, workflowId: string) => {
        if (workflowId.includes('failing')) {
          throw new Error('GitHub Actions API error: 422 Unprocessable Entity');
        }
        return Promise.resolve();
      }),
  };

  beforeAll(async () => {
    process.env.GITHUB_APP_ID = '123456';
    process.env.GITHUB_APP_PRIVATE_KEY =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    process.env.GITHUB_WEBHOOK_SECRET = webhookSecret;

    setGithubServiceMock(mockGithubService);

    // Create User A and User B
    const dbUserA = await createUser({
      email: `pipeline-test-a-${testRunId}@securedeploy.local`,
      name: 'Pipeline User A',
    });
    const dbUserB = await createUser({
      email: `pipeline-test-b-${testRunId}@securedeploy.local`,
      name: 'Pipeline User B',
    });

    userA = { id: dbUserA.id, email: dbUserA.email, name: dbUserA.name };
    userB = { id: dbUserB.id, email: dbUserB.email, name: dbUserB.name };
    createdUserIds.push(userA.id, userB.id);

    // Create Projects
    const projA = await createProject({
      name: 'Project Pipeline Alpha',
      ownerId: userA.id,
    });
    const projB = await createProject({
      name: 'Project Pipeline Beta',
      ownerId: userB.id,
    });
    projectAId = projA.id;
    projectBId = projB.id;

    // Connect GitHub installation to User A
    const instA = await upsertInstallation({
      installationId: BigInt(654321),
      accountLogin: 'acme-pipelines',
      accountId: BigInt(998877),
      userId: userA.id,
    });
    installationAId = instA.id;

    // Link repository to Project A
    await linkProjectRepository({
      projectId: projectAId,
      installationId: installationAId,
      repoId: BigInt(778899),
      repoOwner: 'acme-pipelines',
      repoName: 'backend-service',
      fullName: 'acme-pipelines/backend-service',
      repoUrl: 'https://github.com/acme-pipelines/backend-service',
      defaultBranch: 'main',
    });

    appA = createApp({
      authMiddleware: createTestAuthMiddleware(userA),
      enableCsrf: false,
    });
    appB = createApp({
      authMiddleware: createTestAuthMiddleware(userB),
      enableCsrf: false,
    });
    unauthApp = createApp({ enableCsrf: false });
  });

  afterAll(async () => {
    process.env.GITHUB_APP_ID = originalAppId;
    process.env.GITHUB_APP_PRIVATE_KEY = originalKey;
    process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
    setGithubServiceMock(null);

    for (const id of createdUserIds) {
      try {
        await deleteUser(id);
      } catch {
        // Ignore
      }
    }
    await prisma.$disconnect();
  });

  function signPayload(payload: object) {
    const raw = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    return {
      signature: `sha256=${hmac}`,
      raw,
    };
  }

  describe('Authorization and Validation (POST /api/projects/:projectId/pipelines)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(unauthApp)
        .post(`/api/projects/${projectAId}/pipelines`)
        .send({ workflowFile: 'deploy.yml', gitRef: 'main' });
      expect(res.status).toBe(401);
    });

    it('prevents User B from triggering a pipeline on User A project (404 Not Found)', async () => {
      const res = await request(appB)
        .post(`/api/projects/${projectAId}/pipelines`)
        .send({ workflowFile: 'deploy.yml', gitRef: 'main' });
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/project not found or unauthorized/i);
    });

    it('rejects dispatch if project has no linked repository (400 Bad Request)', async () => {
      const res = await request(appB)
        .post(`/api/projects/${projectBId}/pipelines`)
        .send({ workflowFile: 'deploy.yml', gitRef: 'main' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not have a linked github repository/i);
    });

    it('rejects invalid or traversal workflow filenames (400 Bad Request)', async () => {
      const res1 = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines`)
        .send({ workflowFile: '../../etc/passwd', gitRef: 'main' });
      expect(res1.status).toBe(400);
      expect(res1.body.message).toMatch(/workflowFile/i);

      const res2 = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines`)
        .send({ workflowFile: 'malicious.sh', gitRef: 'main' });
      expect(res2.status).toBe(400);
    });

    it('rejects invalid git ref format (400 Bad Request)', async () => {
      const res = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines`)
        .send({ workflowFile: 'deploy.yml', gitRef: 'main..HEAD' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/gitRef/i);
    });

    it('rejects non-existent git ref on remote repository (400 Bad Request)', async () => {
      const res = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines`)
        .send({ workflowFile: 'deploy.yml', gitRef: 'non-existent-branch' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not exist in repository/i);
    });

    it('rejects non-existent workflow file in repository (400 Bad Request)', async () => {
      const res = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines`)
        .send({ workflowFile: 'missing-workflow.yml', gitRef: 'main' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/workflow .* not found in repository/i);
    });
  });

  describe('Pipeline Dispatch Execution (POST /api/projects/:projectId/pipelines)', () => {
    let createdPipelineId: string;

    it('successfully triggers workflow_dispatch, persists run, and reports DISPATCHED status', async () => {
      const res = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines`)
        .send({
          workflowFile: 'deploy.yml',
          gitRef: 'main',
          inputs: { environment: 'production' },
        });

      expect(res.status).toBe(202);
      expect(res.body.message).toMatch(/dispatch requested successfully/i);
      expect(res.body.pipeline).toBeDefined();
      expect(res.body.pipeline.status).toBe('DISPATCHED');
      expect(res.body.pipeline.workflowFile).toBe('deploy.yml');
      expect(res.body.pipeline.gitRef).toBe('main');
      expect(res.body.pipeline.commitSha).toBe('abcdef1234567890abcdef1234567890abcdef12');

      // The dispatch itself is unconfirmed; githubRunId must not be fabricated
      expect(res.body.pipeline.githubRunId).toBeNull();
      expect(res.body.pipeline.conclusion).toBeNull();

      createdPipelineId = res.body.pipeline.id;
    });

    it('records failed dispatches safely without leaving stuck pending records', async () => {
      // getWorkflow will fail on missing-workflow before dispatch, so mock getWorkflow for failing
      vi.mocked(mockGithubService.getWorkflow).mockResolvedValueOnce({
        id: 999,
        name: 'Failing Workflow',
        path: 'failing-workflow.yml',
        state: 'active',
      });

      const resFail = await request(appA).post(`/api/projects/${projectAId}/pipelines`).send({
        workflowFile: 'failing-workflow.yml',
        gitRef: 'main',
      });

      expect(resFail.status).toBe(502);
      expect(resFail.body.error).toBe('Bad Gateway');

      // Verify that the run record in DB is marked FAILED, not left PENDING
      const dbRun = await prisma.pipelineRun.findFirst({
        where: { projectId: projectAId, workflowFile: 'failing-workflow.yml' },
      });
      expect(dbRun).toBeDefined();
      expect(dbRun?.status).toBe('FAILED');
      expect(dbRun?.errorMessage).toContain('422');
    });

    it('allows owner to retrieve single pipeline run (GET /api/projects/:projectId/pipelines/:pipelineId)', async () => {
      const res = await request(appA).get(
        `/api/projects/${projectAId}/pipelines/${createdPipelineId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(createdPipelineId);
      expect(res.body.status).toBe('DISPATCHED');
    });

    it('prevents User B from viewing User A single pipeline run (404 Not Found)', async () => {
      const res = await request(appB).get(
        `/api/projects/${projectAId}/pipelines/${createdPipelineId}`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('Webhook Ingestion & HMAC Signature Verification (POST /api/webhooks/github)', () => {
    it('rejects webhooks without X-Hub-Signature-256 header (401 Unauthorized)', async () => {
      const res = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-github-event', 'ping')
        .set('x-github-delivery', crypto.randomUUID())
        .send({ zen: 'Keep it simple.' });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/signature/i);
    });

    it('rejects webhooks with invalid HMAC signature (401 Unauthorized)', async () => {
      const res = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', 'sha256=invalid_tampered_signature_hex_digest_here')
        .set('x-github-event', 'ping')
        .set('x-github-delivery', crypto.randomUUID())
        .send({ zen: 'Keep it simple.' });

      expect(res.status).toBe(401);
    });

    it('accepts webhooks with valid HMAC-SHA256 signature for ping event', async () => {
      const payload = { zen: 'Approachable is better than simple.' };
      const { signature, raw } = signPayload(payload);
      const deliveryId = crypto.randomUUID();

      const res = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'ping')
        .set('x-github-delivery', deliveryId)
        .set('content-type', 'application/json')
        .send(raw);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('pong');
    });

    it('handles duplicate delivery IDs idempotently without repeating processing', async () => {
      const payload = { zen: 'Design for failure.' };
      const { signature, raw } = signPayload(payload);
      const deliveryId = crypto.randomUUID();

      // First delivery
      const res1 = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'ping')
        .set('x-github-delivery', deliveryId)
        .set('content-type', 'application/json')
        .send(raw);
      expect(res1.status).toBe(200);

      // Duplicate delivery with identical deliveryId
      const res2 = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'ping')
        .set('x-github-delivery', deliveryId)
        .set('content-type', 'application/json')
        .send(raw);
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('ignored');
      expect(res2.body.message).toMatch(/already processed/i);
    });

    it('handles concurrent duplicate webhook deliveries atomically without race conditions', async () => {
      const payload = { zen: 'Concurrency is not parallelism.' };
      const { signature, raw } = signPayload(payload);
      const deliveryId = crypto.randomUUID();

      // Launch 2 simultaneous requests with the exact same delivery ID
      const [res1, res2] = await Promise.all([
        request(unauthApp)
          .post('/api/webhooks/github')
          .set('x-hub-signature-256', signature)
          .set('x-github-event', 'ping')
          .set('x-github-delivery', deliveryId)
          .set('content-type', 'application/json')
          .send(raw),
        request(unauthApp)
          .post('/api/webhooks/github')
          .set('x-hub-signature-256', signature)
          .set('x-github-event', 'ping')
          .set('x-github-delivery', deliveryId)
          .set('content-type', 'application/json')
          .send(raw),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const statuses = [res1.body.status, res2.body.status];
      // Exactly one should be processed ('pong' without status: ignored) and one ignored
      expect(statuses).toContain('ignored');

      // Database should only have 1 WebhookDelivery row
      const deliveryRows = await prisma.webhookDelivery.findMany({
        where: { id: deliveryId },
      });
      expect(deliveryRows.length).toBe(1);
    });

    it('safely ignores workflow_run events for untracked repositories', async () => {
      const payload = {
        action: 'queued',
        workflow_run: {
          id: 99887766,
          status: 'queued',
          path: '.github/workflows/deploy.yml',
          head_branch: 'main',
        },
        repository: {
          id: 999999999, // Unknown repo ID
          full_name: 'unknown/repo',
        },
      };

      const { signature, raw } = signPayload(payload);
      const res = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ignored');
    });
  });

  describe('Workflow Run State Lifecycle & Out-of-Order Safety', () => {
    const githubRunId = 12345678901;

    it('correlates queued webhook with unconfirmed dispatch and transitions status to QUEUED', async () => {
      const payload = {
        action: 'queued',
        workflow_run: {
          id: githubRunId,
          run_number: 14,
          run_attempt: 1,
          status: 'queued',
          conclusion: null,
          html_url: `https://github.com/acme-pipelines/backend-service/actions/runs/${githubRunId}`,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          head_branch: 'main',
          path: '.github/workflows/deploy.yml',
          run_started_at: new Date().toISOString(),
        },
        repository: {
          id: 778899,
          full_name: 'acme-pipelines/backend-service',
        },
        installation: {
          id: 654321,
        },
      };

      const { signature, raw } = signPayload(payload);
      const res = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify DB record now has githubRunId and QUEUED status
      const run = await prisma.pipelineRun.findUnique({
        where: { githubRunId: BigInt(githubRunId) },
      });
      expect(run).toBeDefined();
      expect(run?.status).toBe('QUEUED');
      expect(run?.htmlUrl).toBe(
        `https://github.com/acme-pipelines/backend-service/actions/runs/${githubRunId}`
      );
    });

    it('transitions status to IN_PROGRESS upon in_progress webhook', async () => {
      const payload = {
        action: 'in_progress',
        workflow_run: {
          id: githubRunId,
          run_number: 14,
          run_attempt: 1,
          status: 'in_progress',
          conclusion: null,
          html_url: `https://github.com/acme-pipelines/backend-service/actions/runs/${githubRunId}`,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          head_branch: 'main',
          path: '.github/workflows/deploy.yml',
        },
        repository: {
          id: 778899,
          full_name: 'acme-pipelines/backend-service',
        },
      };

      const { signature, raw } = signPayload(payload);
      const res = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw);

      expect(res.status).toBe(200);

      const run = await prisma.pipelineRun.findUnique({
        where: { githubRunId: BigInt(githubRunId) },
      });
      expect(run?.status).toBe('IN_PROGRESS');
    });

    it('transitions status to COMPLETED with conclusion upon completed webhook', async () => {
      const payload = {
        action: 'completed',
        workflow_run: {
          id: githubRunId,
          run_number: 14,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          html_url: `https://github.com/acme-pipelines/backend-service/actions/runs/${githubRunId}`,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          head_branch: 'main',
          path: '.github/workflows/deploy.yml',
          updated_at: new Date().toISOString(),
        },
        repository: {
          id: 778899,
          full_name: 'acme-pipelines/backend-service',
        },
      };

      const { signature, raw } = signPayload(payload);
      const res = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw);

      expect(res.status).toBe(200);

      const run = await prisma.pipelineRun.findUnique({
        where: { githubRunId: BigInt(githubRunId) },
      });
      expect(run?.status).toBe('COMPLETED');
      expect(run?.conclusion).toBe('success');
      expect(run?.completedAt).toBeDefined();
    });

    it('out-of-order events do not regress a COMPLETED run to earlier status', async () => {
      // Simulate delayed/reordered in_progress event arriving AFTER completion
      const payload = {
        action: 'in_progress',
        workflow_run: {
          id: githubRunId,
          status: 'in_progress',
          conclusion: null,
          path: '.github/workflows/deploy.yml',
          head_branch: 'main',
        },
        repository: {
          id: 778899,
          full_name: 'acme-pipelines/backend-service',
        },
      };

      const { signature, raw } = signPayload(payload);
      const res = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw);

      expect(res.status).toBe(200);

      // Verify status is STILL COMPLETED and conclusion is STILL success
      const run = await prisma.pipelineRun.findUnique({
        where: { githubRunId: BigInt(githubRunId) },
      });
      expect(run?.status).toBe('COMPLETED');
      expect(run?.conclusion).toBe('success');
    });

    it('supports workflow reruns with run_attempt > 1 transitioning from COMPLETED back to IN_PROGRESS and then COMPLETED', async () => {
      const rerunAttempt2Payload = {
        action: 'in_progress',
        workflow_run: {
          id: githubRunId,
          run_number: 14,
          run_attempt: 2,
          status: 'in_progress',
          conclusion: null,
          html_url: `https://github.com/acme-pipelines/backend-service/actions/runs/${githubRunId}`,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          head_branch: 'main',
          path: '.github/workflows/deploy.yml',
        },
        repository: {
          id: 778899,
          full_name: 'acme-pipelines/backend-service',
        },
      };

      const { signature: sig1, raw: raw1 } = signPayload(rerunAttempt2Payload);
      const res1 = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', sig1)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw1);

      expect(res1.status).toBe(200);

      const runAfterRerun = await prisma.pipelineRun.findUnique({
        where: { githubRunId: BigInt(githubRunId) },
      });
      expect(runAfterRerun?.status).toBe('IN_PROGRESS');
      expect(runAfterRerun?.conclusion).toBeNull();
      expect(runAfterRerun?.githubRunAttempt).toBe(2);

      // Now complete the rerun
      const rerunCompletedPayload = {
        action: 'completed',
        workflow_run: {
          id: githubRunId,
          run_number: 14,
          run_attempt: 2,
          status: 'completed',
          conclusion: 'success',
          html_url: `https://github.com/acme-pipelines/backend-service/actions/runs/${githubRunId}`,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          head_branch: 'main',
          path: '.github/workflows/deploy.yml',
          updated_at: new Date().toISOString(),
        },
        repository: {
          id: 778899,
          full_name: 'acme-pipelines/backend-service',
        },
      };

      const { signature: sig2, raw: raw2 } = signPayload(rerunCompletedPayload);
      const res2 = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', sig2)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw2);

      expect(res2.status).toBe(200);

      const runFinal = await prisma.pipelineRun.findUnique({
        where: { githubRunId: BigInt(githubRunId) },
      });
      expect(runFinal?.status).toBe('COMPLETED');
      expect(runFinal?.conclusion).toBe('success');
      expect(runFinal?.githubRunAttempt).toBe(2);
    });
  });

  describe('Safe Correlation & Ambiguity Protection for Concurrent Dispatches', () => {
    it('does not arbitrarily correlate or mutate runs when multiple unconfirmed dispatches match identically', async () => {
      // 1. Trigger two simultaneous dispatches for project A with identical workflow and branch
      const resDispatch1 = await request(appA).post(`/api/projects/${projectAId}/pipelines`).send({
        workflowFile: 'deploy.yml',
        gitRef: 'main',
      });
      expect(resDispatch1.status).toBe(202);
      const run1Id = resDispatch1.body.pipeline.id;

      const resDispatch2 = await request(appA).post(`/api/projects/${projectAId}/pipelines`).send({
        workflowFile: 'deploy.yml',
        gitRef: 'main',
      });
      expect(resDispatch2.status).toBe(202);
      const run2Id = resDispatch2.body.pipeline.id;

      expect(run1Id).not.toBe(run2Id);

      // Verify both are DISPATCHED and unconfirmed
      const run1Before = await prisma.pipelineRun.findUnique({ where: { id: run1Id } });
      const run2Before = await prisma.pipelineRun.findUnique({ where: { id: run2Id } });
      expect(run1Before?.status).toBe('DISPATCHED');
      expect(run1Before?.githubRunId).toBeNull();
      expect(run2Before?.status).toBe('DISPATCHED');
      expect(run2Before?.githubRunId).toBeNull();

      // 2. Incoming webhook arrives for a GitHub workflow run matching both candidates
      const ambiguousGithubRunId = 9988112233;
      const ambiguousPayload = {
        action: 'queued',
        workflow_run: {
          id: ambiguousGithubRunId,
          run_number: 42,
          run_attempt: 1,
          status: 'queued',
          conclusion: null,
          html_url: `https://github.com/acme-pipelines/backend-service/actions/runs/${ambiguousGithubRunId}`,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          head_branch: 'main',
          path: '.github/workflows/deploy.yml',
          run_started_at: new Date().toISOString(),
        },
        repository: {
          id: 778899,
          full_name: 'acme-pipelines/backend-service',
        },
        installation: {
          id: 654321,
        },
      };

      const { signature, raw } = signPayload(ambiguousPayload);
      const resWebhook = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw);

      expect(resWebhook.status).toBe(200);

      // 3. Verify that NEITHER candidate run was arbitrarily mutated with ambiguousGithubRunId
      const run1After = await prisma.pipelineRun.findUnique({ where: { id: run1Id } });
      const run2After = await prisma.pipelineRun.findUnique({ where: { id: run2Id } });

      expect(run1After?.githubRunId).toBeNull();
      expect(run1After?.status).toBe('DISPATCHED');

      expect(run2After?.githubRunId).toBeNull();
      expect(run2After?.status).toBe('DISPATCHED');

      // 4. Verify that the GitHub run was safely recorded as an independent run record
      const independentRun = await prisma.pipelineRun.findUnique({
        where: { githubRunId: BigInt(ambiguousGithubRunId) },
      });
      expect(independentRun).toBeDefined();
      expect(independentRun?.id).not.toBe(run1Id);
      expect(independentRun?.id).not.toBe(run2Id);
      expect(independentRun?.status).toBe('QUEUED');
    });

    it('unambiguously correlates when exact branch and commitSha match a single candidate', async () => {
      // Dispatch for release/v1.0 (commitSha: 1234567890abcdef1234567890abcdef12345678)
      const resDispatch = await request(appA).post(`/api/projects/${projectAId}/pipelines`).send({
        workflowFile: 'deploy.yml',
        gitRef: 'release/v1.0',
      });
      expect(resDispatch.status).toBe(202);
      const releaseRunId = resDispatch.body.pipeline.id;
      expect(resDispatch.body.pipeline.commitSha).toBe('1234567890abcdef1234567890abcdef12345678');

      // Webhook arrives matching release/v1.0 and its exact commitSha
      const releaseGithubRunId = 1122334455;
      const releasePayload = {
        action: 'queued',
        workflow_run: {
          id: releaseGithubRunId,
          run_number: 99,
          run_attempt: 1,
          status: 'queued',
          conclusion: null,
          html_url: `https://github.com/acme-pipelines/backend-service/actions/runs/${releaseGithubRunId}`,
          head_sha: '1234567890abcdef1234567890abcdef12345678',
          head_branch: 'release/v1.0',
          path: '.github/workflows/deploy.yml',
          run_started_at: new Date().toISOString(),
        },
        repository: {
          id: 778899,
          full_name: 'acme-pipelines/backend-service',
        },
        installation: {
          id: 654321,
        },
      };

      const { signature, raw } = signPayload(releasePayload);
      const resWebhook = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', signature)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(raw);

      expect(resWebhook.status).toBe(200);

      // Verify exact correlation to releaseRunId
      const correlatedRun = await prisma.pipelineRun.findUnique({
        where: { id: releaseRunId },
      });
      expect(correlatedRun?.githubRunId).toBe(BigInt(releaseGithubRunId));
      expect(correlatedRun?.status).toBe('QUEUED');
      expect(correlatedRun?.gitRef).toBe('release/v1.0');
    });
  });

  describe('Owner-Scoped Run Tracking History (GET /api/projects/:projectId/pipelines)', () => {
    it('returns owner-scoped pipeline history with pagination metadata', async () => {
      const res = await request(appA).get(
        `/api/projects/${projectAId}/pipelines?page=1&per_page=10`
      );
      expect(res.status).toBe(200);
      expect(res.body.runs).toBeDefined();
      expect(res.body.runs.length).toBeGreaterThanOrEqual(1);
      expect(res.body.totalCount).toBeGreaterThanOrEqual(1);
      expect(res.body.page).toBe(1);
      expect(res.body.perPage).toBe(10);
      expect(res.body.totalPages).toBeGreaterThanOrEqual(1);
    });

    it('prevents User B from accessing User A pipeline history (404 Not Found)', async () => {
      const res = await request(appB).get(`/api/projects/${projectAId}/pipelines`);
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/project not found or unauthorized/i);
    });

    it('rejects invalid pagination parameters (400 Bad Request)', async () => {
      const res = await request(appA).get(
        `/api/projects/${projectAId}/pipelines?page=0&per_page=200`
      );
      expect(res.status).toBe(400);
    });
  });
});
