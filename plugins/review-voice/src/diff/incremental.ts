import { execFileSync } from 'node:child_process';

/** Every reason a pull request must be read in full rather than narrowed. */
export type FullReviewCause =
  | 'requested'
  | 'no-prior-review'
  | 'no-new-commits'
  | 'truncated'
  | 'compare-unavailable'
  | 'history-rewritten'
  | 'base-merged'
  | 'base-sync-only';

/** The boundary a pull-request review actually covers. */
export type ReviewScope =
  | {
      kind: 'incremental';
      since: string;
      priorRunId: string;
      priorReviewedAt: string;
      commits: number;
      files: string[];
    }
  | {
      kind: 'full';
      cause: FullReviewCause;
      since: string | null;
      priorRunId: string | null;
    };

/** The one stored run a new pull-request review may compare itself with. */
export interface PriorPullReview {
  reviewRunId: string;
  headRef: string;
  createdAt: string;
}

/** Paths as the pull-request file endpoint described them. */
export interface ReviewedPullFile {
  path: string;
  previousPath?: string | undefined;
}

/**
 * The small, injectable git surface the planner needs.
 *
 * Keeping the commands here makes the decision testable without making a
 * planner test depend on a checkout's current branch or remote.
 */
export interface IncrementalGit {
  hasCommit(sha: string, cwd: string): boolean;
  isAncestor(ancestor: string, descendant: string, cwd: string): boolean;
  mergeCommits(since: string, head: string, cwd: string): string[];
  changedPaths(since: string, head: string, cwd: string): string[];
  commitCount(since: string, head: string, cwd: string): number;
}

export interface PlanIncrementalScopeOptions {
  priorRun: PriorPullReview | null;
  head: string;
  /** Established while acquiring the pull request, before planning begins. */
  headAvailable: boolean;
  /** Only files that the full pull-request read would otherwise review. */
  reviewedFiles: ReviewedPullFile[];
  cwd: string;
  truncated: boolean;
  forceFull: boolean;
  git?: IncrementalGit | undefined;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const systemGit: IncrementalGit = {
  hasCommit(sha, cwd) {
    try {
      runGit(['cat-file', '-e', `${sha}^{commit}`], cwd);
      return true;
    } catch {
      return false;
    }
  },
  isAncestor(ancestor, descendant, cwd) {
    try {
      runGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
      return true;
    } catch (error) {
      // Exit 1 is git's documented answer for "not an ancestor". Everything
      // else means the comparison itself could not be trusted.
      if ((error as { status?: unknown }).status === 1) return false;
      throw error;
    }
  },
  mergeCommits(since, head, cwd) {
    return runGit(['rev-list', '--merges', `${since}..${head}`], cwd)
      .split('\n')
      .filter((sha) => sha.length > 0);
  },
  changedPaths(since, head, cwd) {
    return runGit(['diff', '--name-only', '-z', since, head], cwd)
      .split('\0')
      .filter((path) => path.length > 0);
  },
  commitCount(since, head, cwd) {
    const count = Number(runGit(['rev-list', '--count', `${since}..${head}`], cwd).trim());
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('git returned an invalid commit count');
    return count;
  },
};

function full(cause: FullReviewCause, priorRun: PriorPullReview | null): ReviewScope {
  return {
    kind: 'full',
    cause,
    since: priorRun?.headRef ?? null,
    priorRunId: priorRun?.reviewRunId ?? null,
  };
}

/**
 * Maps changed paths back to the pull-request file names we will show.
 *
 * A rename can be named from either side by git depending on the comparison,
 * but the current path is the one the analyst can open. Treating both names as
 * one file prevents a rename from looking like a base-only update.
 */
function changedReviewedFiles(files: ReviewedPullFile[], changedPaths: string[]): string[] {
  const changed = new Set(changedPaths);
  const selected = new Set<string>();

  for (const file of files) {
    if (changed.has(file.path) || (file.previousPath !== undefined && changed.has(file.previousPath))) {
      selected.add(file.path);
    }
  }

  return [...selected].sort();
}

/**
 * Decides whether a pull request may be narrowed to commits after its last
 * recorded review.
 *
 * The order is intentional. Each prerequisite answers a different way a
 * smaller range could omit author work, and a failed git command is never
 * treated as evidence that the range is safe.
 */
export function planIncrementalScope(options: PlanIncrementalScopeOptions): ReviewScope {
  const prior = options.priorRun;

  if (options.forceFull) return full('requested', prior);
  if (prior === null) return full('no-prior-review', null);
  if (prior.headRef === options.head) return full('no-new-commits', prior);
  if (options.truncated) return full('truncated', prior);

  try {
    const git = options.git ?? systemGit;
    if (!options.headAvailable || !git.hasCommit(prior.headRef, options.cwd)) {
      return full('compare-unavailable', prior);
    }
    if (!git.isAncestor(prior.headRef, options.head, options.cwd)) {
      return full('history-rewritten', prior);
    }
    if (git.mergeCommits(prior.headRef, options.head, options.cwd).length > 0) {
      return full('base-merged', prior);
    }

    const files = changedReviewedFiles(
      options.reviewedFiles,
      git.changedPaths(prior.headRef, options.head, options.cwd),
    );
    if (files.length === 0) return full('base-sync-only', prior);

    return {
      kind: 'incremental',
      since: prior.headRef,
      priorRunId: prior.reviewRunId,
      priorReviewedAt: prior.createdAt,
      commits: git.commitCount(prior.headRef, options.head, options.cwd),
      files,
    };
  } catch {
    // Narrowing on partial information is worse than re-reading a change. The
    // caller still receives a usable full diff and an honest explanation.
    return full('compare-unavailable', prior);
  }
}
