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
  // Recorded by versions that matched own-diff hunks before and after a merge
  // or rebase. No longer produced; kept so those stored scopes still read back.
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
      /** Which files were read whole, and why, when some were. */
      detail?: string;
    }
  | {
      kind: 'full';
      cause: FullReviewCause;
      since: string | null;
      priorRunId: string | null;
      /**
       * Which condition fired, and for a failed git command which one and what
       * it said. A cause alone left a run that fell back to a full read with
       * nothing to go on; this is what to look at first.
       */
      detail?: string;
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
  if (
    scope.kind === 'interdiff' &&
    prior &&
    typeof scope.mergeBase === 'string' &&
    strings(scope.files) &&
    Number.isInteger(scope.hunks) &&
    (scope.detail === undefined || typeof scope.detail === 'string')
  ) {
    return scope as unknown as ReviewScope;
  }
  if (
    scope.kind === 'full' &&
    typeof scope.cause === 'string' &&
    nullableString(scope.since) &&
    nullableString(scope.priorRunId) &&
    (scope.detail === undefined || typeof scope.detail === 'string')
  ) {
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
    case 'interdiff': {
      const counts = `${scope.hunks} hunk${scope.hunks === 1 ? '' : 's'} in ${scope.files.length} file${scope.files.length === 1 ? '' : 's'}`;
      return `interdiff since ${scope.since.slice(0, 7)} (${scope.detail === undefined ? counts : `${counts}; ${scope.detail}`})`;
    }
    case 'full':
      return scope.detail === undefined ? `full (${scope.cause})` : `full (${scope.cause}: ${scope.detail})`;
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
  /** `from` may be a commit or a tree: a replayed head is only a tree. */
  diffText?(from: string, to: string, paths: string[], cwd: string): string;
  /**
   * The tree of `head` with its changes since `from` re-applied onto `onto`,
   * and the paths where they conflict. Only needed after a merge or a rebase.
   */
  replay?(from: string, onto: string, head: string, cwd: string): Replay;
}

/**
 * A replayed head. A conflicted path's file in `tree` holds conflict markers,
 * so it is no reference to read that file against.
 */
export interface Replay {
  tree: string;
  conflicts: string[];
}

/** `git merge-tree --merge-base` arrived in 2.40; `--write-tree` alone is 2.38. */
const REPLAY_GIT = [2, 40] as const;

export interface PlanIncrementalScopeOptions {
  priorRun: PriorPullReview | null;
  head: string;
  /** Established while acquiring the pull request, before planning begins. */
  headAvailable: boolean;
  /** Only files that the full pull-request read would otherwise review. */
  reviewedFiles: ReviewedPullFile[];
  /**
   * Files the pull request deletes at the head. A full read never reviews a
   * deletion, but a follow-up that deletes a file has changed the pull request
   * since the review, and leaving the file out of the patch would hide that.
   */
  deletedFiles?: string[] | undefined;
  cwd: string;
  truncated: boolean;
  forceFull: boolean;
  /**
   * The pull request's base commit. With it, a merged base or a rebase is
   * read as what the author changed since the review, replayed onto the new
   * base, so neither forces a full read. Without it every decision is the
   * commit-range one.
   */
  base?: string | undefined;
  git?: IncrementalGit | undefined;
  /**
   * Called once when the previous head is not in this clone, to fetch it. The
   * caller knows which repository is under review and whether `origin` is it;
   * the planner does not. Returns why the commit could not be fetched, or null
   * when a fetch ran, and never throws. Whether the commit is now readable is
   * asked of git again afterwards, not taken from the answer.
   */
  fetchPriorHead?: ((sha: string) => string | null) | undefined;
}

/** A planned scope, and the patch an `interdiff` scope reviews. */
export interface PlannedScope {
  scope: ReviewScope;
  interdiffPatch: string | null;
}

/**
 * One line naming a failed git command and what git said about it.
 *
 * Commit ids are shortened and pathspecs dropped, so the line stays readable
 * in a summary; the first line of stderr is usually git's own `fatal:` reason.
 */
export function gitFailure(args: string[], error: unknown): string {
  const end = args.indexOf('--');
  const command = (end === -1 ? args : args.slice(0, end))
    .map((arg) => (/^[0-9a-f]{40,64}$/.test(arg) ? arg.slice(0, 7) : arg))
    .join(' ');
  const failure = error as { stderr?: unknown; status?: unknown; message?: unknown };
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : '';
  const said =
    stderr.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ??
    (typeof failure.status === 'number' ? `exit status ${failure.status}` : String(failure.message ?? 'unknown error').split('\n')[0]);
  return `${command} failed: ${said}`;
}

/** The first line of a thrown value, for a detail that must stay one line. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
}

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Rethrown with the command named, so a full read can say which git step
    // failed; `status` is kept because `isAncestor` reads exit 1 as an answer.
    throw Object.assign(new Error(gitFailure(args, error)), { status: (error as { status?: unknown }).status });
  }
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
    // Without renames, so a renamed file lists both of its paths: a follow-up
    // that undoes a rename must show the old path coming back, not only the
    // new one going.
    return runGit(['diff', '--name-only', '--no-renames', '-z', since, head], cwd)
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
  replay(from, onto, head, cwd) {
    const version = /(\d+)\.(\d+)/.exec(runGit(['version'], cwd));
    const [major, minor] = [Number(version?.[1] ?? 0), Number(version?.[2] ?? 0)];
    if (major < REPLAY_GIT[0] || (major === REPLAY_GIT[0] && minor < REPLAY_GIT[1])) {
      throw new Error(
        `git ${version?.[0] ?? '(unknown version)'} cannot replay the reviewed head onto a new base; ` +
          `that needs git ${REPLAY_GIT.join('.')} or later`,
      );
    }
    const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', '--merge-base', from, onto, head];
    let output: string;
    let conflicted = false;
    try {
      output = execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // Exit 1 is merge-tree's answer for "conflicts", with the tree and the
      // conflicted paths still on stdout. Anything else is a failed command.
      const failure = error as { status?: unknown; stdout?: unknown };
      if (failure.status !== 1 || typeof failure.stdout !== 'string') throw new Error(gitFailure(args, error));
      output = failure.stdout;
      conflicted = true;
    }
    const [tree, ...paths] = output.split('\0').filter((part) => part.length > 0);
    if (tree === undefined || !/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git merge-tree returned no tree');
    return { tree, conflicts: conflicted ? [...new Set(paths)].sort() : [] };
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

function full(cause: FullReviewCause, priorRun: PriorPullReview | null, detail?: string): ReviewScope {
  return {
    kind: 'full',
    cause,
    since: priorRun?.headRef ?? null,
    priorRunId: priorRun?.reviewRunId ?? null,
    ...(detail === undefined ? {} : { detail }),
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

/** One hunk of a patch, keyed by what it changes. */
interface OwnHunk {
  /**
   * Its `-`/`+` lines, plus the context line directly before and after each
   * run of them. Not its `@@` numbers, so a hunk that only shifted is the same
   * hunk; but its immediate neighbours, so the same edit moved elsewhere in the
   * file is a different one.
   */
  key: string;
}

interface OwnFile {
  hunks: OwnHunk[];
}

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

/** The right-side path a `diff --git` header names, quoted or not. */
function gitHeaderPath(line: string): string | null {
  const quoted = /^diff --git (?:"(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/.exec(line);
  const raw = quoted?.[1] ?? /^diff --git (?:a\/)?.+? (b\/.+)$/.exec(line)?.[1] ?? null;
  return raw === null ? null : unquoteGitPath(raw).replace(/^b\//, '');
}

/**
 * Splits a patch into files and hunks, to count what an interdiff holds.
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
      file.hunks.push({ key: hunkKey(hunk.slice(1)) });
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
      file = { hunks: [] };
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
  }
  closeHunk();
  return files;
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
    if (!options.headAvailable) {
      return only(full('compare-unavailable', prior, `the head ${options.head.slice(0, 7)} is not in this clone`));
    }
    if (!git.hasCommit(prior.headRef, options.cwd)) {
      // A force-push leaves the reviewed head reachable from no ref this clone
      // fetched, though origin usually still has it. Ask for it by sha before
      // giving up on a narrower read.
      const why = options.fetchPriorHead?.(prior.headRef) ?? null;
      if (!git.hasCommit(prior.headRef, options.cwd)) {
        const missing = `the previous head ${prior.headRef.slice(0, 7)} is not in this clone`;
        return only(full('compare-unavailable', prior, why === null ? missing : `${missing}; ${why}`));
      }
    }

    const ancestor = git.isAncestor(prior.headRef, options.head, options.cwd);
    const merged = ancestor && git.mergeCommits(prior.headRef, options.head, options.cwd).length > 0;

    // With the base known, a plain follow-up is read as the commit range, and
    // a merged base or a rewritten history as the head against the reviewed
    // head replayed onto the new base, so base-branch work never reaches the
    // review.
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
  } catch (error) {
    // Narrowing on partial information is worse than re-reading a change. The
    // caller still receives a usable full diff and an honest explanation.
    return only(full('compare-unavailable', prior, firstLine(error)));
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
 * Reads what the author changed since the review, wherever the base moved.
 *
 * The reviewed head is first put where the head now stands: on a plain
 * follow-up, or a rewrite that kept the merge base, it already is; after a
 * merged base or a rebase it is replayed onto the new merge base, which is
 * what the reviewed pull request would look like had it branched there. The
 * head against that is only what the author changed since the review: new
 * commits, and any rewrite of their own code while resolving the merge. The
 * base's own changes are on both sides and cancel out.
 */
function ownDiffScope(
  options: PlanIncrementalScopeOptions,
  prior: PriorPullReview,
  git: IncrementalGit,
  ancestor: boolean,
  merged: boolean,
): PlannedScope {
  const base = options.base as string;
  if (git.mergeBase === undefined || git.diffText === undefined) {
    return { scope: full('compare-unavailable', prior, 'this git surface cannot read an own diff'), interdiffPatch: null };
  }
  if (!git.hasCommit(base, options.cwd)) {
    return { scope: full('compare-unavailable', prior, `the base ${base.slice(0, 7)} is not in this clone`), interdiffPatch: null };
  }

  const mergeBase = git.mergeBase(base, options.head, options.cwd);
  const priorMergeBase = git.mergeBase(base, prior.headRef, options.cwd);
  const paths = pullRequestPaths(options, prior, git, priorMergeBase, mergeBase);

  // Commits on top of the reviewed head, against the same point on the base,
  // hold nothing but author work, so that range is the review. A rewrite that
  // kept the merge base needs no replay either: the reviewed head is already
  // the pull request on this base.
  if (priorMergeBase === mergeBase) {
    return interdiffFrom(options, prior, git, prior.headRef, mergeBase, paths, ancestor ? 'base-sync-only' : 'history-rewritten');
  }

  if (git.replay === undefined) {
    return { scope: full('compare-unavailable', prior, 'this git surface cannot replay the reviewed head'), interdiffPatch: null };
  }
  const replayed = git.replay(priorMergeBase, mergeBase, prior.headRef, options.cwd);
  return interdiffFrom(
    options,
    prior,
    git,
    replayed.tree,
    mergeBase,
    paths,
    !ancestor ? 'history-rewritten' : merged ? 'base-merged' : 'base-sync-only',
    replayed.conflicts,
  );
}

/**
 * The pull request's files, on either side of the review.
 *
 * Those the full read would review now under both names of a rename, those it
 * deletes now, and those the reviewed head changed that the head no longer
 * does, so withdrawing a file's changes still shows as its removed lines.
 */
function pullRequestPaths(
  options: PlanIncrementalScopeOptions,
  prior: PriorPullReview,
  git: IncrementalGit,
  priorMergeBase: string,
  mergeBase: string,
): string[] {
  const reviewed = options.reviewedFiles.flatMap((file) =>
    file.previousPath === undefined ? [file.path] : [file.path, file.previousPath],
  );
  const current = new Set(git.changedPaths(mergeBase, options.head, options.cwd));
  const withdrawn = git.changedPaths(priorMergeBase, prior.headRef, options.cwd).filter((path) => !current.has(path));
  return [...new Set([...reviewed, ...(options.deletedFiles ?? []), ...withdrawn])];
}

/**
 * Reads the head against `from` - the reviewed head, or its replay onto the
 * new base - over the pull request's files only.
 *
 * A file whose replay conflicted has only markers to compare with, so it is
 * read whole: the pull request's own diff of it on the new base, which shows
 * the author's resolution and everything else the pull request does there,
 * and none of the base's changes. If that own diff is empty the author
 * resolved by dropping their change, and the marker diff is the only place
 * the withdrawal shows, so that file keeps it.
 */
function interdiffFrom(
  options: PlanIncrementalScopeOptions,
  prior: PriorPullReview,
  git: IncrementalGit,
  from: string,
  mergeBase: string,
  paths: string[],
  unchangedReason: UnchangedReason,
  conflicts: string[] = [],
): PlannedScope {
  const diffText = git.diffText as NonNullable<IncrementalGit['diffText']>;
  // No pathspec means the whole range to git: with no pull request files, the
  // change since the review is nothing, never every file in the repository.
  const read = (left: string, list: string[]): string => (list.length === 0 ? '' : diffText(left, options.head, list, options.cwd));

  // A conflicted path outside the pull request's files stays out, as it would
  // without the conflict.
  const wanted = new Set(paths);
  const conflicted = conflicts.filter((path) => wanted.has(path));
  const whole = read(mergeBase, conflicted);
  const readWhole = new Set(ownDiffFiles(whole).keys());
  const rest = paths.filter((path) => !readWhole.has(path));
  const patch = [read(from, rest), whole].filter((part) => part.length > 0).join('');
  const detail =
    readWhole.size === 0 ? {} : { detail: `read whole after a conflicting replay: ${[...readWhole].sort().join(', ')}` };

  const common = { since: prior.headRef, priorRunId: prior.reviewRunId, priorReviewedAt: prior.createdAt, mergeBase };
  if (patch.trim().length === 0) {
    return { scope: { kind: 'unchanged', ...common, reason: unchangedReason }, interdiffPatch: null };
  }

  const reviewed = new Map<string, string>();
  for (const file of options.reviewedFiles) {
    reviewed.set(file.path, file.path);
    if (file.previousPath !== undefined) reviewed.set(file.previousPath, file.path);
  }
  const files = new Set<string>();
  let hunks = 0;
  for (const [path, file] of ownDiffFiles(patch)) {
    files.add(reviewed.get(path) ?? path);
    hunks += file.hunks.length;
  }

  return {
    scope: { kind: 'interdiff', ...common, files: [...files].sort(), hunks, ...detail },
    interdiffPatch: patch,
  };
}
