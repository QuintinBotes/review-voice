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
  if (scope.kind === 'interdiff' && prior && typeof scope.mergeBase === 'string' && strings(scope.files) && Number.isInteger(scope.hunks)) {
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
    case 'interdiff':
      return `interdiff since ${scope.since.slice(0, 7)} (${scope.hunks} hunk${scope.hunks === 1 ? '' : 's'} in ${scope.files.length} file${scope.files.length === 1 ? '' : 's'})`;
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
  /** The site's base lines by their text, whether kept as context or removed. */
  siteText: Set<string>;
  /** Its `-`, `+` and `\` lines: exactly what the author's edit is. */
  changes: string[];
  /** The `@@` line, to say which hunk a full read was about. */
  header: string;
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

function hunkChanges(body: string[]): string[] {
  return body.filter((line) => line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'));
}

/** A site line is a context or removed line; both are base text after the prefix. */
function siteText(site: Set<string>): Set<string> {
  return new Set([...site].map((line) => line.slice(1)));
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
      const body = hunk.slice(1);
      const site = hunkSite(body);
      file.hunks.push({
        key: hunkKey(body),
        site,
        siteText: siteText(site),
        changes: hunkChanges(body),
        header: /^@@ [^@]* @@/.exec(hunk[0] ?? '')?.[0] ?? (hunk[0] ?? ''),
        text: hunk.join('\n'),
      });
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
  /** The first thing that made it so, naming the file. */
  reason: string | null;
}

/**
 * Whether a new hunk is the reviewed one with a neighbouring line edited.
 *
 * A follow-up that edits the line next to a reviewed hunk merges the two into
 * one hunk, and the reviewed hunk's context line there now shows as removed:
 * ` b` becomes `-b`. The exact site no longer matches, though the edit sits
 * where it did. Matching the site on line text alone would also accept a
 * revert of the reviewed edit next to that new edit, so the reviewed hunk's
 * own `-`, `+` and `\` lines must all still be in the new hunk, counted:
 * nothing the review saw was withdrawn, and the new hunk shows the rest.
 */
function keepsReviewedEdit(gone: OwnHunk, candidate: OwnHunk): boolean {
  if (![...gone.siteText].every((line) => candidate.siteText.has(line))) return false;
  const left = new Map<string, number>();
  for (const line of candidate.changes) left.set(line, (left.get(line) ?? 0) + 1);
  for (const line of gone.changes) {
    const count = left.get(line) ?? 0;
    if (count === 0) return false;
    left.set(line, count - 1);
  }
  return true;
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
  let reason: string | null = null;
  const because = (why: string) => {
    reason ??= why;
  };

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const earlier = before.get(path);
    const later = after.get(path);
    if ((earlier?.metadata ?? '') !== (later?.metadata ?? '')) {
      because(`${path}: its rename, mode, new or deleted marker changed`);
    }

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
    // the other's revert goes unread. An exact site match is a rewrite in
    // place; otherwise the new hunk must keep the reviewed edit whole, with
    // only a neighbouring line edited (see `keepsReviewedEdit`).
    const unused = [...fresh];
    for (const hunk of [...remaining.values()].flat()) {
      let index = unused.findIndex((candidate) => [...hunk.site].every((line) => candidate.site.has(line)));
      if (index === -1) index = unused.findIndex((candidate) => keepsReviewedEdit(hunk, candidate));
      if (index === -1) because(`${path}: the reviewed hunk ${hunk.header} was reverted or moved`);
      else unused.splice(index, 1);
    }
    // A file on one side only, with no hunk to carry it (an empty new file).
    if ((earlier === undefined) !== (later === undefined) && fresh.length === 0) {
      because(`${path}: on one side only, with no hunk to show it`);
    }
    if (fresh.length > 0) added.set(path, fresh);
  }

  return { added, unrepresentable: reason !== null, reason };
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
    // a merged base or a rewritten history compares the pull request's own
    // diff before and after, so base-branch work never reaches the review.
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
  if (git.mergeBase === undefined || git.diffText === undefined) {
    return { scope: full('compare-unavailable', prior, 'this git surface cannot read an own diff'), interdiffPatch: null };
  }
  if (!git.hasCommit(base, options.cwd)) {
    return { scope: full('compare-unavailable', prior, `the base ${base.slice(0, 7)} is not in this clone`), interdiffPatch: null };
  }

  const paths = [
    ...new Set(
      options.reviewedFiles.flatMap((file) => (file.previousPath === undefined ? [file.path] : [file.path, file.previousPath])),
    ),
  ];
  const mergeBase = git.mergeBase(base, options.head, options.cwd);
  const priorMergeBase = git.mergeBase(base, prior.headRef, options.cwd);

  // A plain follow-up - commits on top of the reviewed head, against the same
  // point on the base - holds nothing but author work between the two heads,
  // so that range is the review. Matching hunks there turned every revert,
  // move and new file into a full re-read of the pull request.
  if (ancestor && priorMergeBase === mergeBase) {
    return plainFollowUp(options, prior, git, mergeBase, paths);
  }

  const before = ownDiffFiles(git.diffText(priorMergeBase, prior.headRef, paths, options.cwd));
  const after = ownDiffFiles(git.diffText(mergeBase, options.head, paths, options.cwd));
  const { added, unrepresentable, reason } = compareOwnDiffs(before, after);

  if (unrepresentable) {
    return { scope: full('own-diff-unrepresentable', prior, reason ?? undefined), interdiffPatch: null };
  }

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
    if (shown === undefined) {
      return { scope: full('compare-unavailable', prior, `${path} changed but is not a reviewed file`), interdiffPatch: null };
    }
    files.add(shown);
    hunks += fresh.length;
    parts.push([...(after.get(path)?.header ?? []), ...fresh.map((hunk) => hunk.text)].join('\n'));
  }

  return {
    scope: { kind: 'interdiff', ...common, files: [...files].sort(), hunks },
    interdiffPatch: `${parts.join('\n')}\n`,
  };
}

/**
 * Reads a plain follow-up as the diff from the reviewed head to the new head.
 *
 * Only the pull request's files are read: those the full read would review
 * now, plus those the reviewed head changed that the new head no longer does,
 * so withdrawing a file's changes still shows as its removed lines.
 */
function plainFollowUp(
  options: PlanIncrementalScopeOptions,
  prior: PriorPullReview,
  git: IncrementalGit,
  mergeBase: string,
  reviewedPaths: string[],
): PlannedScope {
  const diffText = git.diffText as NonNullable<IncrementalGit['diffText']>;
  const current = new Set(git.changedPaths(mergeBase, options.head, options.cwd));
  const withdrawn = git.changedPaths(mergeBase, prior.headRef, options.cwd).filter((path) => !current.has(path));
  const patch = diffText(prior.headRef, options.head, [...new Set([...reviewedPaths, ...withdrawn])], options.cwd);

  const common = { since: prior.headRef, priorRunId: prior.reviewRunId, priorReviewedAt: prior.createdAt, mergeBase };
  if (patch.trim().length === 0) {
    return { scope: { kind: 'unchanged', ...common, reason: 'base-sync-only' }, interdiffPatch: null };
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
    scope: { kind: 'interdiff', ...common, files: [...files].sort(), hunks },
    interdiffPatch: patch,
  };
}
