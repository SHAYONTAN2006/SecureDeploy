import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { getGithubAppConfig } from '../config/github.js';

export interface GithubRepositorySummary {
  id: number;
  name: string;
  fullName: string;
  owner: {
    login: string;
    id?: number;
  };
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
}

export interface GithubInstallationDetails {
  id: number;
  account: {
    login: string;
    id: number;
    type?: string;
  };
  targetType?: string;
  repositorySelection?: string;
}

export interface GithubServiceApi {
  getInstallationDetails(installationId: number): Promise<GithubInstallationDetails>;
  listInstallationRepositories(
    installationId: number,
    options?: { page?: number; perPage?: number }
  ): Promise<{ totalCount: number; repositories: GithubRepositorySummary[] }>;
  getRepository(
    installationId: number,
    owner: string,
    repo: string
  ): Promise<GithubRepositorySummary>;
  getInstallationAccessToken(installationId: number): Promise<string>;
}

/**
 * Real GitHub API implementation using Octokit GitHub App authentication.
 */
class OctokitGithubService implements GithubServiceApi {
  private getAppOctokit(): Octokit {
    const config = getGithubAppConfig();
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      },
    });
  }

  private getInstallationOctokit(installationId: number): Octokit {
    const config = getGithubAppConfig();
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId,
      },
    });
  }

  async getInstallationDetails(installationId: number): Promise<GithubInstallationDetails> {
    const octokit = this.getAppOctokit();
    const { data } = await octokit.rest.apps.getInstallation({
      installation_id: installationId,
    });

    return {
      id: data.id,
      account: {
        login: (data.account as { login?: string })?.login || 'unknown',
        id: data.account?.id || 0,
        type: (data.account as { type?: string })?.type || 'User',
      },
      targetType: data.target_type,
      repositorySelection: data.repository_selection,
    };
  }

  async listInstallationRepositories(
    installationId: number,
    options: { page?: number; perPage?: number } = {}
  ): Promise<{ totalCount: number; repositories: GithubRepositorySummary[] }> {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
      page: options.page || 1,
      per_page: options.perPage || 30,
    });

    const repositories: GithubRepositorySummary[] = data.repositories.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: {
        login: repo.owner.login,
        id: repo.owner.id,
      },
      private: repo.private,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch || 'main',
    }));

    return {
      totalCount: data.total_count,
      repositories,
    };
  }

  async getRepository(
    installationId: number,
    owner: string,
    repo: string
  ): Promise<GithubRepositorySummary> {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await octokit.rest.repos.get({
      owner,
      repo,
    });

    return {
      id: data.id,
      name: data.name,
      fullName: data.full_name,
      owner: {
        login: data.owner.login,
        id: data.owner.id,
      },
      private: data.private,
      htmlUrl: data.html_url,
      defaultBranch: data.default_branch || 'main',
    };
  }

  async getInstallationAccessToken(installationId: number): Promise<string> {
    const config = getGithubAppConfig();
    const auth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
    });

    const installationAuth = await auth({
      type: 'installation',
      installationId,
    });

    return installationAuth.token;
  }
}

let activeGithubService: GithubServiceApi = new OctokitGithubService();

/**
 * Allows automated tests to inject a mocked GitHub service without network calls or secrets.
 */
export function setGithubServiceMock(mock: GithubServiceApi | null): void {
  activeGithubService = mock || new OctokitGithubService();
}

export function getGithubService(): GithubServiceApi {
  return activeGithubService;
}
