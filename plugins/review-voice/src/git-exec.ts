import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCommand } from './evidence/run.ts';

/**
 * Bounded git reads that hold when a descendant keeps the pipes open
 * (issues #482, #493).
 *
 * In a partial clone, `cat-file` lazily starts `git fetch` over ssh. The
 * fetch and ssh hold stdout and stderr, so killing only the direct child
 * leaves the sleeper holding the pipes. Git runs detached in its own
 * process group and the timer ends the whole group (the tree on Windows)
 * before git is reaped, as `evidence/run.ts` does.
 */

/** One bound for a whole `cat-file --batch`: a large diff can legitimately fetch many blobs. */
export const CAT_FILE_BATCH_TIMEOUT_MS = 120_000;
/** A per-blob bound for a single `cat-file blob`. */
export const CAT_FILE_BLOB_TIMEOUT_MS = 30_000;

function timeoutFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  // Only ever shortens the bound, so a stray override cannot bring back an unbounded wait.
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, fallback) : fallback;
}

/** The batch bound, injectable in tests through the environment. Read at call time. */
export function catFileBatchTimeoutMs(): number {
  return timeoutFromEnv('REVIEW_VOICE_CAT_FILE_BATCH_TIMEOUT_MS', CAT_FILE_BATCH_TIMEOUT_MS);
}

/** The per-blob bound, injectable in tests through the environment. Read at call time. */
export function catFileBlobTimeoutMs(): number {
  return timeoutFromEnv('REVIEW_VOICE_CAT_FILE_BLOB_TIMEOUT_MS', CAT_FILE_BLOB_TIMEOUT_MS);
}

let warnedAboutPartialClone = false;

/** Test seam: a fresh command would warn again. */
export function resetCatFileTimeoutWarning(): void {
  warnedAboutPartialClone = false;
}

function readGitConfig(root: string): string {
  const texts: string[] = [];
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };
  const dotGit = read(join(root, '.git'));
  // A worktree's `.git` is a file naming its git directory; the shared
  // config then sits in the common directory it names.
  let gitDir = join(root, '.git');
  if (dotGit !== null && dotGit.startsWith('gitdir:')) {
    const named = dotGit.slice('gitdir:'.length).trim();
    gitDir = named.startsWith('/') ? named : join(root, named);
    const common = read(join(gitDir, 'commondir'))?.trim();
    if (common !== undefined && common !== '') {
      gitDir = common.startsWith('/') ? common : join(gitDir, common);
    }
  }
  const config = read(join(gitDir, 'config'));
  if (config !== null) texts.push(config);
  return texts.join('\n');
}

/**
 * Whether the repository is a partial clone, read from its config file
 * rather than by spawning git, since the git that just timed out is the
 * last thing to ask. A clone made with `--filter` records
 * `remote.<name>.partialclonefilter`.
 */
export function isPartialClone(root: string): boolean {
  return /partialclonefilter/i.test(readGitConfig(root));
}

function warnPartialCloneOnce(root: string): void {
  if (warnedAboutPartialClone) return;
  if (!isPartialClone(root)) return;
  warnedAboutPartialClone = true;
  console.error(
    'review-voice: a git command timed out; this repository is a partial clone, so a lazy fetch of missing blobs is the likely cause. Continuing without those blobs.',
  );
}

export interface GitCatFileOptions {
  input?: string;
  maxBuffer: number;
  timeoutMs: number;
}

/** A local-object check (`cat-file -e`, `rev-parse --verify`): a lazy fetch is the only slow case. */
export const GIT_CHECK_TIMEOUT_MS = 10_000;
/** Any other git read or fetch in the diff and conventions path (issue #487). */
export const GIT_READ_TIMEOUT_MS = 60_000;

/** The bound for a git call in the diff path, injectable in tests; like the cat-file bounds it can only shorten. */
export function gitTimeoutMs(fallback: number): number {
  return timeoutFromEnv('REVIEW_VOICE_GIT_TIMEOUT_MS', fallback);
}

/** Options that bound a synchronous git child process: a SIGKILL timeout and capped output (issue #502). */
export function boundedGit(timeoutMs: number, maxBuffer: number = 64 * 1024 * 1024): { timeout: number; killSignal: 'SIGKILL'; maxBuffer: number } {
  return { timeout: gitTimeoutMs(timeoutMs), killSignal: 'SIGKILL', maxBuffer };
}

/** The same bounded, group-killed run for any git command; `maxBuffer` defaults to 64 MiB. Failures carry `status`, `stdout` and `stderr` (strings) as `execFileSync` errors did. */
export function runGit(
  root: string,
  args: readonly string[],
  options: { input?: string; maxBuffer?: number; timeoutMs: number },
): Promise<Buffer> {
  return runGitCatFile(root, args, { maxBuffer: 64 * 1024 * 1024, ...options });
}

/**
 * Runs `git <args>` in `root`, bounded by `timeoutMs`, and resolves to
 * stdout. Rejects on spawn failure, timeout (with `code` `ETIMEDOUT`),
 * overflow or a non-zero exit, as `execFileSync` did, so callers keep
 * treating a failure as an unreadable blob. A timeout in a partial clone
 * names it once on stderr.
 *
 * The shared `spawnCommand` runner ends the group (POSIX) or the tree
 * (Windows) from its timer, while git is still unreaped, so the group id
 * is still ours. It never signals after git has returned (issue #493).
 * Being async, a stop signal to the CLI is no longer blocked behind git.
 */
export async function runGitCatFile(root: string, args: readonly string[], options: GitCatFileOptions): Promise<Buffer> {
  const result = await spawnCommand('git', {
    cwd: root,
    env: process.env,
    shell: false,
    args,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: options.maxBuffer,
    detached: process.platform !== 'win32',
    bytes: true,
    killAfterClose: false,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') {
    warnPartialCloneOnce(root);
    const bound = options.timeoutMs < 1000 ? `${options.timeoutMs}ms` : `${options.timeoutMs / 1000}s`;
    throw Object.assign(new Error(`git ${args.join(' ')} timed out after ${bound}`), { code: 'ETIMEDOUT' });
  }
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw Object.assign(new Error(`git ${args.join(' ')} failed${stderr === '' ? '' : `: ${stderr}`}`), {
      status: result.status,
      stdout: result.stdout,
      stderr,
    });
  }
  return result.stdoutBytes ?? Buffer.alloc(0);
}
