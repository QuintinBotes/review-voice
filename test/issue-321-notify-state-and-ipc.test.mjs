/**
 * Issue 321. Two checks of the macOS reproduction sandbox made from outside it.
 * The notify probe reads the state of its escape key as well as the lines its
 * listener prints, so its answer does not rest on the order notifyd delivers
 * in, and it passes only when its own notification attempt ran. And a
 * reproduction run is bracketed by listings of the System V IPC objects of the
 * user: one that appears during the run is left in place and named, and the
 * run counts as not run. Everything here runs through a fake spawner, on every host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { probeSandbox, reproduce } from '../plugins/review-voice/src/evidence/reproduce.ts';

const NOTIFYUTIL = '/usr/bin/notifyutil';
const IPCS = '/usr/bin/ipcs';
const IPCRM = '/usr/bin/ipcrm';
const MARKER = 'RV_REPRO_REACHED cand_001';
const USER = userInfo().username;
const PASSED = { platform: 'darwin', mechanism: 'sandbox-exec', probe: 'passed' };

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A clone with one commit, and a run directory inside a data directory holding a linked head worktree, as the driver lays it out. */
function scratchRepository(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rv-321-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clone = join(dir, 'clone');
  mkdirSync(join(clone, 'src'), { recursive: true });
  git(clone, 'init', '-q', '-b', 'main');
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Test');
  git(clone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(clone, 'src/add.mjs'), 'export const add = (a, b) => a - b;\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'base');
  const dataDir = join(dir, 'data');
  const runDir = join(dataDir, 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  const worktree = join(runDir, 'head');
  git(clone, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return { dir, clone, dataDir, runDir, worktree, home };
}

const context = (repo, spawn, platform = 'darwin') => ({
  worktree: repo.worktree, runDir: repo.runDir, clone: repo.clone, dataDir: repo.dataDir, home: repo.home,
  config: { enabled: true, runners: [{ name: 'node-test', run: 'node --test {file}', extension: '.test.mjs', timeoutSeconds: 120 }], linkPaths: [], memoryMb: 1024, cpuSeconds: 60 },
  env: { PATH: '/usr/bin:/bin' }, platform, spawn, execPath: '/opt/node/bin/node',
});

const verification = { verifications: [{ candidate_id: 'cand_001', reproduction: { runner: 'node-test', path: 'src/add.repro.test.mjs', content: 'test\n', expected: 'add subtracts' } }] };
const blocking = new Map([['cand_001', { candidate_id: 'cand_001', path: 'src/add.mjs', line: 1, severity: 'blocking' }]]);
const failing = { status: 1, stdout: `# ${MARKER}\nnot ok 1\n`, stderr: '' };

/** The key the macOS probe posts, read from its script. */
const notifyKey = (options) => /"notify":"([^"]+)"/.exec(options.args.at(-1))?.[1];

/**
 * notifyd and notifyutil as the probe uses them. A listener takes each key
 * with `-w` (every notification) or `-1` (one, after which it no longer
 * holds the key) and prints a key as a notification of it arrives, unless the
 * test marks that line lost. As the real notifyd does, a key keeps its state
 * only while some listener holds it, and `-g` prints `<key> <state>`.
 */
function fakeNotifyd() {
  const listeners = new Set();
  const states = new Map();
  const holds = (key) => [...listeners].some((listener) => listener.held.has(key));
  const forget = () => {
    for (const key of states.keys()) if (!holds(key)) states.delete(key);
  };
  const notify = (args, options = {}) => {
    if (args[0] === '-p') {
      for (const listener of [...listeners]) listener.receive(args[1]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '-g') return { status: 0, stdout: `${args[1]} ${states.get(args[1]) ?? 0}\n`, stderr: '' };
    assert.ok(args.length === 6 && args.every((arg, at) => at % 2 === 1 || arg === '-w' || arg === '-1'), `one listener for three keys: ${args.join(' ')}`);
    return new Promise((done) => {
      let stdout = '';
      const listener = {
        keys: [args[1], args[3], args[5]],
        held: new Map([[args[1], args[0]], [args[3], args[2]], [args[5], args[4]]]),
        lost: new Set(),
        receive: (key) => {
          const kind = listener.held.get(key);
          if (kind === undefined) return;
          if (kind === '-1') listener.held.delete(key);
          forget();
          if (!listener.lost.has(key)) {
            stdout += `${key}\n`;
            options.onStdout?.(`${key}\n`);
          }
          if (listener.held.size === 0) listener.end({ status: 0, stderr: '' });
        },
        end: (result) => {
          if (!listeners.delete(listener)) return;
          forget();
          done({ ...result, stdout });
        },
      };
      listeners.add(listener);
      const aborted = Object.assign(new Error(`spawn ${NOTIFYUTIL} ABORT_ERR`), { code: 'ABORT_ERR' });
      options.signal?.addEventListener('abort', () => listener.end({ status: null, stderr: '', error: aborted }));
    });
  };
  const set = (key, value) => {
    if (holds(key)) states.set(key, value);
  };
  return { notify, set, listener: () => [...listeners][0], listening: () => listeners.size };
}

/**
 * ipcs -c and ipcrm as macOS prints and takes them, over a list of objects
 * (type q, m or s, id, owner, creator). `fail` answers a listing (by its
 * number, from 1) in place of the fake. ipcrm is there only to record a call
 * the CLI must never make.
 */
function fakeIpc(objects = [], fail = {}) {
  const removals = [];
  let listings = 0;
  const header = 'T     ID     KEY        MODE       OWNER    GROUP  CREATOR   CGROUP';
  const rows = (type) => objects.filter((object) => object.type === type).map((object) => `${type} ${object.id} 0x00000000 --rw------- ${object.owner ?? USER}    staff ${object.creator ?? object.owner ?? USER}    staff`);
  const run = (command, args) => {
    if (command === IPCS) {
      listings += 1;
      const over = fail.list?.(listings);
      if (over !== undefined) return over;
      const text = ['IPC status from <running system> as of Thu Nov 12 09:00:00 CET 2026', header, 'Message Queues:', ...rows('q'), '', header, 'Shared Memory:', ...rows('m'), '', header, 'Semaphores:', ...rows('s'), ''];
      return { status: 0, stdout: `${text.join('\n')}\n`, stderr: '' };
    }
    removals.push(args);
    for (let at = 0; at < args.length; at += 2) {
      const index = objects.findIndex((object) => `-${object.type}` === args[at] && String(object.id) === args[at + 1]);
      assert.ok(index >= 0, `ipcrm ${args[at]} ${args[at + 1]} names an object that exists`);
      objects.splice(index, 1);
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, objects, removals, listings: () => listings };
}

/** A spawner for the probe and the runs: notifyutil, ipcs and ipcrm go to the fakes, every other command is the probe or the next run. */
function fakeHost({ runs = [], onRun = () => {}, onProbe = () => {}, ipc = fakeIpc(), notifyd = fakeNotifyd(), probe = { status: 0, stdout: 'RV_PROBE_OK\n', stderr: '' } } = {}) {
  const calls = [];
  const spawn = async (command, options) => {
    calls.push({ command, args: options.args ?? [] });
    if (command === NOTIFYUTIL) return notifyd.notify(options.args, options);
    if (command === IPCS || command === IPCRM) return ipc.run(command, options.args ?? []);
    if (options.args.at(-1).includes('RV_PROBE_OK')) {
      onProbe(options, notifyd);
      return probe;
    }
    onRun(options, ipc);
    const next = runs.shift();
    assert.ok(next !== undefined, 'a run nobody expected');
    return { stdout: '', stderr: '', status: 0, ...next };
  };
  return { spawn, calls, notifyd, ipc, runs: () => calls.filter((call) => call.command === '/usr/bin/sandbox-exec' && !call.args.at(-1).includes('RV_PROBE_OK')) };
}

// The notify probe, decided by the state of its key as well as by the lines.

test('on macOS an escape whose line the listener never prints is still seen in the state of its key, and is the escape notify', async (t) => {
  const repo = scratchRepository(t);
  // The probe got out: it set the key and posted it, and the listener took the post, but its line is lost, as when the port had filled.
  const onProbe = (options, notifyd) => {
    const key = notifyKey(options);
    notifyd.listener().lost.add(key);
    notifyd.set(key, 1);
    notifyd.notify(['-p', key]);
  };
  const host = fakeHost({ onProbe });
  assert.deepEqual(await probeSandbox(context(repo, host.spawn)), { platform: 'darwin', mechanism: 'none', probe: 'escaped by notify' });
  assert.equal(host.notifyd.listening(), 0, 'no listener is left');
});

test('on macOS any state of the escape key but 0 is the escape notify, not only 1', async (t) => {
  for (const value of [2, 7, Number.MAX_SAFE_INTEGER]) {
    const onProbe = (options, notifyd) => {
      const key = notifyKey(options);
      notifyd.listener().lost.add(key);
      notifyd.set(key, value);
      notifyd.notify(['-p', key]);
    };
    const host = fakeHost({ onProbe });
    assert.deepEqual(await probeSandbox(context(scratchRepository(t), host.spawn)), { platform: 'darwin', mechanism: 'none', probe: 'escaped by notify' }, `state ${value}`);
  }
});

test('on macOS a state of the escape key that cannot be read fails the probe closed', async (t) => {
  const repo = scratchRepository(t);
  const missing = Object.assign(new Error(`spawn ${NOTIFYUTIL} ENOENT`), { code: 'ENOENT' });
  const cases = [
    [() => ({ status: 1, stdout: '', stderr: '' }), 'notifyutil -g exited 1'],
    [() => ({ status: null, stdout: '', stderr: '', error: missing }), `spawn ${NOTIFYUTIL} ENOENT`],
    [(key) => ({ status: 0, stdout: `${key} one\n`, stderr: '' }), (key) => `notifyutil -g printed an unexpected line: ${key} one`],
    [() => ({ status: 0, stdout: 'rv.probe.other 0\n', stderr: '' }), 'notifyutil -g printed an unexpected line: rv.probe.other 0'],
    // A key nobody holds has no state, so a read once the listener has ended says nothing.
    [(key, notifyd) => {
      notifyd.listener().end({ status: 1, stderr: '' });
      return { status: 0, stdout: `${key} 0\n`, stderr: '' };
    }, 'the listener ended before the state was read'],
  ];
  for (const [answer, why] of cases) {
    const host = fakeHost();
    let key;
    const spawn = (command, options) => {
      if (command === NOTIFYUTIL && options.args[0] === '-g') {
        key = options.args[1];
        return answer(key, host.notifyd);
      }
      return host.spawn(command, options);
    };
    const state = await probeSandbox(context(repo, spawn));
    const reason = typeof why === 'function' ? why(key) : why;
    assert.deepEqual(state, { platform: 'darwin', mechanism: 'none', probe: `could not read the state of the notification key: ${reason}` }, reason);
    assert.equal(host.notifyd.listening(), 0, `${reason}: no listener is left`);
  }
});

test('on macOS the probe passes with the escape key unset, read once the last key is heard and before the listener is killed', async (t) => {
  const repo = scratchRepository(t);
  const host = fakeHost();
  const alive = [];
  const spawn = (command, options) => {
    if (command === NOTIFYUTIL && options.args[0] === '-g') alive.push(host.notifyd.listening());
    return host.spawn(command, options);
  };
  assert.deepEqual(await probeSandbox(context(repo, spawn)), PASSED);
  const [listener, ...rest] = host.calls;
  const [escape, post, pre] = [listener.args[1], listener.args[3], listener.args[5]];
  // Every notification of the escape key, so its registration, and with it the state, lasts until the listener is killed.
  assert.deepEqual(listener.args, ['-w', escape, '-1', post, '-1', pre]);
  const reads = rest.flatMap((call, at) => (call.args[0] === '-g' ? [at] : []));
  assert.deepEqual(reads.map((at) => rest[at].args), [['-g', escape]], 'the state of the escape key is read once');
  assert.deepEqual(rest[reads[0] - 1].args, ['-p', post], 'after the last key');
  assert.deepEqual(alive, [1], 'while the listener still holds the key');
  assert.equal(host.notifyd.listening(), 0, 'and the listener is killed after');
});

test('on macOS an escape line the listener prints while the state is being read is the escape notify', async (t) => {
  const repo = scratchRepository(t);
  const host = fakeHost();
  // The probe left the state at 0, and its post reaches the listener only after the last key, while the CLI reads the state.
  let key;
  const spawn = (command, options) => {
    if (options.args.at(-1).includes('RV_PROBE_OK')) key = notifyKey(options);
    if (command === NOTIFYUTIL && options.args[0] === '-g') host.notifyd.notify(['-p', key]);
    return host.spawn(command, options);
  };
  assert.deepEqual(await probeSandbox(context(repo, spawn)), { platform: 'darwin', mechanism: 'none', probe: 'escaped by notify' });
  assert.equal(host.notifyd.listening(), 0, 'no listener is left');
});

// The notification attempt of the probe itself, which must have run for the probe to pass.

/**
 * Runs the probe script the CLI wrote with node, outside any sandbox, with
 * every target but the notification one pointed at nothing, as the profile
 * would refuse it, and `fake` in place of notifyutil.
 */
function runProbeScript(repo, fake) {
  const written = readFileSync(join(repo.runDir, 'reproductions', 'probe', 'probe.js'), 'utf8');
  const nowhere = join(repo.dir, 'nowhere');
  const swaps = [
    [/^const t = (.+);$/m, (_, json) => `const t = ${JSON.stringify({ ...JSON.parse(json), port: 0, escape: join(nowhere, 'escape'), canary: join(nowhere, 'canary'), overwrite: join(nowhere, 'overwrite'), pid: null, domain: null })};`],
    ["'/dev/pts'", () => JSON.stringify(join(nowhere, 'pts'))],
    [JSON.stringify(NOTIFYUTIL), () => JSON.stringify(fake)],
  ];
  let script = written;
  for (const [from, to] of swaps) {
    assert.ok(typeof from === 'string' ? script.includes(from) : from.test(script), `the probe script holds ${from}`);
    script = script.replace(from, to);
  }
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A notifyutil of the test's own, which does only what `body` says. */
function fakeNotifyutil(repo, name, body) {
  const path = join(repo.dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test('on macOS a probe whose notification attempt did not run, or did not end as a refused one does, fails closed with the reason', async (t) => {
  const repo = scratchRepository(t);
  const absent = join(repo.dir, 'absent');
  const cases = [
    [absent, `spawnSync ${absent} ENOENT`],
    [fakeNotifyutil(repo, 'killed', 'kill -KILL $$'), 'notifyutil was killed by SIGKILL'],
    [fakeNotifyutil(repo, 'odd', 'exit 3'), 'notifyutil exited 3'],
    // Past the time the probe gives it, which ends it.
    [fakeNotifyutil(repo, 'slow', 'exec sleep 60'), `spawnSync ${join(repo.dir, 'slow')} ETIMEDOUT`],
  ];
  for (const [fake, why] of cases) {
    const host = fakeHost();
    const spawn = (command, options) => (options.args.at(-1).includes('RV_PROBE_OK') ? runProbeScript(repo, fake) : host.spawn(command, options));
    assert.deepEqual(await probeSandbox(context(repo, spawn)), { platform: 'darwin', mechanism: 'none', probe: `could not test notifications: ${why}` }, why);
    assert.equal(host.notifyd.listening(), 0, `${why}: no listener is left`);
  }
});

test('on macOS a probe whose notification attempt ran and exited 0, as a refused one does, still passes', async (t) => {
  const repo = scratchRepository(t);
  const called = join(repo.dir, 'called');
  const fake = fakeNotifyutil(repo, 'refused', `printf '%s\\n' "$*" > '${called}'`);
  const host = fakeHost();
  let key;
  const spawn = (command, options) => {
    if (!options.args.at(-1).includes('RV_PROBE_OK')) return host.spawn(command, options);
    key = notifyKey(options);
    return runProbeScript(repo, fake);
  };
  assert.deepEqual(await probeSandbox(context(repo, spawn)), PASSED);
  assert.equal(readFileSync(called, 'utf8'), `-s ${key} 1 -p ${key}\n`, 'the attempt sets and posts the escape key');
});

// System V IPC objects a run leaves behind.

test('on macOS a System V IPC object created during a run is left in place and named, and the run is recorded as not run', async (t) => {
  const repo = scratchRepository(t);
  const ipc = fakeIpc([{ type: 's', id: 7 }]);
  // Two made during the run: one the user owns, and one created by the user and now owned by another.
  const onRun = () => ipc.objects.push({ type: 'm', id: 65536 }, { type: 'q', id: 131072, owner: 'nobody', creator: USER });
  const host = fakeHost({ runs: [failing, failing], onRun, ipc });
  const report = await reproduce(verification, blocking, context(repo, host.spawn));
  assert.deepEqual(report.sandbox, PASSED);
  const [record] = report.reproductions;
  assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', 'System V IPC objects appeared during the run and were left in place: q 131072, m 65536', 1]);
  assert.doesNotMatch(record.reason, /\bs 7\b/, 'the one from before is not mentioned');
  assert.deepEqual(ipc.removals, [], 'nothing is removed');
  assert.ok(!host.calls.some((call) => call.command === IPCRM), 'ipcrm is never called');
  assert.deepEqual(ipc.objects, [{ type: 's', id: 7 }, { type: 'm', id: 65536 }, { type: 'q', id: 131072, owner: 'nobody', creator: USER }], 'every object is still there');
  assert.equal(host.runs().length, 1, 'run 2 never starts');
});

test('on macOS a System V IPC object a run made is named even when the run also changed its copy', async (t) => {
  const repo = scratchRepository(t);
  const ipc = fakeIpc();
  const onRun = (options) => {
    ipc.objects.push({ type: 'm', id: 65536 });
    writeFileSync(join(options.cwd, 'extra.txt'), 'x\n');
  };
  const host = fakeHost({ runs: [failing, failing], onRun, ipc });
  const report = await reproduce(verification, blocking, context(repo, host.spawn));
  const [record] = report.reproductions;
  assert.deepEqual([record.outcome, record.reason], ['did-not-run', 'System V IPC objects appeared during the run and were left in place: m 65536'], 'checked before the copy is');
  assert.deepEqual(ipc.removals, [], 'nothing is removed');
  assert.deepEqual(ipc.objects, [{ type: 'm', id: 65536 }]);
  assert.equal(host.runs().length, 1, 'run 2 never starts');
});

test('on macOS a System V IPC object that existed before a run, or that another user made during it, is left alone', async (t) => {
  const repo = scratchRepository(t);
  const before = [{ type: 'q', id: 1 }, { type: 'm', id: 2 }, { type: 's', id: 3 }, { type: 'm', id: 4, owner: 'nobody' }];
  const ipc = fakeIpc([...before]);
  const onRun = () => {
    if (!ipc.objects.some((object) => object.id === 5)) ipc.objects.push({ type: 'm', id: 5, owner: 'nobody' });
  };
  const host = fakeHost({ runs: [failing, failing], onRun, ipc });
  const report = await reproduce(verification, blocking, context(repo, host.spawn));
  assert.deepEqual(report.reproductions.map((record) => [record.outcome, record.reason, record.runs.length]), [['reproduced', undefined, 2]]);
  assert.deepEqual(ipc.removals, [], 'nothing is removed');
  assert.equal(ipc.listings(), 4, 'listed before and after each run');
  assert.deepEqual(ipc.objects, [...before, { type: 'm', id: 5, owner: 'nobody' }]);
  // Linux has no sandbox profile to bracket, so nothing there lists or removes an object.
  const linux = fakeHost({ runs: [failing, failing] });
  const onLinux = await reproduce(verification, blocking, context(scratchRepository(t), linux.spawn, 'linux'));
  assert.deepEqual(onLinux.reproductions.map((record) => record.outcome), ['reproduced']);
  assert.equal(linux.ipc.listings(), 0);
});

test('on macOS a System V IPC object of another user from before a run that is handed to the user during it is left alone', async (t) => {
  const repo = scratchRepository(t);
  const ipc = fakeIpc([{ type: 'm', id: 4, owner: 'nobody', creator: 'nobody' }]);
  const onRun = () => {
    ipc.objects[0].owner = USER;
  };
  const host = fakeHost({ runs: [failing, failing], onRun, ipc });
  const report = await reproduce(verification, blocking, context(repo, host.spawn));
  assert.deepEqual(report.reproductions.map((record) => [record.outcome, record.reason, record.runs.length]), [['reproduced', undefined, 2]]);
  assert.deepEqual(ipc.removals, [], 'nothing is removed');
  assert.deepEqual(ipc.objects, [{ type: 'm', id: 4, owner: USER, creator: 'nobody' }]);
});

test('on macOS a listing of System V IPC objects that fails records the run as not run', async (t) => {
  const missing = Object.assign(new Error(`spawn ${IPCS} ENOENT`), { code: 'ENOENT' });
  const cases = [
    // Before run 1, so it never starts.
    [{ list: (at) => (at === 1 ? { status: 1, stdout: '', stderr: '' } : undefined) }, [], 'could not list System V IPC objects before the run: ipcs exited 1', 0],
    [{ list: (at) => (at === 1 ? { status: null, stdout: '', stderr: '', error: missing } : undefined) }, [], `could not list System V IPC objects before the run: spawn ${IPCS} ENOENT`, 0],
    // A listing that leaves out a facility is not read as one with nothing in it.
    [{ list: (at) => (at === 1 ? { status: 0, stdout: 'Message Queues:\nShared Memory:\n', stderr: '' } : undefined) }, [], 'could not list System V IPC objects before the run: ipcs did not list every facility', 0],
    // After run 1.
    [{ list: (at) => (at === 2 ? { status: 1, stdout: '', stderr: '' } : undefined) }, [], 'could not list System V IPC objects after the run: ipcs exited 1', 1],
    // Before run 2.
    [{ list: (at) => (at === 3 ? { status: 1, stdout: '', stderr: '' } : undefined) }, [], 'could not list System V IPC objects before the run: ipcs exited 1', 1],
  ];
  for (const [fail, during, reason, runs] of cases) {
    const ipc = fakeIpc([], fail);
    const host = fakeHost({ runs: [failing, failing], onRun: () => ipc.objects.push(...during), ipc });
    const report = await reproduce(verification, blocking, context(scratchRepository(t), host.spawn));
    const [record] = report.reproductions;
    assert.deepEqual([record.outcome, record.reason, record.runs.length], ['did-not-run', reason, runs], reason);
    assert.equal(host.runs().length, runs, `${reason}: what ran`);
    assert.deepEqual(ipc.removals, [], `${reason}: nothing is removed`);
  }
});
