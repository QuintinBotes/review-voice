import { execFileSync } from 'node:child_process';

/**
 * Whether a finding's cited path actually exists.
 *
 * Everything else in this pipeline is deterministic and auditable; the path is
 * free text from the analyst and nothing checked it. On the first posted batch
 * a candidate cited `modules/productChecklist/hooks/...` where the real file is
 * `modules/productCheckList/utils/...`. The line number was right and the
 * substance was right, and posting the citation as given would have sent the
 * author to a path that does not exist.
 *
 * Cheap to check and impossible to argue with, which is the profile of every
 * guard in this file's neighbour `existence.ts`.
 */
export interface CitationCheck {
  resolves: boolean;
  /** A path differing only in case or a near miss, when one exists. */
  suggestion: string | null;
  /** True when the check could not run, in which case nothing is concluded. */
  inconclusive: boolean;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  });
}

function normalise(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

/** Paths the diff itself touches, which exist whether or not the ref has them. */
export function pathsInDiff(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^\+\+\+ [ab]\/(.+)$/gm)) {
    if (match[1] !== undefined && match[1] !== '/dev/null') paths.add(normalise(match[1]));
  }
  return paths;
}

/**
 * Checks a cited path against the diff and the reviewed tree.
 *
 * A file the change adds will not be at the base ref, so the diff is consulted
 * first. A failure to run the search is never read as "the path is wrong".
 */
export function checkCitation(
  candidatePath: string,
  cwd: string,
  ref: string | null,
  diff: string | null,
): CitationCheck {
  const wanted = normalise(candidatePath);
  if (wanted.length === 0) return { resolves: false, suggestion: null, inconclusive: false };

  if (diff !== null && pathsInDiff(diff).has(wanted)) {
    return { resolves: true, suggestion: null, inconclusive: false };
  }

  let tracked: string[];
  try {
    const args = ref === null ? ['ls-files'] : ['ls-tree', '-r', '--name-only', ref];
    tracked = git(args, cwd).split('\n').filter((line) => line.length > 0);
  } catch {
    // The tree could not be listed. That is a failure to ask the question, not
    // an answer to it.
    return { resolves: false, suggestion: null, inconclusive: true };
  }

  if (tracked.includes(wanted)) return { resolves: true, suggestion: null, inconclusive: false };

  // A case difference is the miss actually observed, so name it rather than
  // leaving the author to find it.
  const lowered = wanted.toLowerCase();
  const nearest = tracked.find((path) => path.toLowerCase() === lowered);
  if (nearest !== undefined) return { resolves: false, suggestion: nearest, inconclusive: false };

  // Failing that, the same basename somewhere else is the next most likely slip.
  const base = wanted.split('/').pop();
  const sameName =
    base === undefined ? undefined : tracked.find((path) => path.split('/').pop() === base);

  return { resolves: false, suggestion: sameName ?? null, inconclusive: false };
}
