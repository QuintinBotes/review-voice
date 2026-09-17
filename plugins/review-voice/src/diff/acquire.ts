import { execFileSync } from 'node:child_process';
import { classify, isReviewable, languageOf, type FileClass } from './classify.ts';

export interface ChangedFile {
  path: string;
  /** Previous path when the change is a rename. */
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'changed';
  class: FileClass;
  language: string | null;
  additions: number;
  deletions: number;
  reviewed: boolean;
  /** Why an excluded file was excluded, so the omission is visible. */
  excludedBecause?: string;
}

export interface DiffResult {
  repositoryRoot: string;
  mode: 'worktree' | 'staged' | 'base' | 'pull-request';
  base: string | null;
  head: string;
  files: ChangedFile[];
  reviewedFileCount: number;
  /**
   * Reviewed files that actually produced diff content.
   *
   * Separate from `reviewedFileCount` because the two answer different
   * questions. That one asks whether there is anything to look at, and an
   * untracked new file legitimately counts. This asks how big the change is,
   * and a file contributing no hunks legitimately does not. On a live run a
   * stray `$HOME/` directory and another project's handover notes took the
   * reviewed count from 11 to 17 and bought word budget with nothing in them.
   */
  hunkFileCount: number;
  excludedFileCount: number;
  /** Unified diff restricted to reviewable files. Empty when nothing qualifies. */
  diff: string;
}

export class GitError extends Error {}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new GitError(`git ${args[0]} failed: ${stderr.trim() || String(error)}`);
  }
}

/**
 * `git diff --no-index` exits 1 when the files differ, which is the normal
 * case here rather than a failure. Its stdout is still the diff.
 */
function gitAllowingDifference(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const typed = error as { status?: number; stdout?: string };
    if (typed.status === 1 && typeof typed.stdout === 'string') return typed.stdout;
    throw new GitError(`git ${args[0]} failed: ${String(error)}`);
  }
}

/**
 * Untracked files are invisible to `git diff`, but a brand-new file is exactly
 * where defects hide. They are collected separately and diffed against
 * /dev/null so they reach the reviewer, without `git add -N` mutating the
 * user's index - Review Voice is read-only, and that includes their working
 * state.
 */
function untrackedFiles(root: string): string[] {
  return git(['ls-files', '--others', '--exclude-standard', '-z'], root)
    .split('\0')
    .filter((path) => path.length > 0);
}

export function repositoryRoot(cwd: string): string {
  // Resolving the root means the command works from any subdirectory, which is
  // where people actually run it.
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

const STATUS: Record<string, ChangedFile['status']> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed',
};

/** Parse `git diff --name-status -z`, which is NUL-delimited to survive odd paths. */
function parseNameStatus(raw: string): { status: string; path: string; previousPath?: string }[] {
  const fields = raw.split('\0').filter((field) => field.length > 0);
  const out: { status: string; path: string; previousPath?: string }[] = [];

  for (let i = 0; i < fields.length; ) {
    const code = fields[i]!;
    // Renames and copies carry a similarity score and two paths.
    if (code.startsWith('R') || code.startsWith('C')) {
      out.push({ status: code[0]!, previousPath: fields[i + 1]!, path: fields[i + 2]! });
      i += 3;
    } else {
      out.push({ status: code[0]!, path: fields[i + 1]! });
      i += 2;
    }
  }
  return out;
}

function excludedReason(cls: FileClass): string {
  switch (cls) {
    case 'lockfile': return 'lock file; use --include-generated if the dependency change is the point';
    case 'vendored': return 'vendored dependency';
    case 'generated': return 'generated or minified';
    case 'binary': return 'binary';
    default: return '';
  }
}

export interface AcquireOptions {
  cwd: string;
  staged: boolean;
  base: string | null;
  includeGenerated: boolean;
}

export function acquireDiff(options: AcquireOptions): DiffResult {
  const root = repositoryRoot(options.cwd);

  const range: string[] = options.base !== null
    ? [`${options.base}...HEAD`]
    : options.staged
      ? ['--cached']
      : [];

  const mode: DiffResult['mode'] = options.base !== null ? 'base' : options.staged ? 'staged' : 'worktree';

  const entries = parseNameStatus(git(['diff', '--name-status', '-z', ...range], root));

  // Per-file line counts, so a caller can judge the size of a change from the
  // tool's own output rather than guessing.
  const numstat = new Map<string, { additions: number; deletions: number }>();
  for (const line of git(['diff', '--numstat', ...range], root).split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (match === null) continue;
    numstat.set(match[3]!, {
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }

  // Only the working tree can have untracked files; --staged and --base both
  // describe content git already knows about.
  if (mode === 'worktree') {
    for (const path of untrackedFiles(root)) {
      entries.push({ status: 'A', path });
    }
  }

  const files: ChangedFile[] = entries.map((entry) => {
    const cls = classify(entry.path);
    // A deleted file has no content to review; its removal shows up in the
    // diff of whatever referenced it.
    const deleted = entry.status === 'D';
    const reviewed = !deleted && isReviewable(entry.path, options.includeGenerated);
    return {
      path: entry.path,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
      status: STATUS[entry.status] ?? 'changed',
      class: cls,
      language: languageOf(entry.path),
      additions: numstat.get(entry.path)?.additions ?? 0,
      deletions: numstat.get(entry.path)?.deletions ?? 0,
      reviewed,
      ...(reviewed ? {} : { excludedBecause: deleted ? 'file deleted' : excludedReason(cls) }),
    };
  });

  const reviewable = files.filter((file) => file.reviewed).map((file) => file.path);

  const untracked = new Set(mode === 'worktree' ? untrackedFiles(root) : []);
  const trackedReviewable = reviewable.filter((path) => !untracked.has(path));
  const untrackedReviewable = reviewable.filter((path) => untracked.has(path));

  const parts: string[] = [];
  if (trackedReviewable.length > 0) {
    parts.push(git(['diff', ...range, '--', ...trackedReviewable], root));
  }
  for (const path of untrackedReviewable) {
    parts.push(gitAllowingDifference(['diff', '--no-index', '--', '/dev/null', path], root));
  }
  const diff = parts.join('').trim().length === 0 ? '' : parts.join('');

  // Which reviewed files actually carry a hunk. Read from the assembled diff
  // rather than from numstat, because an untracked file has no numstat entry
  // at all and would otherwise be indistinguishable from an empty one.
  const hunkPaths = new Set<string>();
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const path = match[1];
    if (path !== undefined && path !== '/dev/null') hunkPaths.add(path);
  }

  return {
    repositoryRoot: root,
    mode,
    base: options.base,
    head: git(['rev-parse', 'HEAD'], root).trim(),
    files,
    reviewedFileCount: reviewable.length,
    // Counted from the diff itself, not from the file list: a file can be
    // reviewable, present and empty.
    hunkFileCount: reviewable.filter((path) => hunkPaths.has(path)).length,
    excludedFileCount: files.length - reviewable.length,
    diff,
  };
}
