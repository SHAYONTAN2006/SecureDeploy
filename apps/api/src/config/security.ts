import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import { doubleCsrf } from 'csrf-csrf';

export const CSRF_COOKIE_NAME = 'securedeploy.csrf';
export const SESSION_COOKIE_NAME = 'securedeploy.sid';

/**
 * Validates security-critical environment variables.
 * Fails closed immediately in production if required secrets or safe configurations are absent.
 */
export function validateSecurityConfig(): void {
  if (process.env.NODE_ENV === 'production') {
    const secret = process.env.SESSION_SECRET;
    if (
      !secret ||
      secret.length < 32 ||
      secret.includes('dev-') ||
      secret.includes('change-me') ||
      secret.includes('insecure')
    ) {
      throw new Error(
        'CRITICAL CONFIGURATION ERROR: SESSION_SECRET must be set to a cryptographically secure random value of at least 32 characters in production.'
      );
    }

    const corsOrigin = process.env.CORS_ORIGIN;
    if (!corsOrigin || corsOrigin === '*' || corsOrigin.includes('localhost')) {
      throw new Error(
        'CRITICAL CONFIGURATION ERROR: CORS_ORIGIN must be explicitly set to a production origin (cannot be wildcard or localhost).'
      );
    }
  }
}

/**
 * Creates a PostgreSQL-backed session store using connect-pg-simple.
 */
export function createPgSessionStore(): session.Store {
  const PgSession = connectPgSimple(session);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });

  return new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: false, // Managed by Prisma migrations
  });
}

/**
 * Double-submit cookie CSRF protection.
 */
const csrf = doubleCsrf({
  getSecret: () =>
    process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-in-prod-at-least-32-chars',
  cookieName: CSRF_COOKIE_NAME,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  },
  size: 64,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
});

export const generateCsrfToken = csrf.generateToken;
export const doubleCsrfProtection = csrf.doubleCsrfProtection;

export function isInvalidCsrfTokenError(err: unknown): boolean {
  if (err === csrf.invalidCsrfTokenError) {
    return true;
  }
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    return (
      e.code === 'EBADCSRFTOKEN' ||
      e.message === 'invalid csrf token' ||
      e.error === 'invalid csrf token'
    );
  }
  return false;
}
