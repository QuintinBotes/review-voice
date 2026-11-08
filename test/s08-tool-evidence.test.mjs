import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEvidence } from '../plugins/review-voice/src/evidence/run.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const claim = 'Optional quantity produces invalid cart totals for existing items.';
const candidate = (extra = {}) => ({
  candidate_id: 'cand_001', path: 'src/app.ts', line: 3,
  category: 'correctness', severity: 'minor', claim, failure_mode: claim,
  evidence: ['src/app.ts:3 multiplies by an optional quantity.'], technical_confidence: 0.9,
  ...extra,
});
const signal = (extra = {}) => ({
  kind: 'type_error', path: 'src/app.ts', line: 3, claim, evidence: [claim],
  confidence: 0.95, tool: 'typecheck', ...extra,
});

function temporary(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(t, cwd, args, input = '', env = {}) {
  return JSON.parse(execFileSync(process.execPath, [bundle, ...args], {
    cwd, encoding: 'utf8', input,
    env: { ...process.env, REVIEW_VOICE_NO_COMMANDS: '0', ...env, REVIEW_VOICE_DATA_DIR: temporary(t, 'rv-s08-cli-data-') },
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

function check(t, candidates, signals) {
  const dir = temporary(t, 'rv-s08-candidates-');
  const diff = join(dir, 'diff.patch');
  const evidence = join(dir, 'evidence.json');
  writeFileSync(diff, [
    'diff --git a/src/app.ts b/src/app.ts', 'new file mode 100644',
    '--- /dev/null', '+++ b/src/app.ts', '@@ -0,0 +1,6 @@',
    '+export function total(items) {', '+  let sum = 0;',
    '+  for (const item of items) sum += item.price * item.qty;',
    '+  return sum;', '+}', '+', '',
  ].join('\n'));
  writeFileSync(evidence, JSON.stringify({ enabled: true, signals, commands: [], didNotRun: [] }));
  return cli(t, dir, ['check-candidates', '--diff-file', diff, '--evidence', evidence], JSON.stringify({ candidates }));
}

test('AC-1: evidence alone selects the full report and drops restatements within two lines', (t) => {
  for (const delta of [-2, -1, 0, 1, 2]) {
    const report = check(t, [candidate()], [signal({ line: 3 + delta })]);
    assert.equal(report.valid, true);
    assert.equal(report.candidates, 0);
    assert.deepEqual(report.kept, []);
    assert.deepEqual(report.droppedAsRepeat, []);
    assert.deepEqual(report.droppedAsHeld, []);
    assert.deepEqual(report.droppedAsTool, [{
      candidateId: 'cand_001', path: 'src/app.ts', line: 3,
      tool: 'typecheck', signalLine: 3 + delta, message: claim,
    }]);
  }
});

test('AC-1: unrelated wording, another path, distant lines and pathless signals keep the candidate', (t) => {
  for (const other of [
    signal({ claim: 'Authentication permits forged credentials.', evidence: ['Missing signature validation.'] }),
    signal({ path: 'src/other.ts' }), signal({ line: 6 }), signal({ path: null }),
  ]) {
    const report = check(t, [candidate()], [other]);
    assert.equal(report.candidates, 1);
    assert.deepEqual(report.kept, [candidate()]);
    assert.deepEqual(report.droppedAsTool, []);
  }
});

test('AC-3: the evidence CLI skips every configured check and version command', (t) => {
  const dir = temporary(t, 'rv-s08-no-commands-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.review-voice'));
  const commands = ['typecheck', 'lint'].map((name) => ({
    name, run: `touch ${name}-ran`, version: `touch ${name}-version-ran`,
  }));
  writeFileSync(join(dir, '.review-voice/config.yaml'), JSON.stringify({ static_evidence: { enabled: true, commands } }));
  const report = cli(t, dir, ['evidence'], '', { REVIEW_VOICE_NO_COMMANDS: '1' });
  assert.deepEqual(report, {
    enabled: false, signals: [], commands: [], didNotRun: ['typecheck', 'lint'], skipped: 'REVIEW_VOICE_NO_COMMANDS',
  });
  for (const { name } of commands) {
    assert.equal(existsSync(join(dir, `${name}-ran`)), false);
    assert.equal(existsSync(join(dir, `${name}-version-ran`)), false);
  }
});

test('AC-5: only configured versions spawn and use the check limits with a sanitised first line', () => {
  const calls = [];
  const stdout = ` \u0000Tool\u202e\u200b\u2066\u2028\u2029 1.2 ${'\u{1f680}'.repeat(90)}\r\nignored second line`;
  const report = collectEvidence([
    { name: 'plain', run: 'check plain' },
    { name: 'versioned', run: 'check versioned', version: 'tool --version', timeoutSeconds: 7 },
  ], {
    cwd: '/synthetic/repository', enabled: true,
    spawn: (command, options) => {
      calls.push({ command, options });
      return { status: 0, stdout: command === 'tool --version' ? stdout : '', stderr: '' };
    },
  });
  assert.deepEqual(calls.map(({ command }) => command), ['check plain', 'check versioned', 'tool --version']);
  assert.equal(Object.hasOwn(report.commands[0], 'version'), false);
  // Every configured command runs in its own process group, so a failure can take the whole group.
  assert.deepEqual(calls[0].options, { cwd: '/synthetic/repository', shell: true, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, detached: true });
  assert.deepEqual(calls[1].options, { ...calls[0].options, timeout: 7000 });
  assert.deepEqual(calls[2].options, calls[1].options);
  assert.equal(report.commands[1].version, [...`Tool 1.2 ${'\u{1f680}'.repeat(90)}`].slice(0, 80).join(''));
  assert.equal([...report.commands[1].version].length, 80);
  assert.deepEqual(report.signals, []);
  assert.deepEqual(report.didNotRun, []);
});

test('AC-5: failed or empty version commands add no version, signal or didNotRun entry', () => {
  for (const result of [
    { status: 1, stdout: 'src/app.ts(3,1): error TS1234: Version failed.' },
    { status: 0, stdout: 'ignored', error: new Error('spawn failed') },
    { status: null, stdout: 'ignored', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { status: 0, stdout: '\nsecond line is not a version' },
    { status: 0, stdout: ' \u202e\u200b\r\n' },
  ]) {
    const calls = [];
    const report = collectEvidence([{ name: 'typecheck', run: 'check', version: 'version' }], {
      cwd: '/synthetic/repository', enabled: true,
      spawn: (command) => {
        calls.push(command);
        return command === 'version' ? result : { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(calls, ['check', 'version']);
    assert.equal(report.commands.length, 1);
    assert.equal(Object.hasOwn(report.commands[0], 'version'), false);
    assert.equal(Object.hasOwn(report.commands[0], 'unavailable'), false);
    assert.equal(report.commands[0].exitCode, 0);
    assert.deepEqual(report.signals, []);
    assert.deepEqual(report.didNotRun, []);
  }
});

// Wording overlap is a heuristic. A type error can share its words with a claim
// about a breach at the same line, so the categories that name a breach or a
// trust boundary are never held on it; the same words on a plain category are.
test('a candidate in an exempt category is never dropped as a restatement, while a plain one is', (t) => {
  const typeError = signal({
    kind: 'type_error',
    claim: "Property 'password' does not exist on type 'User'.",
    evidence: ["src/app.ts(3,1): error TS2339: Property 'password' does not exist on type 'User'."],
  });
  // An echo of the message, which a plain category is dropped on; an exempt one never is.
  const breach = { claim: "Property 'password' does not exist on type 'User', so the field was removed.", failure_mode: "Property 'password' does not exist on type 'User'." };
  const security = check(t, [candidate({ ...breach, category: 'security' })], [typeError]);
  assert.deepEqual(security.kept.map((entry) => entry.candidate_id), ['cand_001']);
  assert.deepEqual(security.droppedAsTool, []);
  const plain = check(t, [candidate({ ...breach, category: 'correctness' })], [typeError]);
  assert.deepEqual(plain.kept, []);
  assert.deepEqual(plain.droppedAsTool.map((entry) => [entry.candidateId, entry.tool]), [['cand_001', 'typecheck']]);
});

// Some tools print absolute paths; the candidate names a repository-relative
// one, and the two are the same file.
test('a signal with an absolute path under the repository matches a relative candidate path', (t) => {
  const dir = temporary(t, 'rv-s08-absolute-');
  const diff = join(dir, 'diff.patch');
  const evidence = join(dir, 'evidence.json');
  writeFileSync(diff, [
    'diff --git a/src/app.ts b/src/app.ts', 'new file mode 100644',
    '--- /dev/null', '+++ b/src/app.ts', '@@ -0,0 +1,6 @@',
    '+export function total(items) {', '+  let sum = 0;',
    '+  for (const item of items) sum += item.price * item.qty;',
    '+  return sum;', '+}', '+', '',
  ].join('\n'));
  writeFileSync(evidence, JSON.stringify({
    enabled: true, commands: [], didNotRun: [],
    signals: [signal({ path: join(dir, 'src', 'app.ts') }), signal({ path: '/elsewhere/src/app.ts', line: 3 })],
  }));
  const report = cli(t, dir, ['check-candidates', '--diff-file', diff, '--evidence', evidence], JSON.stringify({ candidates: [candidate()] }));
  assert.deepEqual(report.kept, []);
  assert.equal(report.droppedAsTool.length, 1, 'the path under the repository matched; the one outside it matched nothing');
});

// The switch that keeps a watcher-run review from running repository commands
// holds for the verify command too, whoever calls it.
test('verify spawns nothing under REVIEW_VOICE_NO_COMMANDS and says so', (t) => {
  const dir = temporary(t, 'rv-s08-verify-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.review-voice'));
  const marker = join(dir, 'ran.txt');
  writeFileSync(join(dir, '.review-voice', 'config.yaml'), `verification:\n  enabled: true\n  command: "touch ${marker}"\n`);
  const report = cli(t, dir, ['verify'], JSON.stringify({ candidates: [candidate()] }), { REVIEW_VOICE_NO_COMMANDS: '1' });
  assert.equal(existsSync(marker), false, 'the configured verifier did not run');
  assert.equal(report.enabled, false);
  assert.equal(report.skipped, 'REVIEW_VOICE_NO_COMMANDS');
  assert.deepEqual(report.verdicts, []);
  assert.deepEqual(report.didNotRun, ['external']);
});

// A timed-out version command's shell is killed by the timeout; what it left
// running in the background has to go with it, or it outlives the review.
test('a version command that times out takes its background children with it', (t) => {
  const dir = temporary(t, 'rv-s08-reap-');
  const pidFile = join(dir, 'child.pid');
  const report = collectEvidence(
    [{ name: 'slow', run: 'true', timeoutSeconds: 1, version: `sleep 30 & echo $! > "${pidFile}"; wait` }],
    { cwd: dir, enabled: true },
  );
  assert.equal(Object.hasOwn(report.commands[0], 'version'), false);
  assert.deepEqual(report.didNotRun, []);
  const pid = Number(execFileSync('cat', [pidFile], { encoding: 'utf8' }).trim());
  assert.ok(pid > 0);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) {
    process.kill(pid, 'SIGKILL');
  }
  assert.equal(alive, false, 'the background child was reaped with its process group');
});

// A tool's message is short and names the symbol and its type, so an unrelated
// claim about the same symbol at the same line shares words with it. Only a
// claim that echoes most of the message is a restatement.
test('two words in five shared with a type error is not a restatement; an echo of it is', (t) => {
  const typeError = signal({
    kind: 'type_error',
    claim: "Property 'total' does not exist on type 'Order'.",
    evidence: ["src/app.ts(3,1): error TS2339: Property 'total' does not exist on type 'Order'."],
  });
  const units = check(t, [candidate({ claim: 'Order total uses wrong units.', failure_mode: 'Order total uses wrong units.' })], [typeError]);
  assert.deepEqual(units.kept.map((entry) => entry.candidate_id), ['cand_001']);
  assert.deepEqual(units.droppedAsTool, []);
  const echo = check(
    t,
    [candidate({ claim: "Property 'total' does not exist on type 'Order', so this will not compile.", failure_mode: "The type 'Order' has no property 'total'." })],
    [typeError],
  );
  assert.deepEqual(echo.kept, []);
  assert.deepEqual(echo.droppedAsTool.map((entry) => entry.candidateId), ['cand_001']);
});

// The anchor checks accept a candidate path spelled `./src/app.ts`; the
// restatement match must see the same file the signal names.
test('a candidate path spelled with a leading dot still matches its signal', (t) => {
  const report = check(t, [candidate({ path: './src/app.ts' })], [signal()]);
  assert.deepEqual(report.kept, []);
  assert.deepEqual(report.droppedAsTool.map((entry) => entry.candidateId), ['cand_001']);
});

// A version command that ignores the polite signal must not hold the review.
test('a version command that traps the termination signal is still cut off at the timeout', () => {
  const started = Date.now();
  const report = collectEvidence(
    [{ name: 'stubborn', run: 'true', timeoutSeconds: 1, version: "trap '' TERM; sleep 5; printf 'tool 1.2\\n'" }],
    { cwd: tmpdir(), enabled: true },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `collectEvidence took ${elapsed}ms`);
  assert.equal(Object.hasOwn(report.commands[0], 'version'), false);
  assert.deepEqual(report.didNotRun, []);
});

// Two tool messages about different members of one type share every word that
// survives the stop list, so the quoted identifiers decide: a candidate about
// `tax` is not a restatement of a signal about `qty` two lines away.
test('a candidate about another member of the same type is not a restatement of the signal', (t) => {
  const qty = signal({
    line: 2,
    claim: "Property 'qty' does not exist on type 'Item'.",
    evidence: ["src/app.ts(2,1): error TS2339: Property 'qty' does not exist on type 'Item'."],
  });
  const tax = check(t, [candidate({ claim: "Property 'tax' does not exist on type 'Item'; tax is NaN.", failure_mode: "Property 'tax' does not exist on type 'Item'; tax is NaN." })], [qty]);
  assert.deepEqual(tax.kept.map((entry) => entry.candidate_id), ['cand_001']);
  assert.deepEqual(tax.droppedAsTool, []);
  // The same candidate about qty itself is the restatement it looks like.
  const same = check(t, [candidate({ claim: "Property 'qty' does not exist on type 'Item'; qty is undefined.", failure_mode: "Property 'qty' does not exist on type 'Item'." })], [qty]);
  assert.deepEqual(same.kept, []);
  assert.deepEqual(same.droppedAsTool.map((entry) => entry.candidateId), ['cand_001']);
});

// A relative signal path is normalised the way the candidate's is.
test('a signal path with a dot segment matches the plain candidate path', (t) => {
  const report = check(t, [candidate()], [signal({ path: 'src/./app.ts' })]);
  assert.deepEqual(report.kept, []);
  assert.deepEqual(report.droppedAsTool.map((entry) => entry.candidateId), ['cand_001']);
});

// A check, not only a version command, runs in its own process group, and the
// group goes on every failure: a timeout here, output past the cap below.
test('a check that times out and a version command that overflows both take their children with them', (t) => {
  const dir = temporary(t, 'rv-s08-reap-all-');
  const checkPid = join(dir, 'check.pid');
  const versionPid = join(dir, 'version.pid');
  const report = collectEvidence(
    [
      { name: 'slow-check', run: `sleep 30 & echo $! > "${checkPid}"; wait`, timeoutSeconds: 1 },
      { name: 'loud-version', run: 'true', timeoutSeconds: 5, version: `sleep 30 & echo $! > "${versionPid}"; head -c 20000000 /dev/zero` },
    ],
    { cwd: dir, enabled: true },
  );
  assert.deepEqual(report.didNotRun, ['slow-check']);
  assert.match(report.commands[0].unavailable, /timed out/);
  assert.equal(Object.hasOwn(report.commands[1], 'version'), false);
  for (const file of [checkPid, versionPid]) {
    const pid = Number(execFileSync('cat', [file], { encoding: 'utf8' }).trim());
    assert.ok(pid > 0, file);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, `${file}: the background child was reaped with its process group`);
  }
});

// The names a diagnostic quotes are compared as spelled: a different case or a
// different hyphenated key is a different defect, and a suggested fix is not
// part of the defect's identity.
test('quoted names are compared as spelled, and a suggested fix is not required', (t) => {
  const idSignal = signal({ line: 2, claim: "Property 'ID' does not exist on type 'User'.", evidence: ["src/app.ts(2,1): error TS2339: Property 'ID' does not exist on type 'User'."] });
  const lowerId = check(t, [candidate({ claim: "Property 'id' does not exist on type 'User'.", failure_mode: "Property 'id' does not exist on type 'User'." })], [idSignal]);
  assert.deepEqual(lowerId.kept.map((entry) => entry.candidate_id), ['cand_001'], 'id and ID are different members');
  const locale = signal({ claim: "Unknown locale 'en-GB' in the format call.", evidence: ["src/app.ts(3,1): error: Unknown locale 'en-GB' in the format call."] });
  const other = check(t, [candidate({ claim: "Unknown locale 'en-US' in the format call.", failure_mode: "Unknown locale 'en-US' in the format call." })], [locale]);
  assert.deepEqual(other.kept.map((entry) => entry.candidate_id), ['cand_001'], 'en-US and en-GB are different keys');
  const suggestion = signal({
    claim: "Property 'quantity' does not exist on type 'Item'. Did you mean 'quantities'?",
    evidence: ["src/app.ts(3,1): error TS2551: Property 'quantity' does not exist on type 'Item'. Did you mean 'quantities'?"],
  });
  const echo = check(t, [candidate({ claim: "Property 'quantity' does not exist on type 'Item'.", failure_mode: "Property 'quantity' does not exist on type 'Item'." })], [suggestion]);
  assert.deepEqual(echo.kept, []);
  assert.deepEqual(echo.droppedAsTool.map((entry) => entry.candidateId), ['cand_001'], 'the echo need not repeat the suggested fix');
});

// A check that exits non-zero has returned; whatever it left in the background
// goes with its process group all the same.
test('a check that exits non-zero takes its background child with it', (t) => {
  const dir = temporary(t, 'rv-s08-reap-exit-');
  const pidFile = join(dir, 'child.pid');
  const report = collectEvidence([{ name: 'failing', run: `sleep 30 > /dev/null 2>&1 & echo $! > "${pidFile}"; exit 1` }], { cwd: dir, enabled: true });
  assert.equal(report.commands[0].exitCode, 1);
  const pid = Number(execFileSync('cat', [pidFile], { encoding: 'utf8' }).trim());
  assert.ok(pid > 0);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) process.kill(pid, 'SIGKILL');
  assert.equal(alive, false, 'the background child was reaped with its process group');
});
