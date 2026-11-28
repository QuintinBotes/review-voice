import { isDependencyFile } from './classify.ts';
import { GitHubError, type GitHubClient } from '../github/client.ts';

/**
 * GitHub's dependency review (#546): whether a version is vulnerable is a fact
 * from an advisory database, not something to reason out of a diff, and lock
 * files are excluded from the diff anyway. So a pull request that changes
 * dependencies is checked against `GET /dependency-graph/compare`, a read on the
 * repository already under review.
 */

export const DEPENDENCY_SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
export type DependencySeverity = (typeof DEPENDENCY_SEVERITIES)[number];

/** One row of the compare endpoint, as GitHub's REST docs give it. */
interface DependencyChange {
  change_type: 'added' | 'removed';
  manifest: string;
  ecosystem: string;
  name: string;
  version: string;
  license: string | null;
  scope?: 'runtime' | 'development' | 'unknown';
  vulnerabilities: { severity: string; advisory_ghsa_id: string; advisory_summary: string; advisory_url: string }[];
}

/** `hold` raises the change for human review (docs/adr/0012); `note` stays local. */
export interface DependencyCheck {
  hold: string | null;
  note: string | null;
}

/** Why the dependency change went unchecked, or null when no file changes dependencies. */
export function uncheckedDependencies(files: { path: string }[], why: string): DependencyCheck {
  const paths = files.map((file) => file.path).filter(isDependencyFile);
  if (paths.length === 0) return { hold: null, note: null };
  const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '');
  return { hold: null, note: `Dependency changes were not checked for advisories or licences (${shown}): ${why}.` };
}

export async function checkDependencies(options: {
  client: GitHubClient;
  repository: string;
  base: string;
  head: string;
  files: { path: string }[];
  minSeverity: DependencySeverity | null;
}): Promise<DependencyCheck> {
  const { files, minSeverity } = options;
  // Off is the default, so it says nothing: a note on every manifest change would be noise.
  if (minSeverity === null) return { hold: null, note: null };
  if (!files.some((file) => isDependencyFile(file.path))) return { hold: null, note: null };
  let rows: DependencyChange[];
  try {
    rows = (
      await options.client.get<DependencyChange[]>(
        `/repos/${options.repository}/dependency-graph/compare/${options.base}...${options.head}`,
        { retryRateLimits: false },
      )
    ).data;
    if (!Array.isArray(rows)) throw new Error('the answer was not a list');
  } catch (error) {
    // 403 or 404: the dependency graph is off, or a private repository has no GitHub Advanced Security.
    const why = error instanceof GitHubError ? `GitHub's dependency review answered ${error.status}` : `GitHub's dependency review could not be read (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
    return uncheckedDependencies(files, why);
  }

  const rank = (severity: string): number => DEPENDENCY_SEVERITIES.indexOf(severity.toLowerCase() as DependencySeverity);
  // An `added` row is a new package or the new version of a bumped one; nothing the change did not add is named.
  const added = rows.filter((row) => row.change_type === 'added');
  const vulnerable = added.flatMap((row) => {
    if (row.scope === 'development') return [];
    const advisories = (row.vulnerabilities ?? []).filter((advisory) => rank(String(advisory.severity)) >= rank(minSeverity));
    return advisories.length === 0 ? [] : [`${row.name}@${row.version} (${advisories.map((advisory) => `${advisory.advisory_ghsa_id} ${advisory.severity}`).join(', ')})`];
  });
  // A licence a package did not have at the base: a new package, or a bump that changed it.
  const removed = rows.filter((row) => row.change_type === 'removed');
  const licences = added.flatMap((row) => {
    const before = removed.find((old) => old.name === row.name && old.ecosystem === row.ecosystem && old.manifest === row.manifest);
    return before !== undefined && before.license === row.license ? [] : [`${row.name}@${row.version} (${row.license ?? 'no licence detected'})`];
  });
  return {
    hold: vulnerable.length === 0 ? null : `${vulnerable.length} added dependency(ies) with an advisory at or above ${minSeverity}: ${vulnerable.join('; ')}`,
    note: licences.length === 0 ? null : `Dependency licences added by this change: ${licences.join(', ')}.`,
  };
}
