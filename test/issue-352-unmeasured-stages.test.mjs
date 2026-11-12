/** #352: a stage may be recorded without its measurements, and a figure nobody measured is no data, never a zero. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { shallowPassWarning, unjudgedRead } from '../plugins/review-voice/src/store/effort.ts';
import { computeMetrics, stageSeconds } from '../plugins/review-voice/src/evaluate/metrics.ts';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const FIGURES = ['seconds', 'toolCalls', 'filesRead', 'tokens'];
const MEASURED = { name: 'analyst', seconds: 5, toolCalls: 3, filesRead: 2, tokens: 900 };

/** `files` new files of `each` added lines. */
const patchOf = (files, each) =>
  Array.from({ length: files }, (_, f) =>
    [
      `diff --git a/src/f${f}.ts b/src/f${f}.ts`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/src/f${f}.ts`,
      `@@ -0,0 +1,${each} @@`,
      ...Array.from({ length: each }, (_, i) => `+const v${i} = ${i};`),
    ].join('\n'),
  ).join('\n') + '\n';

/** A store of its own, and `rv` to run the built bundle against it. */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-352-'));
  try {
    const env = { ...process.env, REVIEW_VOICE_DATA_DIR: dir };
    const rv = (args, input) => spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', env, ...(input === undefined ? {} : { input }) });
    return fn(rv, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Records a review, clean unless `output` says otherwise, with the stages file `text`, over `diff` when one is given. */
function record(rv, dir, text, diff = null, output = 'No actionable findings.') {
  writeFileSync(join(dir, 'stages.json'), text);
  if (diff !== null) writeFileSync(join(dir, 'd.patch'), diff);
  return rv(['record', '--repository', 'o/r', '--stages', join(dir, 'stages.json'), ...(diff === null ? [] : ['--diff-file', join(dir, 'd.patch')])], output);
}

const storedStages = (rv) => JSON.parse(rv(['explain', '--json']).stdout).stages;

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-352-db-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const runWith = (db, stages) => recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'd', output: 'No actionable findings.', stages });
const metric = (metrics, name) => metrics.find((m) => m.name === name);

test('a stage with only a name is stored and read back as not measured', () => {
  withStore((rv, dir) => {
    const done = record(rv, dir, JSON.stringify([{ name: 'analyst' }]));
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(storedStages(rv), [{ name: 'analyst' }]);
    assert.match(rv(['explain']).stdout, /^Effort analyst: seconds not measured, tool calls not measured, files read not measured, tokens not measured$/m);
  });
});

test('each of the four figures may be left out or null alone, and the rest are kept', () => {
  for (const figure of FIGURES) {
    const { [figure]: _dropped, ...rest } = MEASURED;
    for (const stage of [rest, { ...MEASURED, [figure]: null }]) {
      withStore((rv, dir) => {
        const done = record(rv, dir, JSON.stringify([stage]));
        assert.equal(done.status, 0, `${figure}: ${done.stderr}`);
        assert.doesNotMatch(done.stderr, /Stages in|must be/, figure);
        assert.deepEqual(storedStages(rv), [rest], figure);
      });
    }
  }
});

test('a figure that is present must still be a number of zero or more', () => {
  for (const figure of FIGURES) {
    // 1e999 is how a JSON file spells a number that is not finite.
    for (const value of ['"5"', '-1', '1e999', 'true', '[]']) {
      withStore((rv, dir) => {
        const done = record(rv, dir, `[${JSON.stringify(MEASURED).replace(`"${figure}":${MEASURED[figure]}`, `"${figure}":${value}`)}]`);
        assert.equal(done.status, 2, `${figure} ${value}: ${done.stderr}`);
        assert.match(done.stderr, new RegExp(`Cannot read stages from .*entry 0: ${figure} must be a number`), `${figure} ${value}`);
        assert.match(rv(['explain']).stdout, /No review has been recorded yet/);
      });
    }
  }
});

test('a stage still needs a name, and an unknown field is still kept out and warned about', () => {
  withStore((rv, dir) => {
    const unnamed = record(rv, dir, JSON.stringify([{ toolCalls: 3 }]));
    assert.equal(unnamed.status, 2, unnamed.stderr);
    assert.match(unnamed.stderr, /entry 0: name must be a non-empty string/);
    const noted = record(rv, dir, JSON.stringify([{ name: 'verifier', note: 'x' }]));
    assert.equal(noted.status, 0, noted.stderr);
    assert.match(noted.stderr, /entry 0: unknown field "note" not stored/);
    assert.deepEqual(storedStages(rv), [{ name: 'verifier' }]);
  });
});

test('the median and p95 of a stage ignore the runs that did not measure it, and count them', () => {
  withDb((db) => {
    runWith(db, [{ name: 'analyst', seconds: 10 }, { name: 'verifier', seconds: 4 }]);
    runWith(db, [{ name: 'analyst', seconds: 20 }, { name: 'verifier' }]);
    runWith(db, [{ name: 'analyst', seconds: 30 }, { name: 'verifier', seconds: 6 }]);
    runWith(db, [{ name: 'analyst' }]);
    // Named twice in one run and timed once: the sum would pass an unmeasured call off as zero seconds.
    runWith(db, [{ name: 'analyst', seconds: null }, { name: 'verifier', seconds: 100 }, { name: 'verifier' }]);
    // Counted as zeros, the analyst's median would be 10; with the partial sum, the verifier's p95 would be 100.
    assert.deepEqual(stageSeconds(db), {
      analyst: { median: 20, p95: 30, runs: 3, unmeasured: 2 },
      verifier: { median: 6, p95: 6, runs: 2, unmeasured: 2 },
    });
  });
});

test('a run with an unmeasured stage has no review seconds, as a run with an uncosted stage has no cost', () => {
  withDb((db) => {
    runWith(db, [{ name: 'analyst', seconds: 10 }, { name: 'verifier', seconds: 4 }]);
    runWith(db, [{ name: 'analyst', seconds: 500 }, { name: 'verifier' }]);
    const metrics = computeMetrics(db);
    assert.equal(metric(metrics, 'median_review_seconds').value, 14);
    assert.equal(metric(metrics, 'p95_review_seconds').value, 14);
    assert.equal(metric(metrics, 'p95_review_seconds').basis, '1 run(s) with recorded stages, 1 excluded (a stage not measured)');
  });
});

test('an unmeasured entry ahead of a measured one still leaves the stage and the run without a figure', () => {
  withDb((db) => {
    // The order the two tests above do not cover: a sum restarted at the measured entry would report 100 and 500.
    runWith(db, [{ name: 'verifier' }, { name: 'verifier', seconds: 100 }]);
    runWith(db, [{ name: 'editor' }, { name: 'analyst', seconds: 500 }]);
    assert.deepEqual(stageSeconds(db), {
      analyst: { median: 500, p95: 500, runs: 1, unmeasured: 0 },
      editor: { median: null, p95: null, runs: 0, unmeasured: 1 },
      verifier: { median: null, p95: null, runs: 0, unmeasured: 1 },
    });
    const seconds = metric(computeMetrics(db), 'median_review_seconds');
    assert.equal(seconds.value, null);
    assert.equal(seconds.basis, '0 run(s) with recorded stages, 2 excluded (a stage not measured)');
  });
});

test('a recorded zero seconds is left out of the figures and is not counted as unmeasured', () => {
  withDb((db) => {
    runWith(db, [{ name: 'analyst', seconds: 10 }]);
    runWith(db, [{ name: 'analyst', seconds: 0 }, { name: 'editor', seconds: 0 }]);
    runWith(db, [{ name: 'analyst', seconds: 30 }]);
    runWith(db, [{ name: 'analyst', seconds: 50 }]);
    // With the zero among them the median would be 10, and the editor would have a row.
    assert.deepEqual(stageSeconds(db), { analyst: { median: 30, p95: 50, runs: 3, unmeasured: 0 } });
  });
});

test('a negative seconds stored by an older version stays out of the stage figures, as it stays out of the review seconds', () => {
  withDb((db) => {
    // 1.24.0 accepted any finite seconds; this version refuses a negative, so only an old row holds one.
    runWith(db, [{ name: 'analyst', seconds: 10 }]);
    runWith(db, [{ name: 'analyst', seconds: -5 }, { name: 'editor', seconds: -5 }]);
    runWith(db, [{ name: 'analyst', seconds: 30 }]);
    runWith(db, [{ name: 'analyst', seconds: 50 }]);
    assert.deepEqual(stageSeconds(db), { analyst: { median: 30, p95: 50, runs: 3, unmeasured: 0 } });
    const seconds = metric(computeMetrics(db), 'median_review_seconds');
    assert.equal(seconds.value, 30);
    assert.equal(seconds.basis, '3 run(s) with recorded stages');
  });
});

test('a stage never measured gives null figures and prints as not measured in text, JSON and the rendered page', () => {
  withStore((rv, dir) => {
    assert.equal(record(rv, dir, JSON.stringify([{ name: 'analyst', toolCalls: 12 }])).status, 0);
    assert.equal(record(rv, dir, JSON.stringify([{ name: 'analyst' }])).status, 0);

    const json = JSON.parse(rv(['evaluate', '--json']).stdout);
    assert.deepEqual(json.stage_seconds, { analyst: { median: null, p95: null, runs: 0, unmeasured: 2 } });
    assert.equal(json.metrics.find((m) => m.name === 'median_review_seconds').value, null);

    const page = rv(['evaluate', '--html']).stdout;
    assert.ok(page.includes('<tr><th>stage</th><th>median</th><th>p95</th><th>runs</th><th>unmeasured</th></tr>'), page);
    assert.ok(page.includes('<tr><td>analyst</td><td>no data</td><td>no data</td><td>0</td><td>2</td></tr>'), page);

    const text = rv(['evaluate']).stdout;
    assert.match(text, /median_review_seconds\s+no data\s/);
    assert.match(text, /0 run\(s\) with recorded stages, 2 excluded \(a stage not measured\)/);
    assert.match(rv(['explain']).stdout, /^Effort analyst: seconds not measured, /m);
  });
});

test('record raises no shallow-read warning and says once that the read could not be judged when filesRead is missing', () => {
  const unjudged = /could not be judged, because the stage recorded no file count/g;
  withStore((rv, dir) => {
    const done = record(rv, dir, JSON.stringify([{ name: 'analyst', seconds: 90, toolCalls: 30 }]), patchOf(14, 20));
    assert.equal(done.status, 0, done.stderr);
    assert.equal(JSON.parse(done.stdout).warnings, undefined);
    assert.equal(done.stderr.match(unjudged)?.length, 1, done.stderr);
    assert.match(done.stderr, /14 changed files/);
    const explained = rv(['explain']).stdout;
    assert.match(explained, /^Effort analyst: 90s, 30 tool calls, files read not measured, tokens not measured, on 280 changed lines$/m);
    assert.doesNotMatch(explained, /^Warning /m);
  });
  // The control: a count that was measured is judged as before, and nothing is said about judging.
  withStore((rv, dir) => {
    const done = record(rv, dir, JSON.stringify([{ name: 'analyst', seconds: 90, toolCalls: 30, filesRead: 2 }]), patchOf(14, 20));
    assert.equal(done.status, 0, done.stderr);
    assert.match(JSON.parse(done.stdout).warnings[0], /read 2 of 14 changed files/);
    assert.doesNotMatch(done.stderr, unjudged);
  });
  // Nothing to judge: no diff, no analyst stage, a diff that changes no line, or a finding.
  withStore((rv, dir) => {
    const nameOnly = JSON.stringify([{ name: 'analyst' }]);
    assert.doesNotMatch(record(rv, dir, nameOnly).stderr, unjudged);
    assert.doesNotMatch(record(rv, dir, JSON.stringify([{ name: 'verifier' }]), patchOf(14, 20)).stderr, unjudged);
    const renamed = record(rv, dir, nameOnly, 'diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n');
    assert.equal(renamed.status, 0, renamed.stderr);
    assert.doesNotMatch(renamed.stderr, unjudged);
    const found = record(rv, dir, nameOnly, patchOf(14, 20), '[minor] `src/f0.ts:1` - Something breaks here. It fails. Fix it.');
    assert.equal(found.status, 0, found.stderr);
    assert.equal(JSON.parse(found.stdout).findings.length, 1);
    assert.doesNotMatch(found.stderr, unjudged);
  });
});

test('the read is reported as not judged when another stage is recorded ahead of the analyst', () => {
  const unjudged = /could not be judged, because the stage recorded no file count/g;
  withStore((rv, dir) => {
    // The order a real review records. The first stage carries a file count, so reading it for the analyst says nothing.
    const done = record(rv, dir, JSON.stringify([{ name: 'intent', filesRead: 14 }, { name: 'analyst' }, { name: 'verifier', filesRead: 14 }]), patchOf(14, 20));
    assert.equal(done.status, 0, done.stderr);
    assert.equal(JSON.parse(done.stdout).warnings, undefined);
    assert.equal(done.stderr.match(unjudged)?.length, 1, done.stderr);
  });
  withStore((rv, dir) => {
    const done = record(rv, dir, JSON.stringify([{ name: 'intent' }, { name: 'analyst', filesRead: 2 }]), patchOf(14, 20));
    assert.equal(done.status, 0, done.stderr);
    assert.match(JSON.parse(done.stdout).warnings[0], /read 2 of 14 changed files/);
    assert.doesNotMatch(done.stderr, unjudged);
  });
});

test('a figure stored as null is not measured to the shallow-read warning, as it is to the effort line', () => {
  // record stores no null, so only a row written by something else holds one.
  const unmeasured = { name: 'analyst', seconds: null, toolCalls: null, filesRead: null, tokens: null, diffLines: 240, diffFiles: 6 };
  withStore((rv, dir) => {
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      runWith(db, [unmeasured]);
    } finally {
      db.close();
    }
    const explained = rv(['explain']).stdout;
    assert.match(explained, /^Effort analyst: seconds not measured, tool calls not measured, files read not measured, tokens not measured, on 240 changed lines$/m);
    assert.doesNotMatch(explained, /^Warning /m);
    assert.doesNotMatch(explained, /null/);
  });
  assert.equal(shallowPassWarning([unmeasured], 0), null);
  assert.match(unjudgedRead([unmeasured], 0), /the 6 changed files could not be judged/);
  // Each figure alone: the one that was measured is still judged.
  assert.match(shallowPassWarning([{ ...unmeasured, toolCalls: 2 }], 0), /^The analyst made 2 tool call\(s\) on 240 changed lines and found nothing\./);
  assert.match(shallowPassWarning([{ ...unmeasured, filesRead: 2 }], 0), /^The analyst read 2 of 6 changed files and found nothing\./);
  assert.equal(unjudgedRead([{ ...unmeasured, filesRead: 2 }], 0), null);
});

test('a tool-call count that was measured is still judged when the file count was not', () => {
  withStore((rv, dir) => {
    const done = record(rv, dir, JSON.stringify([{ name: 'analyst', toolCalls: 2 }]), patchOf(14, 20));
    assert.equal(done.status, 0, done.stderr);
    const { warnings } = JSON.parse(done.stdout);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /made 2 tool call\(s\) on 280 changed lines/);
    assert.doesNotMatch(warnings[0], /changed files/);
  });
});

test('a run recorded by an older version, whose stages all carry numbers, reads exactly as before', () => {
  withStore((rv, dir) => {
    // Written as 1.24.0 stored it, not through this version's record.
    const db = openDatabase(join(dir, 'review-voice.db'));
    const old = [
      { name: 'analyst', seconds: 18, toolCalls: 4, tokens: 9000, filesRead: 2, diffLines: 300, diffFiles: 1 },
      { name: 'verifier', seconds: 6.5, toolCalls: 1, tokens: 1200, filesRead: 1 },
    ];
    try {
      runWith(db, old);
      runWith(db, [{ ...old[0], seconds: 22 }]);
    } finally {
      db.close();
    }
    assert.deepEqual(storedStages(rv), [{ ...old[0], seconds: 22 }]);
    const explained = rv(['explain']).stdout;
    assert.match(explained, /^Effort analyst: 22s, 4 tool calls, 2 files read, 9000 tokens, on 300 changed lines$/m);
    assert.match(explained, /^Warning The analyst made 4 tool call\(s\) on 300 changed lines and found nothing\./m);
    assert.doesNotMatch(explained, /not measured/);
    const json = JSON.parse(rv(['evaluate', '--json']).stdout);
    assert.deepEqual(json.stage_seconds, { analyst: { median: 22, p95: 22, runs: 2, unmeasured: 0 }, verifier: { median: 6.5, p95: 6.5, runs: 1, unmeasured: 0 } });
    const seconds = json.metrics.find((m) => m.name === 'median_review_seconds');
    assert.equal(seconds.value, 24.5);
    assert.equal(seconds.basis, '2 run(s) with recorded stages');
    assert.ok(rv(['evaluate', '--html']).stdout.includes('<tr><td>analyst</td><td>22.00</td><td>22.00</td><td>2</td><td>0</td></tr>'));
  });
});

test('the help and the slash command say a figure nobody measured is left out, never estimated', () => {
  const recordHelp = commandHelp('record');
  assert.match(recordHelp, /only "name" is required/);
  assert.match(recordHelp, /not measured/);
  assert.match(commandHelp('evaluate'), /unmeasured/);
  const command = readFileSync(join(root, 'plugins/review-voice/commands/review.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(command, /Give a number only when it was measured/);
  assert.match(command, /never estimate one/);
  for (const said of [
    /Only `name` is required\./,
    /and leave the field out otherwise/,
    /A stage you handed to a subagent comes back as its answer, [^.]*, so its entry is often the name alone, and that is the right record\./,
    /A figure left out is stored as not measured, and `explain` shows it so\./,
    /`evaluate` reads only `seconds`, and counts a stage recorded without it as unmeasured/,
    /`record` refuses an entry without `name`, or with a figure that is present and is not a number of zero or more, and stores/,
    /When the `analyst` entry has no `filesRead`, `record` raises no files warning and says on stderr that the read could not be judged, which is not a pass\./,
  ]) {
    assert.match(command, said);
  }
  assert.doesNotMatch(command, /refuses an entry without `name` and a numeric `seconds`/);
});
