/**
 * #547. Static evidence had no coverage adapter, so nothing said which changed
 * lines the tests never ran. A command may now name the LCOV or Cobertura
 * report it writes; each changed line the report lists as executable with no
 * hits becomes an `uncovered_line` signal, and a report that is missing, stale,
 * unparsable or partial is inconclusive with a reason, never zero coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHunks } from '../plugins/review-voice/src/diff/hunks.ts';
import { collectEvidence } from '../plugins/review-voice/src/evidence/run.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const fixture = (name) => readFileSync(join(root, 'fixtures/coverage', name), 'utf8');
const patch = fixture('change.patch');
const changed = new Map([...parseHunks(patch)].map(([path, hunks]) => [path, hunks.added]));

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-547-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The fixture as the tool would have written it in `dir`. */
const recorded = (name, dir) => fixture(name).replaceAll('/home/runner/work/shop/shop', dir);

/** Collects evidence for one command whose run writes `report` (or nothing) into the directory. */
async function collect(dir, { coverage = 'coverage/report', report, status = 0, diff = changed } = {}) {
  return collectEvidence([{ name: 'test', run: 'npm test', coverage }], {
    cwd: dir,
    enabled: true,
    ...(diff === null ? {} : { changed: diff }),
    spawn: () => {
      if (report !== undefined) {
        mkdirSync(join(dir, 'coverage'), { recursive: true });
        writeFileSync(join(dir, 'coverage/report'), report);
      }
      return { status, stdout: '', stderr: '' };
    },
  });
}

const lines = (report) => report.signals.map((signal) => `${signal.path}:${signal.line}`);

test('an LCOV report gives the changed lines it lists with no hits, and nothing else', async (t) => {
  const dir = temporary(t);
  // Node's own reporter writes relative paths; c8 writes absolute ones under the directory the run used.
  for (const report of [fixture('node-test.lcov.info'), recorded('c8.lcov.info', dir)]) {
    const evidence = await collect(dir, { report });
    // Line 5 and 6 are uncovered but unchanged, src/format.js is uncovered but not in the change, and shop/cart.py is not in the report.
    assert.deepEqual(lines(evidence), ['src/cart.js:4', 'src/cart.js:13', 'src/cart.js:14']);
    assert.equal(evidence.commands[0].coverageInconclusive, undefined);
    const [first] = evidence.signals;
    assert.equal(first.kind, 'uncovered_line');
    assert.equal(first.tool, 'test');
    assert.equal(first.claim, 'changed line 4 was not run by any test in coverage/report');
    // What a finding's evidence block shows, so it names the report the finding relied on.
    assert.deepEqual(first.evidence, ['coverage/report: line 4 is executable and has 0 hits']);
  }
});

test('a Cobertura report from coverage.py gives the changed lines it lists with no hits', async (t) => {
  const dir = temporary(t);
  const evidence = await collect(dir, { report: recorded('coverage-py.cobertura.xml', dir) });
  // Line 5 is uncovered but unchanged, and shop/tax.py is not in the change.
  assert.deepEqual(lines(evidence), ['shop/cart.py:4', 'shop/cart.py:12']);
  assert.equal(evidence.commands[0].coverageInconclusive, undefined);
});

test('a line any record ran counts as run, and a report naming no changed line gives no signal', async (t) => {
  const dir = temporary(t);
  const twice = `${fixture('node-test.lcov.info')}\nTN:\nSF:src/cart.js\nDA:4,3\nDA:13,0\nend_of_record\n`;
  assert.deepEqual(lines(await collect(dir, { report: twice })), ['src/cart.js:13', 'src/cart.js:14']);
  const elsewhere = '<?xml version="1.0" ?>\n<coverage version="7.6.4"><sources><source>/elsewhere</source></sources><packages><package name="x"><classes><class name="cart.py" filename="shop/cart.py"><lines><line number="4" hits="0"/></lines></class></classes></package></packages></coverage>\n';
  const evidence = await collect(dir, { report: elsewhere });
  assert.deepEqual(evidence.signals, []);
  assert.equal(evidence.commands[0].coverageInconclusive, undefined);
});

test('a report that cannot say which lines ran is inconclusive with a reason, never zero coverage', async (t) => {
  const dir = temporary(t);
  const lcov = fixture('node-test.lcov.info');
  const cases = [
    [{}, 'coverage/report was not written by the command'],
    [{ report: 'not a coverage report\n' }, 'coverage/report is neither LCOV nor Cobertura XML'],
    [{ report: lcov, status: 1 }, 'coverage/report was not read: the command exited 1, so the report may be partial'],
    [{ report: lcov, diff: null }, 'coverage/report was not read: no diff was given, so the changed lines are unknown'],
    [{ report: lcov, coverage: '../outside/report' }, '../outside/report is outside the directory the command ran in'],
  ];
  for (const [options, reason] of cases) {
    rmSync(join(dir, 'coverage'), { recursive: true, force: true });
    const evidence = await collect(dir, options);
    assert.deepEqual(evidence.signals, [], reason);
    assert.equal(evidence.commands[0].coverageInconclusive, reason);
    // The command ran; only its report is inconclusive.
    assert.deepEqual(evidence.didNotRun, []);
  }
});

test('a report the run did not write, such as one committed to the head, is stale', async (t) => {
  const dir = temporary(t);
  mkdirSync(join(dir, 'coverage'));
  writeFileSync(join(dir, 'coverage/report'), fixture('node-test.lcov.info'));
  const anHourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, 'coverage/report'), anHourAgo, anHourAgo);
  const evidence = await collect(dir);
  assert.deepEqual(evidence.signals, []);
  assert.equal(evidence.commands[0].coverageInconclusive, 'coverage/report was not written during this run, so it may describe another commit');
});

test('a report linked to a file outside the directory is not read', async (t) => {
  const dir = temporary(t);
  const outside = temporary(t);
  writeFileSync(join(outside, 'lcov.info'), fixture('node-test.lcov.info'));
  mkdirSync(join(dir, 'coverage'));
  symlinkSync(join(outside, 'lcov.info'), join(dir, 'coverage/report'));
  const evidence = await collectEvidence([{ name: 'test', run: 'npm test', coverage: 'coverage/report' }], {
    cwd: dir,
    enabled: true,
    changed,
    spawn: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.deepEqual(evidence.signals, []);
  assert.equal(evidence.commands[0].coverageInconclusive, 'coverage/report is outside the directory the command ran in');
});

test('the coverage key is read from static_evidence.commands without an unknown-key warning', (t) => {
  const dir = temporary(t);
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(
    join(dir, '.review-voice/config.yaml'),
    'static_evidence:\n  enabled: true\n  commands:\n    - name: test\n      run: npm test\n      coverage: coverage/lcov.info\n',
  );
  const config = loadConfig(dir);
  assert.deepEqual(config.staticEvidence.commands, [{ name: 'test', run: 'npm test', coverage: 'coverage/lcov.info' }]);
  assert.deepEqual(config.warnings.filter((warning) => warning.includes('coverage')), []);
});

test('the built CLI reads a real command\'s report against --diff-file', (t) => {
  const dir = temporary(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, 'recorded.lcov'), fixture('node-test.lcov.info'));
  writeFileSync(join(dir, 'change.patch'), patch);
  writeFileSync(
    join(dir, '.review-voice/config.yaml'),
    JSON.stringify({ static_evidence: { enabled: true, commands: [{ name: 'test', run: 'mkdir -p coverage && cp recorded.lcov coverage/lcov.info', coverage: 'coverage/lcov.info' }] } }),
  );
  const env = { ...process.env, REVIEW_VOICE_NO_COMMANDS: '0', REVIEW_VOICE_DATA_DIR: temporary(t) };
  delete env.REVIEW_VOICE_CONFIG;
  const run = (args) => JSON.parse(execFileSync(process.execPath, [bundle, 'evidence', ...args], { cwd: dir, encoding: 'utf8', env }));
  assert.deepEqual(lines(run(['--diff-file', join(dir, 'change.patch')])), ['src/cart.js:4', 'src/cart.js:13', 'src/cart.js:14']);
  assert.equal(run([]).commands[0].coverageInconclusive, 'coverage/lcov.info was not read: no diff was given, so the changed lines are unknown');
});
