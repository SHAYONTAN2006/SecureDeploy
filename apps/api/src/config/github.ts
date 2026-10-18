import fs from 'node:fs';

export interface GithubAppConfig {
  appId: string;
  slug: string;
  clientId?: string;
  clientSecret?: string;
  privateKey: string;
  callbackUrl: string;
  frontendUrl: string;
  webhookSecret?: string;
}

/**
 * Resolves the GitHub App private key from either an inline PEM string
 * or a path to a PEM file.
 */
function resolvePrivateKey(): string | null {
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    // Normalize newlines in case it was passed as a single line with \n
    return process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  }

  if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      if (fs.existsSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH)) {
        return fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Checks whether the minimum required GitHub App configuration is present.
 */
export function isGithubAppConfigured(): boolean {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = resolvePrivateKey();
  return Boolean(appId && privateKey);
}

/**
 * Retrieves the GitHub App configuration or throws a descriptive error if not configured.
 */
export function getGithubAppConfig(): GithubAppConfig {
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG || 'securedeploy-app';
  const privateKey = resolvePrivateKey();
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const callbackUrl =
    process.env.GITHUB_CALLBACK_URL || 'http://localhost:5000/api/github/callback';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!appId || !privateKey) {
    throw new Error(
      'GitHub App is not configured. Please set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH) in your environment.'
    );
  }

  return {
    appId,
    slug,
    clientId,
    clientSecret,
    privateKey,
    callbackUrl,
    frontendUrl,
    webhookSecret,
  };
}

export function getGithubWebhookSecret(): string | null {
  return process.env.GITHUB_WEBHOOK_SECRET || null;
}
