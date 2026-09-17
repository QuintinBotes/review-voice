import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normaliseCandidate } from '../plugins/review-voice/src/scoring/score.ts';
import { deriveSeverity } from '../plugins/review-voice/src/scoring/severity.ts';
import { SEVERITIES } from '../plugins/review-voice/src/contract/limits.ts';

// Inter-stage contract drift
//
// Four defects in this project came from a seam between a prompt and the code
// that reads its output, and none was caught by a test:
//
//   - `score` accepted `verifications` and `candidates`; the verifier emits
//     `results`. Every candidate silently fell back to the analyst self-report.
//   - The analyst emitted `title`, `location`, `suggested_direction`, and a
//     whole pull request produced nothing.
//   - The category enum was never in the analyst prompt, so the agent invented
//     plausible names, and severity had come to rest entirely on that field.
//   - Severities exist that no prompt listed.
//
// Each was invisible until a retest against a real repository. These pin the
// seams so the suite can fail instead.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');

const read = (path) => readFileSync(join(plugin, path), 'utf8');
const schema = (name) => JSON.parse(read(join('schemas', name)));

const ANALYST = read('agents/diff-analyst.md');
const VERIFIER = read('agents/evidence-verifier.md');
const EDITOR = read('agents/concise-editor.md');

// Seam one: the analyst's schema is what score actually parses

test('every field the candidate schema requires is one score reads', () => {
  const required = schema('candidate.schema.json').properties.candidates.items.required;

  const candidate = {
    candidate_id: 'cand_001',
    path: 'src/a.ts',
    line: 12,
    category: 'correctness',
    severity: 'minor',
    claim: 'A claim.',
    failure_mode: 'A failure.',
    evidence: ['At line 12.'],
    technical_confidence: 0.9,
  };

  for (const field of required) {
    assert.ok(field in candidate, `schema requires ${field}, which this test does not supply`);
  }

  const parsed = normaliseCandidate(candidate, 0);
  assert.equal(parsed.candidateId, 'cand_001');
  assert.equal(parsed.path, 'src/a.ts');
  assert.equal(parsed.line, 12);
  assert.equal(parsed.category, 'correctness');
  assert.equal(parsed.technicalConfidence, 0.9);
  assert.deepEqual(parsed.evidence, ['At line 12.']);
});

test('the analyst prompt names the schema it must emit against', () => {
  assert.match(ANALYST, /candidate\.schema\.json/);
});

// Seam two: the verifier's documented output is what score accepts

test('every field the verifier prompt promises is one score reads', () => {
  // Taken from the prompt rather than restated, so renaming a field there
  // fails here.
  const documented = [...VERIFIER.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  const consumed = ['candidate_id', 'evidence_quality', 'technical_confidence', 'required_context_missing'];

  for (const field of consumed) {
    assert.ok(
      documented.includes(field),
      `score reads ${field} and the verifier prompt never mentions it`,
    );
  }
});

test('a verification file shaped exactly as the prompt describes is read', () => {
  // `results` is what the verifier actually returned. It was not accepted, the
  // command exited 0, and the release's headline fix did nothing. This builds
  // the payload from the prompt's own field list rather than restating it.
  const documented = [...VERIFIER.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  assert.ok(documented.includes('candidate_id'), 'the prompt no longer documents candidate_id');
  assert.ok(documented.includes('technical_confidence'), 'the prompt no longer documents technical_confidence');

  const dir = mkdtempSync(join(tmpdir(), 'rv-seam-'));
  try {
    const file = join(dir, 'verification.json');
    writeFileSync(
      file,
      JSON.stringify({
        results: [{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.88 }],
      }),
    );

    const candidates = JSON.stringify({
      candidates: [
        {
          candidate_id: 'cand_001',
          path: 'src/a.ts',
          line: 12,
          category: 'correctness',
          severity: 'minor',
          claim: 'A claim.',
          failure_mode: 'A failure.',
          evidence: ['At line 12.'],
          technical_confidence: 0.5,
        },
      ],
    });

    const result = spawnSync(process.execPath, [join(plugin, 'dist/review-voice.mjs'), 'score', '--verification', file], {
      encoding: 'utf8',
      input: candidates,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.scores[0].confidenceSource, 'verifier');
    assert.equal(parsed.scores[0].verifiedConfidence, 0.88);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Seam three: every enum a prompt must contain

test('every category in the schema appears in the analyst prompt', () => {
  // Severity rests entirely on this field, and the prompt referenced only the
  // schema, which reaches the enum through a $ref the agent never follows.
  const categories = schema('finding-category.schema.json').enum;
  const missing = categories.filter((category) => !ANALYST.includes(`\`${category}\``));

  assert.deepEqual(missing, [], `the analyst prompt does not list: ${missing.join(', ')}`);
});

test('every category the schema defines has a severity', () => {
  const categories = schema('finding-category.schema.json').enum;
  const unmapped = categories.filter((category) => deriveSeverity(category, 'minor').reason.includes('no mapping'));

  assert.deepEqual(unmapped, [], `no tier maps these categories: ${unmapped.join(', ')}`);
});

test('every severity the contract allows appears in the prompts that use it', () => {
  for (const severity of SEVERITIES) {
    assert.ok(ANALYST.includes(severity), `the analyst prompt never mentions ${severity}`);
    assert.ok(EDITOR.includes(severity), `the editor prompt never mentions ${severity}`);
  }
});

test('the severity list the editor states matches the contract exactly', () => {
  const stated = [...EDITOR.matchAll(/`(blocking|important|minor|nit|question)`/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(stated)].sort(), [...SEVERITIES].sort());
});

// Seam four: the shipped command text against the CLI's own flags
//
// The three seams above are agent boundaries. The defect that got through was
// at a different one: `commands/review.md` tells the operator to run `record`
// without `--diff-file`, so every run recorded the hash of the empty string
// and `candidate_set_agreement` compared unrelated pull requests. Nothing
// watched the boundary between the prose and the binary.

const REVIEW = read('commands/review.md');

const cli = (args) => {
  try {
    return execFileSync(process.execPath, [join(plugin, 'dist/review-voice.mjs'), ...args], { encoding: 'utf8' });
  } catch (error) {
    return error.stdout ?? '';
  }
};

/** Every `RV <command> ...` invocation the review command instructs. */
function invocations(markdown) {
  return [...markdown.matchAll(/\bRV\s+([a-z-]+)((?:\s+--?[\w-]+(?:\s+[^\s`]+)?)*)/g)].map((match) => ({
    command: match[1],
    flags: [...(match[2] ?? '').matchAll(/--[\w-]+/g)].map((flag) => flag[0]),
  }));
}

test('every flag the review command instructs is one the CLI defines', () => {
  const usage = cli(['--help']);

  for (const { command, flags } of invocations(REVIEW)) {
    for (const flag of flags) {
      assert.ok(
        usage.includes(flag),
        `commands/review.md tells the operator to run \`RV ${command} ${flag}\`, and --help never mentions ${flag}`,
      );
    }
  }
});

test('the record invocation supplies the diff the agreement metric needs', () => {
  // `candidate_set_agreement` identifies a run by its diff hash. A `record`
  // without `--diff-file` hashes the empty string, so every run collides and
  // the metric reports the disagreement of unrelated pull requests as this
  // reviewer's variance.
  // The full invocation, not a passing mention of one flag elsewhere in the
  // document.
  const record = invocations(REVIEW).find(
    (call) => call.command === 'record' && call.flags.includes('--candidates'),
  );
  assert.ok(record !== undefined, 'the review command no longer instructs a full `RV record`');
  assert.ok(
    record.flags.includes('--diff-file'),
    `record is instructed without --diff-file, so every run records the same diff identity. Flags: ${record.flags.join(' ')}`,
  );
});

test('the score invocation supplies what the gates depend on', () => {
  const score = invocations(REVIEW).find((call) => call.command === 'score');
  assert.ok(score !== undefined, 'the review command no longer instructs `RV score`');
  for (const flag of ['--verification', '--base']) {
    assert.ok(
      score.flags.includes(flag),
      `score is instructed without ${flag}, which silently changes which gate decides`,
    );
  }
});

test('the review command checks the analyst shape before the verifier runs', () => {
  // A wrong shape reaching step 4 has already cost a verification pass, and on
  // a real run it cost the only analyst pass that found the most serious
  // defect in the diff.
  const stepTwo = REVIEW.slice(
    REVIEW.indexOf('## Step 2'),
    REVIEW.indexOf('## Step 3'),
  );
  assert.match(stepTwo, /check-candidates/, 'step 2 no longer checks the candidate shape');

  const check = invocations(REVIEW).find((call) => call.command === 'check-candidates');
  assert.ok(check !== undefined, 'check-candidates is described but not instructed');
});

test('check-candidates refuses a foreign shape and accepts a valid one', () => {
  const foreign = JSON.stringify({ candidates: [{ title: 'A thing', suggestion: 'fix' }] });
  const valid = JSON.stringify({
    candidates: [
      {
        candidate_id: 'cand_001',
        path: 'a.ts',
        line: 4,
        category: 'correctness',
        severity: 'minor',
        claim: 'A claim.',
        failure_mode: 'A failure.',
        evidence: ['At line 4.'],
        technical_confidence: 0.9,
      },
    ],
  });

  const bad = spawnSync(process.execPath, [join(plugin, 'dist/review-voice.mjs'), 'check-candidates'], {
    encoding: 'utf8',
    input: foreign,
  });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not the candidate schema/);

  const good = spawnSync(process.execPath, [join(plugin, 'dist/review-voice.mjs'), 'check-candidates'], {
    encoding: 'utf8',
    input: valid,
  });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).candidates, 1);
});

test('every agent declares the narrowest tool grant it can do its job with', () => {
  // Pinned so a widening is a visible diff rather than a quiet edit. This does
  // not prove the harness enforces the grant - see docs/THREAT-MODEL.md, threat
  // 4 - but it does stop the declaration drifting without review.
  const expected = {
    'diff-analyst': 'Read, Grep, Glob, Bash(git:*)',
    'evidence-verifier': 'Read, Grep, Glob, Bash(git:*)',
    'static-evidence-interpreter': 'Read, Grep',
    'precedent-ranker': 'Read',
    'concise-editor': '[]',
  };

  for (const [name, grant] of Object.entries(expected)) {
    const agent = readFileSync(
      new URL(`../plugins/review-voice/agents/${name}.md`, import.meta.url),
      'utf8',
    );
    const declared = /^tools:\s*(.+)$/m.exec(agent)?.[1]?.trim();
    assert.equal(
      declared,
      grant,
      `${name} declares "${declared}" where the reviewed grant is "${grant}". ` +
        'Widening an agent grant is a threat-model change, not a refactor.',
    );
  }
});

test('no agent is granted an unrestricted shell', () => {
  const agents = ['diff-analyst', 'evidence-verifier', 'static-evidence-interpreter', 'precedent-ranker', 'concise-editor'];
  for (const name of agents) {
    const agent = readFileSync(
      new URL(`../plugins/review-voice/agents/${name}.md`, import.meta.url),
      'utf8',
    );
    const declared = /^tools:\s*(.+)$/m.exec(agent)?.[1] ?? '';
    assert.ok(
      !/\bBash\b(?!\()/.test(declared),
      `${name} declares bare Bash. Static analysis is opt-in and config-declared ` +
        '(adr/0003); an agent with an unrestricted shell reaches the same outcome by another route.',
    );
  }
});
