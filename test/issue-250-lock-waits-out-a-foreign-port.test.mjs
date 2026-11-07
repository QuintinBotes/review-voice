/**
 * #250: a busy lock port whose holder is not a watcher is tried again a few
 * times before it counts as foreign. The port sits in the range the kernel
 * hands to outbound connections, so a passing connection, or another test's
 * server, can hold it for a moment; two watchers racing for such a port both
 * read it as foreign and neither ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, DEFAULT_LOCK_PATIENCE } from '../plugins/review-voice/src/watch/lock.ts';

/** A server on a free 127.0.0.1 port that answers nothing a watcher would. */
function occupant() {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      // Read the probe, or the paused socket never sees its close and server.close never settles.
      socket.resume();
      socket.end('not a watcher\n');
    });
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () =>
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) }),
    );
  });
}

function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-250-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a port freed while the lock waits is won on a later try', async (t) => {
  const dir = dataDir(t);
  const busy = await occupant();
  setTimeout(() => void busy.close(), 250);
  const started = Date.now();
  const lock = await acquireLock(dir, busy.port, { tries: 20, waitMs: 100 });
  assert.ok('release' in lock, JSON.stringify(lock));
  assert.ok(Date.now() - started >= 200, 'the port was waited for');
  lock.release();
});

test('a port that stays busy is foreign after the last try, not before', async (t) => {
  const dir = dataDir(t);
  const busy = await occupant();
  t.after(() => busy.close());
  const started = Date.now();
  const lock = await acquireLock(dir, busy.port, { tries: 3, waitMs: 100 });
  assert.deepEqual(lock, { foreign: busy.port });
  assert.ok(Date.now() - started >= 200, 'two waits passed before giving up');
});

test('a port held by a watcher names it at once, with no waiting', async (t) => {
  const dir = dataDir(t);
  const free = await occupant();
  await free.close();
  const holder = await acquireLock(dir, free.port);
  assert.ok('release' in holder, JSON.stringify(holder));
  try {
    const started = Date.now();
    const second = await acquireLock(dir, free.port, { tries: 3, waitMs: 1_000 });
    assert.deepEqual(second, { holder: process.pid });
    assert.ok(Date.now() - started < 1_000, 'a watcher is named without a wait');
  } finally {
    holder.release();
  }
});

test('the default patience is a few seconds, not a stall', () => {
  const total = DEFAULT_LOCK_PATIENCE.tries * DEFAULT_LOCK_PATIENCE.waitMs;
  assert.ok(total >= 1_000 && total <= 5_000, `${total} ms`);
});
