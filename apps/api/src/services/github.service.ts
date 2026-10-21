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
  dispatchWorkflow(
    installationId: number,
    owner: string,
    repo: string,
    workflowId: string,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void>;
  getWorkflow(
    installationId: number,
    owner: string,
    repo: string,
    workflowId: string
  ): Promise<{ id: number; name: string; path: string; state: string }>;
  getRef(
    installationId: number,
    owner: string,
    repo: string,
    ref: string
  ): Promise<{ ref: string; sha: string }>;
  listWorkflowRunArtifacts(
    installationId: number,
    owner: string,
    repo: string,
    runId: number
  ): Promise<{
    totalCount: number;
    artifacts: Array<{
      id: number;
      name: string;
      sizeInBytes: number;
      expired: boolean;
    }>;
  }>;
  downloadWorkflowRunArtifact(
    installationId: number,
    owner: string,
    repo: string,
    artifactId: number
  ): Promise<Buffer>;
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

  async dispatchWorkflow(
    installationId: number,
    owner: string,
    repo: string,
    workflowId: string,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    const octokit = this.getInstallationOctokit(installationId);
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowId,
      ref,
      inputs,
    });
  }

  async getWorkflow(
    installationId: number,
    owner: string,
    repo: string,
    workflowId: string
  ): Promise<{ id: number; name: string; path: string; state: string }> {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await octokit.rest.actions.getWorkflow({
      owner,
      repo,
      workflow_id: workflowId,
    });
    return {
      id: data.id,
      name: data.name,
      path: data.path,
      state: data.state,
    };
  }

  async getRef(
    installationId: number,
    owner: string,
    repo: string,
    ref: string
  ): Promise<{ ref: string; sha: string }> {
    const octokit = this.getInstallationOctokit(installationId);
    const cleanRef = ref.replace(/^refs\/heads\//, '');
    try {
      const branchRes = await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: cleanRef,
      });
      return {
        ref: cleanRef,
        sha: branchRes.data.commit.sha,
      };
    } catch {
      const formattedRef = ref.startsWith('refs/') ? ref.replace(/^refs\//, '') : `heads/${ref}`;
      const gitRefRes = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: formattedRef,
      });
      return {
        ref: cleanRef,
        sha: gitRefRes.data.object.sha,
      };
    }
  }

  async listWorkflowRunArtifacts(
    installationId: number,
    owner: string,
    repo: string,
    runId: number
  ): Promise<{
    totalCount: number;
    artifacts: Array<{
      id: number;
      name: string;
      sizeInBytes: number;
      expired: boolean;
    }>;
  }> {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await octokit.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: runId,
    });
    return {
      totalCount: data.total_count,
      artifacts: data.artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        sizeInBytes: a.size_in_bytes,
        expired: a.expired,
      })),
    };
  }

  async downloadWorkflowRunArtifact(
    installationId: number,
    owner: string,
    repo: string,
    artifactId: number
  ): Promise<Buffer> {
    const octokit = this.getInstallationOctokit(installationId);
    const res = await octokit.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifactId,
      archive_format: 'zip',
    });
    return Buffer.from(res.data as ArrayBuffer);
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
