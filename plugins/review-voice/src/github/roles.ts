export type ReviewerRole = 'owner' | 'team' | 'external' | 'bot';

/** GitHub marks bot accounts, but plenty of automation posts as a user. */
const BOT_HINTS = [
  /\[bot\]$/i,
  /^(dependabot|renovate|greenkeeper|snyk|codecov|coveralls|sonarcloud|sonarqube|github-actions|copilot|mergify|allcontributors|imgbot|semantic-release|stale|codeclimate|deepsource|reviewpad|restyled)/i,
  /-bot$/i,
  /^bot-/i,
];

export interface RoleInput {
  login: string;
  /** GitHub's own account type, when the API supplied it. */
  accountType?: string | undefined;
  ownerLogin: string;
  /** Logins the user has chosen to treat as teammates. */
  teamLogins?: readonly string[] | undefined;
  /** Association GitHub reports for the comment author on that repository. */
  authorAssociation?: string | undefined;
}

/**
 * Bot output is excluded from voice learning entirely: it carries zero weight
 * and would otherwise teach the reviewer to sound like a linter.
 */
export function isBot(login: string, accountType?: string): boolean {
  if (accountType !== undefined && accountType.toLowerCase() === 'bot') return true;
  return BOT_HINTS.some((pattern) => pattern.test(login));
}

export function classifyReviewer(input: RoleInput): ReviewerRole {
  if (isBot(input.login, input.accountType)) return 'bot';
  if (input.login.toLowerCase() === input.ownerLogin.toLowerCase()) return 'owner';

  const team = (input.teamLogins ?? []).map((login) => login.toLowerCase());
  if (team.includes(input.login.toLowerCase())) return 'team';

  // GitHub's association is the best available signal for who is inside the
  // project. OWNER and MEMBER are people with standing; CONTRIBUTOR and below
  // are not, and their comments must not be able to establish global rules.
  const association = (input.authorAssociation ?? '').toUpperCase();
  if (association === 'OWNER' || association === 'MEMBER' || association === 'COLLABORATOR') {
    return 'team';
  }

  return 'external';
}
