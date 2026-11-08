import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';

const PROBE_MS = 1_500;

/** 49152 to 65151, from the data directory, so each data directory has its own port. */
export function lockPort(dataDir: string): number {
  let path = dataDir;
  try {
    path = realpathSync(dataDir);
  } catch {
    // Not created yet: the path as given.
  }
  return 49152 + Number(createHash('sha256').update(path).digest().readBigUInt64BE(0) % 16000n);
}

export type LockResult = { release: () => void } | { holder: number } | { foreign: number };

const answer = (dataDir: string): string => `review-voice-watch ${process.pid} ${dataDir}\n`;

/** Asks whatever listens on the port who it is: a watcher's pid, or null. */
function probe(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let text = '';
    const done = (pid: number | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(pid);
    };
    const timer = setTimeout(() => done(null), PROBE_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write('review-voice-watch?\n'));
    socket.on('data', (chunk: string) => {
      text += chunk;
      if (!text.includes('\n')) return;
      const match = /^review-voice-watch (\d+) /.exec(text);
      done(match === null ? null : Number(match[1]));
    });
    socket.on('error', () => done(null));
    socket.on('end', () => done(null));
  });
}

/** How often, and how long apart, a busy port whose holder is not a watcher is tried again. */
export interface LockPatience {
  tries: number;
  waitMs: number;
}

/** About two and a half seconds in all: long enough for a passing connection, short enough to notice at startup. */
export const DEFAULT_LOCK_PATIENCE: LockPatience = { tries: 6, waitMs: 400 };

/**
 * One watcher per data directory (docs/adr/0027), held by the kernel: the
 * watcher listens on 127.0.0.1 at the data directory's port. Only one process
 * can, and the kernel frees the port when that process dies, so there is no
 * stale lock and no takeover. `watch.lock` gets the pid for people to read; it
 * decides nothing.
 *
 * The port sits inside the range the kernel hands to outbound connections
 * (all of it on macOS, the top of it on Linux), so an unrelated connection can
 * hold it for a moment. A busy port whose holder is not a watcher is therefore
 * tried again a few times before it counts as foreign (#250); a watcher that
 * answers is named at once.
 */
export async function acquireLock(dataDir: string, port = lockPort(dataDir), patience: LockPatience = DEFAULT_LOCK_PATIENCE): Promise<LockResult> {
  let server: Server;
  for (let attempt = 1; ; attempt += 1) {
    server = createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.end(answer(dataDir)));
    });
    const listening = server;
    const failure = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      listening.once('error', (error: NodeJS.ErrnoException) => resolve(error));
      listening.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(null));
    });
    if (failure === null) break;
    if (failure.code !== 'EADDRINUSE') throw failure;
    const holder = await probe(port);
    if (holder !== null) return { holder };
    if (attempt >= patience.tries) return { foreign: port };
    await new Promise((resolve) => setTimeout(resolve, patience.waitMs));
  }
  // The watcher's own work keeps the process alive; the lock must not keep a finished one running.
  server.unref();

  const display = join(dataDir, 'watch.lock');
  const mine = String(process.pid);
  try {
    writeFileSync(display, mine, { mode: 0o600 });
  } catch {
    // Display only.
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      server.close();
      try {
        if (readFileSync(display, 'utf8') === mine) unlinkSync(display);
      } catch {
        // Already gone.
      }
    },
  };
}
