import { execFile, spawn } from 'node:child_process';
import { formatDuration } from './config.ts';

/** What one `review` run reported, read from its exit code and JSON. */
export interface ReviewResult {
  exitCode: number;
  runId: string | null;
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' | null;
  reviewUrl: string | null;
  detail: string | null;
  /** The review JSON said the owner's approval was carried and nothing was posted. */
  carried?: boolean;
}

export type ReviewPullRequest = (args: {
  repository: string;
  pull: number;
  clone: string;
  post: boolean;
  mode?: string | undefined;
  /** The head the queue read; the review exits 3 when the pull request is elsewhere at its start. */
  expectHead: string;
  timeoutMs: number;
  /** `watch.run_repository_commands`; off sets REVIEW_VOICE_NO_COMMANDS=1 for the review. */
  runRepositoryCommands: boolean;
}) => Promise<ReviewResult>;

const EVENTS = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const;

const EXIT_DETAIL: Record<number, string> = {
  2: 'review refused',
  3: 'head moved',
  4: 'waiting on CI',
  6: 'CI needs a rerun',
  7: 'an agent failed twice',
  8: 'someone else raised a finding during the review',
};

/** The result of a finished `review`; every field it cannot find is null. */
export function reviewResult(exitCode: number, stdout: string, stderr: string): ReviewResult {
  let doc: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
  } catch {
    // No JSON: the exit code and stderr are all there is.
  }
  const verdict = typeof doc['verdict'] === 'object' && doc['verdict'] !== null ? (doc['verdict'] as Record<string, unknown>) : {};
  const event = EVENTS.find((candidate) => candidate === verdict['event']) ?? null;
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
  const lastLine = stderr.trim().split('\n').at(-1)?.trim() ?? '';
  const detail =
    exitCode === 0
      ? null
      : [EXIT_DETAIL[exitCode] ?? `review exited ${exitCode}`, lastLine].filter((part) => part.length > 0).join(': ').slice(0, 300);
  const carried = doc['carried'] === true || verdict['action'] === 'carry';
  return { exitCode, runId: text(doc['runId']), event, reviewUrl: text(doc['reviewUrl']), detail, carried };
}

export interface SpawnOptions {
  /** The watcher's copy of its own config, passed as REVIEW_VOICE_CONFIG so the clone's config is never read. */
  configPath: string | null;
  /** Between SIGTERM and SIGKILL; default 10 s. */
  graceMs?: number;
}

/** A review that is ended, with its process group, when it outlives the timeout or the watcher. */
export type StoppableReview = ReviewPullRequest & { stop: () => Promise<void> };

/** How long stdout may stay open after the review exited: a descendant can hold it. */
const DRAIN_MS = 1_000;

function killGroup(pid: number | undefined, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // No process groups: taskkill ends the tree, and has no gentle form for a console-less child.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Runs `review` from this same bundle in the clone, as its own process group,
 * so a timeout or a stopped watcher also ends the agents it started: SIGTERM,
 * then SIGKILL after the grace period. The promise settles on exit (allowing
 * stdout a moment to drain) or when the grace period ends, never only on the
 * pipes closing, which a stray descendant can put off forever.
 */
export function spawnReview(bundle: string, options: SpawnOptions): StoppableReview {
  const graceMs = options.graceMs ?? 10_000;
  const live = new Map<number, { terminate: () => void; done: Promise<void> }>();
  const review: ReviewPullRequest = ({ repository, pull, clone, post, mode, expectHead, timeoutMs, runRepositoryCommands }) =>
    new Promise((resolve) => {
      const args = [bundle, 'review', '--pr', String(pull), '--repository', repository, '--json', '--expect-head', expectHead];
      if (post) args.push('--post', '--recheck-thread');
      if (mode !== undefined) args.push('--mode', mode);
      const env = { ...process.env };
      if (options.configPath !== null) env['REVIEW_VOICE_CONFIG'] = options.configPath;
      if (runRepositoryCommands) delete env['REVIEW_VOICE_NO_COMMANDS'];
      else env['REVIEW_VOICE_NO_COMMANDS'] = '1';
      const child = spawn(process.execPath, args, { cwd: clone, env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const pid = child.pid;
      let stdout = '';
      let stderr = '';
      let spawnError = '';
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let timedOut = false;
      let terminating = false;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      let markDone = (): void => {};
      const done = new Promise<void>((resolveDone) => (markDone = resolveDone));
      const timers: NodeJS.Timeout[] = [];
      const later = (ms: number, fn: () => void): void => {
        timers.push(setTimeout(fn, ms));
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        clearTimeout(grace);
        if (pid !== undefined) live.delete(pid);
        markDone();
        if (timedOut) {
          resolve({ exitCode: 124, runId: null, event: null, reviewUrl: null, detail: `review timed out after ${formatDuration(timeoutMs)}` });
        } else {
          const why = stderr.length > 0 ? stderr : exitSignal !== null ? `killed by ${exitSignal}` : spawnError;
          resolve(reviewResult(exitCode ?? 1, stdout, why));
        }
      };
      const terminate = (): void => {
        if (terminating || settled) return;
        terminating = true;
        killGroup(pid, 'SIGTERM');
        grace = setTimeout(() => {
          killGroup(pid, 'SIGKILL');
          finish();
        }, graceMs);
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => {
        spawnError = error.message;
        finish();
      });
      child.on('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        if (terminating) {
          // The review is gone; whatever it left in its group goes now, while the group id cannot have been reused.
          killGroup(pid, 'SIGKILL');
          clearTimeout(grace);
        }
        later(DRAIN_MS, finish);
      });
      child.on('close', finish);
      later(timeoutMs, () => {
        timedOut = true;
        terminate();
      });
      if (pid !== undefined) live.set(pid, { terminate, done });
    });
  return Object.assign(review, {
    stop: async () => {
      const running = [...live.values()];
      for (const entry of running) entry.terminate();
      await Promise.all(running.map((entry) => entry.done));
    },
  });
}
