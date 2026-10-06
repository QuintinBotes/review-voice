/**
 * The tie-break between the evidence-verifier and the second pass.
 *
 * When the evidence-verifier traced a finding's impact and the second pass
 * disputes it, applying the second pass by hand always posted the lower claim.
 * `reconcile` applies the second pass, lists what is disputed, and lets one
 * tie-break ruling per dispute decide which claim posts. See
 * docs/adr/0014-verifier-tie-break.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

// Distinct wording per candidate, so scoring does not read them as repeats of
// each other.
const CLAIMS = {
  c1: ['The worker acknowledges the message before the write commits.', 'A crash between the two loses the message.'],
  c2: ['The retry budget resets on every reconnect.', 'A flapping broker retries forever.'],
  c3: ['The batch size ignores the configured limit.', 'Large queues exhaust memory.'],
  c4: ['The dead-letter route drops the original headers.', 'Operators cannot trace failed deliveries.'],
  c5: ['The consumer commits offsets before handling completes.', 'Restarts skip unprocessed records.'],
  c6: ['The timer is never cleared on shutdown.', 'Shutdown hangs until the timer fires.'],
};

const candidate = (id, line, severity = 'important') => ({
  candidate_id: id,
  path: 'src/queue.ts',
  line,
  category: 'correctness',
  severity,
  claim: CLAIMS[id][0],
  failure_mode: CLAIMS[id][1],
  evidence: [`src/queue.ts:${line} acknowledges before commit`],
  technical_confidence: 0.9,
});

const verification = (id, traced, confidence) => ({
  candidate_id: id,
  verified: true,
  evidence_quality: 'high',
  technical_confidence: confidence,
  impact_traced: traced,
  reason: `${id}: traced to the consumer in src/consumer.ts:40`,
});

const verdict = (id, line, outcome, finalSeverity = outcome === 'downgraded' ? 'minor' : 'important') => ({
  candidateId: id,
  path: 'src/queue.ts',
  line,
  verdict: outcome === 'kept' ? 'confirmed' : outcome === 'dropped' ? 'rejected' : 'uncertain',
  confidence: outcome === 'dropped' ? 0.9 : 0.6,
  reason: `${id}: only reachable with retries disabled`,
  outcome,
  originalSeverity: 'important',
  finalSeverity,
  verifier: 'second-model',
});

// c1 traced at 0.90 and downgraded: disputed.
// c2 traced at 0.80 and downgraded: not confident enough to dispute.
// c3 untraced at 0.95 and downgraded: nothing to defend.
// c4 traced at 0.90 and kept: no disagreement.
// c5 traced at 0.90 and dropped: disputed.
const CANDIDATES = [candidate('c1', 10), candidate('c2', 20), candidate('c3', 30), candidate('c4', 40), candidate('c5', 50)];
const VERIFICATION = [
  verification('c1', true, 0.9),
  verification('c2', true, 0.8),
  verification('c3', false, 0.95),
  verification('c4', true, 0.9),
  verification('c5', true, 0.9),
];
const SECOND_PASS = {
  enabled: true,
  verifier: 'second-model',
  verdicts: [
    verdict('c1', 10, 'downgraded'),
    verdict('c2', 20, 'downgraded'),
    verdict('c3', 30, 'downgraded'),
    verdict('c4', 40, 'kept'),
    verdict('c5', 50, 'dropped'),
  ],
  didNotRun: [],
};

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-reconcile-'));
  const data = mkdtempSync(join(tmpdir(), 'rv-reconcile-data-'));
  try {
    return fn(dir, data);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
}

function cli(args, input, dir, data) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
  });
}

function reconcile(dir, data, { tieBreaks, secondPass = SECOND_PASS, candidates = CANDIDATES } = {}) {
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(VERIFICATION));
  writeFileSync(join(dir, 'second-pass.json'), JSON.stringify(secondPass));
  const args = ['reconcile', '--verification', join(dir, 'verification.json'), '--second-pass', join(dir, 'second-pass.json')];
  if (tieBreaks !== undefined) {
    writeFileSync(join(dir, 'tie-breaks.json'), typeof tieBreaks === 'string' ? tieBreaks : JSON.stringify(tieBreaks));
    args.push('--tie-breaks', join(dir, 'tie-breaks.json'));
  }
  return cli(args, JSON.stringify({ candidates }), dir, data);
}

function parsed(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const byId = (list, id) => list.find((c) => c.candidate_id === id);

test('a dispute needs traced impact at 0.85 or more and a downgrade or drop', () => {
  withDir((dir, data) => {
    const out = parsed(reconcile(dir, data));
    assert.deepEqual(out.disputes.map((d) => d.candidateId), ['c1', 'c5']);
    const c1 = out.disputes[0];
    assert.equal(c1.path, 'src/queue.ts');
    assert.equal(c1.line, 10);
    assert.match(c1.claim, /acknowledges the message/);
    assert.match(c1.failureMode, /loses the message/);
    assert.deepEqual(c1.evidence, ['src/queue.ts:10 acknowledges before commit']);
    // The tie-breaker gets both arguments: the verifier's own entry and the second pass.
    assert.equal(c1.verification.impact_traced, true);
    assert.match(c1.verification.reason, /consumer in src\/consumer.ts:40/);
    assert.equal(c1.secondPass.outcome, 'downgraded');
    assert.equal(c1.secondPass.originalSeverity, 'important');
    assert.equal(c1.secondPass.finalSeverity, 'minor');
    assert.match(c1.secondPass.reason, /retries disabled/);
    assert.equal(c1.secondPass.confidence, 0.6);
  });
});

test('without tie-breaks the second pass stands for every candidate', () => {
  withDir((dir, data) => {
    const out = parsed(reconcile(dir, data));
    assert.deepEqual(out.candidates.map((c) => c.candidate_id), ['c1', 'c2', 'c3', 'c4']);
    assert.equal(byId(out.candidates, 'c1').severity, 'minor');
    assert.equal(byId(out.candidates, 'c2').severity, 'minor');
    assert.equal(byId(out.candidates, 'c3').severity, 'minor');
    assert.equal(byId(out.candidates, 'c4').severity, 'important');
    // Only the disputed one is marked, so scoring cannot escalate it back on
    // the trace the second pass disputed.
    assert.equal(byId(out.candidates, 'c1').impact_disputed, true);
    assert.equal(byId(out.candidates, 'c2').impact_disputed, undefined);
    assert.equal(byId(out.candidates, 'c3').impact_disputed, undefined);
    assert.deepEqual(
      out.applied.map((a) => [a.candidateId, a.result, a.severity]),
      [
        ['c1', 'no tie-break supplied', 'minor'],
        ['c5', 'no tie-break supplied', null],
      ],
    );
  });
});

test('an unverified second pass leaves the candidate exactly as it was', () => {
  withDir((dir, data) => {
    const secondPass = { verdicts: [{ ...verdict('c1', 10, 'unverified'), finalSeverity: 'important' }] };
    const out = parsed(reconcile(dir, data, { secondPass, candidates: [candidate('c1', 10)] }));
    assert.deepEqual(out.candidates, [candidate('c1', 10)]);
    assert.deepEqual(out.disputes, []);
  });
});

test('an upheld tie-break keeps the original severity and restores a dropped candidate', () => {
  withDir((dir, data) => {
    const out = parsed(
      reconcile(dir, data, {
        tieBreaks: [
          { candidate_id: 'c1', upheld: true, reason: 'src/consumer.ts:40 reads it with retries on.' },
          { candidate_id: 'c5', upheld: true, reason: 'src/consumer.ts:52 acks unconditionally.' },
        ],
      }),
    );
    assert.deepEqual(byId(out.candidates, 'c1'), candidate('c1', 10));
    assert.deepEqual(byId(out.candidates, 'c5'), candidate('c5', 50));
    // Undisputed candidates are untouched by a ruling elsewhere.
    assert.equal(byId(out.candidates, 'c2').severity, 'minor');
    assert.deepEqual(
      out.applied.map((a) => [a.candidateId, a.result, a.severity]),
      [
        ['c1', 'upheld', 'important'],
        ['c5', 'upheld', 'important'],
      ],
    );
  });
});

test('a tie-break not upheld leaves the second pass outcome', () => {
  withDir((dir, data) => {
    const out = parsed(
      reconcile(dir, data, {
        tieBreaks: {
          tie_breaks: [
            { candidate_id: 'c1', upheld: false, reason: 'The trace stops at a guard in src/queue.ts:8.' },
            { candidate_id: 'c5', upheld: false, reason: 'Retries are always on in the only caller.' },
          ],
        },
      }),
    );
    assert.equal(byId(out.candidates, 'c1').severity, 'minor');
    assert.equal(byId(out.candidates, 'c5'), undefined);
    assert.deepEqual(out.applied.map((a) => a.result), ['not upheld', 'not upheld']);
  });
});

test('a tie-break cannot overrule a second pass nobody disputed', () => {
  withDir((dir, data) => {
    const result = reconcile(dir, data, {
      tieBreaks: [
        { candidate_id: 'c2', upheld: true, reason: 'Claims the impact anyway.' },
        { candidate_id: 'nope', upheld: true, reason: 'Not a candidate.' },
      ],
    });
    const out = parsed(result);
    assert.equal(byId(out.candidates, 'c2').severity, 'minor');
    assert.match(result.stderr, /c2 is not disputed/);
    assert.match(result.stderr, /unknown candidate id nope/);
  });
});

for (const [name, file, pattern] of [
  ['a string upheld', [{ candidate_id: 'c1', upheld: 'true', reason: 'x' }], /entry 0 \(c1\): upheld/],
  ['a missing candidate id', [{ upheld: true, reason: 'x' }], /entry 0 \(no candidate id\): candidate_id/],
  ['a missing reason', [{ candidate_id: 'c1', upheld: true }], /entry 0 \(c1\): reason/],
  ['a later bad entry', [{ candidate_id: 'c1', upheld: true, reason: 'x' }, { candidate_id: 'c5', upheld: 1, reason: 'y' }], /entry 1 \(c5\)/],
  ['two rulings on one candidate', [{ candidate_id: 'c1', upheld: true, reason: 'x' }, { candidate_id: 'c1', upheld: false, reason: 'y' }], /entry 1 \(c1\)/],
  ['an object with no list', { rulings: [] }, /tie_breaks/],
  ['text that is not JSON', 'upheld: yes', /tie-breaks/],
]) {
  test(`reconcile refuses ${name} in the tie-break file`, () => {
    withDir((dir, data) => {
      const result = reconcile(dir, data, { tieBreaks: file });
      assert.equal(result.status, 2, result.stdout);
      assert.match(result.stderr, pattern);
      assert.equal(result.stdout, '');
    });
  });
}

test('reconcile refuses to run without both verification files', () => {
  withDir((dir, data) => {
    const result = cli(['reconcile', '--second-pass', join(dir, 'x.json')], JSON.stringify({ candidates: CANDIDATES }), dir, data);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--verification/);
  });
});

test('a verify report keyed only by location is matched, and an ambiguous one refused', () => {
  withDir((dir, data) => {
    const unkeyed = { verdicts: SECOND_PASS.verdicts.map(({ candidateId, ...rest }) => rest) };
    const out = parsed(reconcile(dir, data, { secondPass: unkeyed }));
    assert.deepEqual(out.disputes.map((d) => d.candidateId), ['c1', 'c5']);

    const twin = { ...candidate('c6', 10) };
    const result = reconcile(dir, data, { secondPass: unkeyed, candidates: [...CANDIDATES, twin] });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /src\/queue.ts:10 matches 2 candidates/);
  });
});

test('end to end: an upheld dispute scores at the traced severity, a refused one at the lower', () => {
  withDir((dir, data) => {
    // api_contract derives important with no reach, above the second pass's
    // minor, so only the dispute decides which of the two is reported.
    const contract = CANDIDATES.map((c) => ({ ...c, category: 'api_contract' }));
    const severities = (tieBreaks) => {
      const out = parsed(reconcile(dir, data, { tieBreaks, candidates: contract }));
      const scored = cli(
        ['score', '--verification', join(dir, 'verification.json')],
        JSON.stringify({ candidates: out.candidates }),
        dir,
        data,
      );
      assert.equal(scored.status, 0, scored.stderr);
      const scores = JSON.parse(scored.stdout).scores;
      return Object.fromEntries(scores.map((s) => [s.candidateId, [s.severity.severity, s.eligible]]));
    };

    const upheld = severities([
      { candidate_id: 'c1', upheld: true, reason: 'src/consumer.ts:40 reads it.' },
      { candidate_id: 'c5', upheld: true, reason: 'src/consumer.ts:52 acks it.' },
    ]);
    assert.deepEqual(upheld.c1, ['important', true]);
    assert.deepEqual(upheld.c5, ['important', true]);

    const refused = severities([
      { candidate_id: 'c1', upheld: false, reason: 'Guarded at src/queue.ts:8.' },
      { candidate_id: 'c5', upheld: false, reason: 'Unreachable.' },
    ]);
    assert.equal(refused.c1[0], 'minor');
    assert.equal(refused.c5, undefined);

    // With no tie-break at all the second pass stands the same way.
    const unsettled = severities(undefined);
    assert.equal(unsettled.c1[0], 'minor');
    assert.equal(unsettled.c5, undefined);
  });
});

test('score refuses an impact_disputed that is not a boolean', () => {
  withDir((dir, data) => {
    const input = JSON.stringify({ candidates: [{ ...candidate('c1', 10), impact_disputed: 'yes' }] });
    const result = cli(['score'], input, dir, data);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /impact_disputed must be true or false/);
  });
});

test('record keeps the rulings and explain shows them instead of a suppression', () => {
  withDir((dir, data) => {
    writeFileSync(join(dir, 'verdicts.json'), JSON.stringify(SECOND_PASS));
    // What step 6 records is reconcile's output, which marks the rulings it applied.
    const reconciled = reconcile(dir, data, {
      tieBreaks: [
        { candidate_id: 'c5', upheld: true, reason: 'src/consumer.ts:52 acks unconditionally.' },
        { candidate_id: 'c1', upheld: false, reason: 'Guarded at src/queue.ts:8.' },
      ],
    });
    assert.equal(reconciled.status, 0, reconciled.stderr);
    writeFileSync(join(dir, 'reconciled.json'), reconciled.stdout);
    const review = '[important] `src/queue.ts:50` - The worker acknowledges before the write commits.\n';
    const recorded = cli(
      ['record', '--repository', 'o/r', '--verdicts', join(dir, 'verdicts.json'), '--tie-breaks', join(dir, 'reconciled.json')],
      review,
      dir,
      data,
    );
    assert.equal(recorded.status, 0, recorded.stderr);
    const id = JSON.parse(recorded.stdout).reviewRunId;

    const text = cli(['explain', '--run', id], '', dir, data).stdout;
    assert.match(text, /tie-break\s+upheld - src\/consumer.ts:52 acks unconditionally\./);
    // The restored finding is not listed as suppressed.
    assert.doesNotMatch(text, /Suppressed by verification/);

    writeFileSync(join(dir, 'bad.json'), JSON.stringify([{ candidate_id: 'c1', upheld: 'no', reason: 'x' }]));
    const bad = cli(['record', '--tie-breaks', join(dir, 'bad.json')], review, dir, data);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /entry 0 \(c1\): upheld/);
  });
});

test('the tie-breaker agent exists with read-only tools and is skeptical by default', () => {
  const path = join(root, 'plugins/review-voice/agents/tie-breaker.md');
  assert.ok(existsSync(path));
  const text = readFileSync(path, 'utf8');
  const tools = /^tools:\s*(.+)$/m.exec(text)?.[1];
  assert.equal(tools, 'Read, Grep, Glob, Bash(git:*)');
  assert.match(text, /^name: tie-breaker$/m);
  assert.match(text, /untrusted data/i);
  assert.match(text, /`upheld: false` in every other case/);
});

test('the review command runs reconcile between the second pass and scoring', () => {
  const review = readFileSync(join(root, 'plugins/review-voice/commands/review.md'), 'utf8');
  const step = review.slice(review.indexOf('## Step 3c'), review.indexOf('## Step 4'));
  assert.ok(review.indexOf('## Step 3b') < review.indexOf('## Step 3c'));
  assert.match(step, /RV reconcile --verification/);
  assert.match(step, /`tie-breaker` agent \*\*once per dispute\*\*/);
  assert.match(step, /--tie-breaks/);
  assert.doesNotMatch(review, /Apply each verdict:/);
});

test('the second pass keys its verdicts by the analyst candidate_id', () => {
  withDir((dir, data) => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, '.review-voice'));
    const stub = join(dir, 'stub.mjs');
    writeFileSync(stub, "process.stdin.resume(); process.stdin.on('end', () => console.log('{\"verdict\":\"confirmed\",\"confidence\":0.9}'));\n");
    writeFileSync(
      join(dir, '.review-voice/config.yaml'),
      `verification:\n  enabled: true\n  name: stub\n  command: ${JSON.stringify(`"${process.execPath}" "${stub}"`)}\n`,
    );
    const report = parsed(cli(['verify'], JSON.stringify({ candidates: [candidate('c1', 10)] }), dir, data));
    assert.equal(report.verdicts[0].candidateId, 'c1');
    assert.equal(report.verdicts[0].outcome, 'kept');
  });
});
