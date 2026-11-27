/**
 * After a timeout, abort or overflow `spawnCommand` reports status null, as
 * spawnSync did. A shell that outlived the group kill reports its last
 * command's SIGKILL as its own exit, 137, which a caller reading `status !==
 * null` would take as a command that finished (#512). The race is not
 * reproducible on demand, so the shell here outlives the kill by construction:
 * it is not detached, so the group kill finds no group and does nothing, and it
 * exits 137 only when the test lets it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandEnvironment, spawnCommand } from '../plugins/review-voice/src/evidence/run.ts';

const options = (cwd, over = {}) => ({
  cwd, env: commandEnvironment(process.env, []), shell: true, encoding: 'utf8',
  timeout: 0, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, detached: false, ...over,
});

async function until(path) {
  for (let waited = 0; !existsSync(path); waited += 20) {
    assert.ok(waited < 20000, `${path} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Runs a shell that exits with `code` once released, aborts it while it waits, then releases it. */
async function abortedThenExits(t, code) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-512-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ready = join(dir, 'ready');
  const gate = join(dir, 'gate');
  const controller = new AbortController();
  const running = spawnCommand(`: > "${ready}"; while [ ! -e "${gate}" ]; do sleep 0.02; done; exit ${code}`, options(dir, { signal: controller.signal }));
  await until(ready);
  controller.abort();
  writeFileSync(gate, '');
  return running;
}

test('#512: a stopped command whose shell exits 137 reports status null and the stop as its error', async (t) => {
  const result = await abortedThenExits(t, 137);
  assert.equal(result.status, null);
  assert.equal(result.error.code, 'ABORT_ERR');
});

test('#512: any other exit after a stop is kept, so a command that handled the stop is not hidden', async (t) => {
  const result = await abortedThenExits(t, 3);
  assert.equal(result.status, 3);
  assert.equal(result.error.code, 'ABORT_ERR');
});

test('#512: a command that was not stopped and exits 137 on its own keeps its status', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-512-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await spawnCommand('exit 137', options(dir));
  assert.equal(result.status, 137);
  assert.equal(result.error, undefined);
});
