/**
 * Configured analyst lanes (docs/adr/0023): `review.lanes` validation, lane
 * eligibility, the prefix rule in `check-candidates`, the lane severity rule in
 * `score`, `blocker_confirmed` in verification, and the structure agent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { agentExists, DIFF_LANE, eligibleLanes } from '../plugins/review-voice/src/review/lanes.ts';
import { normaliseCandidate, scoreCandidate } from '../plugins/review-voice/src/scoring/score.ts';
import { verificationProblem } from '../plugins/review-voice/src/cli.ts';
import { productionChange } from '../plugins/review-voice/src/review/plan.ts';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const STRUCTURE = `
review:
  lanes:
    - name: structure
      agent: structure-analyst
      prefix: st_
      when: { min_changed_source_lines: 40, paths: ['src/**'], exclude_kinds: [test, docs, config, generated] }
      severity: { cap: minor, escalate: { to: important, requires: blocker_confirmed } }
`;

const structureLane = {
  name: 'structure',
  agent: 'structure-analyst',
  prefix: 'st_',
  when: { minChangedSourceLines: 40, paths: ['src/**'], excludeKinds: ['test', 'docs', 'config', 'generated'] },
  severity: { cap: 'minor', escalate: { to: 'important', requires: 'blocker_confirmed' } },
};

/** A git repository with `.review-voice/config.yaml`, so the CLI finds the config. */
function withRepo(yaml, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-lanes-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (yaml !== null) {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lanesFrom(yaml) {
  return withRepo(yaml, (dir) => loadConfig(dir));
}

test('no review.lanes leaves only the built-in diff lane', () => {
  const config = lanesFrom(null);
  assert.deepEqual(config.lanes, [DIFF_LANE]);
  assert.deepEqual(DIFF_LANE, { name: 'diff', agent: 'diff-analyst', prefix: 'cand_', when: {}, severity: {} });
});

test('a valid structure lane loads after the diff lane', () => {
  const config = lanesFrom(STRUCTURE);
  assert.deepEqual(config.warnings, []);
  assert.deepEqual(config.lanes, [DIFF_LANE, structureLane]);
});

test('an invalid lane is reported and dropped; the others still load', () => {
  const lane = (fields) => ({ name: 'extra', agent: 'structure-analyst', prefix: 'ex_', ...fields });
  const table = [
    [lane({ name: 'diff' }), /diff is built in/],
    [lane({ name: 'structure' }), /name structure is already used/],
    [lane({ prefix: 'st_' }), /prefix st_ is already used/],
    [lane({ prefix: 'cand_' }), /prefix cand_ is already used/],
    [lane({ prefix: 'EX_' }), /prefix must be/],
    [lane({ prefix: 'ex' }), /prefix must be/],
    [lane({ name: 'Bad Name' }), /name must be/],
    [lane({ agent: 'no-such-analyst' }), /agent no-such-analyst is not an agent/],
    [lane({ agent: '../agents/diff-analyst' }), /is not an agent/],
    [lane({ when: { min_changed_source_lines: -1 } }), /min_changed_source_lines/],
    [lane({ when: { paths: 'src/**' } }), /when.paths/],
    [lane({ when: { exclude_kinds: ['vendor'] } }), /exclude_kinds/],
    [lane({ severity: { cap: 'huge' } }), /severity.cap/],
    [lane({ severity: { cap: 'question' } }), /severity.cap/],
    [lane({ severity: { escalate: { to: 'important', requires: 'impact_traced' } } }), /requires must be blocker_confirmed/],
    [lane({ severity: { escalate: { to: 'urgent', requires: 'blocker_confirmed' } } }), /escalate.to/],
    ['not a mapping', /must be a mapping/],
  ];
  for (const [entry, warning] of table) {
    const yaml = `${STRUCTURE}    - ${JSON.stringify(entry)}\n`;
    const config = lanesFrom(yaml);
    assert.deepEqual(config.lanes.map((l) => l.name), ['diff', 'structure'], JSON.stringify(entry));
    assert.equal(config.warnings.length, 1, JSON.stringify(entry));
    assert.match(config.warnings[0], /^review\.lanes\[1\]: /);
    assert.match(config.warnings[0], warning);
  }
  const notAList = lanesFrom('review:\n  lanes: { name: structure }\n');
  assert.deepEqual(notAList.lanes, [DIFF_LANE]);
  assert.match(notAList.warnings[0], /review.lanes must be a list/);
});

test('the structure-analyst agent exists and its frontmatter names its tools', () => {
  assert.equal(agentExists('structure-analyst'), true);
  const text = readFileSync(join(root, 'plugins/review-voice/agents/structure-analyst.md'), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(frontmatter, 'frontmatter');
  const fields = Object.fromEntries(
    frontmatter[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  );
  assert.equal(fields.name, 'structure-analyst');
  assert.ok(fields.description.length > 0);
  assert.equal(fields.tools, 'Read, Grep, Glob, Bash(git:*)');
  assert.match(text, /## Untrusted input/);
  for (const blocker of ['file-crosses-limit', 'existing-helper-duplicate', 'conditional-tangles-shared-flow', 'scattered-feature-checks']) {
    assert.ok(text.includes(blocker), blocker);
  }
});

const file = (path, extra = {}) => ({
  path, status: 'modified', class: 'source', language: 'ts', additions: 0, deletions: 0, reviewed: true, ...extra,
});

test('eligibility leaves out tests, docs, lockfiles and generated files, counts within paths, at exactly the minimum', () => {
  const lanes = [DIFF_LANE, structureLane];
  const noise = [
    file('src/orders.test.ts', { additions: 500 }),
    file('docs/guide.md', { additions: 500 }),
    file('package-lock.json', { class: 'lockfile', additions: 500 }),
    file('src/generated/client.ts', { class: 'generated', additions: 500 }),
    file('scripts/build.ts', { additions: 500 }),
  ];
  const at = eligibleLanes(lanes, [...noise, file('src/a.ts', { additions: 30, deletions: 10 })], '');
  assert.deepEqual(at.map((entry) => [entry.lane.name, entry.eligible]), [['diff', true], ['structure', true]]);
  assert.equal(at[1].reason, '40 changed source lines in src/**, at least 40');

  const under = eligibleLanes(lanes, [...noise, file('src/a.ts', { additions: 30, deletions: 9 })], '');
  assert.equal(under[1].eligible, false);
  assert.equal(under[1].reason, '39 changed source lines in src/**, under the minimum of 40');
  assert.equal(under[0].eligible, true);
});

test('a lane with no paths counts every production file; no minimum means it always runs', () => {
  const open = { ...structureLane, when: { minChangedSourceLines: 40 } };
  const files = [file('scripts/build.ts', { additions: 25 }), file('src/a.ts', { additions: 15 })];
  assert.equal(eligibleLanes([open], files, '')[0].eligible, true);
  const always = { ...structureLane, when: {} };
  assert.equal(eligibleLanes([always], [file('docs/x.md', { additions: 3 })], '')[0].eligible, true);
});

const configFiles = [
  file('config/app.yaml', { additions: 30 }),
  file('package.json', { additions: 5 }),
  file('tsconfig.jsonc', { additions: 5 }),
  file('pyproject.toml', { additions: 5 }),
  file('.env', { additions: 5 }),
  file('yarn.lock', { class: 'lockfile', additions: 300 }),
];

test('configuration is not production source: a config-only change is none', () => {
  assert.deepEqual(productionChange(configFiles, ''), { productionSourceChanged: false, productionLinesChanged: 0 });
  const anyLines = { ...structureLane, when: { minChangedSourceLines: 1 } };
  assert.equal(eligibleLanes([anyLines], configFiles, '')[0].eligible, false);
});

test('a CI workflow still counts as production source', () => {
  const workflow = [file('.github/workflows/ci.yml', { additions: 7 })];
  assert.deepEqual(productionChange(workflow, ''), { productionSourceChanged: true, productionLinesChanged: 7 });
});

test('a lane whose exclude_kinds leaves config out of the list counts config lines', () => {
  const lane = { ...structureLane, when: { minChangedSourceLines: 40, excludeKinds: ['test', 'docs', 'generated'] } };
  const [entry] = eligibleLanes([lane], [...configFiles, file('src/a.test.ts', { additions: 90 })], '');
  // The lockfile counts as configuration too; the test file stays out.
  assert.equal(entry.reason, '350 changed source lines, at least 40');
  assert.equal(entry.eligible, true);
});

test('the decision-point count still reads configuration as before', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,4 @@',
    ' const x = 1;', '+if (x) { y(); }', '+if (x && z) { w(); }', '+while (q) {}',
    'diff --git a/config/app.yaml b/config/app.yaml', '--- a/config/app.yaml', '+++ b/config/app.yaml', '@@ -1,1 +1,3 @@',
    ' a: 1', '+if: true', '+b: x && y', '',
  ].join('\n');
  // Pinned from the assessment before the configuration kind existed.
  const result = assessComplexity(diff, [file('src/a.ts', { additions: 3 }), file('config/app.yaml', { additions: 2 })]);
  assert.equal(result.decisionPoints, 6);
  assert.deepEqual(result.densestHunk, { path: 'src/a.ts', line: 1, decisionPoints: 4 });
  assert.deepEqual(result.excluded, {
    documentationFiles: 0, testFiles: 0, testDecisionPoints: 0, generatedFiles: 0, generatedDecisionPoints: 0,
  });
});

function cli(dir, args, input) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, '.data') },
  });
}

test('lanes command prints each lane with its eligibility; a bad invocation exits 2', () =>
  withRepo(STRUCTURE, (dir) => {
    writeFileSync(join(dir, 'files.json'), JSON.stringify({ files: [file('src/a.ts', { additions: 50 })] }));
    writeFileSync(join(dir, 'diff.patch'), '');
    const run = cli(dir, ['lanes', '--files', join(dir, 'files.json'), '--diff-file', join(dir, 'diff.patch')]);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual(out.map((entry) => [entry.lane.name, entry.eligible]), [['diff', true], ['structure', true]]);
    assert.equal(out[1].lane.prefix, 'st_');

    assert.equal(cli(dir, ['lanes', '--files', join(dir, 'files.json')]).status, 2);
    writeFileSync(join(dir, 'bad.json'), '{"nothing": true}');
    assert.equal(cli(dir, ['lanes', '--files', join(dir, 'bad.json'), '--diff-file', join(dir, 'diff.patch')]).status, 2);
    assert.match(cli(dir, ['lanes', '--help']).stdout, /lanes --files <files.json> --diff-file <diff.patch>/);
  }));

function candidate(id, overrides = {}) {
  return {
    candidate_id: id,
    path: 'src/orders.ts',
    line: 10,
    category: 'maintainability',
    severity: 'minor',
    claim: 'roundTotal repeats the rounding formatAmount already does.',
    failure_mode: 'A change to the rounding rule must be made twice.',
    evidence: ['src/orders.ts:10 rounds to two places', 'src/money.ts:18 formatAmount rounds the same way'],
    technical_confidence: 0.9,
    ...overrides,
  };
}

test('plan auto picks fast for a configuration-only change', () =>
  withRepo(null, (dir) => {
    writeFileSync(join(dir, 'files.json'), JSON.stringify({ files: configFiles }));
    writeFileSync(join(dir, 'diff.patch'), '');
    const run = cli(dir, ['plan', '--files', join(dir, 'files.json'), '--diff-file', join(dir, 'diff.patch')]);
    assert.equal(run.status, 0, run.stderr);
    const plan = JSON.parse(run.stdout);
    assert.equal(plan.mode, 'fast');
    assert.equal(plan.reason, 'auto: no production source changed');
  }));

test('check-candidates refuses a lane candidate without its prefix, and an unknown lane', () =>
  withRepo(STRUCTURE, (dir) => {
    const check = (candidates) => cli(dir, ['check-candidates'], JSON.stringify({ candidates }));

    const good = check([candidate('cand_001'), candidate('st_001', { lane: 'structure' }), candidate('cand_002', { lane: 'diff' })]);
    assert.equal(good.status, 0, good.stderr);

    const bad = check([
      candidate('cand_001', { lane: 'structure' }),
      candidate('st_002'),
      candidate('xx_001', { lane: 'security' }),
      candidate('st_003', { lane: 'diff' }),
    ]);
    assert.equal(bad.status, 1);
    const { valid, laneFailures } = JSON.parse(bad.stdout);
    assert.equal(valid, false);
    assert.deepEqual(laneFailures.map((f) => f.candidateId), ['cand_001', 'st_002', 'xx_001', 'st_003']);
    assert.match(laneFailures[0].reason, /must start with st_/);
    assert.match(laneFailures[1].reason, /names no lane/);
    assert.match(laneFailures[2].reason, /lane security is not configured/);
    assert.match(laneFailures[3].reason, /must start with cand_/);
    assert.match(bad.stderr, /4 candidate lane failures/);
  }));

test('check-candidates without lanes configured accepts any id, as before', () =>
  withRepo(null, (dir) => {
    const run = cli(dir, ['check-candidates'], JSON.stringify({ candidates: [candidate('c1'), candidate('st_001')] }));
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { valid: true, candidates: 2 });
  }));

const normalised = (overrides) => normaliseCandidate(candidate('st_001', { lane: 'structure', ...overrides }), 0);

test('normaliseCandidate keeps lane and blocker_class, and refuses the wrong types', () => {
  const c = normalised({ blocker_class: 'existing-helper-duplicate' });
  assert.equal(c.lane, 'structure');
  assert.equal(c.blockerClass, 'existing-helper-duplicate');
  assert.equal(normalised({ blocker_class: null }).blockerClass, null);
  assert.equal('lane' in normaliseCandidate(candidate('cand_001'), 0), false);
  assert.throws(() => normalised({ lane: 5 }), /lane must be/);
  assert.throws(() => normalised({ blocker_class: 3 }), /blocker_class must be/);
});

// api_contract derives important with no reach, so a cap has something to lower.
const important = () => normalised({ category: 'api_contract', severity: 'important' });

test('score: the cap lowers a derived tier and says which lane did it', () => {
  const b = scoreCandidate(important(), [], [], undefined, { candidateId: 'st_001', verified: true, technicalConfidence: 0.9 }, structureLane);
  assert.equal(b.severity.severity, 'minor');
  assert.match(b.severity.reason, /capped at minor by lane structure/);
  assert.equal(b.lane, 'structure');
});

test('score: escalate raises only on blocker_confirmed with traced impact at the 0011 bar', () => {
  // maintainability derives nit, under the cap.
  const nit = normalised({});
  const verify = (fields) => ({ candidateId: 'st_001', verified: true, technicalConfidence: 0.9, ...fields });
  const tier = (v, lane = structureLane, c = nit) => scoreCandidate(c, [], [], undefined, v, lane).severity;

  const raised = tier(verify({ blockerConfirmed: true, impactTraced: true }));
  assert.equal(raised.severity, 'important');
  assert.match(raised.reason, /raised to important by lane structure because the verifier confirmed the blocker/);

  const untraced = tier(verify({ blockerConfirmed: true, impactTraced: false }));
  assert.equal(untraced.severity, 'nit');
  assert.match(untraced.reason, /blocker confirmed but impact not traced/);

  const unsure = tier(verify({ blockerConfirmed: true, impactTraced: true, technicalConfidence: 0.84 }));
  assert.equal(unsure.severity, 'nit');
  assert.match(unsure.reason, /blocker confirmed but verifier confidence 0\.84, under 0\.85/);

  const disputed = tier(verify({ blockerConfirmed: true, impactTraced: true }), structureLane, normaliseCandidate({ ...candidate('st_001', { lane: 'structure' }), impact_disputed: true }, 0));
  assert.equal(disputed.severity, 'nit');
  assert.match(disputed.reason, /second pass disputed/);

  const asking = tier(verify({ blockerConfirmed: true, impactTraced: true }), structureLane, normalised({ claim: 'Is roundTotal a copy of formatAmount?' }));
  assert.equal(asking.severity, 'nit');
  assert.match(asking.reason, /framed as a question/);

  assert.equal(tier(verify({ impactTraced: true })).severity, 'nit');
  assert.equal(tier(verify({ blockerConfirmed: false, impactTraced: true })).severity, 'nit');
  // No escalate rule: blocker_confirmed is ignored.
  const capOnly = { ...structureLane, severity: { cap: 'minor' } };
  assert.equal(tier(verify({ blockerConfirmed: true, impactTraced: true }), capOnly).severity, 'nit');
});

test('score: the diff lane, or no lane, leaves every score as it was', () => {
  const c = normaliseCandidate(candidate('cand_001', { category: 'api_contract', severity: 'important' }), 0);
  const v = { candidateId: 'cand_001', verified: true, technicalConfidence: 0.9, blockerConfirmed: true, impactTraced: true };
  const without = scoreCandidate(c, [], [], undefined, v);
  assert.deepEqual(scoreCandidate(c, [], [], undefined, v, DIFF_LANE), without);
  assert.equal(without.severity.severity, 'important');
  assert.equal(without.lane, 'diff');
});

test('score reads lanes from config: entries carry lane and the capped tier', () =>
  withRepo(STRUCTURE, (dir) => {
    const candidates = [
      candidate('st_001', { lane: 'structure', category: 'api_contract', severity: 'important' }),
      candidate('cand_001', { category: 'api_contract', severity: 'important', line: 20, claim: 'The response drops the currency field.' }),
    ];
    writeFileSync(
      join(dir, 'v.json'),
      JSON.stringify(candidates.map((c) => ({ candidate_id: c.candidate_id, verified: true, technical_confidence: 0.9, blocker_confirmed: false }))),
    );
    const run = cli(dir, ['score', '--verification', join(dir, 'v.json'), '--min-score', '0'], JSON.stringify({ candidates }));
    assert.equal(run.status, 0, run.stderr);
    const byId = Object.fromEntries(JSON.parse(run.stdout).scores.map((s) => [s.candidate_id, s]));
    assert.equal(byId.st_001.lane, 'structure');
    assert.equal(byId.st_001.severity.severity, 'minor');
    assert.equal(byId.cand_001.lane, 'diff');
    assert.equal(byId.cand_001.severity.severity, 'important');
  }));

test('verification accepts blocker_confirmed as a boolean only', () => {
  assert.equal(verificationProblem([{ candidate_id: 'st_001', blocker_confirmed: true }]), null);
  assert.equal(verificationProblem([{ candidateId: 'st_001', blockerConfirmed: false }]), null);
  assert.match(verificationProblem([{ candidate_id: 'st_001', blocker_confirmed: 'yes' }]), /blocker_confirmed must be true or false/);
  const schema = JSON.parse(readFileSync(join(root, 'plugins/review-voice/schemas/verification.schema.json'), 'utf8'));
  assert.equal(schema.properties.blocker_confirmed.type, 'boolean');
  withRepo(null, (dir) => {
    const run = cli(dir, ['check-verification'], JSON.stringify([{ candidate_id: 'st_001', verified: true, blocker_confirmed: true }]));
    assert.equal(run.status, 0, run.stderr);
  });
});

test('the candidate schema admits lane prefixes, lane and blocker_class', () => {
  const schema = JSON.parse(readFileSync(join(root, 'plugins/review-voice/schemas/candidate.schema.json'), 'utf8'));
  const item = schema.properties.candidates.items.properties;
  const id = new RegExp(item.candidate_id.pattern);
  assert.ok(id.test('cand_001') && id.test('st_001'));
  assert.ok(!id.test('ST_001') && !id.test('st001'));
  assert.equal(item.lane.type, 'string');
  assert.deepEqual(item.blocker_class.type, ['string', 'null']);
});
