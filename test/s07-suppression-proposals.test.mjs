import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { saveOutcome } from '../plugins/review-voice/src/store/outcomes.ts';
import { compileProposals, GLOBAL_SCOPE } from '../plugins/review-voice/src/policy/compile.ts';
import { activePolicyRows, approvePolicy, listPolicies, proposePolicy } from '../plugins/review-voice/src/policy/versions.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const OWNER = 'your-github-login';
const BILLING = { type: 'path', key: 'src/billing/**' };
const PATHS = ['src/billing/retry.ts', 'src/billing/invoice.ts', 'src/billing/charges/retry.ts'];

function withSetup(body) {
  const base = mkdtempSync(join(tmpdir(), 'rv-s07-policy-'));
  const repo = join(base, 'repo');
  const data = join(base, 'data');
  mkdirSync(data);
  for (const area of ['billing', 'orders']) {
    mkdirSync(join(repo, 'src', area), { recursive: true });
    writeFileSync(join(repo, 'src', area, 'retry.ts'),
      Array.from({ length: 20 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n');
  }
  mkdirSync(join(repo, '.review-voice'));
  writeFileSync(join(repo, '.review-voice/config.yaml'), `identity:\n  owner_reviewer: ${OWNER}\n`);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return Promise.resolve()
    .then(() => body({ base, repo, data }))
    .finally(() => rmSync(base, { recursive: true, force: true }));
}

function withDb(data, body) {
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    return body(db);
  } finally {
    db.close();
  }
}

function cli(args, { base, repo, data, input = '' }) {
  // Each invocation copies a closed fixture store so no command opens a shared or personal store.
  const fresh = mkdtempSync(join(base, 'cli-'));
  const source = join(data, 'review-voice.db');
  if (existsSync(source)) copyFileSync(source, join(fresh, 'review-voice.db'));
  const result = spawnSync(process.execPath, [bundle, ...args], {
    cwd: repo, input, encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: fresh },
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, data: fresh };
}

function seedDismissals(db, { paths = PATHS, decidedBy = OWNER, category = 'maintainability', strength = 'strong', outcome = 'dismissed' } = {}) {
  const run = recordRun(db, {
    repository: 'your-org/your-repo', baseRef: null, headRef: null, diff: 'd',
    output: paths.map((path) => `[minor] \`${path}:5\` - The retry repeats the backoff calculation.`).join('\n\n'),
    candidates: paths.map((path) => ({ path, line: 5, category })),
  });
  for (const finding of run.findings) {
    saveOutcome(db, {
      reviewRunId: run.reviewRunId, findingId: finding.findingId, repository: 'your-org/your-repo',
      pullNumber: 7, commentId: 101, outcome, strength, decidedBy,
      evidence: 'a reviewer replied turning it down', checkedAt: '2026-11-08T00:00:00.000Z',
      path: finding.path, line: finding.line, reviewIdSource: 'audit',
    });
  }
  return run;
}

test('AC-2: three owner thread dismissals produce one path suppression with three owner provenance signals', () =>
  withSetup(({ data }) => withDb(data, (db) => {
    const run = seedDismissals(db, { decidedBy: OWNER.toUpperCase() });
    const proposals = compileProposals(db, { ownerReviewer: OWNER });
    assert.equal(proposals.length, 1);
    const [proposal] = proposals;
    assert.equal(proposal.kind, 'suppress');
    assert.equal(proposal.ruleId, 'maintainability:diff');
    assert.deepEqual(proposal.scope, BILLING);
    assert.equal(proposal.glob, BILLING.key);
    assert.equal(proposal.activatable, true);
    assert.equal(proposal.evidence.dismissals, 3);
    assert.equal(proposal.evidence.ownerSignals, 3);
    const expectedIds = run.findings.map((finding) => `${run.reviewRunId}:${finding.findingId}`).sort();
    assert.deepEqual([...proposal.evidence.eventIds].sort(), expectedIds);

    const stored = proposePolicy(db, proposals, proposal.scope);
    const content = parseYaml(stored.contentYaml);
    assert.deepEqual(content.scope, BILLING);
    assert.equal(content.suppressions.length, 1);
    assert.equal(content.suppressions[0].rule_id, 'maintainability:diff');
    assert.equal(content.suppressions[0].glob, BILLING.key);
    const [saved] = listPolicies(db, BILLING);
    assert.equal(saved.provenance[0].evidence.ownerSignals, 3);
    assert.deepEqual([...saved.provenance[0].evidence.eventIds].sort(), expectedIds);
    assert.equal(saved.active, false);
    assert.equal(saved.approvedAt, null);
    assert.deepEqual(activePolicyRows(db), []);
  })));

test('AC-3: teammate dismissals cannot be approved without an owner signal', () =>
  withSetup(({ data }) => withDb(data, (db) => {
    seedDismissals(db, { decidedBy: 'your-teammate-login' });
    const proposals = compileProposals(db, { ownerReviewer: OWNER });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].evidence.dismissals, 3);
    assert.equal(proposals[0].evidence.ownerSignals, 0);
    assert.equal(proposals[0].activatable, false);
    const stored = proposePolicy(db, proposals, BILLING);
    const approved = approvePolicy(db, stored.policyId);
    assert.equal(approved.ok, false);
    assert.match(approved.error, /no owner signal/);
    assert.equal(listPolicies(db)[0].active, false);
    assert.deepEqual(activePolicyRows(db), []);
  })));

test('AC-2 and AC-3: weak outcomes add no evidence and an unknown owner cannot supply owner signals', () =>
  withSetup(({ data }) => withDb(data, (db) => {
    seedDismissals(db, { strength: 'weak' });
    seedDismissals(db, { outcome: 'open', strength: 'weak' });
    seedDismissals(db, { outcome: 'fixed' });
    assert.deepEqual(compileProposals(db, { ownerReviewer: OWNER }), []);
    seedDismissals(db);
    const [proposal] = compileProposals(db);
    assert.equal(proposal.evidence.dismissals, 3);
    assert.equal(proposal.evidence.ownerSignals, 0);
    assert.equal(proposal.activatable, false);
  })));

test('AC-4: dismissals in billing and docs for one rule produce a global suppression', () =>
  withSetup(({ data }) => withDb(data, (db) => {
    seedDismissals(db, { paths: [PATHS[0], PATHS[1], 'docs/retry.md'] });
    const proposals = compileProposals(db, { ownerReviewer: OWNER });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].ruleId, 'maintainability:diff');
    assert.deepEqual(proposals[0].scope, GLOBAL_SCOPE);
    assert.equal(proposals[0].glob, null);
    const content = parseYaml(proposePolicy(db, proposals, proposals[0].scope).contentYaml);
    assert.deepEqual(content.scope, GLOBAL_SCOPE);
    assert.equal(content.suppressions[0].glob, null);
  })));

for (const action of ['dismiss', 'never_flag']) {
  test(`AC-5: a thread dismissal covered by ${action} feedback counts once`, () =>
    withSetup(({ data }) => withDb(data, (db) => {
      const run = seedDismissals(db, { paths: PATHS.slice(0, 2) });
      const findingRef = `${run.reviewRunId}:rv_01`;
      assert.equal(recordFeedback(db, { findingRef, action, actor: 'owner' }).ok, true);
      const [proposal] = compileProposals(db, { ownerReviewer: OWNER });
      assert.equal(proposal.evidence.dismissals, 2);
      assert.equal(proposal.evidence.ownerSignals, 2);
      assert.equal(proposal.evidence.eventIds.filter((id) => id === findingRef).length, 1);
      assert.equal(proposal.activatable, false);
      assert.match(proposal.blockedBecause, /only 2 corroborating signals/);
    })));
}

const candidate = (path, id) => ({
  candidate_id: id, path, line: 5, category: 'maintainability', severity: 'minor',
  claim: 'The retry helper repeats the same backoff calculation in three places, so a change to the delay must be made three times.',
  failure_mode: 'One copy is updated and the others keep the old delay, so retries behave differently by call site.',
  evidence: [
    `${path}:5 computes the delay as attempt times 1000.`,
    `${path}:6 computes the same delay again for the second call site.`,
    `${path}:7 repeats the computation a third time.`,
  ],
  technical_confidence: 0.9,
});

function score(setup) {
  const candidates = [candidate('src/billing/retry.ts', 'cand_001'), candidate('src/orders/retry.ts', 'cand_002')];
  const verification = join(setup.base, 'verification.json');
  writeFileSync(verification, JSON.stringify({ results: candidates.map((cand) => ({
    candidate_id: cand.candidate_id, verified: true, evidence_quality: 'high', technical_confidence: 0.95,
  })) }));
  return JSON.parse(cli(['score', '--verification', verification], { ...setup, input: JSON.stringify({ candidates }) }).stdout);
}

test('AC-6: an approved billing policy holds the billing candidate and leaves the identical orders candidate eligible', () =>
  withSetup((setup) => {
    withDb(setup.data, (db) => {
      seedDismissals(db);
      const proposals = compileProposals(db, { ownerReviewer: OWNER });
      const policy = proposePolicy(db, proposals, BILLING);
      assert.equal(approvePolicy(db, policy.policyId).ok, true);
      const config = loadConfig(setup.repo, undefined, undefined, db);
      assert.ok(config.layers.some((layer) => layer.scope.type === 'path' && layer.scope.key === BILLING.key));
      assert.equal(config.suppressions[0].glob, BILLING.key);
    });
    const result = score(setup);
    assert.deepEqual(result.eligible.map((entry) => entry.candidateId), ['cand_002']);
    const billing = result.scores.find((entry) => entry.candidateId === 'cand_001');
    const orders = result.scores.find((entry) => entry.candidateId === 'cand_002');
    assert.equal(billing.eligible, false);
    assert.equal(billing.rejectedBecause, 'policy-suppressed:maintainability:diff');
    assert.equal(orders.eligible, true);
    assert.equal(orders.rejectedBecause, null);
    assert.deepEqual(result.suppressed.map((entry) => [entry.candidateId, entry.path, entry.ruleId, entry.policyVersion]),
      [['cand_001', 'src/billing/retry.ts', 'maintainability:diff', 1]]);
  }));

test('AC-7: calibrate groups scopes, show filters them, and rollback changes only the selected path scope', () =>
  withSetup((setup) => {
    withDb(setup.data, (db) => {
      seedDismissals(db);
      seedDismissals(db, { category: 'performance' });
      seedDismissals(db, { paths: ['src/billing/retry.ts', 'docs/retry.md', 'src/orders/retry.ts'], category: 'correctness' });
    });
    const first = cli(['calibrate'], setup);
    const firstRows = JSON.parse(first.stdout).policies;
    assert.deepEqual(firstRows.map(({ scope, version, active }) => [scope, version, active]),
      [['global', 1, false], ['path:src/billing/**', 1, false]]);
    assert.ok(firstRows.every((row) => typeof row.policyId === 'string' && row.policyId.length > 0));
    withDb(first.data, (db) => {
      assert.equal(listPolicies(db).length, 2);
      assert.ok(listPolicies(db).every((row) => row.provenance.every((rule) => rule.evidence.ownerSignals === 3)));
      // Two rules in one scope must share a policy row rather than compete for activation.
      assert.deepEqual(listPolicies(db, BILLING)[0].provenance.map((rule) => rule.ruleId).sort(),
        ['maintainability:diff', 'performance:diff']);
      assert.deepEqual(activePolicyRows(db), []);
      // Advance only global so the next calibration must use independent version sequences.
      proposePolicy(db, []);
    });
    const second = cli(['calibrate'], { ...setup, data: first.data });
    const secondRows = JSON.parse(second.stdout).policies;
    assert.deepEqual(secondRows.map(({ scope, version }) => [scope, version]), [['global', 3], ['path:src/billing/**', 2]]);

    const shown = JSON.parse(cli(['policy', 'show'], { ...setup, data: second.data }).stdout).policies;
    assert.deepEqual(shown.map((row) => [row.scopeType, row.scopeKey, row.version]), [
      ['global', 'owner', 3], ['global', 'owner', 2], ['global', 'owner', 1],
      ['path', BILLING.key, 2], ['path', BILLING.key, 1],
    ]);
    const narrowed = JSON.parse(cli(['policy', 'show', '--scope', 'path:src/billing/**'], { ...setup, data: second.data }).stdout).policies;
    assert.deepEqual(narrowed.map((row) => [row.scopeType, row.scopeKey, row.version]), [['path', BILLING.key, 2], ['path', BILLING.key, 1]]);
    const globals = JSON.parse(cli(['policy', 'show', '--scope', 'global'], { ...setup, data: second.data }).stdout).policies;
    assert.deepEqual(globals.map((row) => row.version), [3, 2, 1]);
    assert.ok(globals.every((row) => row.scopeType === 'global'));

    let before;
    withDb(second.data, (db) => {
      for (const row of [...firstRows, ...secondRows]) assert.equal(approvePolicy(db, row.policyId).ok, true);
      const other = proposePolicy(db, [], { type: 'path', key: 'src/orders/**' });
      assert.equal(approvePolicy(db, other.policyId).ok, true);
      before = listPolicies(db);
      assert.equal(activePolicyRows(db).length, 3);
    });
    const rolled = cli(['policy', 'rollback', '1', '--scope', 'path:src/billing/**'], { ...setup, data: second.data });
    assert.match(rolled.stdout, /Rolled back to policy version 1\./);
    withDb(rolled.data, (db) => {
      const after = listPolicies(db);
      const outside = (rows) => rows.filter((row) => row.scopeType !== 'path' || row.scopeKey !== BILLING.key);
      assert.deepEqual(outside(after), outside(before));
      assert.deepEqual(listPolicies(db, BILLING).map((row) => [row.version, row.active]), [[2, false], [1, true]]);
      assert.equal(activePolicyRows(db).length, 3);
    });
  }));

test('AC-8: the outcome ADRs and their index record the November 2026 amendments', () => {
  const index = readFileSync(join(root, 'docs/adr/README.md'), 'utf8');
  for (const [id, name] of [
    ['0004', 'outcome-inference-limits'],
    ['0029', 'posted-findings-are-followed-to-an-outcome'],
  ]) {
    const adr = readFileSync(join(root, `docs/adr/${id}-${name}.md`), 'utf8');
    assert.match(adr, /^## Amendment - 2026-11-08$/m);
    const row = index.split('\n').find((line) => line.startsWith(`| [${id}]`));
    assert.ok(row, `Missing ADR index row ${id}`);
    assert.match(row.split('|')[3], /amended 2026-11-08/);
  }
});


// One finding dismissed is one signal however many ways the owner recorded it:
// dismiss, then never_flag, and the thread agreeing make one dismissal, not three.
test('a finding dismissed as feedback twice over and on the thread counts once', () =>
  withSetup(({ data }) => withDb(data, (db) => {
    const run = seedDismissals(db, { paths: PATHS.slice(0, 2) });
    const findingRef = `${run.reviewRunId}:rv_01`;
    assert.equal(recordFeedback(db, { findingRef, action: 'dismiss', actor: 'owner' }).ok, true);
    assert.equal(recordFeedback(db, { findingRef, action: 'never_flag', actor: 'owner' }).ok, true);
    const [proposal] = compileProposals(db, { ownerReviewer: OWNER });
    assert.equal(proposal.evidence.dismissals, 2);
    assert.equal(proposal.activatable, false, 'two findings are two signals, whatever was recorded about them');
    const stored = proposePolicy(db, [proposal], proposal.scope);
    assert.equal(approvePolicy(db, stored.policyId).ok, false);
  })));

// A teammate's dismissal is evidence for a rule, never a veto over one: the
// owner's keeps stay approvable, and the teammates' suppression stays blocked.
test('teammate dismissals do not contradict the owner, and the owner keeps contradict them', () =>
  withSetup(({ data }) => withDb(data, (db) => {
    const run = seedDismissals(db, { decidedBy: 'a-teammate' });
    for (const finding of run.findings) {
      assert.equal(recordFeedback(db, { findingRef: `${run.reviewRunId}:${finding.findingId}`, action: 'keep', actor: 'owner' }).ok, true);
    }
    const proposals = compileProposals(db, { ownerReviewer: OWNER });
    const prioritise = proposals.find((p) => p.kind === 'prioritise');
    const suppress = proposals.find((p) => p.kind === 'suppress');
    assert.equal(prioritise.evidence.contradictingSignals, 0, 'teammates cannot contradict the owner');
    assert.equal(prioritise.activatable, true);
    assert.equal(suppress.evidence.ownerSignals, 0);
    assert.equal(suppress.evidence.contradictingSignals, 3, 'the owner keeps contradict the teammates');
    assert.equal(suppress.activatable, false);
  })));

// The scope is derived from where the dismissals were, so it must never come
// out wider than that directory: a glob character in a name is kept as written,
// a parent reference is resolved, a path that climbs out shares only the root, and a
// name a glob cannot spell leaves the rule unscoped rather than widening it.
test('the path scope follows the dismissals exactly, whatever their spelling', () =>
  withSetup(({ data }) => withDb(data, (db) => {
    const scopeOf = (paths) => {
      seedDismissals(db, { paths });
      const proposal = compileProposals(db, { ownerReviewer: OWNER }).find((p) => p.kind === 'suppress');
      db.exec('DELETE FROM finding_outcomes');
      db.exec('DELETE FROM review_runs');
      return proposal.scope;
    };
    // A glob character in a directory name cannot be written as a glob, so the
    // rule stays unscoped (and is blocked; the next test covers that).
    assert.deepEqual(scopeOf(['src/bill?ing/a.ts', 'src/bill?ing/b.ts', 'src/bill?ing/c/d.ts']), GLOBAL_SCOPE);
    assert.deepEqual(scopeOf(['src/billing/../orders/a.ts', 'src/orders/b.ts', './src/orders/c.ts']), { type: 'path', key: 'src/orders/**' });
    assert.deepEqual(scopeOf(['../outside/a.ts', 'src/billing/b.ts', 'src/billing/c.ts']), GLOBAL_SCOPE);
  })));

// A path policy applies inside its scope and nowhere else, so a row whose
// suppression names a wider glob is read with the scope's glob and a warning.
test('a path policy row naming a wider glob still applies only inside its scope', () =>
  withSetup((setup) => {
    withDb(setup.data, (db) => {
      db.prepare(
        `INSERT INTO policies (policy_id, scope_type, scope_key, version, content_yaml,
                               active, generated_at, approved_at, provenance_json, evaluation_json)
         VALUES ('wide-billing', 'path', ?, 1, ?, 1, '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z', '[]', '{}')`,
      ).run(
        BILLING.key,
        ['policy_version: 1', 'scope:', '  type: path', `  key: "${BILLING.key}"`, '', 'suppressed_patterns:', '  []', '', 'suppressions:', '  - rule_id: "maintainability:diff"', '    glob: "**"', '    reason: "edited by hand"', ''].join('\n'),
      );
      const config = loadConfig(setup.repo, undefined, undefined, db);
      assert.equal(config.suppressions[0].glob, BILLING.key);
      assert.ok(config.warnings.some((w) => /names glob \*\*; the policy's scope src\/billing\/\*\* applies/.test(w)), config.warnings.join('\n'));
    });
    const result = score(setup);
    assert.deepEqual(result.eligible.map((entry) => entry.candidateId), ['cand_002']);
    assert.deepEqual(result.suppressed.map((entry) => entry.candidateId), ['cand_001']);
  }));

// A directory whose name holds a glob character cannot be written as a glob
// without widening it, so the rule is proposed unscoped and blocked.
test('dismissals under a directory whose name holds a glob character cannot be scoped, so the rule is blocked', () =>
  withSetup(({ data }) => withDb(data, (db) => {
    seedDismissals(db, { paths: ['src/bill*/a.ts', 'src/bill*/b.ts', 'src/bill*/c/d.ts'] });
    const [proposal] = compileProposals(db, { ownerReviewer: OWNER });
    assert.deepEqual(proposal.scope, GLOBAL_SCOPE);
    assert.equal(proposal.glob, null);
    assert.equal(proposal.activatable, false);
    assert.match(proposal.blockedBecause, /src\/bill\*, whose name holds a glob character/);
    const stored = proposePolicy(db, [proposal], proposal.scope);
    assert.equal(approvePolicy(db, stored.policyId).ok, false);
  })));

// A blocked rule in a scope must not veto the owner's approvable one beside it:
// calibrate stores only what can be approved and lists the rest with its reason.
test('calibrate keeps a blocked teammate rule out of the row it would otherwise veto', () =>
  withSetup((setup) => {
    withDb(setup.data, (db) => {
      seedDismissals(db);
      seedDismissals(db, { category: 'performance', decidedBy: 'a-teammate' });
    });
    const result = cli(['calibrate'], setup);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.policies.map((row) => row.scope), ['path:src/billing/**']);
    assert.deepEqual(output.blocked.map((entry) => [entry.ruleId, entry.scope]), [['performance:diff', 'path:src/billing/**']]);
    assert.match(output.blocked[0].blockedBecause, /no owner signal/);
    assert.equal(output.proposals.length, 2, 'every proposal is still printed');
    withDb(result.data, (db) => {
      const [row] = listPolicies(db, BILLING);
      assert.deepEqual(row.provenance.map((rule) => rule.ruleId), ['maintainability:diff']);
      assert.equal(approvePolicy(db, output.policies[0].policyId).ok, true);
    });
  }));

// A suppression of an exempt category can never be approved, so it is never
// activatable and never joins a row where it would stop the rules beside it.
test('an exempt-category suppression is blocked at compile time and kept out of the row', () =>
  withSetup((setup) => {
    withDb(setup.data, (db) => {
      seedDismissals(db);
      seedDismissals(db, { category: 'security' });
      const security = compileProposals(db, { ownerReviewer: OWNER }).find((p) => p.ruleId === 'security:diff');
      assert.equal(security.activatable, false);
      assert.match(security.blockedBecause, /may not reach security/);
    });
    const result = cli(['calibrate'], setup);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.policies.map((row) => row.scope), ['path:src/billing/**']);
    assert.deepEqual(output.blocked.map((entry) => entry.ruleId), ['security:diff']);
    withDb(result.data, (db) => {
      assert.deepEqual(listPolicies(db, BILLING)[0].provenance.map((rule) => rule.ruleId), ['maintainability:diff']);
      assert.equal(approvePolicy(db, output.policies[0].policyId).ok, true);
    });
  }));
