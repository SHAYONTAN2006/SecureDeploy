import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { findUserById } from '../db/users.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
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

/**
 * Authentication middleware verifying PostgreSQL session validity.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // If an authenticated user was already injected (e.g. in test dependency injection), proceed
  if (req.user) {
    return next();
  }

  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required. Please log in.',
    });
    return;
  }

  try {
    const user = await findUserById(userId);
    if (!user) {
      req.session.destroy(() => {});
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Account not found or session expired.',
      });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
    };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Test dependency injection helper to attach a test identity cleanly.
 */
export function createTestAuthMiddleware(user: AuthUser): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.user = user;
    if (req.session) {
      req.session.userId = user.id;
    }
    next();
  };
}
