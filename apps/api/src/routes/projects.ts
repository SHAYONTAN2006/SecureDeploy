import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  createProjectSchema,
  updateProjectSchema,
  uuidParamSchema,
} from '../validation/projects.js';
import * as projectsService from '../services/projects.service.js';

export const projectsRouter = Router();

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
