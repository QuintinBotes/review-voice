import { GitHubError, type GitHubClient } from '../github/client.ts';
import { defaultRelevanceConfig, type QueueConfig } from './config.ts';
import { checkRelevance } from './relevance.ts';

export interface RelevanceCommandDeps {
  /** The loaded repository config, or null outside a repository. */
  config: { allowlist: string[]; queue: QueueConfig; warnings: string[] } | null;
  client: (allowlist: string[]) => GitHubClient;
  /** owner/repo from the git remote, when --repository is absent. */
  inferRepository: () => string | null;
  out: (text: string) => void;
  err: (text: string) => void;
}

interface RawPull {
  title?: string;
  body?: string | null;
  base?: { sha?: string };
  user?: { login?: string } | null;
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

/**
 * `review-voice relevance --pr <n> [--repository owner/repo]`. Prints the
 * relevance check's JSON (docs/adr/0038) and exits 0 whether or not the
 * pull request is relevant; 2 on a bad invocation. A credential or
 * allowlist problem throws, and the CLI maps it to 2 as for `queue`. With
 * no `queue.relevance` block the check still runs, on the defaults with
 * `queue.teams` as its teams, so it can be tried before it is enabled;
 * that is said on stderr. Reads GitHub only.
 */
export async function relevanceCommand(argv: string[], deps: RelevanceCommandDeps): Promise<number> {
  const pullNumber = Number(flag(argv, '--pr'));
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    deps.err('--pr needs a pull request number.');
    return 2;
  }
  if (argv.includes('--repository') && flag(argv, '--repository') === null) {
    deps.err('--repository needs a value.');
    return 2;
  }
  const repository = flag(argv, '--repository') ?? deps.inferRepository();
  if (repository === null) {
    deps.err('Cannot tell which repository. Pass --repository <owner/repo>.');
    return 2;
  }
  const config = deps.config;
  for (const warning of config?.warnings ?? []) deps.err(`Warning: ${warning}`);
  if (config === null || config.allowlist.length === 0) {
    deps.err('No repositories are allowlisted. Run /review-voice:init first.');
    return 2;
  }
  if (config.queue.relevance === undefined) {
    deps.err('queue.relevance is not configured; running the check on its defaults, with queue.teams as its teams.');
  }
  const relevance = config.queue.relevance ?? defaultRelevanceConfig(config.queue.teams);

  const client = deps.client(config.allowlist);
  let result;
  try {
    const { data: pull } = await client.get<RawPull>(`/repos/${repository}/pulls/${pullNumber}`);
    result = await checkRelevance({
      client,
      config: relevance,
      repository,
      pull: pullNumber,
      pullRequest: {
        title: pull.title ?? '',
        body: pull.body ?? '',
        author: pull.user?.login ?? '',
        baseSha: pull.base?.sha ?? '',
      },
    });
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 401 || error.status === 403)) {
      deps.err(`GitHub refused the request (status ${error.status}); check the token's access.`);
      return 2;
    }
    throw error;
  }
  deps.out(JSON.stringify(result, null, 2));
  return 0;
}
