import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export interface CreatePipelineRunData {
  projectId: string;
  projectRepositoryId?: string | null;
  triggeredById: string;
  workflowFile: string;
  gitRef: string;
  commitSha?: string | null;
  status?: string;
  errorMessage?: string | null;
  githubRunId?: bigint | null;
  githubRunNumber?: number | null;
  githubRunAttempt?: number | null;
  htmlUrl?: string | null;
  conclusion?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface UpdatePipelineRunData {
  status?: string;
  conclusion?: string | null;
  githubRunId?: bigint | null;
  githubRunNumber?: number | null;
  githubRunAttempt?: number | null;
  htmlUrl?: string | null;
  commitSha?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  errorMessage?: string | null;
}

/**
 * Creates a new pipeline run record (typically in PENDING_DISPATCH or DISPATCHED status).
 */
export async function createPipelineRun(data: CreatePipelineRunData) {
  return prisma.pipelineRun.create({
    data: {
      projectId: data.projectId,
      projectRepositoryId: data.projectRepositoryId || undefined,
      triggeredById: data.triggeredById,
      workflowFile: data.workflowFile,
      gitRef: data.gitRef,
      commitSha: data.commitSha || null,
      status: data.status || 'PENDING_DISPATCH',
      errorMessage: data.errorMessage || null,
      githubRunId: data.githubRunId || null,
      githubRunNumber: data.githubRunNumber || null,
      githubRunAttempt: data.githubRunAttempt || 1,
      htmlUrl: data.htmlUrl || null,
      conclusion: data.conclusion || null,
      startedAt: data.startedAt || null,
      completedAt: data.completedAt || null,
    },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          ownerId: true,
        },
      },
      triggeredBy: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });
}

/**
 * Updates an existing pipeline run record.
 * Protects terminal states from being regressed by out-of-order webhooks.
 */
export async function updatePipelineRun(id: string, data: UpdatePipelineRunData) {
  const current = await prisma.pipelineRun.findUnique({
    where: { id },
  });

  if (!current) {
    return null;
  }

  // If this is a new run attempt (retry / rerun), allow transitioning from terminal status
  const isNewAttempt =
    typeof data.githubRunAttempt === 'number' &&
    typeof current.githubRunAttempt === 'number' &&
    data.githubRunAttempt > current.githubRunAttempt;

  // Prevent regressing completed or failed runs to earlier queued/in_progress states unless it's a new attempt
  const terminalStatuses = ['COMPLETED', 'FAILED'];
  if (
    !isNewAttempt &&
    terminalStatuses.includes(current.status) &&
    data.status &&
    !terminalStatuses.includes(data.status)
  ) {
    // If attempting to regress, keep the terminal status and existing conclusion
    delete data.status;
    delete data.conclusion;
  }

  return prisma.pipelineRun.update({
    where: { id },
    data: {
      status: data.status,
      conclusion: data.conclusion !== undefined ? data.conclusion : current.conclusion,
      githubRunId: data.githubRunId !== undefined ? data.githubRunId : current.githubRunId,
      githubRunNumber:
        data.githubRunNumber !== undefined ? data.githubRunNumber : current.githubRunNumber,
      githubRunAttempt:
        data.githubRunAttempt !== undefined ? data.githubRunAttempt : current.githubRunAttempt,
      htmlUrl: data.htmlUrl !== undefined ? data.htmlUrl : current.htmlUrl,
      commitSha: data.commitSha !== undefined ? data.commitSha : current.commitSha,
      startedAt: data.startedAt !== undefined ? data.startedAt : current.startedAt,
      completedAt: data.completedAt !== undefined ? data.completedAt : current.completedAt,
      errorMessage: data.errorMessage !== undefined ? data.errorMessage : current.errorMessage,
    },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          ownerId: true,
        },
      },
      triggeredBy: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });
}

/**
 * Finds a pipeline run by its UUID scoped to a project.
 */
export async function findPipelineRunById(id: string, projectId: string) {
  return prisma.pipelineRun.findFirst({
    where: {
      id,
      projectId,
    },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          ownerId: true,
        },
      },
      triggeredBy: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });
}

/**
 * Finds a pipeline run by GitHub run ID.
 */
export async function findPipelineRunByGithubRunId(githubRunId: bigint) {
  return prisma.pipelineRun.findUnique({
    where: {
      githubRunId,
    },
    include: {
      project: true,
      projectRepository: true,
    },
  });
}

/**
 * Finds the latest unconfirmed dispatched run for a repository to correlate with an incoming webhook.
 */
export async function findLatestDispatchedRunForCorrelation(
  projectRepositoryId: string,
  workflowFile: string,
  gitRef: string
) {
  // Normalize workflowFile (e.g., .github/workflows/deploy.yml or deploy.yml)
  const normalizedFile = workflowFile.replace(/^\.github\/workflows\//, '');
  const normalizedRef = gitRef.replace(/^refs\/heads\//, '');

  return prisma.pipelineRun.findFirst({
    where: {
      projectRepositoryId,
      githubRunId: null,
      status: { in: ['PENDING_DISPATCH', 'DISPATCHED', 'QUEUED'] },
      OR: [
        { workflowFile },
        { workflowFile: normalizedFile },
        { workflowFile: `.github/workflows/${normalizedFile}` },
      ],
      AND: {
        OR: [{ gitRef }, { gitRef: normalizedRef }, { gitRef: `refs/heads/${normalizedRef}` }],
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    include: {
      project: true,
      projectRepository: true,
    },
  });
}

export interface FindCandidatesParams {
  projectRepositoryId: string;
  workflowFile: string;
  gitRef: string;
  commitSha?: string | null;
  runCreatedAt?: Date | null;
}

/**
 * Finds all candidate unconfirmed dispatched runs matching workflow, ref, commit SHA, and time window.
 * Returns an array of candidates so callers can detect and reject ambiguous matches.
 */
export async function findCandidateDispatchedRuns(params: FindCandidatesParams) {
  const { projectRepositoryId, workflowFile, gitRef, commitSha, runCreatedAt } = params;
  const normalizedFile = workflowFile.replace(/^\.github\/workflows\//, '');
  const normalizedRef = gitRef.replace(/^refs\/heads\//, '');

  const andConditions: Prisma.PipelineRunWhereInput[] = [
    {
      OR: [{ gitRef }, { gitRef: normalizedRef }, { gitRef: `refs/heads/${normalizedRef}` }],
    },
  ];

  // If authoritative commit SHA is provided by GitHub, require an exact match
  if (commitSha) {
    andConditions.push({ commitSha });
  }

  // If GitHub run creation timestamp is available, enforce chronological ordering
  if (runCreatedAt) {
    const maxCreatedAt = new Date(runCreatedAt.getTime() + 15_000); // 15s clock skew allowance
    const minCreatedAt = new Date(runCreatedAt.getTime() - 30 * 60 * 1000); // 30 minute dispatch window
    andConditions.push({
      createdAt: {
        lte: maxCreatedAt,
        gte: minCreatedAt,
      },
    });
  }

  return prisma.pipelineRun.findMany({
    where: {
      projectRepositoryId,
      githubRunId: null,
      status: { in: ['PENDING_DISPATCH', 'DISPATCHED'] },
      OR: [
        { workflowFile },
        { workflowFile: normalizedFile },
        { workflowFile: `.github/workflows/${normalizedFile}` },
      ],
      AND: andConditions,
    },
    orderBy: {
      createdAt: 'asc', // oldest pending dispatch first
    },
    include: {
      project: true,
      projectRepository: true,
    },
  });
}

/**
 * Lists pipeline history for a project with pagination.
 */
export async function listPipelineRunsByProjectId(
  projectId: string,
  options: { page: number; perPage: number }
) {
  const { page, perPage } = options;
  const skip = (page - 1) * perPage;

  const [runs, totalCount] = await Promise.all([
    prisma.pipelineRun.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: perPage,
      include: {
        triggeredBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    }),
    prisma.pipelineRun.count({
      where: { projectId },
    }),
  ]);

  return {
    runs,
    totalCount,
    page,
    perPage,
    totalPages: Math.ceil(totalCount / perPage),
  };
}

/**
 * Checks if a webhook delivery has already been processed (for idempotency).
 */
export async function findWebhookDelivery(deliveryId: string) {
  return prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
  });
}

/**
 * Records a webhook delivery ID for idempotency.
 */
export async function recordWebhookDelivery(deliveryId: string, event: string, action?: string) {
  try {
    return await prisma.webhookDelivery.create({
      data: {
        id: deliveryId,
        event,
        action: action || null,
        statusCode: 200,
      },
    });
  } catch {
    // If unique constraint violation occurs (delivery already exists)
    return null;
  }
}
