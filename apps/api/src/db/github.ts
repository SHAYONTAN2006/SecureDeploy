import { prisma } from '../lib/prisma.js';

export interface UpsertInstallationData {
  installationId: bigint;
  accountLogin: string;
  accountId: bigint;
  accountType?: string;
  targetType?: string | null;
  repositorySelection?: string | null;
  userId: string;
}

export interface LinkProjectRepositoryData {
  projectId: string;
  installationId: string;
  repoId: bigint;
  repoOwner: string;
  repoName: string;
  fullName: string;
  repoUrl: string;
  defaultBranch?: string;
}

/**
 * Upserts a GitHub installation for a user.
 */
export async function upsertInstallation(data: UpsertInstallationData) {
  return prisma.githubInstallation.upsert({
    where: {
      installationId_userId: {
        installationId: data.installationId,
        userId: data.userId,
      },
    },
    update: {
      accountLogin: data.accountLogin,
      accountId: data.accountId,
      accountType: data.accountType || 'User',
      targetType: data.targetType,
      repositorySelection: data.repositorySelection || 'all',
    },
    create: {
      installationId: data.installationId,
      accountLogin: data.accountLogin,
      accountId: data.accountId,
      accountType: data.accountType || 'User',
      targetType: data.targetType,
      repositorySelection: data.repositorySelection || 'all',
      userId: data.userId,
    },
  });
}

/**
 * Finds an installation by its database UUID scoped to the user.
 */
export async function findInstallationById(id: string, userId: string) {
  return prisma.githubInstallation.findFirst({
    where: {
      id,
      userId,
    },
  });
}

/**
 * Finds an installation by its GitHub installation ID scoped to the user.
 */
export async function findInstallationByInstallationId(installationId: bigint, userId: string) {
  return prisma.githubInstallation.findUnique({
    where: {
      installationId_userId: {
        installationId,
        userId,
      },
    },
  });
}

/**
 * Finds an installation by its GitHub installation ID across all users.
 */
export async function findInstallationByInstallationIdOnly(installationId: bigint) {
  return prisma.githubInstallation.findFirst({
    where: { installationId },
  });
}

/**
 * Finds all installations connected to a user.
 */
export async function findInstallationsByUserId(userId: string) {
  return prisma.githubInstallation.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Deletes an installation owned by the user.
 */
export async function deleteInstallation(id: string, userId: string) {
  const result = await prisma.githubInstallation.deleteMany({
    where: {
      id,
      userId,
    },
  });
  return result.count > 0;
}

/**
 * Links or updates a project's associated GitHub repository.
 */
export async function linkProjectRepository(data: LinkProjectRepositoryData) {
  return prisma.projectRepository.upsert({
    where: {
      projectId: data.projectId,
    },
    update: {
      installationId: data.installationId,
      repoId: data.repoId,
      repoOwner: data.repoOwner,
      repoName: data.repoName,
      fullName: data.fullName,
      repoUrl: data.repoUrl,
      defaultBranch: data.defaultBranch || 'main',
    },
    create: {
      projectId: data.projectId,
      installationId: data.installationId,
      repoId: data.repoId,
      repoOwner: data.repoOwner,
      repoName: data.repoName,
      fullName: data.fullName,
      repoUrl: data.repoUrl,
      defaultBranch: data.defaultBranch || 'main',
    },
    include: {
      installation: true,
    },
  });
}

/**
 * Finds a project's linked repository.
 */
export async function findProjectRepositoryByProjectId(projectId: string) {
  return prisma.projectRepository.findUnique({
    where: { projectId },
    include: {
      installation: true,
    },
  });
}

/**
 * Unlinks a project's repository.
 */
export async function deleteProjectRepository(projectId: string) {
  const result = await prisma.projectRepository.deleteMany({
    where: { projectId },
  });
  return result.count > 0;
}
