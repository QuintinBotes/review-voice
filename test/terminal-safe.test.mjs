/**
 * Untrusted text reaches a person's terminal through several commands. Each
 * route here prints text that carried an OSC 52 clipboard write, a CSI clear
 * screen, a C1 CSI, a bidi override and a lone carriage return, and the
 * output is captured as a string: nothing is written to a real terminal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { matchCarried } from '../plugins/review-voice/src/diff/carry.ts';
import { collectEvidence } from '../plugins/review-voice/src/evidence/run.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { checkOutcomes } from '../plugins/review-voice/src/store/outcomes.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { terminalInert, terminalSafe, terminalSafeDeep } from '../plugins/review-voice/src/terminal.ts';
import { verifyFindings } from '../plugins/review-voice/src/verify/external.ts';

const bundle = join(dirname(dirname(fileURLToPath(import.meta.url))), 'plugins/review-voice/dist/review-voice.mjs');

const ESC = '\u001b';
const OSC52 = `${ESC}]52;c;${Buffer.from('synthetic clipboard text').toString('base64')}\u0007`;
const HOSTILE = `one${OSC52} two${ESC}[2J three\u009b31m four\u202e five\rsix`;
const CLEAN = 'one two three four fivesix';
/** A control a terminal acts on, a format character, or a carriage return that is not part of a line ending. */
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]|\r(?!\n)/u;
/** What a sequence leaves behind when only its introducer is removed. */
const JUNK = /52;c;|\[2J/;

const REPO = 'acme/web';
const PR = 7;
const HEAD = 'a'.repeat(40);

/** A failure message escaped, so a test that fails never sends what it caught to the terminal running it. */
const shown = (text) => JSON.stringify(text).replace(/[\u007f-\u009f\p{Cf}]/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);

function assertSafe(text, label) {
  assert.doesNotMatch(text, UNSAFE, `${label}: ${shown(text)}`);
  assert.doesNotMatch(text, JUNK, `${label}: ${shown(text)}`);
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A data directory for the store the commands open, and a token so no command asks gh for one. */
async function withData(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-terminal-'));
  const saved = { data: process.env.REVIEW_VOICE_DATA_DIR, token: process.env.GITHUB_TOKEN };
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  process.env.GITHUB_TOKEN = 'synthetic';
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    await body(db);
  } finally {
    db.close();
    for (const [name, value] of [['REVIEW_VOICE_DATA_DIR', saved.data], ['GITHUB_TOKEN', saved.token]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const record = (db, extra) =>
  recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: '[minor] `src/cart.ts:12` - The total skips the discount.', ...extra });

test('terminalSafe removes each sequence whole and keeps newlines, tabs and line endings', () => {
  assert.equal(terminalSafe(HOSTILE), CLEAN);
  assert.equal(terminalSafe('a\tb\r\nc\nd'), 'a\tb\r\nc\nd');
  // A string sequence ends at BEL, at either ST, or with the text; a short form takes its intermediates.
  assert.equal(terminalSafe(`a${ESC}]0;title${ESC}\\b${ESC}P1$r${ESC}\\c\u009d8;;x\u009cd${ESC}]2;open`), 'abcd');
  assert.equal(terminalSafe(`a${ESC}(Bb${ESC}cc${ESC}7d\u0000\u007f\u0085e\u200b\u2066f\ufefff`), 'abcdeff');
  // A string sequence nothing ends stops at its line, so a later line a tool printed is still read.
  assert.equal(terminalSafe(`a${ESC}]0;open\nsrc/cart.ts(12,3): error\u009dopen\r\nb`), 'a\nsrc/cart.ts(12,3): error\r\nb');
  // Letters and emoji are neither controls nor format characters.
  assert.equal(terminalSafe('café \u{1f680}'), 'café \u{1f680}');
  assert.deepEqual(terminalSafeDeep({ [`k${ESC}[1m`]: [HOSTILE, 3, null, { nested: HOSTILE }], flag: true }), { k: [CLEAN, 3, null, { nested: CLEAN }], flag: true });
});

test('every C0 and C1 control but tab and a line ending, DEL and every format character is removed', () => {
  for (let code = 0; code <= 0x9f; code += 1) {
    if (code === 0x20) code = 0x7f;
    const control = String.fromCharCode(code);
    if ('\t\n\r'.includes(control)) continue;
    // Before a line ending, where an introducer has nothing to take.
    assert.equal(terminalSafe(`a${control}\nb`), 'a\nb', `U+${code.toString(16)}`);
  }
  // A soft hyphen, the Arabic letter mark, a zero-width joiner, the bidi isolates, a byte order mark and a tag character.
  assert.equal(terminalSafe('a\u00ad\u061c\u200d\u2066\u2069\ufeff\u{e0001}b'), 'ab');
  assert.equal(terminalSafe('a\rb\r\nc\r'), 'ab\r\nc');
});

test('each form of sequence goes whole, with no parameter byte left as text', () => {
  const ST = `${ESC}\\`;
  // The string forms by ESC and by C1 (DCS, SOS, OSC, PM, APC), ended by either string terminator or by BEL.
  for (const introducer of [`${ESC}]`, `${ESC}P`, `${ESC}X`, `${ESC}^`, `${ESC}_`, '\u0090', '\u0098', '\u009d', '\u009e', '\u009f']) {
    for (const end of [ST, '\u009c', '\u0007']) assert.equal(terminalSafe(`a${introducer}52;c;payload${end}b`), 'ab', shown(`${introducer}${end}`));
  }
  // CSI with a private marker, with an intermediate, and with its bytes in an order a terminal skips to the final byte.
  for (const body of ['?25l', '4 q', '>4;2m', '1;31m', ' 1;2 3m']) {
    assert.equal(terminalSafe(`a${ESC}[${body}b`), 'ab', body);
    assert.equal(terminalSafe(`a\u009b${body}b`), 'ab', body);
  }
});

test('a control inside a sequence leaves none of the bytes of the sequence behind', () => {
  // A terminal executes or ignores each of these and carries on with the sequence.
  for (const inside of ['\u0000', '\u0007', '\u000b', '\r', '\u007f', '\u0080', '\u200b', '\u202e']) {
    assert.equal(terminalSafe(`a${ESC}${inside}[2Jb`), 'ab', shown(inside));
    assert.equal(terminalSafe(`a${ESC}[3${inside}1mb`), 'ab', shown(inside));
    assert.equal(terminalSafe(`a\u009b3${inside}1mb`), 'ab', shown(inside));
    assert.equal(terminalSafe(`a${ESC}${inside}(Bb`), 'ab', shown(inside));
  }
  for (const inside of ['\u0000', '\u000b', '\u0080', '\u200b']) assert.equal(terminalSafe(`a${ESC}]52;c;QU${inside}JD\u0007b`), 'ab', shown(inside));
  assert.equal(terminalSafe(`a${ESC}${ESC}[2Jb`), 'ab');
  // A tab is executed too, and goes with the sequence it is in.
  assert.equal(terminalSafe(`a${ESC}[3\t1mb`), 'ab');
  assert.equal(terminalSafe(`a${ESC}\t[2Jb`), 'ab');
  // CAN and SUB cancel a sequence, so what follows is text again.
  assert.equal(terminalSafe(`a${ESC}[31\u0018mb`), 'amb');
  assert.equal(terminalSafe(`a${ESC}]0;title\u001amb`), 'amb');
  // Cut short by the end of the text or of the line, what a sequence had taken goes with it.
  assert.equal(terminalSafe(`a${ESC}[31`), 'a');
  assert.equal(terminalSafe(`a\u009b31`), 'a');
  assert.equal(terminalSafe(`a${ESC}`), 'a');
  assert.equal(terminalSafe(`a${ESC}(`), 'a');
  assert.equal(terminalSafe(`a${ESC}[31\nb`), 'a\nb');
  // A sequence never runs past its line, so the next line keeps every byte, the diagnostic a tool printed there included.
  assert.equal(terminalSafe(`a${ESC}[\n12:5 error`), 'a\n12:5 error');
  assert.equal(terminalSafe(`a${ESC}[2\nJb`), 'a\nJb');
  assert.equal(terminalSafe(`a${ESC}]52;c;QU\nJD\u0007b`), 'a\nJDb');
});

test('no mix of controls, introducers and parameter bytes leaves a control behind, and cleaning twice changes nothing', () => {
  const alphabet = [ESC, '[', ']', 'P', 'X', '^', '_', '\\', '\u0007', '\u0018', '\u001a', '\u0000', '\t', '\n', '\r', '\u007f', '\u0080', '\u0090', '\u0098', '\u009b', '\u009c', '\u009d', '\u009e', '\u009f', '\u202e', '\u200b', '\u{e0001}', '0', '1', ';', '?', ' ', '/', '(', 'm', 'J', 'a', 'é'];
  // A fixed seed, so a failure names the same text on every run.
  let seed = 20261111;
  const next = (below) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % below;
  };
  for (let round = 0; round < 20000; round += 1) {
    const text = Array.from({ length: 1 + next(12) }, () => alphabet[next(alphabet.length)]).join('');
    const clean = terminalSafe(text);
    assert.doesNotMatch(clean, UNSAFE, shown(text));
    assert.equal(terminalSafe(clean), clean, shown(text));
  }
});

test('terminalInert writes a format character outside the basic plane as both halves of its pair', () => {
  const text = JSON.stringify({ path: 'src/a\u{e0001}\u007f\u009b\u202e.ts' });
  const inert = terminalInert(text);
  assert.equal(inert, '{"path":"src/a\\udb40\\udc01\\u007f\\u009b\\u202e.ts"}');
  assert.deepEqual(JSON.parse(inert), JSON.parse(text));
});

test('a tool version line is one line with no tab and no line separator', async () => {
  const report = await collectEvidence([{ name: 'typecheck', run: 'check', version: 'tool --version' }], {
    cwd: '/synthetic/repository',
    enabled: true,
    spawn: (command) => ({ status: 0, stdout: command === 'tool --version' ? 'Tool\t1.2\u2028beta\u2029\nbuild 7\n' : '', stderr: '' }),
  });
  assert.equal(report.commands[0].version, 'Tool1.2beta');
});

test('a tool version line keeps no parameter bytes of an escape sequence', async () => {
  const report = await collectEvidence([{ name: 'typecheck', run: 'check', version: 'tool --version' }], {
    cwd: '/synthetic/repository',
    enabled: true,
    spawn: (command) => ({ status: 0, stdout: command === 'tool --version' ? `${ESC}[1mTool${ESC}[0m 1.2${OSC52}\n` : '', stderr: '' }),
  });
  assert.equal(report.commands[0].version, 'Tool 1.2');
});

/** A variable a repository listed for its commands, set for one test; its value is split by a sequence in what the tool prints. */
const LISTED = 'RV_TERMINAL_TEST_LISTED';
const VALUE = ['listed', 'value', '0123456789'].join('-');
const SPLIT = `${VALUE.slice(0, 9)}${ESC}[0m${VALUE.slice(9)}`;
async function withListed(body) {
  process.env[LISTED] = VALUE;
  try {
    await body();
  } finally {
    delete process.env[LISTED];
  }
}

test('a tool diagnostic and a version line lose their terminal controls before a listed value is masked', async () => {
  await withListed(async () => {
    const report = await collectEvidence([{ name: 'typecheck', run: 'check', version: 'tool --version' }], {
      cwd: '/synthetic/repository',
      enabled: true,
      envPassthrough: [LISTED],
      spawn: (command) =>
        command === 'tool --version'
          ? { status: 0, stdout: `Tool ${SPLIT}\n`, stderr: '' }
          : { status: 2, stdout: `src/cart.ts(12,3): error TS2345: ${HOSTILE} ${SPLIT}\n`, stderr: '' },
    });
    assert.equal(report.commands[0].version, `Tool [redacted:${LISTED}]`);
    assert.equal(report.signals.length, 1);
    assertSafe(JSON.stringify(report.signals), 'signals');
    assert.ok(report.signals[0].claim.includes(`${CLEAN} [redacted:${LISTED}]`), shown(report.signals[0].claim));
    assert.ok(!JSON.stringify(report).includes(VALUE));
  });
});

test('a listed value split by a sequence that holds a tab, or by a tab or a separator alone, is masked in the version line', async () => {
  await withListed(async () => {
    const split = (by) => `${VALUE.slice(0, 9)}${by}${VALUE.slice(9)}`;
    for (const by of [`${ESC}[3\t1m`, `${ESC}]0;a\tb\u0007`, '\t', '\u2028']) {
      const report = await collectEvidence([{ name: 'typecheck', run: 'check', version: 'tool --version' }], {
        cwd: '/synthetic/repository',
        enabled: true,
        envPassthrough: [LISTED],
        spawn: (command) =>
          command === 'tool --version'
            ? { status: 0, stdout: `Tool ${split(by)}\n`, stderr: '' }
            : { status: 2, stdout: `src/cart.ts(12,3): error TS2345: wrong ${split(`${ESC}[3\t1m`)}\n`, stderr: '' },
      });
      assert.equal(report.commands[0].version, `Tool [redacted:${LISTED}]`, shown(by));
      assert.ok(!JSON.stringify(report).includes(VALUE), shown(by));
      assert.ok(report.signals[0].claim.includes(`wrong [redacted:${LISTED}]`), shown(report.signals[0].claim));
    }
  });
});

test('a diagnostic for a file whose cleaned name is no file the tool named keeps its text and loses its place', async () => {
  const report = await collectEvidence([{ name: 'typecheck', run: 'check' }], {
    cwd: '/synthetic/repository',
    enabled: true,
    spawn: () => ({ status: 2, stdout: 'src/a\u200bb.ts(12,3): error TS2345: wrong type\nsrc/cart.ts(3,1): error TS1005: expected a brace\n', stderr: '' }),
  });
  assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line]), [[null, null], ['src/cart.ts', 3]]);
  assert.ok(report.signals[0].claim.includes('wrong type'), shown(report.signals[0].claim));
  assertSafe(JSON.stringify(report.signals), 'signals');
});

test('a diagnostic a tool printed on its error stream reaches a signal without terminal controls', async () => {
  // rustc, cargo and go vet print their diagnostics there.
  const report = await collectEvidence([{ name: 'typecheck', run: 'check' }], {
    cwd: '/synthetic/repository',
    enabled: true,
    spawn: () => ({ status: 2, stdout: '', stderr: `src/cart.ts(12,3): error TS2345: ${HOSTILE}\n` }),
  });
  assert.equal(report.signals.length, 1);
  assertSafe(JSON.stringify(report.signals), 'signals');
  assert.ok(report.signals[0].claim.includes(CLEAN), shown(report.signals[0].claim));
});

test('a second-pass verdict loses its terminal controls before a listed value is masked', async () => {
  await withListed(async () => {
    const finding = { candidateId: 'cand_001', path: 'src/cart.ts', line: 12, severity: 'important', claim: 'The total skips the discount.' };
    const report = await verifyFindings([finding], { enabled: true, command: 'verifier', envPassthrough: [LISTED] }, {
      cwd: '/synthetic/repository',
      runner: () => ({ stdout: JSON.stringify({ verdict: 'confirmed', confidence: 0.9, reason: `${HOSTILE} ${SPLIT}` }), stderr: '', failed: false }),
    });
    assert.equal(report.verdicts[0].reason, `${CLEAN} [redacted:${LISTED}]`);
  });
});

/** The shipped bundle with its streams piped, so what it writes is read here and never reaches a terminal. */
const throughBundle = (argv, input, options = {}) => spawnSync(process.execPath, [bundle, ...argv], { input, encoding: 'utf8', ...options });
/** A review whose path a pull request chose, with more prose than a finding may hold, so the contract names it. */
const LONG_REVIEW = `[minor] \`src/cart${OSC52}\u009b2J\u202e\u007f.ts:12\` - ${'The total skips the discount. '.repeat(20)}\n`;

test('a diagnostic on the error stream of the bundle carries no terminal control', () => {
  const result = throughBundle(['validate-output'], LONG_REVIEW);
  assert.equal(result.status, 1, shown(result.stderr));
  assertSafe(result.stderr, 'validate-output stderr');
  assert.ok(result.stderr.includes('finding at `src/cart.ts:12`'), shown(result.stderr));
});

test('a warning the bundled YAML parser gives about a file of the repository carries no terminal control', async () => {
  // An unresolved tag, so the parser warns and quotes the line. The bundle holds the parser build that warns
  // through console.warn, where the source loads the build for Node, so only the bundle shows this.
  const line = (key) => `${key}: !zz${OSC52}${ESC}[2J\u009b2J‮ [a]\n`;
  for (const [file, key] of [['policy.yaml', 'priorities'], ['config.yaml', 'reviewers']]) {
    await withRepo((repo) => {
      mkdirSync(join(repo, '.review-voice'));
      writeFileSync(join(repo, '.review-voice', file), line(key));
      for (const command of ['status', 'context']) {
        const result = throughBundle([command], '', { cwd: repo, env: { ...process.env, HOME: process.env.REVIEW_VOICE_DATA_DIR } });
        assert.equal(result.status, 0, shown(result.stderr));
        assert.ok(result.stderr.includes('Unresolved tag: !zz'), `${file} ${command}: ${shown(result.stderr)}`);
        assertSafe(result.stderr, `${file} ${command} stderr`);
        // The JSON `context` prints quotes the line too, with each control written as an escape.
        assert.doesNotMatch(result.stdout, UNSAFE, `${file} ${command} stdout: ${shown(result.stdout)}`);
      }
    });
  }
});

test('JSON on the output stream of the bundle writes DEL, C1 and format characters as escapes and parses to the same data', async () => {
  const result = throughBundle(['validate-output', '--json'], LONG_REVIEW);
  assert.equal(result.status, 1, shown(result.stderr));
  assert.doesNotMatch(result.stdout, UNSAFE, shown(result.stdout));
  // A stage reads this output back, so the path must come out of the parser as it went in.
  const inProcess = await runInProcess(['validate-output', '--json'], { stdin: LONG_REVIEW });
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(inProcess.stdout));
  assert.ok(JSON.stringify(JSON.parse(result.stdout)).includes('\u009b2J\u202e\u007f.ts:12'));
  assert.ok(result.stdout.includes('\\u009b2J\\u202e\\u007f.ts:12'), shown(result.stdout));
});

test('a line a command prints for a person through the bundle carries no terminal control, whatever it quotes', async () => {
  await withData(async (db) => {
    // The path is the pull request's, and the owner passes it back to decline the hold.
    const path = `src/held${OSC52}${ESC}[2J.ts`;
    const { reviewRunId } = record(db, { held: [{ path, line: 30, verdict: 'refuted', source: 'verifier', reason: 'Refuted.' }] });
    const result = throughBundle(['decline', '--run', reviewRunId, `${path}:30`]);
    assert.equal(result.status, 0, shown(result.stderr));
    assert.equal(result.stdout, `Recorded owner-declined for src/held.ts:30 in run ${reviewRunId}.\n`, shown(result.stdout));
  });
});

test('a plain line through the bundle loses a C1 sequence whole, with no escape and no parameter byte left as text', async () => {
  await withData(async (db) => {
    const path = `src/held\u009b2J\u202e${ESC}\u0007[31m.ts`;
    const { reviewRunId } = record(db, { held: [{ path, line: 30, verdict: 'refuted', source: 'verifier', reason: 'Refuted.' }] });
    const result = throughBundle(['decline', '--run', reviewRunId, `${path}:30`]);
    assert.equal(result.status, 0, shown(result.stderr));
    assert.equal(result.stdout, `Recorded owner-declined for src/held.ts:30 in run ${reviewRunId}.\n`, shown(result.stdout));
  });
});

test('a path as explain shows it is accepted by decline', async () => {
  // A name a pull request filled with sequences, and one whose spelling needs a zero-width non-joiner.
  for (const path of [`src/held${OSC52}${ESC}[2J.ts`, 'src/\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.ts']) {
    await withData(async (db) => {
      const { reviewRunId } = record(db, { held: [{ path, line: 30, verdict: 'refuted', source: 'verifier', reason: 'Refuted.' }] });
      const explained = await runInProcess(['explain', '--run', reviewRunId]);
      const [, anchor] = /^ {2}\[refuted\] (\S+:30) /m.exec(explained.stdout) ?? [];
      assert.equal(anchor, `${terminalSafe(path)}:30`, shown(explained.stdout));
      assert.notEqual(anchor, `${path}:30`);
      const declined = await runInProcess(['decline', '--run', reviewRunId, anchor]);
      assert.equal(declined.code, 0, shown(declined.stderr));
      assert.match((await runInProcess(['explain', '--run', reviewRunId])).stdout, /^ {2}\[owner-declined\] \S+:30 /m);
    });
  }
});

test('decline takes the stored path first, so a path that only looks the same is left held', async () => {
  await withData(async (db) => {
    const hold = (path) => ({ path, line: 30, verdict: 'refuted', source: 'verifier', reason: 'Refuted.' });
    const { reviewRunId } = record(db, { held: [hold('src/held.ts'), hold('src/held\u200b.ts')] });
    assert.equal((await runInProcess(['decline', '--run', reviewRunId, 'src/held.ts:30'])).code, 0);
    const held = JSON.parse(db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(reviewRunId).output_json).held;
    assert.deepEqual(held.map((entry) => entry.verdict), ['owner-declined', 'refuted']);
  });
});

/** A scratch repository and data directory; `snapshot` commits one more file and gives the new head. */
async function withRepo(body) {
  await withData(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rv-terminal-repo-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const snapshot = (name) => {
        writeFileSync(join(repo, name), 'line\n'.repeat(40));
        git('add', '-A');
        git('commit', '-q', '-m', name);
        return git('rev-parse', 'HEAD');
      };
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      await body(repo, snapshot);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test('carry --text prints the review it carries without the terminal controls the stored one holds', async () => {
  await withRepo((repo, snapshot) => {
    const prior = snapshot('a.ts');
    const recorded = throughBundle(['record', '--repository', REPO, '--head', prior], `[important] \`a.ts:20\` - The loop never ends ${HOSTILE}.\n`, { cwd: repo });
    assert.equal(recorded.status, 0, shown(recorded.stderr));
    const head = snapshot('b.ts');
    const carried = throughBundle(['carry', '--from', JSON.parse(recorded.stdout).reviewRunId, '--head', head, '--text'], '', { cwd: repo });
    assert.equal(carried.status, 0, shown(carried.stderr));
    assert.equal(carried.stdout, `[important] \`a.ts:20\` - The loop never ends ${CLEAN}.\n`, shown(carried.stdout));
    assert.ok(carried.stderr.includes('Terminal control characters were removed'), shown(carried.stderr));
  });
});

test('record --carried-from pairs the text carry --text printed with the stored finding it came from', async () => {
  // A word whose spelling needs a zero-width non-joiner, an emoji joined by a zero-width joiner, and a quoted bidi override.
  for (const quoted of ['می‌خواهم', '\u{1f469}‍\u{1f4bb}', '‮']) {
    await withRepo((repo, snapshot) => {
      const prior = snapshot('a.ts');
      const recorded = throughBundle(['record', '--repository', REPO, '--head', prior], `[important] \`a.ts:20\` - The label "${quoted}" is never translated.\n`, { cwd: repo });
      assert.equal(recorded.status, 0, shown(recorded.stderr));
      const from = JSON.parse(recorded.stdout).reviewRunId;
      const head = snapshot('b.ts');
      const carried = throughBundle(['carry', '--from', from, '--head', head, '--text'], '', { cwd: repo });
      assert.equal(carried.status, 0, shown(carried.stderr));
      assertSafe(carried.stdout, 'carry --text');
      const again = throughBundle(['record', '--repository', REPO, '--head', head, '--carried-from', from], carried.stdout, { cwd: repo });
      assert.equal(again.status, 0, shown(again.stderr));
      assert.deepEqual(JSON.parse(again.stdout).findings.map((finding) => finding.carriedFrom), [{ runId: from, findingId: 'rv_01' }], shown(again.stdout));
    });
  }
});

test('challenge without --out writes DEL, C1 and format characters as escapes and parses to the same document', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-terminal-challenge-'));
  try {
    const claim = `The cache key omits the tenant ${HOSTILE}\u007f, so one tenant reads the entries of another.`;
    const finding = { candidateId: 'cand_001', candidate_id: 'cand_001', path: 'src/a.ts', line: 3 };
    const scores = {
      scores: [{
        ...finding, eligible: true, rejectedBecause: null, finalScore: 0.81, confidenceSource: 'verifier',
        severity: { severity: 'important', reason: 'correctness, traced' },
        anchorCheck: { path: 'src/a.ts', line: 3, kind: 'added', ok: true, nearest: [3], patchLine: null, beyondHunks: false },
        verification: { reason: 'agreed', technical_confidence: 0.937, impact_traced: true },
        fix: { verdict: 'verified', reason: 'fix' },
      }],
      distribution: { count: 1 },
      eligible: [{ ...finding, severity: 'important', requestedSeverity: 'important', severityReason: 'correctness, traced', category: 'correctness', claim, failureMode: 'Failure mode.', evidence: ['traced'], fix: { render: 'fix', text: 'fix' } }],
      belowGate: [],
    };
    const candidates = { candidates: [{ candidate_id: 'cand_001', path: 'src/a.ts', line: 3, category: 'correctness', severity: 'important', claim, failure_mode: 'Failure mode.', evidence: ['traced'], technical_confidence: 0.937, suggested_fix: 'fix' }] };
    const patch = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,7 @@', ' line 1', '+added 2', '+added 3', '+added 4', '+added 5', '+added 6', ' line 7', ''].join('\n');
    const file = (name, body) => {
      writeFileSync(join(dir, name), body);
      return join(dir, name);
    };
    const argv = ['challenge', '--scores', file('scores.json', JSON.stringify(scores)), '--candidates', file('checked.json', JSON.stringify(candidates)), '--diff-file', file('diff.patch', patch)];
    const verdicts = JSON.stringify({ verdicts: [{ candidate_id: 'cand_001', verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/a.ts:3'], reason: `agreed ${HOSTILE}` }] });
    const printed = throughBundle(argv, verdicts);
    assert.equal(printed.status, 0, shown(printed.stderr));
    assert.doesNotMatch(printed.stdout, UNSAFE, shown(printed.stdout));
    // The next stage reads this, so it is the document --out writes.
    const written = throughBundle([...argv, '--out', join(dir, 'out.json')], verdicts);
    assert.equal(written.status, 0, shown(written.stderr));
    assert.deepEqual(JSON.parse(printed.stdout), JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')));
    assert.equal(JSON.parse(printed.stdout).eligible[0].claim, claim);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redact prints its text without terminal controls, and a secret a sequence split is still redacted', () => {
  // Built here, so no file holds a string shaped like a token.
  const token = ['gh', 'p_', 'Ab3d', 'Ef5h'.repeat(5)].join('');
  const printed = throughBundle(['redact'], `${HOSTILE}\ntoken ${token.slice(0, 9)}${ESC}[0m${token.slice(9)}\n`);
  assert.equal(printed.status, 0, shown(printed.stderr));
  assert.equal(printed.stdout, `${CLEAN}\ntoken [REDACTED:GITHUB_TOKEN]\n`, shown(printed.stdout));
});

test('redact removes a secret that only a sequence parted from the word before it', () => {
  const token = ['gh', 'p_', 'Ab3d', 'Ef5h'.repeat(5)].join('');
  const printed = throughBundle(['redact'], `prefix${ESC}]0;title\u0007${token}\n`);
  assert.equal(printed.status, 0, shown(printed.stderr));
  assert.equal(printed.stdout, 'prefix[REDACTED:GITHUB_TOKEN]\n', shown(printed.stdout));
});

test('a carried finding is paired only under its own path, never one that reads the same once cleaned', () => {
  const text = '[important] `src/ab.ts:20` - The loop never ends.';
  const carried = [{ findingId: 'rv_01', path: 'src/a\u200bb.ts', line: 20, text: '[important] `src/a\u200bb.ts:20` - The loop never ends.' }];
  assert.deepEqual([...matchCarried([{ findingId: 'rv_01', path: 'src/ab.ts', line: 20, text }], carried).matches], []);
  // The text may have lost what a terminal acts on; the path is the same file.
  const quoted = [{ findingId: 'rv_02', path: 'src/ab.ts', line: 20, text: '[important] `src/ab.ts:20` - The loop\u200b never ends.' }];
  assert.deepEqual([...matchCarried([{ findingId: 'rv_01', path: 'src/ab.ts', line: 20, text }], quoted).matches], [['rv_01', 'rv_02']]);
});

test('explain prints a stored run without the terminal controls its untrusted text carried', async () => {
  await withData(async (db) => {
    const { reviewRunId } = record(db, {
      verdicts: [{ path: 'src/cart.ts', line: 12, verdict: 'refuted', confidence: 0.9, reason: `verifier ${HOSTILE}`, outcome: 'dropped', originalSeverity: 'minor', verifier: 'evidence-verifier' }],
      held: [{ path: `src/held${OSC52}.ts`, line: 30, verdict: 'reproduction-did-not-fail', source: 'reproduce', reason: `node-test: run 1 exited 0; ${HOSTILE}` }],
    });
    for (const argv of [['explain', '--run', reviewRunId], ['explain', '--run', reviewRunId, '--json']]) {
      const explained = await runInProcess(argv);
      assert.equal(explained.code, 0, shown(explained.stderr));
      assertSafe(explained.stdout, argv.join(' '));
    }
    const text = (await runInProcess(['explain', '--run', reviewRunId])).stdout;
    assert.ok(text.includes(`      verifier ${CLEAN}\n`), shown(text));
    assert.ok(text.includes(`  [reproduction-did-not-fail] src/held.ts:30  reproduce - node-test: run 1 exited 0; ${CLEAN}\n`), shown(text));
  });
});

test('explain prints the state a later run gave a follow-up without its terminal controls', async () => {
  await withData(async (db) => {
    // Written into the stored rows, as a run that partly addressed a comment and a later run that resolved it leave them.
    const amend = (runId, change) => {
      const row = JSON.parse(db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(runId).output_json);
      db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?').run(JSON.stringify(change(row)), runId);
    };
    const first = record(db).reviewRunId;
    amend(first, (row) => ({
      ...row,
      findings: row.findings.map((finding) => ({
        ...finding,
        partlyAddressed: { prior: { author: 'synthetic-reviewer', path: 'src/cart.ts', line: 12 }, remaining: ['the discount'], addressed: ['the total'] },
      })),
    }));
    const later = record(db).reviewRunId;
    amend(later, (row) => ({ ...row, followUps: [{ id: `${first}:rv_01`, status: 'resolved', reason: `resolved ${HOSTILE}`, remaining: [] }] }));
    const explained = await runInProcess(['explain', '--run', first]);
    assert.equal(explained.code, 0, shown(explained.stderr));
    assertSafe(explained.stdout, 'explain');
    assert.ok(explained.stdout.includes(`  follow-up         resolved in run ${later} - resolved ${CLEAN}\n`), shown(explained.stdout));
  });
});

test('status prints the last run without terminal controls in its rule ids or its scope', async () => {
  await withData(async (db) => {
    // A full read after a failed git command records what git said.
    const scope = { kind: 'full', cause: 'compare-unavailable', since: null, priorRunId: null, detail: `git said ${HOSTILE}` };
    record(db, { candidates: [{ path: 'src/cart.ts', line: 12, category: `correctness${HOSTILE}` }], scope });
    const status = await runInProcess(['status']);
    assert.equal(status.code, 0, shown(status.stderr));
    assertSafe(status.stdout, 'status');
    assert.match(status.stdout, new RegExp(`rv_01 \\(correctness${CLEAN}:`));
    assert.ok(status.stdout.includes(`last scope       full (compare-unavailable: git said ${CLEAN})\n`), shown(status.stdout));
  });
});

test('evaluate prints rule ids without terminal controls', async () => {
  await withData(async (db) => {
    const { reviewRunId } = record(db, { candidates: [{ path: 'src/cart.ts', line: 12, category: `correctness${HOSTILE}` }] });
    db.prepare(
      `INSERT INTO finding_outcomes (review_run_id, finding_id, repository, pull_number, comment_id, outcome, strength, evidence, checked_at)
       VALUES (?, 'rv_01', ?, ?, 1, 'fixed', 'strong', 'suggestion applied', ?)`,
    ).run(reviewRunId, REPO, PR, new Date().toISOString());
    const evaluated = await runInProcess(['evaluate', '--json']);
    assert.equal(evaluated.code, 0, shown(evaluated.stderr));
    assertSafe(evaluated.stdout, 'evaluate --json');
    assert.ok(Object.keys(JSON.parse(evaluated.stdout).posted_breakdown.by_rule).some((rule) => rule.startsWith(`correctness${CLEAN}:`)));
  });
});

test('draft prints its preview without terminal controls', async () => {
  const review = `[minor] \`src/cart.ts:12\` - The total ${HOSTILE}.`;
  for (const argv of [['draft', '--repository', REPO, '--pr', String(PR)], ['draft', '--repository', REPO, '--pr', String(PR), '--json']]) {
    const drafted = await runInProcess(argv, { stdin: review });
    assert.equal(drafted.code, 0, shown(drafted.stderr));
    assertSafe(drafted.stdout, argv.join(' '));
  }
  assert.ok((await runInProcess(['draft', '--repository', REPO, '--pr', String(PR)], { stdin: review })).stdout.includes(`**minor** - The total ${CLEAN}.`));
});

test('verdict and post print their output without terminal controls', async () => {
  const output = '[minor] `src/cart.ts:12` - The total skips the discount.';
  // A check run name is chosen by the workflow that runs on the pull request.
  const impl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/graphql') return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (path === '/user') return json({ login: 'synthetic-reviewer' });
    if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: HEAD } });
    if (path.endsWith('/check-runs')) {
      return json({ total_count: 1, check_runs: [{ id: 1, name: `build${HOSTILE}`, status: 'completed', conclusion: 'timed_out', completed_at: '2026-10-01T10:00:00Z' }] });
    }
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (/\/(comments|reviews)$/.test(path)) return json([]);
    return new Response('not found', { status: 404 });
  };
  await withData(async (db) => {
    record(db, { output });
    const result = await runInProcess(['verdict', '--pr', String(PR), '--head', HEAD, '--repository', REPO], { stdin: output, fetchImpl: impl });
    assert.equal(result.code, 6, shown(result.stderr));
    assertSafe(result.stdout, 'verdict');
    assert.ok(JSON.parse(result.stdout).reasons.includes(`CI needs a rerun: build${CLEAN} (timed_out)`), shown(result.stdout));
    // Posting is on, so post reads the same checks; without --confirm it could send nothing even if they passed.
    const config = join(process.env.REVIEW_VOICE_DATA_DIR, 'config.yaml');
    writeFileSync(config, 'writes:\n  github_posting_enabled: true\n');
    process.env.REVIEW_VOICE_CONFIG = config;
    try {
      const refused = await runInProcess(['post', '--pr', String(PR), '--head', HEAD, '--repository', REPO], { stdin: output, fetchImpl: impl });
      assertSafe(refused.stdout, 'post');
      assert.ok(JSON.parse(refused.stdout).reasons.includes(`CI needs a rerun: build${CLEAN} (timed_out)`), shown(refused.stdout));
    } finally {
      delete process.env.REVIEW_VOICE_CONFIG;
    }
  });
});

test('outcomes reports a stored path without terminal controls', async () => {
  const path = `src/cart${OSC52}\u009b2J\u202e.ts`;
  const impl = async (url) => {
    const at = new URL(String(url)).pathname;
    if (at === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
    }
    if (at === '/user') return json({ login: 'synthetic-reviewer' });
    if (at === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: HEAD } });
    const root = { id: 101, path, line: 12, original_line: 12, body: '**minor** - The total skips the discount.', user: { login: 'synthetic-reviewer' }, created_at: '2026-10-01T10:00:00Z' };
    if (at === `/repos/${REPO}/pulls/${PR}/comments` || /\/reviews\/\d+\/comments$/.test(at)) return json([root]);
    if (at.endsWith('/reviews')) return json([]);
    return new Response('not found', { status: 404 });
  };
  await withData(async (db) => {
    const { reviewRunId } = record(db, { output: `[minor] \`${path}:12\` - The total skips the discount.` });
    const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
    const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
    recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, reviewId: 555 });
    const result = await checkOutcomes({
      db,
      client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} }),
      allowlist: [REPO],
      since: '2000-01-01T00:00:00.000Z',
    });
    assert.deepEqual(result.outcomes.map((outcome) => outcome.path), ['src/cart.ts']);
    assertSafe(JSON.stringify(result), 'outcomes');
  });
});

/** Three runs, each with a finding the owner dismissed, in a category and a directory the pull request named. */
async function dismissedThrice(db) {
  // A C1 CSI rather than OSC 52, whose bracket would leave the directory no glob and so no path policy.
  const path = `src\u009b2J\u202e/cart.ts`;
  for (const pull of [7, 8, 9]) {
    recordRun(db, {
      repository: REPO, baseRef: null, headRef: HEAD, pullNumber: pull, diff: 'diff',
      output: `[minor] \`${path}:12\` - The total skips the discount.`,
      candidates: [{ path, line: 12, category: `correctness${HOSTILE}` }],
    });
    const dismissed = await runInProcess(['feedback', 'rv_01', 'dismiss']);
    assert.equal(dismissed.code, 0, shown(dismissed.stderr));
  }
}

test('calibrate prints its proposals without terminal controls', async () => {
  await withData(async (db) => {
    await dismissedThrice(db);
    const calibrated = await runInProcess(['calibrate']);
    assert.equal(calibrated.code, 0, shown(calibrated.stderr));
    assertSafe(calibrated.stdout, 'calibrate');
    assert.deepEqual(JSON.parse(calibrated.stdout).proposals.map((proposal) => [proposal.ruleId, proposal.glob]), [[`correctness${CLEAN}:diff`, 'src/**']]);
  });
});

test('policy show prints a proposed policy without terminal controls', async () => {
  await withData(async (db) => {
    await dismissedThrice(db);
    assert.equal((await runInProcess(['calibrate'])).code, 0);
    const shownPolicies = await runInProcess(['policy', 'show']);
    assert.equal(shownPolicies.code, 0, shown(shownPolicies.stderr));
    assert.doesNotMatch(shownPolicies.stdout, UNSAFE, shown(shownPolicies.stdout));
    const [policy] = JSON.parse(shownPolicies.stdout).policies;
    assert.equal(policy.scopeKey, 'src/**');
    // The stored YAML already writes a C0 control as an escape, which is text; the C1 CSI and the bidi override go whole.
    assert.ok(policy.contentYaml.includes('three four five'), shown(policy.contentYaml));
  });
});
