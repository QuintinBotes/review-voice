import type { GitHubClient } from '../github/client.ts';

export interface ConsentPlan {
  ownerLogin: string;
  repositories: string[];
  targetEvents: number;
  /** Exactly what will be read, in the user's terms rather than the API's. */
  dataCategories: string[];
  storageLocation: string;
  retention: string[];
  writeOperations: 'none';
}

/**
 * Builds the disclosure shown before any history is read.
 *
 * The list is deliberately concrete. "Review history" is not consent to
 * anything in particular, and a user cannot agree to a scope they have to
 * infer.
 */
export function buildConsentPlan(input: {
  ownerLogin: string;
  repositories: string[];
  targetEvents: number;
  storageLocation: string;
}): ConsentPlan {
  return {
    ownerLogin: input.ownerLogin,
    repositories: [...input.repositories],
    targetEvents: input.targetEvents,
    dataCategories: [
      'Inline pull-request review comments you or your teammates wrote',
      'The diff hunk each comment was attached to',
      'File path and line number for each comment',
      'Pull request number, title and URL',
      'Comment author login and their association with the repository',
    ],
    storageLocation: input.storageLocation,
    retention: [
      'Secrets are removed before anything is written; the original text is never stored',
      'Redacted text is kept until you purge it',
      'Comments from bots and from outside contributors are not stored at all',
      'Nothing is uploaded anywhere; the store never leaves this machine',
    ],
    writeOperations: 'none',
  };
}

export interface DiscoveredRepository {
  fullName: string;
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
}

interface RawRepo {
  full_name: string;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
}

/**
 * Lists repositories the credential can see, so the user picks from reality
 * rather than typing names from memory. Listing is not selecting: nothing is
 * read from any of these until one is explicitly allowlisted.
 */
export async function discoverRepositories(
  client: GitHubClient,
  limit = 100,
): Promise<DiscoveredRepository[]> {
  const repos = await client.paginate<RawRepo>(
    '/user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100',
    limit,
  );
  return repos.map((repo) => ({
    fullName: repo.full_name,
    private: repo.private,
    archived: repo.archived,
    pushedAt: repo.pushed_at,
  }));
}
