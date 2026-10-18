import { describe, it, expect, afterAll } from 'vitest';
import {
  prisma,
  createUser,
  createProject,
  findProjectById,
  findUserById,
  deleteUser,
} from './index.js';

describe('Database Integration — User & Project Relations', () => {
  const testEmail = `test-user-${Date.now()}@securedeploy.local`;
  let createdUserId: string | null = null;

  afterAll(async () => {
    // Clean up test data safely
    if (createdUserId) {
      try {
        await deleteUser(createdUserId);
      } catch {
        // Ignore if already deleted in test
      }
    }
    await prisma.$disconnect();
  });

  it('should persist a User and retrieve it with correct UUID and timestamps', async () => {
    const user = await createUser({
      email: testEmail,
      name: 'Integration Test User',
    });

    createdUserId = user.id;

    expect(user.id).toBeDefined();
    expect(user.email).toBe(testEmail);
    expect(user.name).toBe('Integration Test User');
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);

    const fetchedUser = await findUserById(user.id);
    expect(fetchedUser).not.toBeNull();
    expect(fetchedUser?.email).toBe(testEmail);
    expect(fetchedUser?.projects).toEqual([]);
  });

  it('should persist a related Project and retrieve it with owner relation', async () => {
    expect(createdUserId).not.toBeNull();

    const project = await createProject({
      name: 'SecureDeploy Core Platform',
      description: 'Automated CI/CD security gating and AWS deployment',
      ownerId: createdUserId!,
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe('SecureDeploy Core Platform');
    expect(project.ownerId).toBe(createdUserId);

    const fetchedProject = await findProjectById(project.id);
    expect(fetchedProject).not.toBeNull();
    expect(fetchedProject?.owner.id).toBe(createdUserId);
    expect(fetchedProject?.owner.email).toBe(testEmail);
  });

  it('should enforce cascade deletion when owner User is deleted', async () => {
    expect(createdUserId).not.toBeNull();

    // Verify user and projects exist prior to deletion
    const userWithProjects = await findUserById(createdUserId!);
    expect(userWithProjects?.projects.length).toBe(1);
    const projectId = userWithProjects!.projects[0].id;

    // Delete user
    await deleteUser(createdUserId!);
    createdUserId = null; // Mark as cleaned up

    // Verify project was cascade deleted
    const orphanedProject = await findProjectById(projectId);
    expect(orphanedProject).toBeNull();
  });
});
