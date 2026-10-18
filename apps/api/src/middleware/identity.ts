import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { prisma } from '../lib/prisma.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

export const DEV_USER_EMAIL = 'dev@securedeploy.local';
export const DEV_USER_NAME = 'Development User';

/**
 * Ensures the default development user exists in the database.
 */
export async function getOrCreateDevUser(): Promise<AuthUser> {
  const user = await prisma.user.upsert({
    where: { email: DEV_USER_EMAIL },
    update: {},
    create: {
      email: DEV_USER_EMAIL,
      name: DEV_USER_NAME,
    },
  });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
  };
}

/**
 * Development identity middleware.
 * Fails closed in production environments where real authentication is required.
 * Cannot be enabled in production merely by setting an environment variable.
 */
export async function requireIdentity(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // If an identity was already injected (e.g. in test suite), use it
  if (req.user) {
    return next();
  }

  // Fails closed in production: development identity is strictly prohibited
  if (process.env.NODE_ENV === 'production') {
    res.status(401).json({
      error: 'Unauthorized',
      message:
        'Authentication not configured for production environment. Development identity is disabled.',
    });
    return;
  }

  try {
    const devUser = await getOrCreateDevUser();
    req.user = devUser;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Helper to create a test identity middleware for dependency injection in tests.
 */
export function createTestIdentityMiddleware(user: AuthUser): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.user = user;
    next();
  };
}
