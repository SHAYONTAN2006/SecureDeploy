import express, {
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import {
  validateSecurityConfig,
  createPgSessionStore,
  doubleCsrfProtection,
  isInvalidCsrfTokenError,
  SESSION_COOKIE_NAME,
} from './config/security.js';
import { authRouter } from './routes/auth.js';
import { githubRouter } from './routes/github.js';
import { projectsRouter } from './routes/projects.js';
import { pipelinesRouter } from './routes/pipelines.js';
import { webhooksRouter } from './routes/webhooks.js';

export interface AppOptions {
  authMiddleware?: RequestHandler;
  identityMiddleware?: RequestHandler;
  sessionStore?: session.Store;
  enableCsrf?: boolean;
}

export function createApp(options: AppOptions = {}) {
  // Validate production security requirements and fail closed if insecure
  validateSecurityConfig();

  const application = express();
  const isProduction = process.env.NODE_ENV === 'production';
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
  const sessionSecret =
    process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-in-prod-at-least-32-chars';

  // Strict CORS configuration
  application.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    })
  );

  // Cookie parser signed with session secret
  application.use(cookieParser(sessionSecret));

  // Request body parsing with defensive payload limit and raw body capture for webhook HMAC verification
  application.use(
    express.json({
      limit: '100kb',
      verify: (req: Request, _res: Response, buf: Buffer) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // PostgreSQL-backed session middleware
  const store = options.sessionStore || createPgSessionStore();
  application.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    })
  );

  // GitHub Webhook ingestion endpoint (authenticated via HMAC X-Hub-Signature-256; mounted before browser CSRF)
  application.use('/api/webhooks', webhooksRouter);

  // CSRF protection for state-changing requests
  if (options.enableCsrf !== false) {
    application.use(doubleCsrfProtection);
  }

  // Apply test identity/auth injection if provided for test environments
  const injectedAuth = options.authMiddleware || options.identityMiddleware;
  if (injectedAuth) {
    application.use(injectedAuth);
  }

  // Health check endpoint (public, unauthenticated)
  application.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'securedeploy-api',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  });

  // Authentication endpoints
  application.use('/api/auth', authRouter);

  // GitHub App integration endpoints
  application.use('/api/github', githubRouter);

  // Project Management API routes & Pipeline orchestration routes
  application.use('/api/projects/:projectId/pipelines', pipelinesRouter);
  application.use('/api/projects', projectsRouter);

  // 404 handler
  application.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: 'The requested resource does not exist.',
    });
  });

  // Centralized error handler
  application.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // CSRF validation error handler
    if (isInvalidCsrfTokenError(err)) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid or missing CSRF token.',
      });
      return;
    }

    const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;

    res.status(statusCode).json({
      error: 'Internal Server Error',
      message: isProduction ? 'An unexpected error occurred.' : err.message,
    });
  });

  return application;
}

export const app = createApp();
