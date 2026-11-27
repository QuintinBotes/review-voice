import { GitHubError, type GitHubClient } from './client.ts';

/**
 * The login the token acts as, or undefined when GitHub does not say.
 *
 * `GET /user` refuses a GitHub App installation token with 403, and the
 * Action's `github.token` is one (#525). Reviews and comments made with it
 * are authored by `github-actions[bot]`, so that is the login there. Anywhere
 * else a refusal is an error the caller sees, as it was.
 */
export async function tokenLogin(client: GitHubClient): Promise<string | undefined> {
  try {
    const { data } = await client.get<{ login?: unknown }>('/user');
    return typeof data?.login === 'string' ? data.login : undefined;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 403 && process.env['GITHUB_ACTIONS'] === 'true') return 'github-actions[bot]';
    throw error;
  }
}
