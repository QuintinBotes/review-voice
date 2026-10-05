import { execFileSync } from 'node:child_process';
import { GitHubClient } from '../github/client.ts';
import { classify, findHandEdited, isReviewable, languageOf } from './classify.ts';
import type { ChangedFile, DiffResult } from './acquire.ts';
import { gitFailure, topPathspecs, type ReviewScope } from './incremental.ts';
import { parseHunks } from './hunks.ts';

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

interface RawPull {
  number: number;
  title: string;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
  changed_files: number;
  additions: number;
  deletions: number;
}

const STATUS: Record<string, ChangedFile['status']> = {
  added: 'added',
  modified: 'modified',
  removed: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
};

/** Rebuilds a unified diff header from the per-file patches the API returns. */
function toUnifiedDiff(file: RawFile): string {
  const previous = file.previous_filename ?? file.filename;
  return [
    `diff --git a/${previous} b/${file.filename}`,
    `--- a/${previous}`,
    `+++ b/${file.filename}`,
    file.patch ?? '',
    '',
  ].join('\n');
}

/**
 * Acquires a pull request's diff through the read-only GitHub client.
 *
 * The repository is passed as the client's allowlist for this call. Naming a
 * pull request in a command IS the consent for reading it - the allowlist
 * exists to govern bulk history ingestion, which happens without per-item
 * consent, and applying it here would demand setup before someone can review
 * one pull request.
 */
/**
 * GitHub's own ceiling for the files endpoint. Fetching up to it costs one
 * request per hundred files and is far cheaper than reviewing a pull request
 * without knowing what is in it.
 */
const GITHUB_MAX_FILES = 3000;

/**
 * Whether a commit is in the local object store, and whether we put it there.
 *
 * Stated rather than assumed. `diff --pr` builds the whole diff from the API
 * and never touches local git, so nothing downstream had grounds to believe
 * `base` or `head` could be read. On a live run the head commit was simply
 * absent: the verifier hit `fatal: bad object` and fell back to reading
 * head-side code from the patch alone, which is the same shape as a guard
 * searching the wrong tree.
 */
export interface RefAvailability {
  base: { sha: string; available: boolean };
  head: { sha: string; available: boolean };
  /** True only when this call fetched. Never inferred from an exit status. */
  fetched: boolean;
  note: string | null;
}

function git(args: string[], cwd: string, timeout = 60_000): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout,
  });
}

/** Whether a commit object is present, asked of git rather than assumed. */
function hasCommit(sha: string, cwd: string): boolean {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`], cwd, 10_000);
    return true;
  } catch {
    return false;
  }
}

/** The owner/repo the `origin` remote points at, or null. */
function originRepository(cwd: string): string | null {
  try {
    const url = git(['remote', 'get-url', 'origin'], cwd, 10_000).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Makes a pull request's commits readable locally, when that is safe.
 *
 * Gated on `origin` actually resolving to the repository under review. Fetching
 * `pull/<n>/head` from an unrelated clone yields plausible commits from the
 * wrong project, which is strictly worse than their absence.
 *
 * Fetches into a namespaced ref so nothing of the user's moves. Review Voice is
 * read-only with respect to working state; writing loose objects and one ref
 * under `refs/review-voice/` is the most this may do.
 */
function ensureRefs(options: {
  repository: string;
  pullNumber: number;
  base: string;
  head: string;
  cwd: string;
}): RefAvailability {
  const check = (): { base: boolean; head: boolean } => ({
    base: hasCommit(options.base, options.cwd),
    head: hasCommit(options.head, options.cwd),
  });

  let present = check();
  const result = (fetched: boolean, note: string | null): RefAvailability => ({
    base: { sha: options.base, available: present.base },
    head: { sha: options.head, available: present.head },
    fetched,
    note,
  });

  if (present.base && present.head) return result(false, null);

  const origin = originRepository(options.cwd);
  if (origin === null) {
    return result(false, 'No origin remote resolved, so the pull request commits were not fetched.');
  }
  if (origin.toLowerCase() !== options.repository.toLowerCase()) {
    return result(
      false,
      `origin is ${origin} but the review is of ${options.repository}, so nothing was fetched. ` +
        'Fetching a pull request from an unrelated clone would supply commits from the wrong project.',
    );
  }

  try {
    git(
      [
        'fetch',
        '--no-tags',
        '--quiet',
        'origin',
        `pull/${options.pullNumber}/head:refs/review-voice/pr/${options.pullNumber}/head`,
      ],
      options.cwd,
    );
  } catch {
    // Never fatal. A pull request stays reviewable with no network; the
    // availability below simply reports what is actually in the object store.
  }

  present = check();

  // `pull/<n>/head` brings the base only while it is still an ancestor of the
  // head. Once the base branch moves on, the sha GitHub reports is reachable
  // from no pull ref, and anything that reads the base (`score --base`) fails.
  // Ask for that one commit by sha; it is not fatal for the same reason.
  if (!present.base) {
    try {
      git(['fetch', '--no-tags', '--quiet', 'origin', options.base], options.cwd);
    } catch {
      // The server may refuse a fetch by sha. The note below says so.
    }
    present = check();
  }

  if (present.base && present.head) {
    return result(true, null);
  }

  const missing = [!present.base ? 'base' : null, !present.head ? 'head' : null].filter(Boolean);
  return result(
    true,
    `The ${missing.join(' and ')} commit could not be made available locally. ` +
      'Reading code at that ref will fail, so evidence from it is unavailable rather than absent.',
  );
}

export interface PullRequestDiff extends DiffResult {
  title: string;
  /** What GitHub says the pull request contains, not what we managed to read. */
  totalChangedFiles: number;
  additions: number;
  deletions: number;
  /** True when files were not fetched. Never silent: see truncationNote. */
  truncated: boolean;
  truncationNote: string | null;
  /** Whether the pull request's commits can actually be read locally. */
  refs: RefAvailability;
}

/** A pull-request diff with the exact boundary the caller will review. */
export interface ScopedPullRequestDiff extends PullRequestDiff {
  pullNumber: number;
  scope: ReviewScope;
  /** Printed after findings when a clean incremental result would mislead. */
  scopeNote: string | null;
}

/** "the review of <date>" when a run was recorded, else "the review at <sha>". */
function earlierReview(scope: { since: string; priorReviewedAt: string | null }): string {
  return scope.priorReviewedAt === null
    ? `the review at ${scope.since.slice(0, 7)}`
    : `the review of ${scope.priorReviewedAt.slice(0, 10)}`;
}

function scopeNote(scope: Exclude<ReviewScope, { kind: 'full' }>): string {
  switch (scope.kind) {
    case 'incremental':
      return (
        `Reviewed ${scope.commits} commit(s) since ${scope.since.slice(0, 7)}; ` +
        `earlier changes were covered by ${earlierReview(scope)}.`
      );
    case 'unchanged':
      return (
        `No change to this pull request's own diff since ${scope.since.slice(0, 7)}; ` +
        `${earlierReview(scope)} still applies.`
      );
    case 'interdiff':
      return (
        `Reviewed changes to this pull request's own diff since ${scope.since.slice(0, 7)}; ` +
        'base-branch changes merged in were not reviewed.'
      );
  }
}

function pathsWithHunks(diff: string): Set<string> {
  // The hunk parser decodes paths git quoted, which a header regex would not.
  return new Set([...parseHunks(diff)].filter(([, file]) => file.ranges.length > 0).map(([path]) => path));
}

function fullScopeResult(
  result: PullRequestDiff,
  pullNumber: number,
  scope: Extract<ReviewScope, { kind: 'full' }>,
): ScopedPullRequestDiff {
  return { ...result, pullNumber, scope, scopeNote: null };
}

/**
 * Applies a planned boundary to an already acquired pull-request result.
 *
 * The API's patch remains the authoritative full diff. Only after the planner
 * proved that the local range is safe do we substitute a local patch; if that
 * final read fails, preserving the full patch is safer than returning nothing.
 */
export function applyReviewScope(
  result: PullRequestDiff,
  pullNumber: number,
  scope: ReviewScope,
  cwd: string,
  readIncrementalDiff: (since: string, head: string, files: string[], cwd: string) => string =
    (since, head, files, root) => {
      const args = ['diff', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', since, head, '--', ...topPathspecs(files)];
      try {
        return execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        });
      } catch (error) {
        throw new Error(gitFailure(args, error));
      }
    },
  interdiffPatch: string | null = null,
): ScopedPullRequestDiff {
  if (scope.kind === 'full') return fullScopeResult(result, pullNumber, scope);

  const fallBack = (detail: string): ScopedPullRequestDiff =>
    fullScopeResult(result, pullNumber, {
      kind: 'full',
      cause: 'compare-unavailable',
      since: scope.since,
      priorRunId: scope.priorRunId,
      detail,
    });

  let diff: string;
  let included: Set<string>;
  if (scope.kind === 'unchanged') {
    diff = '';
    included = new Set();
  } else if (scope.kind === 'interdiff') {
    // Only the planner can produce this patch; without it there is nothing
    // narrower that is known to be safe.
    if (interdiffPatch === null) return fallBack('an interdiff scope came with no interdiff patch');
    diff = interdiffPatch;
    included = new Set(scope.files);
  } else {
    try {
      diff = readIncrementalDiff(scope.since, result.head, scope.files, cwd);
    } catch (error) {
      // The planner's probes passed, but the final range read can still lose a
      // race with local object cleanup. Do not present an incomplete patch as a
      // narrowed review; retain the API patch and name the uncertainty instead.
      return fallBack(`reading the incremental diff failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
    }
    included = new Set(scope.files);
  }

  const excludedBecause = `unchanged since the last review (${scope.since.slice(0, 7)})`;
  const files = result.files.map((file) => {
    if (file.reviewed && !included.has(file.path)) return { ...file, reviewed: false, excludedBecause };
    // A full read skips a deletion, but an interdiff that holds one is the
    // change since the review: counted as unreviewed, a follow-up that only
    // deletes a file would read as nothing to review.
    if (scope.kind === 'interdiff' && file.status === 'deleted' && included.has(file.path)) {
      const { excludedBecause: _skipped, ...rest } = file;
      return { ...rest, reviewed: true };
    }
    return file;
  });
  const hunkPaths = pathsWithHunks(diff);
  const reviewedFileCount = files.filter((file) => file.reviewed).length;

  return {
    ...result,
    pullNumber,
    scope,
    scopeNote: scopeNote(scope),
    files,
    reviewedFileCount,
    hunkFileCount: files.filter((file) => file.reviewed && hunkPaths.has(file.path)).length,
    excludedFileCount: files.length - reviewedFileCount,
    diff,
  };
}

export async function acquirePullRequestDiff(options: {
  repository: string;
  pullNumber: number;
  includeGenerated: boolean;
  maxFiles?: number;
  /** Where to check for, and fetch, the pull request's commits. */
  cwd?: string;
}): Promise<PullRequestDiff> {
  const client = new GitHubClient({ allowlist: [options.repository] });

  const { data: pull } = await client.get<RawPull>(
    `/repos/${options.repository}/pulls/${options.pullNumber}`,
  );

  // The cap has to sit above classification, not below it. An earlier version
  // fetched 300 files and then filtered: on a pull request that is mostly
  // generated code, that could exhaust the budget before reaching a single
  // source file, and review the wrong part of the change.
  const limit = options.maxFiles ?? GITHUB_MAX_FILES;
  const rawFiles = await client.paginate<RawFile>(
    `/repos/${options.repository}/pulls/${options.pullNumber}/files?per_page=100`,
    limit,
  );

  const truncated = rawFiles.length < pull.changed_files;

  // A generated file with a do-not-edit header that changed alone in its
  // generated directory is a hand edit. Prefer the head content, which holds
  // the header even when the patch does not reach it; with no head commit
  // locally, fall back to the patch's added lines and leave the file excluded
  // when those do not show the header.
  const cwd = options.cwd ?? process.cwd();
  const headLocal = hasCommit(pull.head.sha, cwd);
  const byName = new Map(rawFiles.map((file) => [file.filename, file]));
  const handEdited = findHandEdited(
    rawFiles.filter((file) => file.status !== 'removed' && file.patch !== undefined).map((file) => file.filename),
    (path) => {
      if (headLocal) {
        try {
          return git(['show', `${pull.head.sha}:${path}`], cwd);
        } catch {
          return null;
        }
      }
      const added = (byName.get(path)?.patch ?? '')
        .split('\n')
        .filter((line) => line.startsWith('+'))
        .map((line) => line.slice(1));
      return added.join('\n');
    },
  );

  const files: ChangedFile[] = rawFiles.map((file) => {
    const cls = classify(file.filename);
    const deleted = file.status === 'removed';
    const suspected = handEdited.has(file.filename);
    const reviewed =
      !deleted && (suspected || isReviewable(file.filename, options.includeGenerated)) && file.patch !== undefined;

    let excludedBecause: string | undefined;
    if (!reviewed) {
      if (deleted) excludedBecause = 'file deleted';
      else if (file.patch === undefined) excludedBecause = 'no patch returned (binary or too large)';
      else excludedBecause = `${cls} file`;
    }

    return {
      path: file.filename,
      ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
      status: STATUS[file.status] ?? 'changed',
      class: cls,
      language: languageOf(file.filename),
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      reviewed,
      ...(suspected ? { handEditSuspected: true } : {}),
      ...(excludedBecause === undefined ? {} : { excludedBecause }),
    };
  });

  const diff = rawFiles
    .filter((file) => files.find((f) => f.path === file.filename)?.reviewed === true)
    .map(toUnifiedDiff)
    .join('');

  return {
    repositoryRoot: options.repository,
    mode: 'pull-request',
    base: pull.base.sha,
    head: pull.head.sha,
    title: pull.title,
    files,
    reviewedFileCount: files.filter((file) => file.reviewed).length,
    // A pull request file with no patch is already excluded, so every reviewed
    // file here carries a hunk by construction.
    hunkFileCount: files.filter((file) => file.reviewed).length,
    excludedFileCount: files.filter((file) => !file.reviewed).length,
    diff,
    totalChangedFiles: pull.changed_files,
    additions: pull.additions,
    deletions: pull.deletions,
    truncated,
    // Reviewing part of a change and presenting it as the whole is the one
    // failure mode a reviewer cannot recover from, because nothing downstream
    // can tell that anything is missing.
    truncationNote: truncated
      ? `Only ${rawFiles.length} of ${pull.changed_files} changed files were read. This review covers part of the change.`
      : null,
    refs: ensureRefs({
      repository: options.repository,
      pullNumber: options.pullNumber,
      base: pull.base.sha,
      head: pull.head.sha,
      cwd,
    }),
  };
}
