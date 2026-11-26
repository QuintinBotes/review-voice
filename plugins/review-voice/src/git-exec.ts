import { spawnSync, type SpawnSyncOptionsWithBufferEncoding } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Synchronous `git cat-file` with a bound that holds when a descendant
 * keeps the pipes open (issue #482).
 *
 * In a partial clone, `cat-file` lazily starts `git fetch` over ssh. The
 * fetch and ssh hold stdout and stderr, so killing only the direct child
 * leaves the sleeper holding the pipes and spawnSync waiting on them (or,
 * once it gives up, the sleeper outliving the command). Git runs detached
 * in its own process group; after spawnSync returns, on timeout, on
 * failure and on success, the whole group is killed, following the
 * pattern in `evidence/run.ts` and `watch/review.ts` for a call that must
 * stay synchronous. spawnSync's own timeout is what makes the call
 * return; the group kill is what makes the descendant go with it.
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

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // No process groups: taskkill ends the tree.
    // shortcut: spawnSync has already reaped git here, so /T may not reach a fetch or ssh it
    // started; upgrade to a job object if a Windows user reports a leftover git or ssh.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone, which is the usual case on success.
  }
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
    'review-voice: git cat-file timed out; this repository is a partial clone, so a lazy fetch of missing blobs is the likely cause. Continuing without those blobs.',
  );
}

export interface GitCatFileOptions {
  input?: string;
  maxBuffer: number;
  timeoutMs: number;
}

/**
 * Runs `git <args>` synchronously in `root`, bounded by `timeoutMs`, and
 * returns stdout. Throws on spawn failure, timeout (with `code`
 * `ETIMEDOUT`), overflow or a non-zero exit, as `execFileSync` did, so
 * callers keep treating a failure as an unreadable blob. A timeout in a
 * partial clone names it once on stderr.
 */
export function runGitCatFileSync(root: string, args: readonly string[], options: GitCatFileOptions): Buffer {
  // `detached` is forwarded by spawnSync to spawn, so the child leads
  // its own process group, though `SpawnSyncOptions` in @types/node
  // omits it. Naming the extra field here keeps the rest type-checked.
  const spawnOptions: SpawnSyncOptionsWithBufferEncoding & { detached: boolean } = {
    cwd: root,
    ...(options.input === undefined ? {} : { input: options.input }),
    maxBuffer: options.maxBuffer,
    timeout: options.timeoutMs,
    killSignal: 'SIGKILL',
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  const result = spawnSync('git', [...args], spawnOptions);
  // Whatever the outcome, nothing git started outlives the call. On
  // Windows the tree kill spawns taskkill, so it runs only when the call
  // did not finish cleanly, since a pipe-holding descendant makes spawnSync
  // report ETIMEDOUT even when git itself exited 0.
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  if (process.platform !== 'win32' || result.error !== undefined || result.status !== 0) {
    killGroup(result.pid);
  }
  if (timedOut) warnPartialCloneOnce(root);
  if (result.error !== undefined) {
    if (timedOut) {
      const bound = options.timeoutMs < 1000 ? `${options.timeoutMs}ms` : `${options.timeoutMs / 1000}s`;
      const error = new Error(`git ${args.join(' ')} timed out after ${bound}`);
      (error as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      throw error;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8').trim() ?? '';
    throw new Error(`git ${args.join(' ')} failed${stderr === '' ? '' : `: ${stderr}`}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}
