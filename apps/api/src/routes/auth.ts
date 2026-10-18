import { Router, type Request, type Response, type NextFunction } from 'express';
import { registerSchema, loginSchema } from '../validation/auth.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createUser, findUserByEmail, findUserById } from '../db/users.js';
import { requireAuth } from '../middleware/auth.js';
import { generateCsrfToken, SESSION_COOKIE_NAME } from '../config/security.js';

export const authRouter = Router();

// GET /api/auth/csrf-token - Generates a double-submit CSRF token
authRouter.get('/csrf-token', (req: Request, res: Response) => {
  const csrfToken = generateCsrfToken(req, res);
  res.status(200).json({ csrfToken });
});

// POST /api/auth/register - Register a new user
authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid registration data',
        details: parseResult.error.errors,
      });
      return;
    }

    const { email, password, name } = parseResult.data;

    // Check if user already exists
    const existing = await findUserByEmail(email);
    if (existing) {
      res.status(409).json({
        error: 'Conflict',
        message: 'An account with this email address already exists.',
      });
      return;
    }

    // Hash password with Argon2id
    const passwordHash = await hashPassword(password);

    // Create user in database
    const user = await createUser({
      email,
      name,
      passwordHash,
    });

    // Establish session
    req.session.userId = user.id;

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/login - Log in with email and password
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid login credentials',
      });
      return;
    }

    const { email, password } = parseResult.data;

    // Generic error message to prevent account enumeration
    const invalidCredentialsResponse = () => {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password.',
      });
    };

    const user = await findUserByEmail(email);
    if (!user || !user.passwordHash) {
      invalidCredentialsResponse();
      return;
    }

    const isValidPassword = await verifyPassword(password, user.passwordHash);
    if (!isValidPassword) {
      invalidCredentialsResponse();
      return;
    }

    // Session fixation protection: regenerate session before saving new identity
    req.session.regenerate((err) => {
      if (err) {
        return next(err);
      }

      req.session.userId = user.id;

      res.status(200).json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt,
        },
      });
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/logout - Terminate current session
authRouter.post('/logout', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  req.session.destroy((err) => {
    if (err) {
      return next(err);
    }
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(200).json({
      message: 'Logged out successfully.',
    });
  });
});

// GET /api/auth/me - Retrieve authenticated current user
authRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await findUserById(req.user!.id);
    if (!user) {
      res.status(404).json({
        error: 'Not Found',
        message: 'User account not found.',
      });
      return;
    }

    res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});
