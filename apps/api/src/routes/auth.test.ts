import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma, deleteUser } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { validateSecurityConfig } from '../config/security.js';

describe('Authentication and Authorization System (/api/auth)', () => {
  const testRunId = Date.now();
  const createdUserIds: string[] = [];

  // App instance with CSRF disabled for auth and session logic tests
  const app = createApp({ enableCsrf: false });

  afterAll(async () => {
    for (const id of createdUserIds) {
      try {
        await deleteUser(id);
      } catch {
        // Ignore if already deleted
      }
    }
    await prisma.$disconnect();
  });

  describe('Password Hashing & Verification (Argon2id)', () => {
    it('hashes passwords using Argon2id format and verifies correctly', async () => {
      const plaintext = 'SuperSecretP@ssw0rd!123';
      const hash = await hashPassword(plaintext);

      expect(hash).toMatch(/^\$argon2id\$/);

      const isMatch = await verifyPassword(plaintext, hash);
      expect(isMatch).toBe(true);

      const isWrongMatch = await verifyPassword('WrongPassword!123', hash);
      expect(isWrongMatch).toBe(false);
    });
  });

  describe('User Registration (POST /api/auth/register)', () => {
    const validEmail = `register-test-${testRunId}@securedeploy.local`;

    it('successfully registers a new user with hashed password and establishes session', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: validEmail,
        password: 'Password123!',
        name: 'Registration Test User',
      });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('user');
      expect(res.body.user.email).toBe(validEmail);
      expect(res.body.user.name).toBe('Registration Test User');
      expect(res.body.user).not.toHaveProperty('password');
      expect(res.body.user).not.toHaveProperty('passwordHash');

      createdUserIds.push(res.body.user.id);

      // Verify password was stored hashed in PostgreSQL
      const dbUser = await prisma.user.findUnique({ where: { id: res.body.user.id } });
      expect(dbUser?.passwordHash).toMatch(/^\$argon2id\$/);

      // Verify session cookie was issued
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some((c: string) => c.includes('securedeploy.sid'))).toBe(true);
    });

    it('returns 409 Conflict when registering with duplicate email', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: validEmail,
        password: 'AnotherPassword123!',
      });

      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty('error', 'Conflict');
      expect(res.body.message).toMatch(/already exists/i);
    });

    it('rejects invalid email and weak passwords with 400 Validation Error', async () => {
      const invalidEmailRes = await request(app).post('/api/auth/register').send({
        email: 'not-an-email',
        password: 'Password123!',
      });
      expect(invalidEmailRes.status).toBe(400);

      const shortPasswordRes = await request(app)
        .post('/api/auth/register')
        .send({
          email: `short-pass-${testRunId}@securedeploy.local`,
          password: 'short',
        });
      expect(shortPasswordRes.status).toBe(400);
      expect(shortPasswordRes.body.message).toMatch(/at least 8 characters/i);
    });
  });

  describe('User Login (POST /api/auth/login)', () => {
    const userEmail = `login-test-${testRunId}@securedeploy.local`;
    const userPassword = 'CorrectPassword123!';

    beforeAll(async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: userEmail,
        password: userPassword,
        name: 'Login Test User',
      });
      createdUserIds.push(res.body.user.id);
    });

    it('returns 401 with generic error for nonexistent email', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: `nonexistent-${testRunId}@securedeploy.local`,
          password: userPassword,
        });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error', 'Unauthorized');
      expect(res.body.message).toBe('Invalid email or password.');
    });

    it('returns 401 with generic error for incorrect password', async () => {
      const res = await request(app).post('/api/auth/login').send({
        email: userEmail,
        password: 'WrongPassword999!',
      });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error', 'Unauthorized');
      expect(res.body.message).toBe('Invalid email or password.');
    });

    it('successfully logs in with valid credentials, issuing session cookie', async () => {
      const res = await request(app).post('/api/auth/login').send({
        email: userEmail,
        password: userPassword,
      });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(userEmail);
      expect(res.headers['set-cookie']).toBeDefined();
    });
  });

  describe('Session Persistence & Current User (GET /api/auth/me)', () => {
    const sessionEmail = `session-test-${testRunId}@securedeploy.local`;
    const sessionPassword = 'SessionPassword123!';

    it('persists session across requests using session agent and rejects unauthenticated access', async () => {
      const unauthRes = await request(app).get('/api/auth/me');
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.body.message).toMatch(/authentication required/i);

      // Authenticated session agent
      const agent = request.agent(app);

      // Register and establish session
      const registerRes = await agent.post('/api/auth/register').send({
        email: sessionEmail,
        password: sessionPassword,
        name: 'Session User',
      });
      expect(registerRes.status).toBe(201);
      createdUserIds.push(registerRes.body.user.id);

      // Subsequent request with agent automatically transmits session cookie
      const meRes = await agent.get('/api/auth/me');
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.email).toBe(sessionEmail);
      expect(meRes.body.user.name).toBe('Session User');
    });
  });

  describe('Logout & Session Invalidation (POST /api/auth/logout)', () => {
    const logoutEmail = `logout-test-${testRunId}@securedeploy.local`;
    const logoutPassword = 'LogoutPassword123!';

    it('invalidates session on logout so subsequent requests are rejected', async () => {
      const agent = request.agent(app);

      const regRes = await agent.post('/api/auth/register').send({
        email: logoutEmail,
        password: logoutPassword,
      });
      createdUserIds.push(regRes.body.user.id);

      // Confirm logged in
      const beforeLogout = await agent.get('/api/auth/me');
      expect(beforeLogout.status).toBe(200);

      // Logout
      const logoutRes = await agent.post('/api/auth/logout');
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.message).toMatch(/logged out successfully/i);

      // After logout, session is terminated
      const afterLogout = await agent.get('/api/auth/me');
      expect(afterLogout.status).toBe(401);
    });
  });

  describe('Authenticated Project Ownership Isolation', () => {
    const userAEmail = `project-owner-a-${testRunId}@securedeploy.local`;
    const userBEmail = `project-owner-b-${testRunId}@securedeploy.local`;
    const password = 'ProjectPassword123!';

    it('derives project ownership from session user and enforces cross-user isolation', async () => {
      const agentA = request.agent(app);
      const agentB = request.agent(app);

      // Register User A
      const regA = await agentA.post('/api/auth/register').send({
        email: userAEmail,
        password,
        name: 'User A',
      });
      createdUserIds.push(regA.body.user.id);

      // Register User B
      const regB = await agentB.post('/api/auth/register').send({
        email: userBEmail,
        password,
        name: 'User B',
      });
      createdUserIds.push(regB.body.user.id);

      // User A creates project
      const projARes = await agentA.post('/api/projects').send({
        name: 'User A Isolated Project',
        description: 'Owner A exclusive',
      });
      expect(projARes.status).toBe(201);
      expect(projARes.body.ownerId).toBe(regA.body.user.id);

      // User B creates project
      const projBRes = await agentB.post('/api/projects').send({
        name: 'User B Isolated Project',
      });
      expect(projBRes.status).toBe(201);
      expect(projBRes.body.ownerId).toBe(regB.body.user.id);

      // User A lists projects: only sees their own
      const listA = await agentA.get('/api/projects');
      const namesA = listA.body.map((p: { name: string }) => p.name);
      expect(namesA).toContain('User A Isolated Project');
      expect(namesA).not.toContain('User B Isolated Project');

      // User B attempts to access User A project -> returns 404
      const crossGet = await agentB.get(`/api/projects/${projARes.body.id}`);
      expect(crossGet.status).toBe(404);

      // User B attempts to delete User A project -> returns 404
      const crossDelete = await agentB.delete(`/api/projects/${projARes.body.id}`);
      expect(crossDelete.status).toBe(404);

      // Unauthenticated request to projects -> returns 401
      const unauthProjectRes = await request(app).get('/api/projects');
      expect(unauthProjectRes.status).toBe(401);
    });
  });

  describe('CSRF Protection for State-Changing Requests', () => {
    const csrfApp = createApp({ enableCsrf: true });

    it('rejects state-changing request missing CSRF token with 403 Forbidden', async () => {
      const res = await request(csrfApp)
        .post('/api/auth/register')
        .send({
          email: `no-csrf-${testRunId}@securedeploy.local`,
          password: 'Password123!',
        });

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty('error', 'Forbidden');
      expect(res.body.message).toMatch(/invalid or missing csrf token/i);
    });

    it('accepts state-changing request when valid CSRF token and cookie are provided', async () => {
      const agent = request.agent(csrfApp);

      // Step 1: Request CSRF token
      const tokenRes = await agent.get('/api/auth/csrf-token');
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body).toHaveProperty('csrfToken');
      const csrfToken = tokenRes.body.csrfToken;

      // Step 2: Perform state-changing request including the token header
      const registerRes = await agent
        .post('/api/auth/register')
        .set('x-csrf-token', csrfToken)
        .send({
          email: `csrf-success-${testRunId}@securedeploy.local`,
          password: 'Password123!',
          name: 'CSRF Validated User',
        });

      expect(registerRes.status).toBe(201);
      createdUserIds.push(registerRes.body.user.id);
    });
  });

  describe('Production Configuration Fail-Closed Verification', () => {
    it('throws error in production when SESSION_SECRET is missing or insecure', () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.SESSION_SECRET;
      const originalCors = process.env.CORS_ORIGIN;

      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGIN = 'https://app.securedeploy.io';

      try {
        // Missing or default secret
        process.env.SESSION_SECRET = 'dev-insecure-secret';
        expect(() => validateSecurityConfig()).toThrow(/SESSION_SECRET/i);

        // Too short secret
        process.env.SESSION_SECRET = 'short';
        expect(() => validateSecurityConfig()).toThrow(/SESSION_SECRET/i);
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.SESSION_SECRET = originalSecret;
        process.env.CORS_ORIGIN = originalCors;
      }
    });

    it('throws error in production when CORS_ORIGIN is wildcard or missing', () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.SESSION_SECRET;
      const originalCors = process.env.CORS_ORIGIN;

      process.env.NODE_ENV = 'production';
      process.env.SESSION_SECRET = 'a-valid-production-secret-with-plenty-of-characters-123456';

      try {
        process.env.CORS_ORIGIN = '*';
        expect(() => validateSecurityConfig()).toThrow(/CORS_ORIGIN/i);

        process.env.CORS_ORIGIN = '';
        expect(() => validateSecurityConfig()).toThrow(/CORS_ORIGIN/i);
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.SESSION_SECRET = originalSecret;
        process.env.CORS_ORIGIN = originalCors;
      }
    });
  });
});
