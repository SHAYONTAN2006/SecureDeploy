import express, {
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from 'express';
import cors from 'cors';
import { requireIdentity } from './middleware/identity.js';
import { projectsRouter } from './routes/projects.js';

export interface AppOptions {
  identityMiddleware?: RequestHandler;
}

export function createApp(options: AppOptions = {}) {
  const application = express();
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';

  application.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    })
  );

  application.use(express.json());

  // Health check endpoint (public, unauthenticated)
  application.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'securedeploy-api',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  });

  // Project Management API routes
  const identity = options.identityMiddleware || requireIdentity;
  application.use('/api/projects', identity, projectsRouter);

  // 404 handler
  application.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: 'The requested resource does not exist.',
    });
  });

  // Centralized error handler
  application.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const isProduction = process.env.NODE_ENV === 'production';
    const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;

    res.status(statusCode).json({
      error: 'Internal Server Error',
      message: isProduction ? 'An unexpected error occurred.' : err.message,
    });
  });

  return application;
}

export const app = createApp();
