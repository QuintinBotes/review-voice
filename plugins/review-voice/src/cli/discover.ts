import { GitHubClient } from '../github/client.ts';
import { discoverRepositories } from '../consent/plan.ts';

export async function discoverCommand(): Promise<number> {
  // Listing is not selecting. Nothing is read from any of these repositories
  // until one is explicitly allowlisted.
  const client = new GitHubClient({ allowlist: [] });
  const repositories = await discoverRepositories(client);
  console.log(JSON.stringify({ repositories }, null, 2));
  return 0;
}
