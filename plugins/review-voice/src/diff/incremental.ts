import { execFileSync } from 'node:child_process';
import { unquoteGitPath } from './hunks.ts';

/** Every reason a pull request must be read in full rather than narrowed. */
export type FullReviewCause =
  | 'requested'
  | 'no-prior-review'
  | 'no-new-commits'
  | 'truncated'
  | 'compare-unavailable'
  | 'history-rewritten'
  | 'base-merged'
  | 'base-sync-only'
  // The author's change since the last review cannot be shown as new hunks at
  // the head: a hunk was reverted or moved, or a file was renamed, re-moded,
  // added empty or deleted. Read in full rather than narrowed past it.
  | 'own-diff-unrepresentable';

/** Why a pull request whose own diff did not change was not read again. */
export type UnchangedReason = 'base-merged' | 'history-rewritten' | 'base-sync-only';

/**
 * The boundary a pull-request review actually covers.
 *
 * `priorRunId` and `priorReviewedAt` are null when the previous head came from
 * `--since` or from the reviewer's own review on GitHub rather than from a run
 * recorded here.
 */
export type ReviewScope =
  | {
      kind: 'incremental';
      since: string;
      priorRunId: string | null;
      priorReviewedAt: string | null;
      commits: number;
      files: string[];
    }
  | {
      kind: 'unchanged';
      since: string;
      priorRunId: string | null;
      priorReviewedAt: string | null;
      /** The head's merge base with the base branch: what the own diff is against. */
      mergeBase: string;
      reason: UnchangedReason;
    }
  | {
      kind: 'interdiff';
      since: string;
      priorRunId: string | null;
      priorReviewedAt: string | null;
      mergeBase: string;
      files: string[];
      hunks: number;
    }
  | {
      kind: 'full';
      cause: FullReviewCause;
      since: string | null;
      priorRunId: string | null;
    };

const nullableString = (value: unknown): boolean => typeof value === 'string' || value === null;
const UNCHANGED_REASONS = new Set(['base-merged', 'history-rewritten', 'base-sync-only']);

/**
 * Reads a scope back from stored or manifest JSON, or null when it is not one.
 *
 * Shared by the run store and `record --files`, so both accept exactly the
 * shapes the planner produces - including the null prior-run fields a
 * `--since` or GitHub-sourced previous head carries.
 */
export function parseReviewScope(value: unknown): ReviewScope | null {
  if (typeof value !== 'object' || value === null) return null;
  const scope = value as Record<string, unknown>;
  const strings = (list: unknown): boolean => Array.isArray(list) && list.every((item) => typeof item === 'string');
  const prior =
    typeof scope.since === 'string' && nullableString(scope.priorRunId) && nullableString(scope.priorReviewedAt);

  if (scope.kind === 'incremental' && prior && Number.isInteger(scope.commits) && strings(scope.files)) {
    return scope as unknown as ReviewScope;
  }
  if (scope.kind === 'unchanged' && prior && typeof scope.mergeBase === 'string' && UNCHANGED_REASONS.has(scope.reason as string)) {
    return scope as unknown as ReviewScope;
  }
  if (scope.kind === 'interdiff' && prior && typeof scope.mergeBase === 'string' && strings(scope.files) && Number.isInteger(scope.hunks)) {
    return scope as unknown as ReviewScope;
  }
  if (scope.kind === 'full' && typeof scope.cause === 'string' && nullableString(scope.since) && nullableString(scope.priorRunId)) {
    return scope as unknown as ReviewScope;
  }
  return null;
}

/** A short human description of a scope, for `explain`. */
export function describeScope(scope: ReviewScope | null): string | null {
  if (scope === null) return null;
  switch (scope.kind) {
    case 'incremental':
      return `incremental since ${scope.since.slice(0, 7)} (${scope.commits} commit${scope.commits === 1 ? '' : 's'})`;
    case 'unchanged':
      return `unchanged since ${scope.since.slice(0, 7)} (${scope.reason})`;
    case 'interdiff':
      return `interdiff since ${scope.since.slice(0, 7)} (${scope.hunks} hunk${scope.hunks === 1 ? '' : 's'} in ${scope.files.length} file${scope.files.length === 1 ? '' : 's'})`;
    case 'full':
      return `full (${scope.cause})`;
  }
}

/** The previous head a new pull-request review may compare itself with. */
export interface PriorPullReview {
  reviewRunId: string | null;
  headRef: string;
  createdAt: string | null;
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
  /** Only needed when the pull request's base is known; see `ownDiffScope`. */
  mergeBase?(left: string, right: string, cwd: string): string;
  diffText?(from: string, to: string, paths: string[], cwd: string): string;
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
  /**
   * The pull request's base commit. With it, the planner compares the pull
   * request's own diff before and after, so a merged base or a rebase no longer
   * forces a full read. Without it every decision is the commit-range one.
   */
  base?: string | undefined;
  git?: IncrementalGit | undefined;
}

/** A planned scope, and the patch an `interdiff` scope reviews. */
export interface PlannedScope {
  scope: ReviewScope;
  interdiffPatch: string | null;
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
  mergeBase(left, right, cwd) {
    const base = runGit(['merge-base', left, right], cwd).trim();
    if (!/^[0-9a-f]{7,64}$/.test(base)) throw new Error('git returned no merge base');
    return base;
  },
  diffText(from, to, paths, cwd) {
    return runGit(
      ['diff', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', from, to, '--', ...topPathspecs(paths)],
      cwd,
    );
  },
};

/**
 * Pathspecs anchored at the repository root and matched literally.
 *
 * Paths come from GitHub relative to the root, but git reads a pathspec
 * relative to the working directory: run from a subdirectory, every path
 * missed, both sides of the comparison came back empty, and the result read as
 * "nothing changed". `literal` keeps a `*` or `?` in a file name from
 * matching other files.
 */
export function topPathspecs(paths: string[]): string[] {
  return paths.map((path) => `:(top,literal)${path}`);
}

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

/** One hunk of a pull request's own diff, keyed by what it changes. */
interface OwnHunk {
  /**
   * Its `-`/`+` lines, plus the context line directly before and after each
   * run of them. Not its `@@` numbers, so a hunk that only shifted is the same
   * hunk; but its immediate neighbours, so the same edit moved elsewhere in the
   * file - a release moved to after a different call - is a different one.
   */
  key: string;
  /**
   * Where in the base the hunk applies: every unchanged line next to one of
   * its changes, and the base lines it removes. A rewrite of the same edit
   * keeps all of them; a revert of part of it, or a move, does not.
   */
  site: Set<string>;
  text: string;
}

interface OwnFile {
  header: string[];
  /** Rename, mode, new and deleted markers: what a hunk cannot show. */
  metadata: string;
  hunks: OwnHunk[];
}

const METADATA = /^(?:old mode|new mode|deleted file mode|new file mode|similarity index|rename from|rename to|copy from|copy to|Binary files) /;

function hunkKey(body: string[]): string {
  const keep = new Set<number>();
  body.forEach((line, index) => {
    // `\ No newline at end of file` is part of what changed: adding or removing
    // a file's final newline is an edit, and without the marker it vanishes.
    if (!line.startsWith('+') && !line.startsWith('-') && !line.startsWith('\\')) return;
    keep.add(index);
    if (index > 0 && body[index - 1]!.startsWith(' ')) keep.add(index - 1);
    if (index + 1 < body.length && body[index + 1]!.startsWith(' ')) keep.add(index + 1);
  });
  return [...keep].sort((x, y) => x - y).map((index) => body[index]).join('\n');
}

function hunkSite(body: string[]): Set<string> {
  const site = new Set<string>();
  body.forEach((line, index) => {
    if (line.startsWith('-')) site.add(line);
    if (!line.startsWith('+') && !line.startsWith('-')) return;
    if (index > 0 && body[index - 1]!.startsWith(' ')) site.add(body[index - 1]!);
    if (index + 1 < body.length && body[index + 1]!.startsWith(' ')) site.add(body[index + 1]!);
  });
  return site;
}

/** The right-side path a `diff --git` header names, quoted or not. */
function gitHeaderPath(line: string): string | null {
  const quoted = /^diff --git (?:"(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/.exec(line);
  const raw = quoted?.[1] ?? /^diff --git (?:a\/)?.+? (b\/.+)$/.exec(line)?.[1] ?? null;
  return raw === null ? null : unquoteGitPath(raw).replace(/^b\//, '');
}

/**
 * Splits a patch into files and hunks for the own-diff comparison.
 *
 * Each file is registered from its `diff --git` header, so a change with no
 * hunk text at all - a pure rename, a mode change, an empty new file - is
 * still a change the comparison can see.
 */
export function ownDiffFiles(patch: string): Map<string, OwnFile> {
  const files = new Map<string, OwnFile>();
  let file: OwnFile | null = null;
  let hunk: string[] | null = null;

  const closeHunk = () => {
    // The patch's final newline leaves an empty line that is not part of it.
    while (hunk !== null && hunk.length > 1 && hunk.at(-1) === '') hunk.pop();
    if (file !== null && hunk !== null) {
      file.hunks.push({ key: hunkKey(hunk.slice(1)), site: hunkSite(hunk.slice(1)), text: hunk.join('\n') });
    }
    hunk = null;
  };

  for (const raw of patch.split('\n')) {
    // A carriage return is kept: changing a line's ending is an author edit,
    // and stripping it here would make that edit compare as unchanged. Only
    // the header path is read without it.
    const line = raw;
    if (line.startsWith('diff --git ')) {
      closeHunk();
      const path = gitHeaderPath(line.endsWith('\r') ? line.slice(0, -1) : line);
      file = { header: [line], metadata: '', hunks: [] };
      if (path !== null) files.set(path, file);
      continue;
    }
    if (line.startsWith('@@ ')) {
      closeHunk();
      hunk = [line];
      continue;
    }
    if (hunk !== null) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\') || line === '') {
        hunk.push(line);
        continue;
      }
      closeHunk();
    }
    if (file === null) continue;
    file.header.push(line);
    if (METADATA.test(line)) file.metadata += `${line}\n`;
  }
  closeHunk();
  return files;
}

interface OwnComparison {
  /** Hunks the head has that the reviewed head did not, per file. */
  added: Map<string, OwnHunk[]>;
  /** True when something changed that new head hunks cannot show. */
  unrepresentable: boolean;
}

/**
 * Compares two own diffs in both directions.
 *
 * Counted rather than set-matched, so a change the author made twice is two
 * changes. A hunk only the earlier diff has is a revert or a move; a file whose
 * rename or mode markers differ, or that only one side has with no hunk to show,
 * cannot be expressed as head hunks either. Both make the comparison
 * unrepresentable, and the caller reads the pull request in full.
 */
function compareOwnDiffs(before: Map<string, OwnFile>, after: Map<string, OwnFile>): OwnComparison {
  const added = new Map<string, OwnHunk[]>();
  let unrepresentable = false;

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const earlier = before.get(path);
    const later = after.get(path);
    if ((earlier?.metadata ?? '') !== (later?.metadata ?? '')) unrepresentable = true;

    const remaining = new Map<string, OwnHunk[]>();
    for (const hunk of earlier?.hunks ?? []) remaining.set(hunk.key, [...(remaining.get(hunk.key) ?? []), hunk]);
    const fresh: OwnHunk[] = [];
    for (const hunk of later?.hunks ?? []) {
      const left = remaining.get(hunk.key) ?? [];
      if (left.length > 0) remaining.set(hunk.key, left.slice(1));
      else fresh.push(hunk);
    }
    // A reviewed hunk that is gone is fine only when a new hunk sits on the
    // same site: the author rewrote that edit, and the new hunk shows the
    // result. Gone with nothing in its place is a revert or a move.
    // A gone hunk is replaced only by a new hunk whose site holds all of its
    // own, and each new hunk replaces at most one: two reviewed additions after
    // the same closing brace must not both be accounted for by one rewrite, or
    // the other's revert goes unread.
    const unused = [...fresh];
    for (const hunk of [...remaining.values()].flat()) {
      const index = unused.findIndex((candidate) => [...hunk.site].every((line) => candidate.site.has(line)));
      if (index === -1) unrepresentable = true;
      else unused.splice(index, 1);
    }
    // A file on one side only, with no hunk to carry it (an empty new file).
    if ((earlier === undefined) !== (later === undefined) && fresh.length === 0) unrepresentable = true;
    if (fresh.length > 0) added.set(path, fresh);
  }

  return { added, unrepresentable };
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
  return planScope(options).scope;
}

/** `planIncrementalScope`, plus the patch an `interdiff` scope reviews. */
export function planScope(options: PlanIncrementalScopeOptions): PlannedScope {
  const prior = options.priorRun;
  const only = (scope: ReviewScope): PlannedScope => ({ scope, interdiffPatch: null });

  if (options.forceFull) return only(full('requested', prior));
  if (prior === null) return only(full('no-prior-review', null));
  if (prior.headRef === options.head) return only(full('no-new-commits', prior));
  if (options.truncated) return only(full('truncated', prior));

  try {
    const git = options.git ?? systemGit;
    if (!options.headAvailable || !git.hasCommit(prior.headRef, options.cwd)) {
      return only(full('compare-unavailable', prior));
    }

    const ancestor = git.isAncestor(prior.headRef, options.head, options.cwd);
    const merged = ancestor && git.mergeCommits(prior.headRef, options.head, options.cwd).length > 0;

    // With the base known, the pull request's own diff is compared in every
    // shape, plain commits included. The commit range answers "what changed
    // since the reviewed head", which on a branch that restores code to its
    // merge-base state shows the restored lines as newly added; the own diff
    // answers what the author changes relative to the base, which is what a
    // review of a pull request is about.
    if (options.base !== undefined) {
      return ownDiffScope(options, prior, git, ancestor, merged);
    }

    if (!ancestor) return only(full('history-rewritten', prior));
    if (merged) return only(full('base-merged', prior));

    const files = changedReviewedFiles(
      options.reviewedFiles,
      git.changedPaths(prior.headRef, options.head, options.cwd),
    );
    if (files.length === 0) return only(full('base-sync-only', prior));

    return only(incremental(options, prior, git, files));
  } catch {
    // Narrowing on partial information is worse than re-reading a change. The
    // caller still receives a usable full diff and an honest explanation.
    return only(full('compare-unavailable', prior));
  }
}

function incremental(
  options: PlanIncrementalScopeOptions,
  prior: PriorPullReview,
  git: IncrementalGit,
  files: string[],
): ReviewScope {
  return {
    kind: 'incremental',
    since: prior.headRef,
    priorRunId: prior.reviewRunId,
    priorReviewedAt: prior.createdAt,
    commits: git.commitCount(prior.headRef, options.head, options.cwd),
    files,
  };
}

/**
 * Compares the pull request's own diff before and after a merged base or a
 * rewritten history, so base churn never reaches the review.
 *
 * Own diff means what the pull request shows: the head against its merge base
 * with the base branch. Both sides are read for the reviewed files only.
 */
function ownDiffScope(
  options: PlanIncrementalScopeOptions,
  prior: PriorPullReview,
  git: IncrementalGit,
  ancestor: boolean,
  merged: boolean,
): PlannedScope {
  const base = options.base as string;
  if (git.mergeBase === undefined || git.diffText === undefined || !git.hasCommit(base, options.cwd)) {
    return { scope: full('compare-unavailable', prior), interdiffPatch: null };
  }

  const paths = [
    ...new Set(
      options.reviewedFiles.flatMap((file) => (file.previousPath === undefined ? [file.path] : [file.path, file.previousPath])),
    ),
  ];
  const mergeBase = git.mergeBase(base, options.head, options.cwd);
  const before = ownDiffFiles(git.diffText(git.mergeBase(base, prior.headRef, options.cwd), prior.headRef, paths, options.cwd));
  const after = ownDiffFiles(git.diffText(mergeBase, options.head, paths, options.cwd));
  const { added, unrepresentable } = compareOwnDiffs(before, after);

  if (unrepresentable) return { scope: full('own-diff-unrepresentable', prior), interdiffPatch: null };

  const common = { since: prior.headRef, priorRunId: prior.reviewRunId, priorReviewedAt: prior.createdAt, mergeBase };

  if (added.size === 0) {
    const reason: UnchangedReason = !ancestor ? 'history-rewritten' : merged ? 'base-merged' : 'base-sync-only';
    return { scope: { kind: 'unchanged', ...common, reason }, interdiffPatch: null };
  }

  const reviewed = new Map<string, string>();
  for (const file of options.reviewedFiles) {
    reviewed.set(file.path, file.path);
    if (file.previousPath !== undefined) reviewed.set(file.previousPath, file.path);
  }

  const parts: string[] = [];
  const files = new Set<string>();
  let hunks = 0;
  for (const [path, fresh] of added) {
    const shown = reviewed.get(path);
    // Every path compared came from the reviewed list, so this cannot miss;
    // if it ever did, narrowing past it would be the silent skip to avoid.
    if (shown === undefined) return { scope: full('compare-unavailable', prior), interdiffPatch: null };
    files.add(shown);
    hunks += fresh.length;
    parts.push([...(after.get(path)?.header ?? []), ...fresh.map((hunk) => hunk.text)].join('\n'));
  }

  return {
    scope: { kind: 'interdiff', ...common, files: [...files].sort(), hunks },
    interdiffPatch: `${parts.join('\n')}\n`,
  };
}
