/**
 * S06: approved policies are enforced at scoring, keyed by rule id
 * (docs/adr/0032). Covers AC-1 to AC-7 of
 * docs/agent-handoffs/professionalisation/S06-enforce-approved-policies.md.
 * Every CLI call runs with a fresh REVIEW_VOICE_DATA_DIR inside the test's
 * temporary directory, so no test opens the developer's store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { compileProposals } from '../plugins/review-voice/src/policy/compile.ts';
import { approvePolicy, proposePolicy } from '../plugins/review-voice/src/policy/versions.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const CLAIM =
  'The retry helper repeats the same backoff calculation in three places, so a change to the delay must be made three times.';

function withSetup(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-s06-'));
  const repo = join(base, 'repo');
  const data = join(base, 'data');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(repo, 'src', 'retry.ts'),
    Array.from({ length: 20 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n',
  );
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return Promise.resolve()
    .then(() => fn({ base, repo, data }))
    .finally(() => rmSync(base, { recursive: true, force: true }));
}

function cli(args, { cwd, data, input = '' }) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function openDb(data) {
  return openDatabase(join(data, 'review-voice.db'));
}

const OUTPUT3 = [
  '[minor] `src/retry.ts:5` - First repeated calculation here. It drifts. Fix it.',
  '[minor] `src/retry.ts:6` - Second repeated calculation here. It drifts. Fix it.',
  '[minor] `src/retry.ts:7` - Third repeated calculation here. It drifts. Fix it.',
].join('\n\n');

const HINTS3 = [
  { path: 'src/retry.ts', line: 5, category: 'maintainability' },
  { path: 'src/retry.ts', line: 6, category: 'maintainability' },
  { path: 'src/retry.ts', line: 7, category: 'maintainability' },
];

/** Records one run and an owner dismissal for each of its three findings. */
function seedDismissals(db, hints = HINTS3) {
  recordRun(db, { repository: 'org/a', baseRef: null, headRef: null, diff: 'x', output: OUTPUT3, candidates: hints });
  for (const ref of ['rv_01', 'rv_02', 'rv_03']) {
    recordFeedback(db, { findingRef: ref, action: 'dismiss', actor: 'owner' });
  }
}

const candidate = (over = {}) => ({
  candidate_id: 'cand_001',
  path: 'src/retry.ts',
  line: 5,
  category: 'maintainability',
  severity: 'minor',
  claim: CLAIM,
  failure_mode: 'One copy is updated and the others keep the old delay, so retries behave differently by call site.',
  evidence: [
    'src/retry.ts:5 computes the delay as attempt times 1000.',
    'src/retry.ts:6 computes the same delay again for the second call site.',
    'src/retry.ts:7 repeats the computation a third time.',
  ],
  technical_confidence: 0.9,
  ...over,
});

function score({ base, repo, data }, cand = candidate(), extra = []) {
  const verification = join(base, 'verification.json');
  writeFileSync(
    verification,
    JSON.stringify({
      results: [{ candidate_id: cand.candidate_id, verified: true, evidence_quality: 'high', technical_confidence: 0.95 }],
    }),
  );
  const r = cli(['score', '--verification', verification, ...extra], {
    cwd: repo,
    data,
    input: JSON.stringify({ candidates: [cand] }),
  });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// AC-1: rule identity on the record, in explain and status, and in evaluate.
test('a recorded finding carries its rule id, and explain, status and evaluate show it', () =>
  withSetup(({ base, repo, data }) => {
    const candidatesFile = join(base, 'candidates.json');
    writeFileSync(
      candidatesFile,
      JSON.stringify({
        candidates: [
          { path: 'src/retry.ts', line: 5, category: 'maintainability' },
          {
            path: 'src/retry.ts',
            line: 6,
            category: 'maintainability',
            lane: 'structure',
            blocker_class: 'existing-helper-duplicate',
          },
        ],
      }),
    );
    const review = [
      '[minor] `src/retry.ts:5` - First repeated calculation here. It drifts. Fix it.',
      '[minor] `src/retry.ts:6` - Second repeated calculation here. It drifts. Fix it.',
    ].join('\n\n');
    const recorded = cli(['record', '--candidates', candidatesFile], { cwd: repo, data, input: `${review}\n` });
    assert.equal(recorded.code, 0, recorded.stderr);
    const { reviewRunId, findings } = JSON.parse(recorded.stdout);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].ruleId, 'maintainability:diff');
    assert.equal(findings[1].ruleId, 'maintainability:structure:existing-helper-duplicate');
    assert.equal(findings[1].blockerClass, 'existing-helper-duplicate');

    const explained = cli(['explain', '--run', reviewRunId], { cwd: repo, data });
    assert.equal(explained.code, 0, explained.stderr);
    assert.match(explained.stdout, /rule id\s+maintainability:diff/);
    assert.match(explained.stdout, /rule id\s+maintainability:structure:existing-helper-duplicate/);

    const status = cli(['status'], { cwd: repo, data });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /rv_01 \(maintainability:diff\)/);

    const db = openDb(data);
    try {
      db.prepare(
        `INSERT INTO finding_outcomes
           (review_run_id, finding_id, repository, pull_number, comment_id, outcome, strength, evidence, checked_at)
         VALUES (?, 'rv_01', 'org/a', 1, 101, 'fixed', 'strong', 'test', '2026-11-08T00:00:00.000Z')`,
      ).run(reviewRunId);
    } finally {
      db.close();
    }
    const evaluated = cli(['evaluate', '--json'], { cwd: repo, data });
    assert.equal(evaluated.code, 0, evaluated.stderr);
    const byRule = JSON.parse(evaluated.stdout).posted_breakdown.by_rule;
    assert.equal(byRule['maintainability:diff'].tracked, 1);
    assert.equal(byRule['maintainability:diff'].fixed, 1);
  }));

// AC-2: three dismissals in one lane form one structured suppression.
test('three owner dismissals compile to one suppression keyed by rule id', () =>
  withSetup(({ data }) => {
    const db = openDb(data);
    try {
      seedDismissals(db);
      const proposals = compileProposals(db);
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].kind, 'suppress');
      assert.equal(proposals[0].ruleId, 'maintainability:diff');
      assert.equal(proposals[0].category, 'maintainability');
      assert.equal(proposals[0].activatable, true);

      const stored = proposePolicy(db, proposals);
      assert.equal(stored.provenance[0].ruleId, 'maintainability:diff');
      assert.equal(stored.provenance[0].category, 'maintainability');
      const entries = stored.contentYaml.match(/- rule_id:/g) ?? [];
      assert.equal(entries.length, 1);
      assert.match(stored.contentYaml, /suppressions:\n  - rule_id: "maintainability:diff"/);
      // The prose pattern is still written for readers.
      assert.match(stored.contentYaml, /suppressed_patterns:\n  - "Suppress maintainability findings/);
    } finally {
      db.close();
    }
  }));

// AC-2: grouping is by rule id, so two lanes are two rules.
test('three dismissals split across two lanes produce two non-activatable rules', () =>
  withSetup(({ data }) => {
    const db = openDb(data);
    try {
      seedDismissals(db, [
        { path: 'src/retry.ts', line: 5, category: 'maintainability' },
        { path: 'src/retry.ts', line: 6, category: 'maintainability' },
        { path: 'src/retry.ts', line: 7, category: 'maintainability', lane: 'structure' },
      ]);
      const proposals = compileProposals(db);
      assert.deepEqual(
        proposals.map((p) => p.ruleId).sort(),
        ['maintainability:diff', 'maintainability:structure'],
      );
      assert.ok(proposals.every((p) => p.kind === 'suppress' && p.activatable === false));
    } finally {
      db.close();
    }
  }));

// AC-3, AC-4, AC-6 and AC-7: the approved suppression loads, holds the next
// score, is recorded and explained, and promote and rollback both lift it.
test('an approved suppression holds the next score, and promote and rollback lift it', () =>
  withSetup((setup) => {
    const { base, repo, data } = setup;
    const db = openDb(data);
    let proposalId;
    try {
      // Version 1 carries no suppression, so rollback has somewhere to go.
      const empty = proposePolicy(db, []);
      assert.equal(approvePolicy(db, empty.policyId).ok, true);
      seedDismissals(db);
      proposalId = proposePolicy(db, compileProposals(db)).policyId;
    } finally {
      db.close();
    }

    const approved = cli(['policy', 'approve', proposalId], { cwd: repo, data });
    assert.equal(approved.code, 0, approved.stderr);
    assert.match(approved.stdout, /Approved policy version 2\./);

    // AC-3: context shows the suppression, and loadConfig reports the loaded
    // version only when a store is given.
    const context = cli(['context'], { cwd: repo, data });
    assert.equal(context.code, 0, context.stderr);
    const shown = JSON.parse(context.stdout).policy.suppressions;
    assert.deepEqual(
      shown.map((s) => [s.ruleId, s.policyVersion]),
      [['maintainability:diff', 2]],
    );
    const withoutStore = loadConfig(repo);
    assert.deepEqual(withoutStore.suppressions, []);
    assert.deepEqual(withoutStore.activePolicyVersions, []);
    const db2 = openDb(data);
    let loaded;
    try {
      loaded = loadConfig(repo, undefined, undefined, db2);
    } finally {
      db2.close();
    }
    assert.deepEqual(
      loaded.activePolicyVersions.map((v) => v.version),
      [2],
    );
    assert.deepEqual(
      loaded.suppressions.map((s) => s.ruleId),
      ['maintainability:diff'],
    );

    // AC-4: the next score holds the verified candidate by policy alone.
    const scored = score(setup);
    assert.equal(scored.scores[0].eligible, false);
    assert.equal(scored.scores[0].rejectedBecause, 'policy-suppressed:maintainability:diff');
    assert.deepEqual(scored.eligible, []);
    assert.deepEqual(scored.belowGate, []);
    assert.equal(scored.suppressed.length, 1);
    const [entry] = scored.suppressed;
    assert.equal(entry.candidateId, 'cand_001');
    assert.equal(entry.candidate_id, 'cand_001');
    assert.equal(entry.ruleId, 'maintainability:diff');
    assert.equal(entry.path, 'src/retry.ts');
    assert.equal(entry.line, 5);
    assert.equal(entry.policyVersion, 2);

    // The held verdict round-trips through record, and explain lists it under
    // "Held back" with the rule id and the policy version.
    const heldFile = join(base, 'held.json');
    writeFileSync(
      heldFile,
      JSON.stringify([
        {
          path: entry.path,
          line: entry.line,
          verdict: 'policy-suppressed',
          source: 'policy',
          reason: `held by approved policy version ${entry.policyVersion} (rule ${entry.ruleId})`,
          text: CLAIM,
        },
      ]),
    );
    const recorded = cli(['record', '--held', heldFile], { cwd: repo, data, input: 'No actionable findings.\n' });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    const explained = cli(['explain', '--run', runId], { cwd: repo, data });
    assert.equal(explained.code, 0, explained.stderr);
    assert.match(explained.stdout, /Held back \(1\):/);
    assert.match(explained.stdout, /\[policy-suppressed\] src\/retry\.ts:5/);
    assert.match(explained.stdout, /maintainability:diff/);
    assert.match(explained.stdout, /policy version 2/);

    // AC-6: the recorded run names the versions loadConfig loaded for it.
    const db3 = openDb(data);
    try {
      const row = db3
        .prepare('SELECT active_policy_versions_json FROM review_runs WHERE review_run_id = ?')
        .get(runId);
      assert.deepEqual(JSON.parse(row.active_policy_versions_json), loaded.activePolicyVersions);
    } finally {
      db3.close();
    }

    // AC-4: the owner can still post it, past the policy gate.
    const promoted = score(setup, candidate(), ['--promote', 'cand_001']);
    assert.deepEqual(
      promoted.eligible.map((e) => e.candidateId),
      ['cand_001'],
    );
    assert.equal(promoted.scores[0].ownerPromotion.gate, 'policy');
    assert.equal(promoted.scores[0].ownerPromotion.ruleId, 'maintainability:diff');
    assert.deepEqual(promoted.suppressed, []);

    // AC-7: rollback to a version without the suppression frees it again.
    const rolledBack = cli(['policy', 'rollback', '1'], { cwd: repo, data });
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    const freed = score(setup);
    assert.deepEqual(
      freed.eligible.map((e) => e.candidateId),
      ['cand_001'],
    );
    assert.deepEqual(freed.suppressed, []);
  }));

// AC-5: approval refuses an exempt suppression, and scoring ignores one that
// got into the store by another route.
test('a suppression may never reach an exempt category', () =>
  withSetup((setup) => {
    const { data } = setup;
    const db = openDb(data);
    try {
      const stored = proposePolicy(db, [
        {
          scope: { type: 'global', key: 'owner' },
          kind: 'suppress',
          category: 'security',
          ruleId: 'security:diff',
          rule: 'Suppress security findings.',
          evidence: {
            keeps: 0,
            dismissals: 3,
            rewrites: 0,
            ownerSignals: 3,
            contradictingSignals: 0,
            mostRecentAt: '2026-10-01T00:00:00Z',
            eventIds: [],
          },
          confidence: 0.9,
          activatable: true,
          blockedBecause: null,
        },
      ]);
      const refused = approvePolicy(db, stored.policyId);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /may not reach/);
      assert.match(refused.error, /security:diff/);

      // The same suppression inserted directly as an active row, bypassing
      // approvePolicy. Scoring must ignore it all the same.
      db.prepare(
        `INSERT INTO policies (policy_id, scope_type, scope_key, version, content_yaml,
                               active, generated_at, approved_at, provenance_json, evaluation_json)
         VALUES ('direct-security', 'global', 'owner', 99, ?, 1,
                 '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', '[]', '{}')`,
      ).run(
        [
          'policy_version: 99',
          'scope:',
          '  type: global',
          '  key: owner',
          '',
          'suppressed_patterns:',
          '  []',
          '',
          'suppressions:',
          '  - rule_id: "security:diff"',
          '    glob: null',
          '    reason: "inserted directly"',
          '',
        ].join('\n'),
      );
    } finally {
      db.close();
    }

    const scored = score(
      setup,
      candidate({
        category: 'security',
        severity: 'important',
        claim: 'The retry helper sends the session token to every endpoint in the list, including the plain http fallback.',
      }),
    );
    assert.deepEqual(
      scored.eligible.map((e) => e.candidateId),
      ['cand_001'],
    );
    assert.deepEqual(scored.suppressed, []);
    assert.equal(scored.scores[0].rejectedBecause, null);
  }));

// The carve-out holds under every spelling of an exempt category: a proposal
// keyed on `authz:diff` is refused, and a row inserted directly under that key
// leaves an `authz` candidate eligible.
test('an alias of an exempt category is refused at approval and ignored at scoring', () =>
  withSetup((setup) => {
    const { data } = setup;
    const db = openDb(data);
    try {
      const stored = proposePolicy(db, [
        {
          scope: { type: 'global', key: 'owner' },
          kind: 'suppress',
          category: 'authz',
          ruleId: 'authz:diff',
          rule: 'Suppress authz findings.',
          evidence: {
            keeps: 0,
            dismissals: 3,
            rewrites: 0,
            ownerSignals: 3,
            contradictingSignals: 0,
            mostRecentAt: '2026-10-01T00:00:00Z',
            eventIds: [],
          },
          confidence: 0.9,
          activatable: true,
          blockedBecause: null,
        },
      ]);
      const refused = approvePolicy(db, stored.policyId);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /authz:diff/);
      db.prepare(
        `INSERT INTO policies (policy_id, scope_type, scope_key, version, content_yaml,
                               active, generated_at, approved_at, provenance_json, evaluation_json)
         VALUES ('direct-authz', 'global', 'owner', 99, ?, 1,
                 '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', '[]', '{}')`,
      ).run(
        ['policy_version: 99', 'scope:', '  type: global', '  key: owner', '', 'suppressed_patterns:', '  []', '', 'suppressions:', '  - rule_id: "authz:diff"', '    glob: null', '    reason: "inserted directly"', ''].join('\n'),
      );
    } finally {
      db.close();
    }

    const scored = score(
      setup,
      candidate({
        category: 'authz',
        severity: 'important',
        claim: 'The retry helper calls the admin endpoint with the caller token and never checks the caller is an admin.',
      }),
    );
    assert.deepEqual(scored.eligible.map((e) => e.candidateId), ['cand_001']);
    assert.deepEqual(scored.suppressed, []);
  }));

// A question with verified premises stays eligible under the unverifiable cap,
// so when a suppression is the only thing that held it, --promote lifts it.
test('a policy-held question under the unverifiable cap can be promoted', () =>
  withSetup((setup) => {
    const { base, repo, data } = setup;
    const db = openDb(data);
    let proposalId;
    try {
      seedDismissals(db);
      proposalId = proposePolicy(db, compileProposals(db)).policyId;
    } finally {
      db.close();
    }
    const approved = cli(['policy', 'approve', proposalId], { cwd: repo, data });
    assert.equal(approved.code, 0, approved.stderr);

    const question = candidate({
      severity: 'question',
      claim: 'Does every call site need its own copy of the retry delay, or can the three share one?',
    });
    const verification = join(base, 'verification.json');
    writeFileSync(
      verification,
      JSON.stringify({
        results: [
          {
            candidate_id: 'cand_001',
            verified: false,
            premises_verified: true,
            evidence_quality: 'medium',
            technical_confidence: 0.9,
            required_context_missing: ['the call sites outside this diff'],
          },
        ],
      }),
    );
    const run = (extra) => {
      const r = cli(['score', '--verification', verification, ...extra], { cwd: repo, data, input: JSON.stringify({ candidates: [question] }) });
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout);
    };

    const held = run([]);
    assert.equal(held.scores[0].confidenceSource, 'unverifiable-cap');
    assert.equal(held.scores[0].rejectedBecause, 'policy-suppressed:maintainability:diff');
    assert.deepEqual(held.suppressed.map((s) => s.candidateId), ['cand_001']);

    const promoted = run(['--promote', 'cand_001']);
    assert.deepEqual(promoted.eligible.map((e) => e.candidateId), ['cand_001']);
    assert.equal(promoted.scores[0].ownerPromotion.gate, 'policy');
    assert.equal(promoted.scores[0].ownerPromotion.ruleId, 'maintainability:diff');
    assert.deepEqual(promoted.suppressed, []);
  }));

// The driver records a run's candidates from score's eligible entries, so a
// finding's rule id can only be as complete as those entries: the lane and the
// blocker class have to travel with them, or every recorded rule reads `:diff`.
test('an eligible entry carries its lane and blocker class, so a recorded finding keeps its full rule id', () =>
  withSetup((setup) => {
    const { base, repo, data } = setup;
    const scored = score(setup, candidate({ lane: 'structure', blocker_class: 'existing-helper-duplicate' }));
    assert.deepEqual(scored.eligible.map((e) => e.candidateId), ['cand_001']);
    assert.equal(scored.eligible[0].lane, 'structure');
    assert.equal(scored.eligible[0].blockerClass, 'existing-helper-duplicate');

    // As the driver does: the eligible entries become record's candidates.
    const candidatesFile = join(base, 'record-candidates.json');
    writeFileSync(candidatesFile, JSON.stringify({ candidates: scored.eligible }));
    const recorded = cli(['record', '--candidates', candidatesFile], {
      cwd: repo,
      data,
      input: '[minor] `src/retry.ts:5` - The retry delay is computed three times. One copy drifts. Share it.\n',
    });
    assert.equal(recorded.code, 0, recorded.stderr);
    const { reviewRunId, findings } = JSON.parse(recorded.stdout);
    assert.equal(findings[0].ruleId, 'maintainability:structure:existing-helper-duplicate');
    const explained = cli(['explain', '--run', reviewRunId], { cwd: repo, data });
    assert.match(explained.stdout, /rule id\s+maintainability:structure:existing-helper-duplicate/);
  }));

// score and record are two commands, so a policy approved or rolled back
// between them must not make the run name versions it was never held to.
test('the recorded run names the policy versions score loaded, not the ones active when it was recorded', () =>
  withSetup((setup) => {
    const { base, repo, data } = setup;
    const db = openDb(data);
    let proposalId;
    try {
      const empty = proposePolicy(db, []);
      assert.equal(approvePolicy(db, empty.policyId).ok, true);
      seedDismissals(db);
      proposalId = proposePolicy(db, compileProposals(db)).policyId;
    } finally {
      db.close();
    }
    const approved = cli(['policy', 'approve', proposalId], { cwd: repo, data });
    assert.equal(approved.code, 0, approved.stderr);

    const scored = score(setup);
    assert.deepEqual(scored.policyVersions.map((v) => v.version), [2]);
    assert.equal(scored.suppressed.length, 1);
    const scoresFile = join(base, 'scores.json');
    writeFileSync(scoresFile, JSON.stringify(scored));

    const rolledBack = cli(['policy', 'rollback', '1'], { cwd: repo, data });
    assert.equal(rolledBack.code, 0, rolledBack.stderr);

    const recorded = cli(['record', '--scores', scoresFile], { cwd: repo, data, input: 'No actionable findings.\n' });
    assert.equal(recorded.code, 0, recorded.stderr);
    const { reviewRunId } = JSON.parse(recorded.stdout);
    const db2 = openDb(data);
    try {
      const row = db2.prepare('SELECT active_policy_versions_json FROM review_runs WHERE review_run_id = ?').get(reviewRunId);
      assert.deepEqual(JSON.parse(row.active_policy_versions_json), scored.policyVersions);
      assert.deepEqual(JSON.parse(row.active_policy_versions_json).map((v) => v.version), [2]);
    } finally {
      db2.close();
    }

    // Without a scores file the run records what is active now, as before.
    const plain = cli(['record'], { cwd: repo, data, input: 'No actionable findings.\n' });
    assert.equal(plain.code, 0, plain.stderr);
    const db3 = openDb(data);
    try {
      const row = db3.prepare('SELECT active_policy_versions_json FROM review_runs WHERE review_run_id = ?').get(JSON.parse(plain.stdout).reviewRunId);
      assert.deepEqual(JSON.parse(row.active_policy_versions_json).map((v) => v.version), [1]);
    } finally {
      db3.close();
    }
  }));

// A carried run is not rescored, so it keeps the policy versions of the run it
// carries, not whatever became active in between.
test('a carried run keeps the policy versions of the run it carries', () =>
  withSetup((setup) => {
    const { repo, data } = setup;
    const db = openDb(data);
    let proposalId;
    try {
      const empty = proposePolicy(db, []);
      assert.equal(approvePolicy(db, empty.policyId).ok, true);
      seedDismissals(db);
      proposalId = proposePolicy(db, compileProposals(db)).policyId;
    } finally {
      db.close();
    }
    assert.equal(cli(['policy', 'approve', proposalId], { cwd: repo, data }).code, 0);

    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const first = git('rev-parse', 'HEAD');
    const source = cli(['record', '--head', first], { cwd: repo, data, input: 'No actionable findings.\n' });
    assert.equal(source.code, 0, source.stderr);
    const sourceId = JSON.parse(source.stdout).reviewRunId;

    assert.equal(cli(['policy', 'rollback', '1'], { cwd: repo, data }).code, 0);
    writeFileSync(join(repo, 'src', 'retry.ts'), 'export const value0 = 0;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'second');
    const second = git('rev-parse', 'HEAD');

    const carried = cli(['record', '--head', second, '--carried-from', sourceId], { cwd: repo, data, input: 'No actionable findings.\n' });
    assert.equal(carried.code, 0, carried.stderr);
    const db2 = openDb(data);
    try {
      const versions = (runId) =>
        JSON.parse(db2.prepare('SELECT active_policy_versions_json FROM review_runs WHERE review_run_id = ?').get(runId).active_policy_versions_json).map((v) => v.version);
      assert.deepEqual(versions(sourceId), [2]);
      assert.deepEqual(versions(JSON.parse(carried.stdout).reviewRunId), [2], 'the carried run names the versions its source was held to');
      // A source from before provenance existed still has the column, and a
      // carry of it keeps those versions too.
      db2.prepare('UPDATE review_runs SET provenance_json = NULL WHERE review_run_id = ?').run(sourceId);
    } finally {
      db2.close();
    }
    writeFileSync(join(repo, 'src', 'retry.ts'), 'export const value0 = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'third');
    const legacy = cli(['record', '--head', git('rev-parse', 'HEAD'), '--carried-from', sourceId], { cwd: repo, data, input: 'No actionable findings.\n' });
    assert.equal(legacy.code, 0, legacy.stderr);
    const db3 = openDb(data);
    try {
      const row = db3.prepare('SELECT active_policy_versions_json FROM review_runs WHERE review_run_id = ?').get(JSON.parse(legacy.stdout).reviewRunId);
      assert.deepEqual(JSON.parse(row.active_policy_versions_json).map((v) => v.version), [2], 'a legacy source without provenance still lends its versions');
    } finally {
      db3.close();
    }
  }));
