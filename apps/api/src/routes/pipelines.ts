import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { isGithubAppConfigured } from '../config/github.js';
import { getGithubService } from '../services/github.service.js';
import * as projectsDb from '../db/projects.js';
import * as githubDb from '../db/github.js';
import {
  createPipelineRun,
  updatePipelineRun,
  findPipelineRunById,
  listPipelineRunsByProjectId,
} from '../db/pipelines.js';
import { findSecurityScansByPipelineRunId, recordSecurityScan } from '../db/scans.js';
import { parseAndNormalizeGitleaksReport } from '../services/gitleaks.service.js';
import {
  triggerPipelineSchema,
  pipelineListQuerySchema,
  pipelineIdParamSchema,
} from '../validation/pipelines.js';
import { uuidParamSchema } from '../validation/projects.js';

export const pipelinesRouter = Router({ mergeParams: true });

// Require authentication for all pipeline operations
pipelinesRouter.use(requireAuth);

// POST /api/projects/:projectId/pipelines - Trigger an approved GitHub Actions workflow
pipelinesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectParam = uuidParamSchema.safeParse(req.params.projectId);
    if (!projectParam.success) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid project ID format (UUID expected)',
      });
      return;
    }

    const projectId = projectParam.data;

    // Verify project ownership
    const project = await projectsDb.findProjectByIdAndOwner(projectId, req.user!.id);
    if (!project) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Project not found or unauthorized.',
      });
      return;
    }

    // Verify project has a linked repository
    const projectRepo = await githubDb.findProjectRepositoryByProjectId(project.id);
    if (!projectRepo) {
      res.status(400).json({
        error: 'Bad Request',
        message:
          'Project does not have a linked GitHub repository. Link a repository before triggering pipelines.',
      });
      return;
    }

    // Verify the installation belongs to the authenticated user
    if (projectRepo.installation.userId !== req.user!.id) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'The GitHub installation for this repository is not authorized for your account.',
      });
      return;
    }

    // Validate request body
    const parseResult = triggerPipelineSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid pipeline trigger parameters',
        details: parseResult.error.errors,
      });
      return;
    }

    if (!isGithubAppConfigured()) {
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'GitHub App is not configured on this server.',
      });
      return;
    }

    const { workflowFile, gitRef, inputs } = parseResult.data;
    const githubService = getGithubService();
    const installationIdNum = Number(projectRepo.installation.installationId);

    // Validate git ref against remote GitHub repository
    let refInfo;
    try {
      refInfo = await githubService.getRef(
        installationIdNum,
        projectRepo.repoOwner,
        projectRepo.repoName,
        gitRef
      );
    } catch {
      res.status(400).json({
        error: 'Bad Request',
        message: `Git ref "${gitRef}" does not exist in repository "${projectRepo.fullName}".`,
      });
      return;
    }

    // Validate workflow exists in remote GitHub repository
    try {
      await githubService.getWorkflow(
        installationIdNum,
        projectRepo.repoOwner,
        projectRepo.repoName,
        workflowFile
      );
    } catch {
      res.status(400).json({
        error: 'Bad Request',
        message: `Workflow "${workflowFile}" not found in repository "${projectRepo.fullName}".`,
      });
      return;
    }

    // Record initial dispatch attempt in database for auditability
    const pipeline = await createPipelineRun({
      projectId: project.id,
      projectRepositoryId: projectRepo.id,
      triggeredById: req.user!.id,
      workflowFile,
      gitRef: refInfo.ref,
      commitSha: refInfo.sha,
      status: 'PENDING_DISPATCH',
    });

    // Dispatch workflow via GitHub Actions workflow_dispatch API
    try {
      await githubService.dispatchWorkflow(
        installationIdNum,
        projectRepo.repoOwner,
        projectRepo.repoName,
        workflowFile,
        refInfo.ref,
        inputs
      );

      const updated = await updatePipelineRun(pipeline.id, {
        status: 'DISPATCHED',
      });

      res.status(202).json({
        message: 'Pipeline workflow dispatch requested successfully.',
        pipeline: updated,
      });
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : 'GitHub Actions workflow dispatch failed';

      await updatePipelineRun(pipeline.id, {
        status: 'FAILED',
        errorMessage: errorMsg,
      });

      res.status(502).json({
        error: 'Bad Gateway',
        message: `Failed to dispatch GitHub Actions workflow: ${errorMsg}`,
      });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/projects/:projectId/pipelines - List pipeline runs with pagination
pipelinesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectParam = uuidParamSchema.safeParse(req.params.projectId);
    if (!projectParam.success) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid project ID format (UUID expected)',
      });
      return;
    }

    const projectId = projectParam.data;

    // Verify project ownership
    const project = await projectsDb.findProjectByIdAndOwner(projectId, req.user!.id);
    if (!project) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Project not found or unauthorized.',
      });
      return;
    }

    const queryParse = pipelineListQuerySchema.safeParse(req.query);
    if (!queryParse.success) {
      res.status(400).json({
        error: 'Bad Request',
        message: queryParse.error.errors[0]?.message || 'Invalid pagination query parameters',
      });
      return;
    }

    const result = await listPipelineRunsByProjectId(project.id, {
      page: queryParse.data.page,
      perPage: queryParse.data.per_page,
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

// GET /api/projects/:projectId/pipelines/templates/gitleaks - Retrieve Gitleaks workflow template and instructions
pipelinesRouter.get('/templates/gitleaks', async (_req: Request, res: Response) => {
  res.status(200).json({
    templateName: 'securedeploy-gitleaks.yml',
    recommendedPath: '.github/workflows/securedeploy-gitleaks.yml',
    scanner: 'gitleaks',
    pinnedActionVersion: 'gitleaks/gitleaks-action@773229b4dd6b8aeeb516315ee54b7be8cb909459',
    description:
      'Minimal, secure Gitleaks workflow template with least-privilege permissions and secret redaction.',
    instructions: [
      '1. Add the template to your repository at `.github/workflows/securedeploy-gitleaks.yml`.',
      '2. Ensure your default branch (main) includes this workflow file.',
      '3. Trigger the workflow dispatch via SecureDeploy or via push/pull_request.',
      '4. SecureDeploy will automatically ingest the scan artifact when the workflow run completes.',
    ],
  });
});

// GET /api/projects/:projectId/pipelines/:pipelineId - Retrieve a single pipeline run
pipelinesRouter.get('/:pipelineId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectParam = uuidParamSchema.safeParse(req.params.projectId);
    if (!projectParam.success) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid project ID format (UUID expected)',
      });
      return;
    }

    const pipelineParam = pipelineIdParamSchema.safeParse(req.params.pipelineId);
    if (!pipelineParam.success) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid pipeline ID format (UUID expected)',
      });
      return;
    }

    const projectId = projectParam.data;
    const pipelineId = pipelineParam.data;

    // Verify project ownership
    const project = await projectsDb.findProjectByIdAndOwner(projectId, req.user!.id);
    if (!project) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Project not found or unauthorized.',
      });
      return;
    }

    const pipeline = await findPipelineRunById(pipelineId, project.id);
    if (!pipeline) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Pipeline run not found.',
      });
      return;
    }

    res.status(200).json(pipeline);
  } catch (error) {
    next(error);
  }
});

// GET /api/projects/:projectId/pipelines/:pipelineId/scans - Retrieve security scans for a run
pipelinesRouter.get(
  '/:pipelineId/scans',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectParam = uuidParamSchema.safeParse(req.params.projectId);
      const pipelineParam = pipelineIdParamSchema.safeParse(req.params.pipelineId);

      if (!projectParam.success || !pipelineParam.success) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid project ID or pipeline ID format (UUID expected)',
        });
        return;
      }

      const projectId = projectParam.data;
      const pipelineId = pipelineParam.data;

      const project = await projectsDb.findProjectByIdAndOwner(projectId, req.user!.id);
      if (!project) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Project not found or unauthorized.',
        });
        return;
      }

      const pipeline = await findPipelineRunById(pipelineId, project.id);
      if (!pipeline) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Pipeline run not found.',
        });
        return;
      }

      const scans = await findSecurityScansByPipelineRunId(pipelineId);
      res.status(200).json({
        pipelineId,
        status: pipeline.status,
        conclusion: pipeline.conclusion,
        scans,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/projects/:projectId/pipelines/:pipelineId/scans/gitleaks - Ingest a Gitleaks scan report
pipelinesRouter.post(
  '/:pipelineId/scans/gitleaks',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectParam = uuidParamSchema.safeParse(req.params.projectId);
      const pipelineParam = pipelineIdParamSchema.safeParse(req.params.pipelineId);

      if (!projectParam.success || !pipelineParam.success) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid project ID or pipeline ID format (UUID expected)',
        });
        return;
      }

      const projectId = projectParam.data;
      const pipelineId = pipelineParam.data;

      const project = await projectsDb.findProjectByIdAndOwner(projectId, req.user!.id);
      if (!project) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Project not found or unauthorized.',
        });
        return;
      }

      const pipeline = await findPipelineRunById(pipelineId, project.id);
      if (!pipeline) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Pipeline run not found.',
        });
        return;
      }

      const reportData = req.body;
      const findingsPayload = Array.isArray(reportData)
        ? reportData
        : reportData?.findings || reportData;

      const normalized = parseAndNormalizeGitleaksReport(findingsPayload, {
        reportReference: reportData?.reportReference || 'api:direct-ingestion',
        scannerVersion: reportData?.scannerVersion || '8.21.2',
      });

      const scan = await recordSecurityScan(pipelineId, normalized);

      res.status(201).json({
        message: 'Security scan recorded successfully.',
        scan,
      });
    } catch (error) {
      next(error);
    }
  }
);
