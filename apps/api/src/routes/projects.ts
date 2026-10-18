import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  createProjectSchema,
  updateProjectSchema,
  uuidParamSchema,
} from '../validation/projects.js';
import { linkRepositorySchema } from '../validation/github.js';
import { requireAuth } from '../middleware/auth.js';
import * as projectsService from '../services/projects.service.js';
import * as projectsDb from '../db/projects.js';
import * as githubDb from '../db/github.js';
import { getGithubService } from '../services/github.service.js';

function isUuid(str: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
}

export const projectsRouter = Router();

// Protect all project routes with requireAuth
projectsRouter.use(requireAuth);

// POST /api/projects - Create a project
projectsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = createProjectSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid request body',
        details: parseResult.error.errors,
      });
      return;
    }

    const project = await projectsService.createProjectForOwner(req.user!.id, parseResult.data);

    res.status(201).json(project);
  } catch (error) {
    next(error);
  }
});

// GET /api/projects - List owner's projects
projectsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projects = await projectsService.listProjectsForOwner(req.user!.id);
    res.status(200).json(projects);
  } catch (error) {
    next(error);
  }
});

// GET /api/projects/:id - Get a project
projectsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParse = uuidParamSchema.safeParse(req.params.id);
    if (!idParse.success) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid project ID format (UUID expected)',
      });
      return;
    }

    const project = await projectsService.getProjectForOwner(idParse.data, req.user!.id);
    if (!project) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Project not found',
      });
      return;
    }

    res.status(200).json(project);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/projects/:id - Update a project
projectsRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParse = uuidParamSchema.safeParse(req.params.id);
    if (!idParse.success) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid project ID format (UUID expected)',
      });
      return;
    }

    // Explicitly reject forbidden attempts to override system fields
    if (
      'ownerId' in req.body ||
      'id' in req.body ||
      'createdAt' in req.body ||
      'updatedAt' in req.body
    ) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'System fields (id, ownerId, createdAt, updatedAt) cannot be modified',
      });
      return;
    }

    const parseResult = updateProjectSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid request body',
        details: parseResult.error.errors,
      });
      return;
    }

    const updated = await projectsService.updateProjectForOwner(
      idParse.data,
      req.user!.id,
      parseResult.data
    );

    if (!updated) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Project not found',
      });
      return;
    }

    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/projects/:id - Delete a project
projectsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParse = uuidParamSchema.safeParse(req.params.id);
    if (!idParse.success) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid project ID format (UUID expected)',
      });
      return;
    }

    const deleted = await projectsService.deleteProjectForOwner(idParse.data, req.user!.id);

    if (!deleted) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Project not found',
      });
      return;
    }

    res.status(200).json({
      message: 'Project deleted successfully',
      id: idParse.data,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/projects/:projectId/repository - Associate a repository with an owned project
projectsRouter.post(
  '/:projectId/repository',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectParam = uuidParamSchema.safeParse(req.params.projectId);
      if (!projectParam.success) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid project ID format (UUID expected)',
        });
        return;
      }

      // Verify that project exists and belongs to the caller
      const project = await projectsDb.findProjectByIdAndOwner(projectParam.data, req.user!.id);
      if (!project) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Project not found or unauthorized.',
        });
        return;
      }

      // Validate body
      const parseResult = linkRepositorySchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message || 'Invalid repository association data',
          details: parseResult.error.errors,
        });
        return;
      }

      const input = parseResult.data;

      // Verify that the specified installation belongs to the authenticated user
      let installation = null;
      if (isUuid(input.installationId)) {
        installation = await githubDb.findInstallationById(input.installationId, req.user!.id);
      } else if (/^\d+$/.test(input.installationId)) {
        installation = await githubDb.findInstallationByInstallationId(
          BigInt(input.installationId),
          req.user!.id
        );
      }

      if (!installation) {
        res.status(404).json({
          error: 'Not Found',
          message: 'GitHub installation not found or unauthorized for your account.',
        });
        return;
      }

      // Cryptographically / server-side verify that the repository is accessible to this installation
      // Never trust client-supplied repoUrl or ID alone
      const githubService = getGithubService();
      try {
        const remoteRepo = await githubService.getRepository(
          Number(installation.installationId),
          input.repoOwner,
          input.repoName
        );

        if (remoteRepo.id !== input.repoId) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'Repository ID does not match remote GitHub repository ID.',
          });
          return;
        }
      } catch {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Repository is not accessible through the specified GitHub installation.',
        });
        return;
      }

      // Link repository to project in PostgreSQL
      const linkedRepo = await githubDb.linkProjectRepository({
        projectId: project.id,
        installationId: installation.id,
        repoId: BigInt(input.repoId),
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        fullName: input.fullName,
        repoUrl: input.repoUrl,
        defaultBranch: input.defaultBranch,
      });

      res.status(201).json({
        id: linkedRepo.id,
        projectId: linkedRepo.projectId,
        repoId: linkedRepo.repoId.toString(),
        repoOwner: linkedRepo.repoOwner,
        repoName: linkedRepo.repoName,
        fullName: linkedRepo.fullName,
        repoUrl: linkedRepo.repoUrl,
        defaultBranch: linkedRepo.defaultBranch,
        installation: {
          id: installation.id,
          accountLogin: installation.accountLogin,
        },
        createdAt: linkedRepo.createdAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/projects/:projectId/repository - Retrieve linked repository
projectsRouter.get(
  '/:projectId/repository',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectParam = uuidParamSchema.safeParse(req.params.projectId);
      if (!projectParam.success) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid project ID format (UUID expected)',
        });
        return;
      }

      // Verify project ownership
      const project = await projectsDb.findProjectByIdAndOwner(projectParam.data, req.user!.id);
      if (!project) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Project not found or unauthorized.',
        });
        return;
      }

      const linkedRepo = await githubDb.findProjectRepositoryByProjectId(project.id);
      if (!linkedRepo) {
        res.status(404).json({
          error: 'Not Found',
          message: 'No repository linked to this project.',
        });
        return;
      }

      res.status(200).json({
        id: linkedRepo.id,
        projectId: linkedRepo.projectId,
        repoId: linkedRepo.repoId.toString(),
        repoOwner: linkedRepo.repoOwner,
        repoName: linkedRepo.repoName,
        fullName: linkedRepo.fullName,
        repoUrl: linkedRepo.repoUrl,
        defaultBranch: linkedRepo.defaultBranch,
        installation: {
          id: linkedRepo.installation.id,
          accountLogin: linkedRepo.installation.accountLogin,
        },
        createdAt: linkedRepo.createdAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/projects/:projectId/repository - Unlink repository
projectsRouter.delete(
  '/:projectId/repository',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectParam = uuidParamSchema.safeParse(req.params.projectId);
      if (!projectParam.success) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid project ID format (UUID expected)',
        });
        return;
      }

      // Verify project ownership
      const project = await projectsDb.findProjectByIdAndOwner(projectParam.data, req.user!.id);
      if (!project) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Project not found or unauthorized.',
        });
        return;
      }

      const unlinked = await githubDb.deleteProjectRepository(project.id);
      if (!unlinked) {
        res.status(404).json({
          error: 'Not Found',
          message: 'No repository was linked to this project.',
        });
        return;
      }

      res.status(200).json({
        message: 'Repository unlinked successfully.',
        projectId: project.id,
      });
    } catch (error) {
      next(error);
    }
  }
);
