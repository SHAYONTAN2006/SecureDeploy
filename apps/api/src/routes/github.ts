import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { isGithubAppConfigured, getGithubAppConfig } from '../config/github.js';
import { getGithubService } from '../services/github.service.js';
import * as githubDb from '../db/github.js';
import { callbackQuerySchema, repositoryListQuerySchema } from '../validation/github.js';

function isUuid(str: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
}

export const githubRouter = Router();

// GET /api/github/status - Check whether GitHub App is configured on the backend
githubRouter.get('/status', (_req: Request, res: Response) => {
  const configured = isGithubAppConfigured();
  if (!configured) {
    res.status(200).json({
      configured: false,
      message: 'GitHub App integration is not configured on this server.',
    });
    return;
  }

  const config = getGithubAppConfig();
  res.status(200).json({
    configured: true,
    slug: config.slug,
  });
});

// GET /api/github/installations - List installations connected to current user
githubRouter.get(
  '/installations',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const installations = await githubDb.findInstallationsByUserId(req.user!.id);
      res.status(200).json({
        installations: installations.map((inst) => ({
          id: inst.id,
          installationId: inst.installationId.toString(),
          accountLogin: inst.accountLogin,
          accountId: inst.accountId.toString(),
          accountType: inst.accountType,
          targetType: inst.targetType,
          repositorySelection: inst.repositorySelection,
          createdAt: inst.createdAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/github/install - Initiate installation flow with anti-CSRF state
githubRouter.get('/install', requireAuth, (req: Request, res: Response) => {
  if (!isGithubAppConfigured()) {
    res.status(503).json({
      error: 'Service Unavailable',
      message:
        'GitHub App is not configured on this server. Please set GITHUB_APP_ID and private key.',
    });
    return;
  }

  const config = getGithubAppConfig();
  const state = crypto.randomBytes(32).toString('hex');
  req.session.githubInstallState = state;

  const installUrl = `https://github.com/apps/${config.slug}/installations/new?state=${encodeURIComponent(state)}`;

  if (req.query.redirect === 'true') {
    res.redirect(installUrl);
    return;
  }

  res.status(200).json({
    url: installUrl,
    state,
  });
});

// GET /api/github/callback - Handle return flow from GitHub App installation
githubRouter.get(
  '/callback',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isGithubAppConfigured()) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'GitHub App is not configured on this server.',
        });
        return;
      }

      const parseResult = callbackQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid callback parameters from GitHub.',
          details: parseResult.error.errors,
        });
        return;
      }

      const { installation_id, state } = parseResult.data;

      // Validate CSRF / session mixup protection
      const sessionState = req.session.githubInstallState;

      if (!sessionState || sessionState !== state) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid or expired GitHub installation state parameter.',
        });
        return;
      }

      // Single-use state: consume only after verified match to prevent replay attacks
      delete req.session.githubInstallState;

      const installationIdNum = parseInt(installation_id, 10);
      if (isNaN(installationIdNum) || installationIdNum <= 0) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid installation ID format.',
        });
        return;
      }

      // Verify installation existence and permissions through GitHub API
      const githubService = getGithubService();
      const details = await githubService.getInstallationDetails(installationIdNum);

      // Associate installation with the authenticated SecureDeploy user
      const installation = await githubDb.upsertInstallation({
        installationId: BigInt(details.id),
        accountLogin: details.account.login,
        accountId: BigInt(details.account.id),
        accountType: details.account.type || 'User',
        targetType: details.targetType,
        repositorySelection: details.repositorySelection || 'all',
        userId: req.user!.id,
      });

      // If client requests HTML/redirect, return redirect to frontend
      if (req.accepts('html') && !req.xhr && !req.accepts('json')) {
        const config = getGithubAppConfig();
        res.redirect(`${config.frontendUrl}/?github=success&installation_id=${installation_id}`);
        return;
      }

      res.status(200).json({
        success: true,
        message: 'GitHub App installation linked successfully.',
        installation: {
          id: installation.id,
          installationId: installation.installationId.toString(),
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/github/installations/:installationId/repositories - List accessible repositories
githubRouter.get(
  '/installations/:installationId/repositories',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isGithubAppConfigured()) {
        res.status(503).json({
          error: 'Service Unavailable',
          message: 'GitHub App is not configured on this server.',
        });
        return;
      }

      const rawInstallationId = req.params.installationId;
      const installationId = Array.isArray(rawInstallationId)
        ? rawInstallationId[0]
        : rawInstallationId;

      if (!installationId || typeof installationId !== 'string') {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid installation ID format.',
        });
        return;
      }

      const queryParse = repositoryListQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        res.status(400).json({
          error: 'Bad Request',
          message: queryParse.error.errors[0]?.message || 'Invalid pagination query parameters',
        });
        return;
      }

      // Verify that this installation belongs to the authenticated user
      let installation = null;
      if (isUuid(installationId)) {
        installation = await githubDb.findInstallationById(installationId, req.user!.id);
      } else if (/^\d+$/.test(installationId)) {
        installation = await githubDb.findInstallationByInstallationId(
          BigInt(installationId),
          req.user!.id
        );
      }

      if (!installation) {
        res.status(404).json({
          error: 'Not Found',
          message: 'GitHub installation not found or not authorized for your account.',
        });
        return;
      }

      const githubService = getGithubService();
      const reposResult = await githubService.listInstallationRepositories(
        Number(installation.installationId),
        queryParse.data
      );

      res.status(200).json({
        installation: {
          id: installation.id,
          installationId: installation.installationId.toString(),
          accountLogin: installation.accountLogin,
        },
        page: queryParse.data.page,
        perPage: queryParse.data.per_page,
        totalCount: reposResult.totalCount,
        repositories: reposResult.repositories,
      });
    } catch (error) {
      next(error);
    }
  }
);
