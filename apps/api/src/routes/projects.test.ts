import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, createApp } from '../app.js';
import { prisma, createUser, deleteUser } from '../db/index.js';
import { createTestIdentityMiddleware, type AuthUser } from '../middleware/identity.js';

describe('Project Management API (/api/projects)', () => {
  let userA: AuthUser;
  let userB: AuthUser;
  let appA: ReturnType<typeof createApp>;
  let appB: ReturnType<typeof createApp>;

  const createdUserIds: string[] = [];
  const testRunId = Date.now();

  beforeAll(async () => {
    // Create two isolated test users for cross-tenant ownership testing
    const dbUserA = await createUser({
      email: `test-owner-a-${testRunId}@securedeploy.local`,
      name: 'Owner A',
    });
    const dbUserB = await createUser({
      email: `test-owner-b-${testRunId}@securedeploy.local`,
      name: 'Owner B',
    });

    userA = { id: dbUserA.id, email: dbUserA.email, name: dbUserA.name };
    userB = { id: dbUserB.id, email: dbUserB.email, name: dbUserB.name };
    createdUserIds.push(userA.id, userB.id);

    appA = createApp({ identityMiddleware: createTestIdentityMiddleware(userA) });
    appB = createApp({ identityMiddleware: createTestIdentityMiddleware(userB) });
  });

  afterAll(async () => {
    // Clean up created test users (cascade deletes their projects)
    for (const userId of createdUserIds) {
      try {
        await deleteUser(userId);
      } catch {
        // Ignore if already deleted
      }
    }
    await prisma.$disconnect();
  });

  describe('GET /api/health (Baseline Check)', () => {
    it('continues to return 200 OK with expected health response contract', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('service', 'securedeploy-api');
    });
  });

  describe('POST /api/projects', () => {
    it('creates a project successfully for the authenticated identity', async () => {
      const response = await request(appA).post('/api/projects').send({
        name: 'Core Payment Gateway',
        description: 'Payment microservice pipeline',
      });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body.name).toBe('Core Payment Gateway');
      expect(response.body.description).toBe('Payment microservice pipeline');
      expect(response.body.ownerId).toBe(userA.id);
      expect(response.body).toHaveProperty('createdAt');
      expect(response.body).toHaveProperty('updatedAt');
    });

    it('rejects creation when name is missing', async () => {
      const response = await request(appA).post('/api/projects').send({
        description: 'No name supplied',
      });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Validation Error');
      expect(response.body.message).toMatch(/name/i);
    });

    it('rejects creation when name is empty or only whitespace', async () => {
      const response = await request(appA).post('/api/projects').send({
        name: '   ',
      });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Validation Error');
    });

    it('rejects creation when name exceeds maximum length (100 chars)', async () => {
      const response = await request(appA)
        .post('/api/projects')
        .send({
          name: 'A'.repeat(101),
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Validation Error');
    });

    it('never trusts client-supplied ownerId and sets owner from server-side identity', async () => {
      const spoofedOwnerId = '00000000-0000-0000-0000-000000000000';
      const response = await request(appA).post('/api/projects').send({
        name: 'Spoof Test Project',
        ownerId: spoofedOwnerId,
      });

      expect(response.status).toBe(201);
      expect(response.body.ownerId).toBe(userA.id);
      expect(response.body.ownerId).not.toBe(spoofedOwnerId);
    });
  });

  describe('GET /api/projects', () => {
    it('returns only projects belonging to the current identity (owner-scoped listing)', async () => {
      // Create a project for user A
      const resA = await request(appA).post('/api/projects').send({
        name: 'User A Secret Project',
      });
      expect(resA.status).toBe(201);

      // Create a project for user B
      const resB = await request(appB).post('/api/projects').send({
        name: 'User B Public Project',
      });
      expect(resB.status).toBe(201);

      // User A lists projects
      const listA = await request(appA).get('/api/projects');
      expect(listA.status).toBe(200);
      expect(Array.isArray(listA.body)).toBe(true);
      const namesA = listA.body.map((p: { name: string }) => p.name);
      expect(namesA).toContain('User A Secret Project');
      expect(namesA).not.toContain('User B Public Project');

      // User B lists projects
      const listB = await request(appB).get('/api/projects');
      expect(listB.status).toBe(200);
      expect(Array.isArray(listB.body)).toBe(true);
      const namesB = listB.body.map((p: { name: string }) => p.name);
      expect(namesB).toContain('User B Public Project');
      expect(namesB).not.toContain('User A Secret Project');
    });
  });

  describe('GET /api/projects/:id', () => {
    it('rejects invalid UUID parameter with 400 Bad Request', async () => {
      const response = await request(appA).get('/api/projects/not-a-valid-uuid');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Bad Request');
      expect(response.body.message).toMatch(/uuid/i);
    });

    it('returns 404 for nonexistent UUID', async () => {
      const nonExistentUuid = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
      const response = await request(appA).get(`/api/projects/${nonExistentUuid}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Not Found');
    });

    it('retrieves an existing project owned by the current identity', async () => {
      const created = await request(appA).post('/api/projects').send({
        name: 'Analytics Pipeline',
        description: 'Streaming clickstream processing',
      });

      const response = await request(appA).get(`/api/projects/${created.body.id}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
      expect(response.body.name).toBe('Analytics Pipeline');
      expect(response.body.description).toBe('Streaming clickstream processing');
    });

    it('returns 404 when attempting to get another owner project (cross-tenant protection)', async () => {
      const createdByA = await request(appA).post('/api/projects').send({
        name: 'Owner A Confidential Vault',
      });

      // User B attempts to read User A's project
      const response = await request(appB).get(`/api/projects/${createdByA.body.id}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Not Found');
    });
  });

  describe('PATCH /api/projects/:id', () => {
    it('rejects invalid UUID parameter with 400 Bad Request', async () => {
      const response = await request(appA)
        .patch('/api/projects/invalid-uuid')
        .send({ name: 'New Name' });

      expect(response.status).toBe(400);
    });

    it('returns 404 for nonexistent UUID', async () => {
      const nonExistentUuid = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
      const response = await request(appA)
        .patch(`/api/projects/${nonExistentUuid}`)
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
    });

    it('rejects empty update bodies with 400 Bad Request', async () => {
      const created = await request(appA).post('/api/projects').send({
        name: 'Target Project',
      });

      const response = await request(appA).patch(`/api/projects/${created.body.id}`).send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Validation Error');
    });

    it('rejects attempts to modify system fields (ownerId, id)', async () => {
      const created = await request(appA).post('/api/projects').send({
        name: 'Immutable Owner Test',
      });

      const response = await request(appA).patch(`/api/projects/${created.body.id}`).send({
        name: 'Valid Name',
        ownerId: userB.id,
      });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/system fields/i);
    });

    it('successfully updates name and description', async () => {
      const created = await request(appA).post('/api/projects').send({
        name: 'Original Title',
        description: 'Original Desc',
      });

      const response = await request(appA).patch(`/api/projects/${created.body.id}`).send({
        name: 'Updated Title',
        description: 'Updated Desc',
      });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated Title');
      expect(response.body.description).toBe('Updated Desc');
    });

    it('returns 404 and prevents User B from updating User A project', async () => {
      const createdByA = await request(appA).post('/api/projects').send({
        name: 'Owner A Protected Name',
      });

      // User B attempts to PATCH User A's project
      const response = await request(appB).patch(`/api/projects/${createdByA.body.id}`).send({
        name: 'Hacked by User B',
      });

      expect(response.status).toBe(404);

      // Verify User A's project was untouched
      const verify = await request(appA).get(`/api/projects/${createdByA.body.id}`);
      expect(verify.body.name).toBe('Owner A Protected Name');
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('rejects invalid UUID parameter with 400 Bad Request', async () => {
      const response = await request(appA).delete('/api/projects/not-valid');
      expect(response.status).toBe(400);
    });

    it('returns 404 for nonexistent UUID', async () => {
      const nonExistentUuid = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
      const response = await request(appA).delete(`/api/projects/${nonExistentUuid}`);
      expect(response.status).toBe(404);
    });

    it('returns 404 and prevents User B from deleting User A project', async () => {
      const createdByA = await request(appA).post('/api/projects').send({
        name: 'Owner A Indelible Project',
      });

      // User B attempts to DELETE User A's project
      const response = await request(appB).delete(`/api/projects/${createdByA.body.id}`);
      expect(response.status).toBe(404);

      // Verify it still exists for User A
      const verify = await request(appA).get(`/api/projects/${createdByA.body.id}`);
      expect(verify.status).toBe(200);
    });

    it('deletes an owned project successfully and returns consistent success message', async () => {
      const created = await request(appA).post('/api/projects').send({
        name: 'To Be Deleted',
      });

      const response = await request(appA).delete(`/api/projects/${created.body.id}`);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'Project deleted successfully');
      expect(response.body).toHaveProperty('id', created.body.id);

      // Confirm 404 on subsequent get
      const verify = await request(appA).get(`/api/projects/${created.body.id}`);
      expect(verify.status).toBe(404);
    });
  });

  describe('Production Identity Security Guardrail', () => {
    it('fails closed and returns 401 Unauthorized when NODE_ENV is production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        // App using default requireIdentity middleware
        const prodApp = createApp();
        const response = await request(prodApp).get('/api/projects');

        expect(response.status).toBe(401);
        expect(response.body).toHaveProperty('error', 'Unauthorized');
        expect(response.body.message).toMatch(/development identity is disabled/i);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});
