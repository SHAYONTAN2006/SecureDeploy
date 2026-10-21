import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { createUser, deleteUser } from '../db/users.js';
import { createProject } from '../db/projects.js';
import { upsertInstallation, linkProjectRepository } from '../db/github.js';
import { createPipelineRun } from '../db/pipelines.js';
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

function buildMockZip(filename: string, content: string): Buffer {
  const fnBuf = Buffer.from(filename, 'utf8');
  const rawData = Buffer.from(content, 'utf8');
  const deflatedData = zlib.deflateRawSync(rawData);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // signature
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8); // Deflated
  header.writeUInt32LE(0, 10);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(deflatedData.length, 18);
  header.writeUInt32LE(rawData.length, 22);
  header.writeUInt16LE(fnBuf.length, 26);
  header.writeUInt16LE(0, 28);

  return Buffer.concat([header, fnBuf, deflatedData]);
}

describe('Gitleaks Secret Detection & Pipeline Tracking API (/api/projects/:id/pipelines/:id/scans)', () => {
  const testRunId = crypto.randomBytes(4).toString('hex');
  const createdUserIds: string[] = [];
  const webhookSecret = 'test-scan-webhook-secret-32-chars-strictly';

  let userA: AuthUser;
  let userB: AuthUser;
  let projectAId: string;
  let projectBId: string;
  let pipelineRunAId: string;
  let appA: ReturnType<typeof createApp>;
  let appB: ReturnType<typeof createApp>;
  let unauthApp: ReturnType<typeof createApp>;

  const originalAppId = process.env.GITHUB_APP_ID;
  const originalKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;

  const mockArtifactZip = buildMockZip(
    'gitleaks-report.json',
    JSON.stringify([
      {
        Description: 'AWS Access Key ID',
        StartLine: 12,
        EndLine: 12,
        StartColumn: 1,
        EndColumn: 28,
        Match: 'AWS_KEY="AKIAIOSFODNN7EXAMPLE"',
        Secret: 'AKIAIOSFODNN7EXAMPLE',
        File: 'src/aws-config.ts',
        Commit: 'e1d2c3b4a5987654321012345678901234567890',
        Author: 'Dev <dev@example.com>',
        Date: '2026-10-21T10:00:00Z',
        RuleID: 'aws-access-token',
        Fingerprint: 'aws-key-fingerprint-1',
      },
    ])
  );

  const mockGithubService: GithubServiceApi = {
    getInstallationDetails: vi.fn(),
    listInstallationRepositories: vi.fn(),
    getRepository: vi.fn(),
    getInstallationAccessToken: vi.fn().mockResolvedValue('ghs_mock_token'),
    getRef: vi.fn().mockResolvedValue({
      ref: 'main',
      sha: 'abcdef1234567890abcdef1234567890abcdef12',
    }),
    getWorkflow: vi.fn().mockResolvedValue({
      id: 771122,
      name: 'Gitleaks Scan',
      path: '.github/workflows/securedeploy-gitleaks.yml',
      state: 'active',
    }),
    dispatchWorkflow: vi.fn().mockResolvedValue(undefined),
    listWorkflowRunArtifacts: vi.fn().mockResolvedValue({
      totalCount: 1,
      artifacts: [
        {
          id: 554433,
          name: 'gitleaks-report',
          sizeInBytes: mockArtifactZip.length,
          expired: false,
        },
      ],
    }),
    downloadWorkflowRunArtifact: vi.fn().mockResolvedValue(mockArtifactZip),
  };

  beforeAll(async () => {
    process.env.GITHUB_APP_ID = '123456';
    process.env.GITHUB_APP_PRIVATE_KEY =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    process.env.GITHUB_WEBHOOK_SECRET = webhookSecret;
    setGithubServiceMock(mockGithubService);

    // Create User A
    const uA = await createUser({
      email: `scan-user-a-${testRunId}@example.com`,
      name: 'Scan User A',
      passwordHash: 'dummy_hash',
    });
    userA = { id: uA.id, email: uA.email, name: uA.name };
    createdUserIds.push(uA.id);

    // Create User B
    const uB = await createUser({
      email: `scan-user-b-${testRunId}@example.com`,
      name: 'Scan User B',
      passwordHash: 'dummy_hash',
    });
    userB = { id: uB.id, email: uB.email, name: uB.name };
    createdUserIds.push(uB.id);

    // Create Projects
    const pA = await createProject({
      name: `Scan Project A ${testRunId}`,
      ownerId: userA.id,
    });
    projectAId = pA.id;

    const pB = await createProject({
      name: `Scan Project B ${testRunId}`,
      ownerId: userB.id,
    });
    projectBId = pB.id;

    // Link repo to Project A
    const instA = await upsertInstallation({
      installationId: 887766,
      accountLogin: 'acme-scan',
      accountId: 112233,
      userId: userA.id,
    });

    const repoA = await linkProjectRepository({
      projectId: projectAId,
      installationId: instA.id,
      repoId: 998877,
      repoOwner: 'acme-scan',
      repoName: 'secret-scanner-repo',
      fullName: 'acme-scan/secret-scanner-repo',
      repoUrl: 'https://github.com/acme-scan/secret-scanner-repo',
      defaultBranch: 'main',
    });

    // Create initial pipeline run for Project A
    const runA = await createPipelineRun({
      projectId: projectAId,
      projectRepositoryId: repoA.id,
      triggeredById: userA.id,
      workflowFile: '.github/workflows/securedeploy-gitleaks.yml',
      gitRef: 'main',
      commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
      status: 'DISPATCHED',
    });
    pipelineRunAId = runA.id;

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
    setGithubServiceMock(null);
    if (originalAppId) process.env.GITHUB_APP_ID = originalAppId;
    if (originalKey) process.env.GITHUB_APP_PRIVATE_KEY = originalKey;
    if (originalSecret) process.env.GITHUB_WEBHOOK_SECRET = originalSecret;

    for (const uid of createdUserIds) {
      await deleteUser(uid).catch(() => {});
    }
  });

  function signPayload(payload: unknown): { signature: string; raw: string } {
    const raw = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(raw);
    return {
      signature: `sha256=${hmac.digest('hex')}`,
      raw,
    };
  }

  describe('Workflow Template Endpoint (GET /api/projects/:projectId/pipelines/templates/gitleaks)', () => {
    it('returns recommended Gitleaks workflow template and setup instructions', async () => {
      const res = await request(appA).get(
        `/api/projects/${projectAId}/pipelines/templates/gitleaks`
      );

      expect(res.status).toBe(200);
      expect(res.body.templateName).toBe('securedeploy-gitleaks.yml');
      expect(res.body.recommendedPath).toBe('.github/workflows/securedeploy-gitleaks.yml');
      expect(res.body.pinnedActionVersion).toContain('gitleaks/gitleaks-action@');
      expect(res.body.instructions).toBeDefined();
      expect(res.body.instructions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Direct Security Scan Report Ingestion & Sanitization', () => {
    it('records a clean scan result with 0 findings (Clean Scan)', async () => {
      const res = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines/${pipelineRunAId}/scans/gitleaks`)
        .send({
          findings: [],
          reportReference: 'manual:clean-scan-run',
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toMatch(/recorded successfully/i);
      expect(res.body.scan).toBeDefined();
      expect(res.body.scan.scannerName).toBe('gitleaks');
      expect(res.body.scan.status).toBe('SUCCESS');
      expect(res.body.scan.hasFindings).toBe(false);
      expect(res.body.scan.findingCount).toBe(0);
      expect(res.body.scan.findings).toHaveLength(0);
    });

    it('records detected secret findings with complete secret redaction and stable fingerprints', async () => {
      const secretValue = 'ghp_SUPER_SECRET_TOKEN_VALUE_DO_NOT_LEAK';
      const rawFindings = [
        {
          Description: 'GitHub Personal Access Token',
          StartLine: 15,
          EndLine: 15,
          StartColumn: 1,
          EndColumn: 50,
          Match: `GITHUB_PAT="${secretValue}"`,
          Secret: secretValue,
          File: 'src/auth/tokens.ts',
          Commit: 'c0ffee1234567890abcdef1234567890abcdef12',
          Author: 'Alice <alice@example.com>',
          Date: '2026-10-21T09:00:00Z',
          RuleID: 'github-pat',
          Fingerprint: 'custom-pat-fingerprint',
        },
      ];

      const res = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines/${pipelineRunAId}/scans/gitleaks`)
        .send({
          findings: rawFindings,
          reportReference: 'manual:test-secrets-detected',
        });

      expect(res.status).toBe(201);
      expect(res.body.scan.status).toBe('SUCCESS');
      expect(res.body.scan.hasFindings).toBe(true);
      expect(res.body.scan.findingCount).toBe(1);

      const finding = res.body.scan.findings[0];
      expect(finding.ruleId).toBe('github-pat');
      expect(finding.filePath).toBe('src/auth/tokens.ts');
      expect(finding.severity).toBe('CRITICAL');
      expect(finding.sanitizedMatch).toBe('GITHUB_PAT="[REDACTED]"');
      expect(finding.sanitizedMatch).not.toContain(secretValue);
      expect(finding.fingerprint).toHaveLength(64);

      // Verify database record has NO secret stored in any column
      const dbFinding = await prisma.securityFinding.findUnique({
        where: { id: finding.id },
      });
      expect(dbFinding).toBeDefined();
      expect(dbFinding?.sanitizedMatch).toBe('GITHUB_PAT="[REDACTED]"');
      expect(JSON.stringify(dbFinding)).not.toContain(secretValue);
    });

    it('handles scanner execution errors gracefully without recording bogus findings', async () => {
      const res = await request(appA)
        .post(`/api/projects/${projectAId}/pipelines/${pipelineRunAId}/scans/gitleaks`)
        .send({ findings: 'INVALID_SYNTAX_CRASH_LOGS_NOT_JSON' });

      expect(res.status).toBe(201);
      expect(res.body.scan.status).toBe('ERROR');
      expect(res.body.scan.hasFindings).toBe(false);
      expect(res.body.scan.findingCount).toBe(0);
      expect(res.body.scan.errorMessage).toContain('Failed to parse Gitleaks report JSON');
    });

    it('prevents User B from ingesting scan reports into User A pipeline (404 Not Found)', async () => {
      const res = await request(appB)
        .post(`/api/projects/${projectAId}/pipelines/${pipelineRunAId}/scans/gitleaks`)
        .send({ findings: [] });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/project not found or unauthorized/i);
    });

    it('prevents User A from ingesting scan reports into User B project (404 Not Found)', async () => {
      const res = await request(appA)
        .post(`/api/projects/${projectBId}/pipelines/${pipelineRunAId}/scans/gitleaks`)
        .send({ findings: [] });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/project not found or unauthorized/i);
    });
  });

  describe('Security Scans Retrieval & Isolation (GET /api/projects/:projectId/pipelines/:pipelineId/scans)', () => {
    it('allows owner to retrieve all security scans and sanitized findings for a pipeline run', async () => {
      const res = await request(appA).get(
        `/api/projects/${projectAId}/pipelines/${pipelineRunAId}/scans`
      );

      expect(res.status).toBe(200);
      expect(res.body.pipelineId).toBe(pipelineRunAId);
      expect(res.body.scans).toBeDefined();
      expect(res.body.scans.length).toBeGreaterThanOrEqual(1);
      expect(res.body.scans[0].scannerName).toBe('gitleaks');
    });

    it('prevents User B from accessing User A security scans (404 Not Found)', async () => {
      const res = await request(appB).get(
        `/api/projects/${projectAId}/pipelines/${pipelineRunAId}/scans`
      );

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/project not found or unauthorized/i);
    });

    it('includes security scan summary in pipeline detail (GET /api/projects/:projectId/pipelines/:pipelineId)', async () => {
      const res = await request(appA).get(
        `/api/projects/${projectAId}/pipelines/${pipelineRunAId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(pipelineRunAId);
      expect(res.body.securityScans).toBeDefined();
      expect(res.body.securityScans.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Automated Webhook Artifact Ingestion', () => {
    it('automatically downloads Gitleaks artifact, normalizes findings, and associates scan upon workflow_run.completed', async () => {
      const githubRunId = 7766554433;

      // 1. Send queued webhook to initialize the run with githubRunId
      const queuedPayload = {
        action: 'queued',
        workflow_run: {
          id: githubRunId,
          run_number: 1,
          run_attempt: 1,
          status: 'queued',
          conclusion: null,
          html_url: `https://github.com/acme-scan/secret-scanner-repo/actions/runs/${githubRunId}`,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          head_branch: 'main',
          path: '.github/workflows/securedeploy-gitleaks.yml',
          run_started_at: new Date().toISOString(),
        },
        repository: {
          id: 998877,
          full_name: 'acme-scan/secret-scanner-repo',
        },
        installation: {
          id: 887766,
        },
      };

      const { signature: sigQ, raw: rawQ } = signPayload(queuedPayload);
      await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', sigQ)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(rawQ);

      // 2. Send completed webhook with conclusion 'failure' (because Gitleaks detected secrets exit code 1)
      const completedPayload = {
        action: 'completed',
        workflow_run: {
          id: githubRunId,
          run_number: 1,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'failure',
          html_url: `https://github.com/acme-scan/secret-scanner-repo/actions/runs/${githubRunId}`,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          head_branch: 'main',
          path: '.github/workflows/securedeploy-gitleaks.yml',
          updated_at: new Date().toISOString(),
        },
        repository: {
          id: 998877,
          full_name: 'acme-scan/secret-scanner-repo',
        },
        installation: {
          id: 887766,
        },
      };

      const { signature: sigC, raw: rawC } = signPayload(completedPayload);
      const resCompleted = await request(unauthApp)
        .post('/api/webhooks/github')
        .set('x-hub-signature-256', sigC)
        .set('x-github-event', 'workflow_run')
        .set('x-github-delivery', crypto.randomUUID())
        .set('content-type', 'application/json')
        .send(rawC);

      expect(resCompleted.status).toBe(200);
      expect(resCompleted.body.success).toBe(true);

      // 3. Verify that the pipeline run has the automatically recorded SecurityScan in PostgreSQL
      const pipelineRun = await prisma.pipelineRun.findUnique({
        where: { githubRunId: BigInt(githubRunId) },
        include: {
          securityScans: {
            include: {
              findings: true,
            },
          },
        },
      });

      expect(pipelineRun).toBeDefined();
      expect(pipelineRun?.status).toBe('COMPLETED');
      expect(pipelineRun?.conclusion).toBe('failure');

      // Scanner execution status is SUCCESS (scanner ran and produced report) with hasFindings: true
      expect(pipelineRun?.securityScans.length).toBeGreaterThanOrEqual(1);
      const scan = pipelineRun?.securityScans.find((s) => s.reportReference === 'artifact:554433');
      expect(scan).toBeDefined();
      expect(scan?.status).toBe('SUCCESS');
      expect(scan?.hasFindings).toBe(true);
      expect(scan?.findingCount).toBe(1);
      expect(scan?.findings[0].ruleId).toBe('aws-access-token');
      expect(scan?.findings[0].sanitizedMatch).toBe('AWS_KEY="[REDACTED]"');
      expect(scan?.findings[0].sanitizedMatch).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });
  });
});
