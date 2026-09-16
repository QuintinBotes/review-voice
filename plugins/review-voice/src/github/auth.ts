import { execFileSync } from 'node:child_process';

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
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
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
