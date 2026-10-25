import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { challengePrompt } from '../plugins/review-voice/src/verify/challenge.ts';

// The independent challenge (docs/adr/0024).

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

// Right side of src/a.ts: 1 context, 2-6 added, 7 context.
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,7 @@',
  ' line 1',
  '+added 2',
  '+added 3',
  '+added 4',
  '+added 5',
  '+added 6',
  ' line 7',
  '',
].join('\n');

const CLAIMS = {
  cand_001: 'The cache key omits the tenant, so one tenant reads the entries of another.',
  cand_002: 'The retry loop never stops when the server keeps answering with a timeout.',
  cand_003: 'The parsed limit is used before it is checked for a negative value.',
};

// Distinctive values in every field the challenger must not see.
const SECRET = {
  evidence: 'EVIDENCE_SENTINEL the verifier traced this',
  reason: 'REASON_SENTINEL the verifier agreed',
  fix: 'FIX_SENTINEL use the tenant id',
};

const scoreEntry = (id, line) => ({
  candidateId: id,
  candidate_id: id,
  path: 'src/a.ts',
  line,
  eligible: true,
  rejectedBecause: null,
  finalScore: 0.81,
  confidenceSource: 'verifier',
  severity: { severity: 'important', reason: 'correctness, traced' },
  anchorCheck: { path: 'src/a.ts', line, kind: 'added', ok: true, nearest: [line], patchLine: null, beyondHunks: false },
  verification: { reason: SECRET.reason, technical_confidence: 0.937, impact_traced: true },
  fix: { verdict: 'verified', reason: SECRET.fix },
});

const eligibleEntry = (id, line) => ({
  candidateId: id,
  candidate_id: id,
  path: 'src/a.ts',
  line,
  severity: 'important',
  requestedSeverity: 'important',
  severityReason: 'correctness, traced',
  category: 'correctness',
  claim: CLAIMS[id],
  failureMode: `Failure mode of ${id}.`,
  evidence: [SECRET.evidence],
  fix: { render: 'fix', text: SECRET.fix },
});

const SCORES = {
  scores: [
    scoreEntry('cand_001', 3),
    scoreEntry('cand_002', 4),
    scoreEntry('cand_003', 5),
    { candidateId: 'cand_009', candidate_id: 'cand_009', path: 'src/a.ts', line: 6, eligible: false, rejectedBecause: 'score 0.41 is below 0.68' },
  ],
  distribution: { count: 4 },
  eligible: [eligibleEntry('cand_001', 3), eligibleEntry('cand_002', 4), eligibleEntry('cand_003', 5)],
  belowGate: [],
};

const candidate = (id, line, extra = {}) => ({
  candidate_id: id,
  path: 'src/a.ts',
  line,
  category: 'correctness',
  severity: 'important',
  claim: CLAIMS[id],
  failure_mode: `Failure mode of ${id}.`,
  evidence: [SECRET.evidence],
  technical_confidence: 0.937,
  suggested_fix: SECRET.fix,
  ...extra,
});

const CANDIDATES = {
  candidates: [candidate('cand_001', 3, { intent_ref: 'int_001' }), candidate('cand_002', 4), candidate('cand_003', 5)],
};

const INTENT = {
  statements: [
    { id: 'int_001', kind: 'goal', statement: 'Cache per tenant.', quote: 'Every cache entry is scoped to its tenant.' },
    { id: 'int_002', kind: 'claim', statement: 'Unrelated.', quote: 'The retry policy is unchanged by this work.' },
  ],
};

const confirmed = (id, extra = {}) => ({
  candidate_id: id,
  verdict: 'confirmed',
  line_ok: true,
  decisive_evidence: ['src/a.ts:3'],
  reason: '',
  ...extra,
});

function withFiles(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-challenge-'));
  const files = {
    patch: join(dir, 'diff.patch'),
    scores: join(dir, 'scores.json'),
    candidates: join(dir, 'checked.json'),
    intent: join(dir, 'intent.json'),
    out: join(dir, 'scores.challenged.json'),
  };
  writeFileSync(files.patch, PATCH);
  writeFileSync(files.scores, JSON.stringify(SCORES, null, 2));
  writeFileSync(files.candidates, JSON.stringify(CANDIDATES, null, 2));
  writeFileSync(files.intent, JSON.stringify(INTENT, null, 2));
  const run = (args, input = '') => {
    const result = spawnSync(process.execPath, [bundle, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const apply = (verdicts, extra = []) =>
    run(
      ['challenge', '--scores', files.scores, '--candidates', files.candidates, '--diff-file', files.patch, ...extra],
      JSON.stringify({ verdicts }),
    );
  try {
    return fn({ dir, files, run, apply });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALL_CONFIRMED = [confirmed('cand_001'), confirmed('cand_002'), confirmed('cand_003')];

test('--emit-prompts prints one prompt per eligible finding with the claim, location and cited intent', () => {
  withFiles(({ files, run }) => {
    const r = run([
      'challenge', '--scores', files.scores, '--candidates', files.candidates, '--intent', files.intent,
      '--diff-file', files.patch, '--emit-prompts',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const { prompts } = JSON.parse(r.stdout);
    assert.deepEqual(prompts.map((p) => p.candidate_id), ['cand_001', 'cand_002', 'cand_003']);
    const first = prompts[0].prompt;
    assert.ok(first.includes(CLAIMS.cand_001));
    assert.ok(first.includes('Failure mode of cand_001.'));
    assert.ok(first.includes('correctness'));
    assert.ok(first.includes('src/a.ts:3'));
    assert.ok(first.includes(files.patch));
    assert.ok(first.includes('Every cache entry is scoped to its tenant.'), 'the cited quote');
    assert.ok(!first.includes('The retry policy is unchanged'), 'an uncited statement stays out');
    assert.ok(!prompts[1].prompt.includes('Every cache entry'), 'a finding citing nothing gets no intent');
    for (const { prompt } of prompts) {
      for (const sentinel of Object.values(SECRET)) assert.ok(!prompt.includes(sentinel), `prompt leaks ${sentinel}`);
      assert.ok(!prompt.includes('0.937'), 'prompt leaks a confidence');
    }
  });
});

test('challengePrompt never carries a verification field, whatever the finding holds', () => {
  const finding = {
    ...eligibleEntry('cand_001', 3),
    reason: SECRET.reason,
    technical_confidence: 0.937,
    impact_traced: true,
    fix_verdict: 'verified',
    fix_confidence: 0.912,
    fix_reason: SECRET.fix,
    fix_direction: 'DIRECTION_SENTINEL',
    verified: true,
    evidence_quality: 'high',
  };
  const prompt = challengePrompt(finding, { ...candidate('cand_001', 3), reason: SECRET.reason }, INTENT.statements);
  for (const key of ['technical_confidence', 'impact_traced', 'fix_verdict', 'fix_confidence', 'fix_reason', 'fix_direction', 'evidence_quality']) {
    assert.ok(!prompt.includes(key), `prompt names ${key}`);
  }
  for (const value of [...Object.values(SECRET), '0.937', '0.912', 'DIRECTION_SENTINEL']) {
    assert.ok(!prompt.includes(value), `prompt leaks ${value}`);
  }
  assert.ok(prompt.includes(CLAIMS.cand_001));
  assert.match(prompt, /not given the verifier's reasoning, confidence or evidence/);
});

test('each contradictory or incomplete verdict set is refused with exit 2, naming the id', () => {
  withFiles(({ apply, files }) => {
    const cases = [
      [[confirmed('cand_001'), confirmed('cand_002')], /no verdict for eligible cand_003/],
      [[...ALL_CONFIRMED, confirmed('cand_009')], /cand_009, which is not eligible/],
      [[confirmed('cand_001', { decisive_evidence: [] }), confirmed('cand_002'), confirmed('cand_003')], /cand_001: confirmed names no decisive_evidence/],
      [[confirmed('cand_001', { line_ok: false }), confirmed('cand_002'), confirmed('cand_003')], /cand_001: confirmed with line_ok false has no corrected_line/],
      [[confirmed('cand_001'), { ...confirmed('cand_002'), verdict: 'partly', reason: '  ' }, confirmed('cand_003')], /cand_002: partly gives no reason/],
      [[confirmed('cand_001'), confirmed('cand_002'), { ...confirmed('cand_003'), verdict: 'refuted', reason: '' }], /cand_003: refuted gives no reason/],
      [[confirmed('cand_001', { corrected_line: 2 }), confirmed('cand_002'), confirmed('cand_003')], /cand_001: line_ok true contradicts corrected_line/],
      [[confirmed('cand_001', { verdict: 'maybe' }), confirmed('cand_002'), confirmed('cand_003')], /cand_001: verdict must be one of/],
      [[confirmed('cand_001', { decisive_evidence: ['the cache module'] }), confirmed('cand_002'), confirmed('cand_003')], /cand_001: decisive_evidence/],
    ];
    const before = readFileSync(files.scores, 'utf8');
    for (const [verdicts, pattern] of cases) {
      const r = apply(verdicts, ['--out', files.out]);
      assert.equal(r.code, 2, `expected a refusal for ${pattern}: ${r.stderr}`);
      assert.match(r.stderr, pattern);
    }
    assert.equal(readFileSync(files.scores, 'utf8'), before);
    assert.throws(() => readFileSync(files.out), 'nothing is written on a refusal');
  });
});

test('confirmed verdicts with the line confirmed keep every finding eligible', () => {
  withFiles(({ apply }) => {
    const r = apply(ALL_CONFIRMED);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.eligible.map((e) => e.candidateId), ['cand_001', 'cand_002', 'cand_003']);
    assert.deepEqual(out.challengeHeld, []);
    assert.deepEqual(out.challenge, { confirmed: ['cand_001', 'cand_002', 'cand_003'], held: [], moved: [] });
    assert.equal(out.scores.find((s) => s.candidateId === 'cand_001').challenge.verdict, 'confirmed');
  });
});

test('partly and refuted are held with the challenge verdict, source and reason, and leave eligible[]', () => {
  withFiles(({ apply }) => {
    const r = apply([
      confirmed('cand_001'),
      { candidate_id: 'cand_002', verdict: 'partly', line_ok: true, decisive_evidence: ['src/a.ts:4'], reason: 'Stops after five attempts at src/a.ts:4.' },
      { candidate_id: 'cand_003', verdict: 'refuted', line_ok: true, decisive_evidence: [], reason: 'Checked at src/a.ts:2.' },
    ]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.eligible.map((e) => e.candidateId), ['cand_001']);
    assert.deepEqual(out.challengeHeld, [
      { path: 'src/a.ts', line: 4, verdict: 'challenge-partly', source: 'challenge', reason: 'Stops after five attempts at src/a.ts:4.', severity: 'important', candidateId: 'cand_002', text: CLAIMS.cand_002 },
      { path: 'src/a.ts', line: 5, verdict: 'challenge-refuted', source: 'challenge', reason: 'Checked at src/a.ts:2.', severity: 'important', candidateId: 'cand_003', text: CLAIMS.cand_003 },
    ]);
    assert.deepEqual(out.challenge.confirmed, ['cand_001']);
    assert.deepEqual(out.challenge.held.map((h) => [h.candidate_id, h.verdict]), [['cand_002', 'challenge-partly'], ['cand_003', 'challenge-refuted']]);
    const held = out.scores.find((s) => s.candidateId === 'cand_003');
    assert.equal(held.eligible, false);
    assert.match(held.rejectedBecause, /^challenge-refuted: /);
  });
});

test('a held finding cannot pass validate-output against the challenged scores', () => {
  withFiles(({ apply, run, files }) => {
    const r = apply([confirmed('cand_001'), confirmed('cand_002'), { ...confirmed('cand_003'), verdict: 'refuted', reason: 'Checked above.' }], ['--out', files.out]);
    assert.equal(r.code, 0, r.stderr);
    const review = `[important] \`src/a.ts:5\` - ${CLAIMS.cand_003}\n`;
    assert.equal(run(['validate-output', '--scores', files.scores], review).code, 0, 'passes before the challenge');
    const after = run(['validate-output', '--scores', files.out], review);
    assert.equal(after.code, 1);
    assert.match(after.stderr, /severity_no_score/);
  });
});

test('confirmed with corrected_line moves the anchor through reanchor; a refused move holds it', () => {
  withFiles(({ apply }) => {
    const r = apply([
      confirmed('cand_001', { line_ok: false, corrected_line: 2 }),
      confirmed('cand_002', { line_ok: false, corrected_line: 7 }),
      confirmed('cand_003'),
    ]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.challenge.moved, [{ candidate_id: 'cand_001', from: { path: 'src/a.ts', line: 3 }, to: { path: 'src/a.ts', line: 2 } }]);
    assert.deepEqual(out.challenge.confirmed, ['cand_001', 'cand_003']);
    const moved = out.eligible.find((e) => e.candidateId === 'cand_001');
    assert.equal(moved.line, 2);
    const score = out.scores.find((s) => s.candidateId === 'cand_001');
    assert.equal(score.line, 2);
    assert.deepEqual(score.reanchoredFrom, { path: 'src/a.ts', line: 3 });
    assert.equal(score.finalScore, 0.81);

    // Line 7 is context, not a changed line, so reanchor refuses it.
    assert.equal(out.eligible.some((e) => e.candidateId === 'cand_002'), false);
    const held = out.challengeHeld.find((h) => h.candidateId === 'cand_002');
    assert.equal(held.verdict, 'challenge-partly');
    assert.equal(held.line, 4);
    assert.match(held.reason, /^corrected line refused: cand_002 /);
  });
});

test('a corrected line another eligible finding holds is refused and held', () => {
  withFiles(({ apply }) => {
    const out = JSON.parse(apply([confirmed('cand_001', { line_ok: false, corrected_line: 4 }), confirmed('cand_002'), confirmed('cand_003')]).stdout);
    assert.match(out.challengeHeld[0].reason, /corrected line refused: cand_002 is already anchored at src\/a\.ts:4/);
    // A finding the challenge held no longer blocks the line.
    const freed = JSON.parse(
      apply([
        confirmed('cand_001', { line_ok: false, corrected_line: 4 }),
        { ...confirmed('cand_002'), verdict: 'refuted', reason: 'Bounded at src/a.ts:4.' },
        confirmed('cand_003'),
      ]).stdout,
    );
    assert.deepEqual(freed.challenge.moved.map((m) => m.to.line), [4]);
  });
});

test('--out writes the challenged scores and prints the summary', () => {
  withFiles(({ apply, files }) => {
    const r = apply(ALL_CONFIRMED, ['--out', files.out]);
    assert.equal(r.code, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.out, files.out);
    assert.deepEqual(summary.confirmed, ['cand_001', 'cand_002', 'cand_003']);
    const written = JSON.parse(readFileSync(files.out, 'utf8'));
    for (const key of ['scores', 'distribution', 'eligible', 'belowGate', 'challengeHeld', 'challenge']) {
      assert.ok(key in written, `${key} missing`);
    }
  });
});

test('apply mode needs --diff-file, and --help names every flag', () => {
  withFiles(({ run, files }) => {
    const r = run(['challenge', '--scores', files.scores, '--candidates', files.candidates], '{"verdicts": []}');
    assert.equal(r.code, 2);
    const help = run(['challenge', '--help']);
    assert.equal(help.code, 0);
    for (const name of ['--scores', '--candidates', '--intent', '--emit-prompts', '--diff-file', '--out']) {
      assert.ok(help.stdout.includes(name), `${name} missing from help`);
    }
  });
});

test('record --held accepts the challenge held verdicts', () => {
  withFiles(({ apply, run, dir }) => {
    const out = JSON.parse(
      apply([
        confirmed('cand_001'),
        { ...confirmed('cand_002'), verdict: 'partly', reason: 'Only after a restart.' },
        { ...confirmed('cand_003'), verdict: 'refuted', reason: 'Checked above.' },
      ]).stdout,
    );
    const heldFile = join(dir, 'held.json');
    writeFileSync(heldFile, JSON.stringify(out.challengeHeld));
    const recorded = run(['record', '--repository', 'o/r', '--held', heldFile], `[important] \`src/a.ts:3\` - ${CLAIMS.cand_001}\n`);
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    const explained = run(['explain', runId]);
    assert.match(explained.stdout, /\[challenge-partly\] src\/a\.ts:4  challenge - Only after a restart\./);
    assert.match(explained.stdout, /\[challenge-refuted\] src\/a\.ts:5  challenge - Checked above\./);
  });
});

test('the challenger agent is read-only and is told it does not see the verifier', () => {
  const agent = readFileSync(join(root, 'plugins/review-voice/agents/challenger.md'), 'utf8');
  assert.equal(/^tools:\s*(.+)$/m.exec(agent)?.[1]?.trim(), 'Read, Grep, Glob, Bash(git:*)');
  assert.match(agent, /^name: challenger$/m);
  assert.match(agent, /## Untrusted input/);
  assert.match(agent, /verifier's reasoning, confidence or\s+evidence/);
});

// A later run reads the held entries through check-candidates --held-from.
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

for (const verdict of ['challenge-refuted', 'challenge-partly']) {
  test(`a ${verdict} held finding drops the same candidate on a later run`, () => {
    const base = mkdtempSync(join(tmpdir(), 'rv-challenge-held-'));
    const repo = join(base, 'repo');
    const dataDir = join(base, 'data');
    const sh = (args, input = '') => {
      const r = spawnSync(process.execPath, [bundle, ...args], {
        encoding: 'utf8', input, cwd: repo, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    try {
      execFileSync('mkdir', ['-p', repo, dataDir]);
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'a.ts'), lines(40));
      git('add', '-A');
      git('commit', '-q', '-m', 'first');
      const prior = git('rev-parse', 'HEAD');
      const heldFile = join(base, 'held.json');
      writeFileSync(heldFile, JSON.stringify([
        { path: 'a.ts', line: 21, verdict, source: 'challenge', reason: 'the key is namespaced upstream', candidateId: 'cand_001', text: CLAIMS.cand_001 },
      ]));
      const recorded = sh(['record', '--repository', 'o/r', '--head', prior, '--held', heldFile], '[minor] `a.ts:5` - an unrelated note.\n');
      assert.equal(recorded.code, 0, recorded.stderr);
      const runId = JSON.parse(recorded.stdout).reviewRunId;

      writeFileSync(join(repo, 'b.ts'), 'unrelated\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'unrelated');
      const head = git('rev-parse', 'HEAD');
      const patch = join(base, 'diff.patch');
      const body = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`);
      writeFileSync(patch, ['diff --git a/a.ts b/a.ts', '--- /dev/null', '+++ b/a.ts', '@@ -0,0 +1,40 @@', ...body].join('\n'));
      const repeat = { ...candidate('cand_001', 20), candidate_id: 'c1', path: 'a.ts' };
      const r = sh(['check-candidates', '--diff-file', patch, '--held-from', runId, '--head', head], JSON.stringify({ candidates: [repeat] }));
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.droppedAsHeld.length, 1);
      assert.equal(out.droppedAsHeld[0].heldVerdict, verdict);
      assert.deepEqual(out.kept, []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
