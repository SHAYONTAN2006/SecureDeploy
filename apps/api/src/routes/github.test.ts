import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma, createUser, createProject, deleteUser } from '../db/index.js';
import { setGithubServiceMock, type GithubServiceApi } from '../services/github.service.js';
import { createTestAuthMiddleware, type AuthUser } from '../middleware/auth.js';

describe('Multi-User GitHub App Integration (/api/github & /api/projects/:id/repository)', () => {
  const testRunId = Date.now();
  const createdUserIds: string[] = [];

  let userA: AuthUser;
  let userB: AuthUser;
  let projectAId: string;
  let projectBId: string;

  let appA: ReturnType<typeof createApp>;
  let appB: ReturnType<typeof createApp>;

  // Save original env
  const originalAppId = process.env.GITHUB_APP_ID;
  const originalKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const originalSlug = process.env.GITHUB_APP_SLUG;

  const mockGithubService: GithubServiceApi = {
    getInstallationDetails: vi.fn().mockImplementation((installationId: number) => {
      if (installationId === 12345678) {
        return Promise.resolve({
          id: 12345678,
          account: {
            login: 'acme-corp',
            id: 9876543,
            type: 'Organization',
          },
          targetType: 'Organization',
          repositorySelection: 'selected',
        });
      }
      if (installationId === 87654321) {
        return Promise.resolve({
          id: 87654321,
          account: {
            login: 'user-b-personal',
            id: 11223344,
            type: 'User',
          },
          targetType: 'User',
          repositorySelection: 'all',
        });
      }
      throw new Error('Installation not found on GitHub');
    }),
    listInstallationRepositories: vi.fn().mockImplementation((installationId: number) => {
      if (installationId === 12345678) {
        return Promise.resolve({
          totalCount: 2,
          repositories: [
            {
              id: 1001,
              name: 'backend-core',
              fullName: 'acme-corp/backend-core',
              owner: { login: 'acme-corp', id: 9876543 },
              private: true,
              htmlUrl: 'https://github.com/acme-corp/backend-core',
              defaultBranch: 'main',
            },
            {
              id: 1002,
              name: 'frontend-portal',
              fullName: 'acme-corp/frontend-portal',
              owner: { login: 'acme-corp', id: 9876543 },
              private: false,
              htmlUrl: 'https://github.com/acme-corp/frontend-portal',
              defaultBranch: 'master',
            },
          ],
        });
      }
      if (installationId === 87654321) {
        return Promise.resolve({
          totalCount: 1,
          repositories: [
            {
              id: 2001,
              name: 'user-b-repo',
              fullName: 'user-b-personal/user-b-repo',
              owner: { login: 'user-b-personal', id: 11223344 },
              private: true,
              htmlUrl: 'https://github.com/user-b-personal/user-b-repo',
              defaultBranch: 'main',
            },
          ],
        });
      }
      throw new Error('Installation not found');
    }),
    getRepository: vi
      .fn()
      .mockImplementation((installationId: number, owner: string, repo: string) => {
        if (installationId === 12345678 && owner === 'acme-corp' && repo === 'backend-core') {
          return Promise.resolve({
            id: 1001,
            name: 'backend-core',
            fullName: 'acme-corp/backend-core',
            owner: { login: 'acme-corp', id: 9876543 },
            private: true,
            htmlUrl: 'https://github.com/acme-corp/backend-core',
            defaultBranch: 'main',
          });
        }
        if (installationId === 87654321 && owner === 'user-b-personal' && repo === 'user-b-repo') {
          return Promise.resolve({
            id: 2001,
            name: 'user-b-repo',
            fullName: 'user-b-personal/user-b-repo',
            owner: { login: 'user-b-personal', id: 11223344 },
            private: true,
            htmlUrl: 'https://github.com/user-b-personal/user-b-repo',
            defaultBranch: 'main',
          });
        }
        throw new Error('Repository not found or inaccessible for installation');
      }),
    getInstallationAccessToken: vi.fn().mockResolvedValue('ghs_mocked_token_12345'),
  };

  beforeAll(async () => {
    // Configure GitHub App environment for tests
    process.env.GITHUB_APP_ID = '123456';
    process.env.GITHUB_APP_PRIVATE_KEY =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    process.env.GITHUB_APP_SLUG = 'securedeploy-test-app';

    // Inject mock GitHub service
    setGithubServiceMock(mockGithubService);

    // Create User A and User B in database
    const dbUserA = await createUser({
      email: `github-test-a-${testRunId}@securedeploy.local`,
      name: 'GitHub User A',
    });
    const dbUserB = await createUser({
      email: `github-test-b-${testRunId}@securedeploy.local`,
      name: 'GitHub User B',
    });

    userA = { id: dbUserA.id, email: dbUserA.email, name: dbUserA.name };
    userB = { id: dbUserB.id, email: dbUserB.email, name: dbUserB.name };
    createdUserIds.push(userA.id, userB.id);

    // Create Projects for User A and User B
    const projA = await createProject({
      name: 'Project Alpha',
      ownerId: userA.id,
    });
    const projB = await createProject({
      name: 'Project Beta',
      ownerId: userB.id,
    });
    projectAId = projA.id;
    projectBId = projB.id;

    // Create apps with dependency-injected test users
    appA = createApp({
      authMiddleware: createTestAuthMiddleware(userA),
      enableCsrf: false,
    });
    appB = createApp({
      authMiddleware: createTestAuthMiddleware(userB),
      enableCsrf: false,
    });
  });

  afterAll(async () => {
    // Restore environment
    process.env.GITHUB_APP_ID = originalAppId;
    process.env.GITHUB_APP_PRIVATE_KEY = originalKey;
    process.env.GITHUB_APP_SLUG = originalSlug;

    // Reset mock
    setGithubServiceMock(null);

    // Clean up users
    for (const id of createdUserIds) {
      try {
        await deleteUser(id);
      } catch {
        // Ignore
      }
    }
    await prisma.$disconnect();
  });

  describe('Configuration & Status (/api/github/status)', () => {
    it('reports configured true when app credentials exist in environment', async () => {
      const res = await request(appA).get('/api/github/status');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.slug).toBe('securedeploy-test-app');
    });

    it('reports configured false when app credentials are not set', async () => {
      delete process.env.GITHUB_APP_ID;
      try {
        const res = await request(appA).get('/api/github/status');
        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(false);
      } finally {
        process.env.GITHUB_APP_ID = '123456';
      }
    });
  });

  describe('Installation Flow (/api/github/install & /api/github/callback)', () => {
    let installState: string;

    it('rejects unauthenticated requests to /api/github/install', async () => {
      const unauthApp = createApp({ enableCsrf: false });
      const res = await request(unauthApp).get('/api/github/install');
      expect(res.status).toBe(401);
    });

    it('generates an anti-CSRF state and GitHub App installation URL for authenticated user', async () => {
      // Use agent to retain session state
      const agentA = request.agent(appA);

      const res = await agentA.get('/api/github/install');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('url');
      expect(res.body).toHaveProperty('state');
      expect(res.body.url).toContain(
        'https://github.com/apps/securedeploy-test-app/installations/new'
      );
      expect(res.body.url).toContain(res.body.state);

      installState = res.body.state;

      // Handle callback with missing state parameter -> returns 400
      const missingStateRes = await agentA.get('/api/github/callback?installation_id=12345678');
      expect(missingStateRes.status).toBe(400);

      // Handle callback with invalid state parameter -> returns 400
      const invalidStateRes = await agentA.get(
        '/api/github/callback?installation_id=12345678&state=tampered_state'
      );
      expect(invalidStateRes.status).toBe(400);

      // Complete legitimate callback
      const callbackRes = await agentA.get(
        `/api/github/callback?installation_id=12345678&state=${installState}`
      );
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body.success).toBe(true);
      expect(callbackRes.body.installation.accountLogin).toBe('acme-corp');
      expect(callbackRes.body.installation.installationId).toBe('12345678');

      // State is single-use: replay attack with same state must fail with 400
      const replayRes = await agentA.get(
        `/api/github/callback?installation_id=12345678&state=${installState}`
      );
      expect(replayRes.status).toBe(400);
    });

    it('never leaks installation access tokens or secrets in responses', async () => {
      const agentA = request.agent(appA);
      const res = await agentA.get('/api/github/installations');
      expect(res.status).toBe(200);

      const jsonString = JSON.stringify(res.body);
      expect(jsonString).not.toContain('ghs_');
      expect(jsonString).not.toContain('PRIVATE KEY');
      expect(jsonString).not.toContain('token');
    });
  });

  describe('Multi-User Installation Isolation (/api/github/installations)', () => {
    beforeAll(async () => {
      // Connect installation 87654321 to User B
      const agentB = request.agent(appB);
      const initB = await agentB.get('/api/github/install');
      await agentB.get(`/api/github/callback?installation_id=87654321&state=${initB.body.state}`);
    });

    it('lists only installations owned by the authenticated caller', async () => {
      // User A lists installations: sees acme-corp, NOT user-b-personal
      const resA = await request(appA).get('/api/github/installations');
      expect(resA.status).toBe(200);
      const loginsA = resA.body.installations.map((i: { accountLogin: string }) => i.accountLogin);
      expect(loginsA).toContain('acme-corp');
      expect(loginsA).not.toContain('user-b-personal');

      // User B lists installations: sees user-b-personal, NOT acme-corp
      const resB = await request(appB).get('/api/github/installations');
      expect(resB.status).toBe(200);
      const loginsB = resB.body.installations.map((i: { accountLogin: string }) => i.accountLogin);
      expect(loginsB).toContain('user-b-personal');
      expect(loginsB).not.toContain('acme-corp');
    });

    it('prevents User B from accessing User A installations repositories (cross-user isolation)', async () => {
      // User A can list repositories for installation 12345678
      const resA = await request(appA).get('/api/github/installations/12345678/repositories');
      expect(resA.status).toBe(200);
      expect(resA.body.totalCount).toBe(2);
      expect(resA.body.repositories[0].fullName).toBe('acme-corp/backend-core');

      // User B attempts to access User A's installation 12345678 -> 404 Not Found
      const resB = await request(appB).get('/api/github/installations/12345678/repositories');
      expect(resB.status).toBe(404);
      expect(resB.body.error).toBe('Not Found');
    });

    it('supports repository pagination parameters', async () => {
      const res = await request(appA).get(
        '/api/github/installations/12345678/repositories?page=2&per_page=10'
      );
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(2);
      expect(res.body.perPage).toBe(10);
    });
  });

  describe('Project-Repository Associations (/api/projects/:projectId/repository)', () => {
    it('prevents linking repository to a project owned by another user (cross-user project protection)', async () => {
      // User B attempts to link a repository to User A's project
      const res = await request(appB).post(`/api/projects/${projectAId}/repository`).send({
        installationId: '87654321',
        repoId: 2001,
        repoOwner: 'user-b-personal',
        repoName: 'user-b-repo',
        fullName: 'user-b-personal/user-b-repo',
        repoUrl: 'https://github.com/user-b-personal/user-b-repo',
      });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/project not found or unauthorized/i);
    });

    it('prevents linking using an installation belonging to another user', async () => {
      // User A attempts to link using User B's installation 87654321
      const res = await request(appA).post(`/api/projects/${projectAId}/repository`).send({
        installationId: '87654321',
        repoId: 2001,
        repoOwner: 'user-b-personal',
        repoName: 'user-b-repo',
        fullName: 'user-b-personal/user-b-repo',
        repoUrl: 'https://github.com/user-b-personal/user-b-repo',
      });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/installation not found or unauthorized/i);
    });

    it('rejects client-supplied spoofed repo details that do not exist on GitHub', async () => {
      const res = await request(appA).post(`/api/projects/${projectAId}/repository`).send({
        installationId: '12345678',
        repoId: 9999, // Mismatched ID
        repoOwner: 'acme-corp',
        repoName: 'nonexistent-repo',
        fullName: 'acme-corp/nonexistent-repo',
        repoUrl: 'https://github.com/acme-corp/nonexistent-repo',
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not accessible/i);
    });

    it('successfully links an accessible repository to an owned project', async () => {
      const res = await request(appA).post(`/api/projects/${projectAId}/repository`).send({
        installationId: '12345678',
        repoId: 1001,
        repoOwner: 'acme-corp',
        repoName: 'backend-core',
        fullName: 'acme-corp/backend-core',
        repoUrl: 'https://github.com/acme-corp/backend-core',
        defaultBranch: 'main',
      });

      expect(res.status).toBe(201);
      expect(res.body.projectId).toBe(projectAId);
      expect(res.body.fullName).toBe('acme-corp/backend-core');
      expect(res.body.defaultBranch).toBe('main');
      expect(res.body.installation.accountLogin).toBe('acme-corp');
    });

    it('handles updating or re-linking repository safely without duplicates', async () => {
      const res = await request(appA).post(`/api/projects/${projectAId}/repository`).send({
        installationId: '12345678',
        repoId: 1001,
        repoOwner: 'acme-corp',
        repoName: 'backend-core',
        fullName: 'acme-corp/backend-core',
        repoUrl: 'https://github.com/acme-corp/backend-core',
        defaultBranch: 'release-2.0',
      });

      expect(res.status).toBe(201);
      expect(res.body.defaultBranch).toBe('release-2.0');

      // Check DB has exactly 1 linked repo record for projectA
      const count = await prisma.projectRepository.count({
        where: { projectId: projectAId },
      });
      expect(count).toBe(1);
    });

    it('retrieves the linked repository for an owned project', async () => {
      const res = await request(appA).get(`/api/projects/${projectAId}/repository`);
      expect(res.status).toBe(200);
      expect(res.body.projectId).toBe(projectAId);
      expect(res.body.fullName).toBe('acme-corp/backend-core');
    });

    it('prevents User B from viewing User A linked repository', async () => {
      const res = await request(appB).get(`/api/projects/${projectAId}/repository`);
      expect(res.status).toBe(404);
    });

    it('prevents User B from unlinking User A repository', async () => {
      const res = await request(appB).delete(`/api/projects/${projectAId}/repository`);
      expect(res.status).toBe(404);

      // Verify still linked
      const verify = await request(appA).get(`/api/projects/${projectAId}/repository`);
      expect(verify.status).toBe(200);
    });

    it('unlinks the repository successfully for the owner', async () => {
      const res = await request(appA).delete(`/api/projects/${projectAId}/repository`);
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/unlinked successfully/i);

      // Subsequent get returns 404
      const verify = await request(appA).get(`/api/projects/${projectAId}/repository`);
      expect(verify.status).toBe(404);
    });

    it('allows User B to link their authorized repository to their own project', async () => {
      const res = await request(appB).post(`/api/projects/${projectBId}/repository`).send({
        installationId: '87654321',
        repoId: 2001,
        repoOwner: 'user-b-personal',
        repoName: 'user-b-repo',
        fullName: 'user-b-personal/user-b-repo',
        repoUrl: 'https://github.com/user-b-personal/user-b-repo',
      });

      expect(res.status).toBe(201);
      expect(res.body.projectId).toBe(projectBId);
      expect(res.body.fullName).toBe('user-b-personal/user-b-repo');
    });
  });
});
