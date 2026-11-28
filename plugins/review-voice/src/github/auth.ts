import { execFileSync } from 'node:child_process';
import { GIT_CHECK_TIMEOUT_MS, boundedGit } from '../git-exec.ts';
import { apiBaseUrl, webHost } from './host.ts';

export class AuthError extends Error {}

/**
 * Review Voice stores no GitHub credential of its own (docs/adr/0002). It
 * borrows the one `gh` already holds, so there is no credential storage and
 * therefore no credential storage bugs.
 */
export function githubToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  try {
    // `gh` holds one token per host; ask for the configured host's, never github.com's by default.
    const host = webHost(apiBaseUrl(env));
    const token = execFileSync('gh', host === 'github.com' ? ['auth', 'token'] : ['auth', 'token', '--hostname', host], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...boundedGit(GIT_CHECK_TIMEOUT_MS, 1024 * 1024),
    }).trim();
    if (token.length > 0) return token;
  } catch {
    // Fall through to the actionable error below.
  }

  throw new AuthError(
    'No GitHub credential. Run `gh auth login`, or set GITHUB_TOKEN. ' +
      'Review Voice needs read access only.',
  );
}
