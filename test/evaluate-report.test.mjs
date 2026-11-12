/**
 * S23. The rendered analytics report: `evaluationReport` builds the object
 * `evaluate --json` prints, `renderEvaluationHtml` renders it, and the text
 * output is byte for byte what it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordFeedback } from '../plugins/review-voice/src/store/feedback.ts';
import { postedBreakdown, precisionBreakdown, saveOutcome } from '../plugins/review-voice/src/store/outcomes.ts';
import { byFamily,
  computeMetrics,
  evaluationReport,
  formatMetricValue,
  metricMark,
  metricTarget,
  ruleEffectiveness,
} from '../plugins/review-voice/src/evaluate/metrics.ts';
import { recallMetrics } from '../plugins/review-voice/src/evaluate/recall-results.ts';
import { htmlDocument, renderEvaluationHtml } from '../plugins/review-voice/src/evaluate/report.ts';
import { activePolicyRows, activeSuppressions, approvePolicy, proposePolicy } from '../plugins/review-voice/src/policy/versions.ts';
import { POLICY_SUPPRESSED_PREFIX } from '../plugins/review-voice/src/scoring/score.ts';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-eval-report-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const candidate = (line, category, lane) => ({ path: 'src/a.ts', line, category, lane });
const finding = (line, word) => `[minor] \`src/a.ts:${line}\` - ${word} problem here. It fails. Fix it.`;
const base = { repository: 'org/a', baseRef: null, headRef: null, diff: 'd' };

/** Five findings: three correctness on the diff lane, two maintainability on the structure lane. */
const labelledRun = (db) =>
  recordRun(db, {
    ...base,
    output: ['First', 'Second', 'Third', 'Fourth', 'Fifth'].map((word, i) => finding(i + 1, word)).join('\n\n'),
    candidates: [
      candidate(1, 'correctness', 'diff'),
      candidate(2, 'maintainability', 'structure'),
      candidate(3, 'correctness', 'diff'),
      candidate(4, 'maintainability', 'structure'),
      candidate(5, 'correctness', 'diff'),
    ],
  }).reviewRunId;

const strong = (db, runId, findingId, outcome) =>
  saveOutcome(db, {
    reviewRunId: runId, findingId, repository: 'org/a', pullNumber: 1, commentId: Number(findingId.slice(3)),
    outcome, strength: outcome === 'open' ? 'weak' : 'strong', evidence: 'test', checkedAt: '2026-11-09T00:00:00.000Z', path: 'src/a.ts', line: 1, reviewIdSource: 'audit',
  });

const setCreatedAt = (db, runId, iso) => db.prepare('UPDATE review_runs SET created_at = ? WHERE review_run_id = ?').run(iso, runId);

// AC-2: precision by lane and rule

test('precisionBreakdown places labels by lane and rule, and an unlabelled or never_flag finding appears nowhere', () => {
  withDb((db) => {
    assert.deepEqual(precisionBreakdown(db), { byLane: {}, byRule: {} });
    labelledRun(db);
    recordFeedback(db, { findingRef: 'rv_01', action: 'keep', actor: 'owner' });
    recordFeedback(db, { findingRef: 'rv_02', action: 'rewrite', replacementText: 'Better.', actor: 'owner' });
    recordFeedback(db, { findingRef: 'rv_03', action: 'dismiss', actor: 'owner' });
    recordFeedback(db, { findingRef: 'rv_05', action: 'never_flag', actor: 'owner' });
    assert.deepEqual(precisionBreakdown(db), {
      byLane: { diff: { kept: 1, dismissed: 1, precision: 0.5 }, structure: { kept: 1, dismissed: 0, precision: 1 } },
      byRule: { 'correctness:diff': { kept: 1, dismissed: 1, precision: 0.5 }, 'maintainability:structure': { kept: 1, dismissed: 0, precision: 1 } },
    });
  });
});

test('a finding recorded without ruleId is placed by ruleIdFor, and both breakdowns place one finding identically', () => {
  withDb((db) => {
    const runId = labelledRun(db);
    const row = db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(runId);
    const parsed = JSON.parse(row.output_json);
    delete parsed.findings[0].ruleId;
    db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?').run(JSON.stringify(parsed), runId);
    recordFeedback(db, { findingRef: 'rv_01', action: 'keep', actor: 'owner' });
    recordFeedback(db, { findingRef: 'rv_02', action: 'dismiss', actor: 'owner' });
    // The structure lane is recorded first, so sorted keys differ from insertion order.
    for (const id of ['rv_02', 'rv_01']) strong(db, runId, id, 'fixed');
    const precision = precisionBreakdown(db);
    const posted = postedBreakdown(db);
    assert.deepEqual(precision.byRule['correctness:diff'], { kept: 1, dismissed: 0, precision: 1 });
    assert.deepEqual(Object.keys(precision.byRule), Object.keys(posted.byRule));
    assert.deepEqual(Object.keys(precision.byLane), Object.keys(posted.byLane));
    assert.deepEqual(Object.keys(posted.byRule), ['correctness:diff', 'maintainability:structure']);
  });
});

// AC-3: rule effectiveness since approval

const RULE = 'maintainability:diff';
const suppressRule = (scope) => ({
  scope, glob: null, kind: 'suppress', category: 'maintainability', ruleId: RULE, rule: 'Suppress maintainability findings.',
  evidence: { keeps: 0, dismissals: 3, rewrites: 0, ownerSignals: 3, contradictingSignals: 0, mostRecentAt: '2026-10-01T00:00:00Z', eventIds: [] },
  confidence: 0.9, activatable: true, blockedBecause: null,
});
const approve = (db, scope = { type: 'global', key: 'owner' }) => {
  const stored = proposePolicy(db, [suppressRule(scope)], scope);
  const result = approvePolicy(db, stored.policyId);
  assert.equal(result.ok, true, result.error);
  return stored.policyId;
};
const heldBy = (ruleId) => `${POLICY_SUPPRESSED_PREFIX}${ruleId}`;
/** One finding of the rule, `held` entries the suppression held, one held by another rule and one eligible. */
const ruleRun = (db, held, createdAt) => {
  const scores = Array.from({ length: held }, (_, i) => ({ candidate_id: `h${i}`, eligible: false, rejectedBecause: heldBy(RULE) }));
  scores.push({ candidate_id: 'other', eligible: false, rejectedBecause: heldBy('other:diff') }, { candidate_id: 'kept', eligible: true });
  const { reviewRunId } = recordRun(db, { ...base, output: finding(1, 'A'), candidates: [candidate(1, 'maintainability', 'diff')], scores, stages: [{ name: 'analyst', seconds: 9 }] });
  if (createdAt !== undefined) setCreatedAt(db, reviewRunId, createdAt);
  return reviewRunId;
};
const afterApproval = (approvedAt) => new Date(Date.parse(approvedAt) + 60_000).toISOString();

/** A store with one approved suppression, a run before it, one at the approval time and one after. */
function seedEffectiveness(db) {
  const before = ruleRun(db, 5, '2026-01-01T00:00:00.000Z');
  strong(db, before, 'rv_01', 'dismissed');
  recordFeedback(db, { findingRef: `${before}:rv_01`, action: 'dismiss', actor: 'owner' });
  approve(db);
  const approvedAt = activePolicyRows(db)[0].approvedAt;
  const after1 = ruleRun(db, 2, approvedAt);
  const after2 = ruleRun(db, 1, afterApproval(approvedAt));
  strong(db, after1, 'rv_01', 'fixed');
  strong(db, after2, 'rv_01', 'open');
  recordFeedback(db, { findingRef: `${after1}:rv_01`, action: 'keep', actor: 'owner' });
  return { approvedAt };
}

test('ruleEffectiveness counts held, runs, posted outcomes and owner labels from runs since approval only', () => {
  withDb((db) => {
    assert.deepEqual(ruleEffectiveness(db), []);
    const { approvedAt } = seedEffectiveness(db);
    assert.match(approvedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(ruleEffectiveness(db), [
      {
        rule_id: RULE,
        suppressions: [{ glob: null, policy_version: 1 }],
        approved_at: approvedAt,
        held: 3,
        runs: 2,
        posted: { tracked: 2, fixed: 1, dismissed: 0, fixedRate: 1, dismissedRate: 0 },
        feedback: { kept: 1, dismissed: 0, precision: 1 },
        basis: `3 held in 2 run(s) since ${approvedAt}; posted outcomes count strong ones only`,
      },
    ]);
    // A run since approval whose output will not parse or has no scores array is skipped and not counted in runs.
    const [noScores, notJson] = [ruleRun(db, 7, afterApproval(approvedAt)), ruleRun(db, 7, afterApproval(approvedAt))];
    const setOutput = db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?');
    setOutput.run('{"output":""}', noScores);
    setOutput.run('not json', notJson);
    assert.deepEqual(ruleEffectiveness(db).map((entry) => [entry.held, entry.runs]), [[3, 2]]);
    // A global and a path scope naming one rule give one entry listing both.
    approve(db, { type: 'path', key: 'src/**' });
    const [entry, ...rest] = ruleEffectiveness(db);
    assert.deepEqual(rest, []);
    assert.deepEqual(entry.suppressions, [{ glob: null, policy_version: 1 }, { glob: 'src/**', policy_version: 1 }]);
    assert.equal(entry.approved_at, approvedAt);
    assert.deepEqual(activeSuppressions(db).map((s) => [s.scopeType, s.glob, s.approvedAt !== null]), [['global', null, true], ['path', 'src/**', true]]);
  });
});

test('postedBreakdown with since excludes a run aged before it, and without since is unchanged', () => {
  withDb((db) => {
    const { approvedAt } = seedEffectiveness(db);
    const all = postedBreakdown(db);
    assert.equal(all.byRule[RULE].tracked, 3);
    assert.equal(all.byRule[RULE].dismissed, 1);
    assert.deepEqual(postedBreakdown(db, {}), all);
    const since = postedBreakdown(db, { since: approvedAt });
    assert.deepEqual(since.byRule[RULE], { tracked: 2, fixed: 1, dismissed: 0, fixedRate: 1, dismissedRate: 0 });
    assert.deepEqual(since.byLane.diff, since.byRule[RULE]);
    assert.deepEqual(precisionBreakdown(db).byRule[RULE], { kept: 1, dismissed: 1, precision: 0.5 });
  });
});

test('a suppression approved after every recorded run has runs 0 and null held', () => {
  withDb((db) => {
    const run = ruleRun(db, 4, '2026-01-01T00:00:00.000Z');
    strong(db, run, 'rv_01', 'fixed');
    approve(db);
    const [entry] = ruleEffectiveness(db);
    assert.equal(entry.runs, 0);
    assert.equal(entry.held, null);
    assert.equal(entry.posted, null);
    assert.equal(entry.feedback, null);
    assert.equal(entry.basis, `no run recorded since ${entry.approved_at}`);
  });
});

/** An active version 7 row written straight to the store, suppressing each rule id everywhere. */
const insertDirect = (db, ruleIds, approvedAt) =>
  db.prepare(
    `INSERT INTO policies (policy_id, scope_type, scope_key, version, content_yaml, active, generated_at, approved_at, provenance_json, evaluation_json)
     VALUES ('direct', 'global', 'owner', 7, ?, 1, '2026-11-08T00:00:00.000Z', ?, '[]', '{}')`,
  ).run(
    ['policy_version: 7', 'scope:', '  type: global', '  key: owner', '', 'suppressed_patterns:', '  - "x"', '', 'suppressions:', ...ruleIds.flatMap((id) => [`  - rule_id: "${id}"`, '    glob: null', '    reason: "r"']), ''].join('\n'),
    approvedAt,
  );

test('an active row with no approved_at gives nulls and a basis naming the version', () => {
  withDb((db) => {
    ruleRun(db, 2);
    insertDirect(db, [RULE], null);
    assert.equal(activePolicyRows(db)[0].approvedAt, null);
    assert.deepEqual(ruleEffectiveness(db), [
      {
        rule_id: RULE,
        suppressions: [{ glob: null, policy_version: 7 }],
        approved_at: null,
        held: null,
        runs: null,
        posted: null,
        feedback: null,
        basis: 'no approval time recorded for policy version 7; nothing counted',
      },
    ]);
  });
});

// AC-4: the shared formatting helpers

test('formatMetricValue, metricMark and metricTarget follow the text rules', () => {
  const m = (over) => ({ name: 'x', value: 0.5, target: '>= 0.80', meets: true, basis: 'b', kind: 'gate', ...over });
  assert.equal(formatMetricValue(m({ name: 'posted_findings_tracked', value: 7 })), '7');
  assert.equal(formatMetricValue(m({ value: 7 })), '7.00');
  assert.equal(formatMetricValue(m({ value: 0.5 })), '0.50');
  assert.equal(formatMetricValue(m({ value: null })), 'no data');
  assert.equal(metricMark(m({ value: null, meets: null })), '-');
  assert.equal(metricMark(m({ target: 'no target' })), '-');
  assert.equal(metricMark(m({})), 'ok');
  assert.equal(metricMark(m({ meets: false, kind: 'goal' })), 'over');
  assert.equal(metricMark(m({ meets: false })), 'FAIL');
  assert.equal(metricTarget(m({ target: 'no target' })), 'reported, not scored');
  assert.equal(metricTarget(m({ target: '<= 28', kind: 'goal' })), 'goal <= 28');
  assert.equal(metricTarget(m({})), 'target >= 0.80');
  const source = readFileSync(join(root, 'plugins/review-voice/src/cli/evaluate.ts'), 'utf8');
  for (const name of ['formatMetricValue', 'metricMark', 'metricTarget']) assert.ok(source.includes(`${name}(metric)`), `evaluateCommand calls ${name}`);
});

// AC-5 and AC-6: the renderer

const ALLOWED = new Set(['h2', 'h3', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'details', 'summary']);
const SECTIONS = ['<h3>Gates</h3>', '<h3>Goals</h3>', '<h3>Reported, not scored</h3>', '<h3>Seconds by stage</h3>', '<h3>Posted findings</h3>', '<h3>Owner labels</h3>', '<h3>Suppressions since approval</h3>'];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const between = (html, from, to) => html.slice(html.indexOf(from), to === undefined ? undefined : html.indexOf(to));
const reportOf = (db) => evaluationReport(db, [...computeMetrics(db), ...recallMetrics(null)], { now: () => new Date('2026-11-09T12:00:00Z') });

function assertSections(html) {
  let at = html.indexOf('<h2>Review Voice evaluation</h2>');
  assert.equal(at, 0);
  for (const heading of SECTIONS) {
    const next = html.indexOf(heading);
    assert.ok(next > at, `${heading} follows in order`);
    at = next;
  }
  for (const [, name, attributes] of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    assert.ok(ALLOWED.has(name), `element ${name} is allowed`);
    assert.equal(attributes, '', `${name} carries no attribute`);
  }
}

test('renderEvaluationHtml on a seeded store prints the eight sections, each metric in its own table as the text helpers print it, and only allowed elements', () => {
  withDb((db) => {
    seedEffectiveness(db);
    const report = reportOf(db);
    const html = renderEvaluationHtml(report);
    assertSections(html);
    assert.equal(renderEvaluationHtml(report), html);
    assert.ok(html.includes('<p>Generated at 2026-11-09T12:00:00.000Z; the recent posted rates cover the last 30 days. A figure with no data prints no data, never zero. A gate is a contract; a goal and a reported figure are never failed.</p>'));
    // A gate or goal with a target sits under its kind; every figure with no target is reported.
    const tables = {
      gate: between(html, '<h3>Gates</h3>', '<h3>Goals</h3>'),
      goal: between(html, '<h3>Goals</h3>', '<h3>Reported, not scored</h3>'),
      reported: between(html, '<h3>Reported, not scored</h3>', '<h3>Seconds by stage</h3>'),
    };
    for (const metric of report.metrics) {
      const where = metric.target === 'no target' ? 'reported' : metric.kind;
      const row = `<tr><td>${esc(metric.name)}</td><td>${esc(formatMetricValue(metric))}</td><td>${metricMark(metric)}</td><td>${esc(metricTarget(metric))}</td><td>${esc(metric.basis)}</td></tr>`;
      assert.ok(tables[where].includes(row), `${metric.name} under ${where}`);
    }
    // The three tables partition the metrics.
    const metricRows = between(html, '<h3>Gates</h3>', '<h3>Seconds by stage</h3>').match(/<tr><td>/g).length;
    assert.equal(metricRows, report.metrics.length);
    assert.ok(between(html, '<h3>Seconds by stage</h3>', '<h3>Posted findings</h3>').includes('<tr><td>analyst</td><td>9.00</td><td>9.00</td><td>3</td><td>0</td></tr>'));
    // Sections 6 and 7 whole, so a missing, reordered or relabelled table fails.
    const tableOf = (headers, rows) =>
      `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>\n<tbody>\n${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>\n`).join('')}</tbody></table>\n`;
    const outcomes = ['tracked', 'fixed', 'dismissed', 'fixed rate', 'dismissed rate'];
    const seen = ['3', '1', '1', '0.50', '0.50'];
    // A block with nothing tracked has null rates, printed as no data and never 0.00.
    const none = ['0', '0', '0', 'no data', 'no data'];
    assert.equal(
      between(html, '<h3>Posted findings</h3>', '<h3>Owner labels</h3>'),
      '<h3>Posted findings</h3>\n<p>Rates count strong outcomes only; a weak outcome is tracked and not counted.</p>\n' +
        tableOf(['severity', ...outcomes], [['minor', ...seen]]) +
        tableOf(['lane', ...outcomes], [['diff', ...seen]]) +
        tableOf(['rule', ...outcomes], [[RULE, ...seen]]) +
        tableOf(['evidence block', ...outcomes], [['with', ...none], ['without', ...none], ['unknown', ...seen]]),
    );
    const labelHeaders = (key) => [key, 'kept', 'dismissed', 'precision'];
    assert.equal(
      between(html, '<h3>Owner labels</h3>', '<h3>Suppressions since approval</h3>'),
      '<h3>Owner labels</h3>\n<p>Unlabelled findings are excluded; silence is never a label.</p>\n' +
        tableOf(labelHeaders('lane'), [['diff', '1', '1', '0.50']]) +
        tableOf(labelHeaders('rule'), [[RULE, '1', '1', '0.50']]),
    );
    const since = between(html, '<h3>Suppressions since approval</h3>');
    assert.ok(since.includes(`<tr><td>${RULE}</td><td>everywhere (v1)</td><td>${report.rule_effectiveness[0].approved_at}</td><td>3</td><td>2</td><td>1</td><td>0</td><td>1</td><td>0</td><td>`));
  });
});

test('on the empty store every section is present, every metric value is no data, and sections 5 to 8 print no table', () => {
  withDb((db) => {
    const html = renderEvaluationHtml(reportOf(db));
    assertSections(html);
    const metricTables = between(html, '<h3>Gates</h3>', '<h3>Seconds by stage</h3>');
    const values = [...metricTables.matchAll(/<tr><td>[^<]*<\/td><td>([^<]*)<\/td>/g)].map((m) => m[1]);
    assert.ok(values.length > 10);
    assert.ok(values.every((value) => value === 'no data'), values.join(','));
    // Each of sections 5 to 8 is exactly its heading and one no data paragraph.
    const empty = [
      ['Seconds by stage', 'Posted findings', 'no run has recorded stage timings'],
      ['Posted findings', 'Owner labels', 'no posted finding has a recorded outcome'],
      ['Owner labels', 'Suppressions since approval', 'no finding has been labelled'],
      ['Suppressions since approval', undefined, 'no approved suppression is active'],
    ];
    for (const [heading, next, reason] of empty) {
      assert.equal(between(html, `<h3>${heading}</h3>`, next && `<h3>${next}</h3>`), `<h3>${heading}</h3>\n<p>no data; ${reason}</p>\n`);
    }
    assert.doesNotMatch(html, /\b0\.00\b/);
  });
});

test('a suppressed rule id named like an Object.prototype member has null posted and feedback, printed as no data', () => {
  withDb((db) => {
    const ids = ['__proto__', 'constructor', 'toString'];
    insertDirect(db, ids, '2026-11-08T00:00:00.000Z');
    ruleRun(db, 0, '2026-11-09T00:00:00.000Z');
    const report = reportOf(db);
    assert.deepEqual(report.rule_effectiveness.map((entry) => [entry.rule_id, entry.runs, entry.posted, entry.feedback]), ids.map((id) => [id, 1, null, null]));
    const html = renderEvaluationHtml(report);
    for (const id of ids) {
      assert.ok(html.includes(`<tr><td>${id}</td><td>everywhere (v7)</td><td>2026-11-08T00:00:00.000Z</td><td>0</td><td>1</td><td>no data</td><td>no data</td><td>no data</td><td>no data</td>`), id);
    }
    assert.doesNotMatch(html, /undefined/);
  });
});

test('strings from the store are cut at 120 code points, lose their line endings and are then escaped, whole entities only', () => {
  const none = { tracked: 0, fixed: 0, dismissed: 0, fixedRate: null, dismissedRate: null };
  const stats = { tracked: 1, fixed: 1, dismissed: 0, fixedRate: 1, dismissedRate: 0 };
  const longRule = `${'r'.repeat(117)}&${'z'.repeat(10)}`;
  // An astral character is two UTF-16 units, so a cut by code unit would differ.
  const point = '\u{1D6FC}';
  const stage = point.repeat(200);
  // A blank line would end the HTML block in a job summary and the rest of the cell would render as Markdown.
  const markdown = 'x\r\n\n[evil](https://example.com) ![p](https://example.com/p.png)\n\ny';
  const html = renderEvaluationHtml({
    generated_at: '2026-11-09T00:00:00.000Z',
    window_days: 30,
    metrics: [],
    posted_breakdown: { by_severity: {}, by_lane: { '<script>alert(1)</script>': stats, [markdown]: stats }, by_rule: { 'a&b"c\'d': stats, [longRule]: stats }, by_evidence_block: { with: none, without: none, unknown: none } },
    // Kept differs from dismissed, so swapped columns fail.
    precision_breakdown: { by_lane: { structure: { kept: 3, dismissed: 1, precision: 0.75 } }, by_rule: { 'maintainability:structure': { kept: 0, dismissed: 2, precision: 0 } } },
    stage_seconds: { [stage]: { median: 1, p95: 2, runs: 3, unmeasured: 4 } },
    rule_effectiveness: [{ rule_id: 'x:diff', suppressions: [{ glob: 'src/<x>/**', policy_version: 1 }], approved_at: null, held: null, runs: null, posted: null, feedback: null, basis: 'b' }],
  });
  assertSections(html);
  assert.ok(html.includes('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>'));
  assert.doesNotMatch(html, /<script/);
  // The whole row, so swapped fixed and dismissed columns fail.
  assert.ok(html.includes('<tr><td>a&amp;b&quot;c&#39;d</td><td>1</td><td>1</td><td>0</td><td>1.00</td><td>0.00</td></tr>'));
  assert.ok(html.includes('<td>src/&lt;x&gt;/** (v1)</td>'));
  assert.ok(html.includes('<td>x [evil](https://example.com) ![p](https://example.com/p.png) y</td>'));
  assert.doesNotMatch(html, /\n[ \t]*\n/);
  // The whole row, so swapped median and p95 columns fail.
  assert.ok(html.includes(`<tr><td>${point.repeat(120)}...</td><td>1.00</td><td>2.00</td><td>3</td><td>4</td></tr>`));
  assert.ok(!html.includes(point.repeat(121)));
  assert.ok(html.includes(`<td>${'r'.repeat(117)}&amp;zz...</td>`));
  assert.doesNotMatch(html, /&(?!amp;|lt;|gt;|quot;|#39;)/);
  // With no metric, each metric section is its heading and one no data paragraph, never an empty table.
  for (const [heading, next] of [['Gates', 'Goals'], ['Goals', 'Reported, not scored'], ['Reported, not scored', 'Seconds by stage']]) {
    assert.equal(between(html, `<h3>${heading}</h3>`, `<h3>${next}</h3>`), `<h3>${heading}</h3>\n<p>no data; no metric of this kind</p>\n`);
  }
  const labels = between(html, '<h3>Owner labels</h3>', '<h3>Suppressions since approval</h3>');
  assert.ok(labels.includes('<tr><td>structure</td><td>3</td><td>1</td><td>0.75</td></tr>'));
  assert.ok(labels.includes('<tr><td>maintainability:structure</td><td>0</td><td>2</td><td>0.00</td></tr>'));
  // Every null prints no data: the all-null suppression row and the rates of a block with nothing tracked.
  assert.ok(html.includes('<tr><td>x:diff</td><td>src/&lt;x&gt;/** (v1)</td><td>no data</td><td>no data</td><td>no data</td><td>no data</td><td>no data</td><td>no data</td><td>no data</td><td>b</td></tr>'));
  assert.ok(html.includes('<tr><td>without</td><td>0</td><td>0</td><td>0</td><td>no data</td><td>no data</td></tr>'));
});

test('htmlDocument wraps the fragment in a static page with an escaped title', () => {
  const page = htmlDocument('<h2>x</h2>\n', 'A & B');
  assert.ok(page.startsWith('<!doctype html>\n<html lang="en">'));
  assert.ok(page.includes('<meta charset="utf-8">'));
  assert.ok(page.includes('<title>A &amp; B</title>'));
  assert.ok(page.includes('<body>\n<h2>x</h2>\n</body>'));
  assert.doesNotMatch(page, /<script|<link|<img|@import|url\(| on[a-z]+=/);
});

// AC-7: through the bundle

function cli(args, dataDir) {
  const result = spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir } });
  // Node prints its own experimental warnings on stderr; the command's lines are what is asserted.
  const stderr = result.stderr.split('\n').filter((line) => !/ExperimentalWarning|--trace-warnings/.test(line)).join('\n');
  return { code: result.status, stdout: result.stdout, stderr };
}

/** Seeds a store in a fresh data directory, runs `fn` against the bundle, removes it. */
function withStore(seed, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-eval-report-cli-'));
  try {
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      seed(db);
    } finally {
      db.close();
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RESULTS = {
  pluginVersion: '9.9.9',
  mode: 'auto',
  runner: 'fake',
  fixtures: [
    { name: 'positive/a', class: 'positive', hit: true, lineDelta: 0, exitCode: 0 },
    { name: 'positive/b', class: 'positive', hit: false, lineDelta: 5, exitCode: 0 },
  ],
  summary: { keyBugRecall: 0.5, causalLineHit: 0.5, cleanSilence: null, positives: 2, skipped: 0, cleanFixtures: 0, failedRuns: 0 },
};

test('evaluate --html prints the fragment, --out writes the page, and bad invocations exit 2 before the store opens', () => {
  withStore(seedEffectiveness, (dir) => {
    const html = cli(['evaluate', '--html'], dir);
    assert.equal(html.code, 0, html.stderr);
    assert.equal(html.stderr, '');
    assert.ok(html.stdout.startsWith('<h2>Review Voice evaluation</h2>\n'));
    assertSections(html.stdout);

    const target = join(dir, 'sub', 'report.html');
    const out = cli(['evaluate', '--html', '--out', target], dir);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, '');
    const page = readFileSync(target, 'utf8');
    assert.ok(page.startsWith('<!doctype html>'));
    assert.ok(page.includes('<meta charset="utf-8">'));
    assert.ok(page.includes('<title>Review Voice evaluation</title>'));
    // Generated at differs between the two invocations; everything after it is the fragment.
    assert.ok(page.includes(html.stdout.slice(html.stdout.indexOf('<h3>Gates</h3>')).trimEnd()));
    const asDir = cli(['evaluate', '--html', '--out', join(dir, 'pages/')], dir);
    assert.equal(asDir.code, 0, asDir.stderr);
    assert.ok(existsSync(join(dir, 'pages', 'evaluation.html')));

    const never = join(dir, 'never');
    const both = cli(['evaluate', '--json', '--html'], never);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /^--json and --html are exclusive\.$/m);
    assert.equal(existsSync(never), false);
    const outOnly = cli(['evaluate', '--out', 'x.html'], never);
    assert.equal(outOnly.code, 2);
    assert.match(outOnly.stderr, /^--out needs --html\.$/m);
    assert.equal(existsSync(never), false);
    assert.equal(cli(['evaluate', '--html', '--out'], never).code, 2);
    assert.equal(existsSync(never), false);

    const file = join(dir, 'plain.txt');
    writeFileSync(file, 'x');
    const under = cli(['evaluate', '--html', '--out', join(file, 'sub', 'report.html')], dir);
    assert.equal(under.code, 2);
    assert.match(under.stderr, /^Cannot write .*: expected a file path or a directory; /m);

    const week = cli(['evaluate', '--html', '--since', '7d'], dir);
    assert.equal(week.code, 0, week.stderr);
    assert.ok(week.stdout.includes('the recent posted rates cover the last 7 days.'));

    const results = join(dir, 'results.json');
    writeFileSync(results, JSON.stringify(RESULTS));
    const recall = cli(['evaluate', '--html', '--recall', results], dir);
    assert.equal(recall.code, 0, recall.stderr);
    const reported = between(recall.stdout, '<h3>Reported, not scored</h3>', '<h3>Seconds by stage</h3>');
    for (const name of ['fixture_key_bug_recall', 'fixture_causal_line_hit', 'fixture_clean_silence']) assert.ok(reported.includes(`<tr><td>${name}</td>`), name);
    assert.ok(reported.includes('<tr><td>fixture_key_bug_recall</td><td>0.50</td>'));
  });
});

// AC-1: the JSON shape and the unchanged text

test('evaluate --json prints the EvaluationReport shape, with every key equal to what its function returns', () => {
  withStore(seedEffectiveness, (dir) => {
    const result = cli(['evaluate', '--json'], dir);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(parsed), ['generated_at', 'window_days', 'metrics', 'posted_breakdown', 'precision_breakdown', 'stage_seconds', 'rule_effectiveness', 'by_family']);
    assert.match(parsed.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(parsed.window_days, 30);
    assert.equal(JSON.parse(cli(['evaluate', '--json', '--since', '7d'], dir).stdout).window_days, 7);
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      const { bySeverity, byLane, byRule, byEvidenceBlock } = postedBreakdown(db);
      assert.deepEqual(parsed.posted_breakdown, { by_severity: bySeverity, by_lane: byLane, by_rule: byRule, by_evidence_block: byEvidenceBlock });
      const precision = precisionBreakdown(db);
      assert.deepEqual(parsed.precision_breakdown, { by_lane: precision.byLane, by_rule: precision.byRule });
      assert.deepEqual(parsed.rule_effectiveness, ruleEffectiveness(db));
      assert.deepEqual(parsed.by_family, byFamily(db));
      assert.deepEqual(parsed.stage_seconds, { analyst: { median: 9, p95: 9, runs: 3, unmeasured: 0 } });
      assert.deepEqual(parsed.metrics.map((m) => m.name), [...computeMetrics(db), ...recallMetrics(null)].map((m) => m.name));
    } finally {
      db.close();
    }
  });
});

test('the text output prints a metric marked - and one marked ok exactly as before', () => {
  withStore(
    (db) => recordRun(db, { ...base, output: '[blocking] `src/a.ts:8` - Token returned before commit. A retry mints two. Commit first.' }),
    (dir) => {
      const result = cli(['evaluate'], dir);
      assert.equal(result.code, 0, result.stderr);
      const lines = result.stdout.split('\n');
      const at = (text) => lines.indexOf(text);
      assert.ok(at('  ok  contract_compliance                  1.00  target = 1.00') >= 0, result.stdout);
      assert.equal(lines[at('  ok  contract_compliance                  1.00  target = 1.00') + 1], '      1/1 recorded outputs pass validate-output');
      assert.ok(at('  -  median_findings_per_review           1.00  reported, not scored') >= 0, result.stdout);
      assert.equal(lines[at('  -  median_findings_per_review           1.00  reported, not scored') + 1], '      1 runs; a count reflects the diff, not the reviewer');
      assert.doesNotMatch(result.stdout, /<h2>|rule_effectiveness|precision_breakdown/);
    },
  );
});

// AC-8: help and documentation

test('evaluate --help lists --html and --out and the docs name the report', () => {
  const help = commandHelp('evaluate');
  assert.match(help, /--html/);
  assert.match(help, /--out <path>/);
  assert.match(help, /Exit codes: 0 ok, 2 bad invocation\./);
  const evaluation = readFileSync(join(root, 'docs/EVALUATION.md'), 'utf8');
  assert.ok(evaluation.includes('--html'));
  assert.ok(evaluation.includes('rule_effectiveness'));
  assert.ok(evaluation.includes('precision_breakdown'));
  assert.ok(readFileSync(join(root, 'docs/ACTION.md'), 'utf8').includes('evaluate --html'));
});

test('a rule whose only posted outcomes since approval are weak reports no data, not measured zeros', () => {
  withDb((db) => {
    approve(db);
    const approvedAt = activePolicyRows(db)[0].approvedAt;
    const run = ruleRun(db, 1, afterApproval(approvedAt));
    strong(db, run, 'rv_01', 'open');
    const [entry] = ruleEffectiveness(db);
    assert.equal(entry.posted, null);
    const html = renderEvaluationHtml(evaluationReport(db, computeMetrics(db), {}));
    const section = html.slice(html.indexOf('<h3>Suppressions since approval</h3>'));
    const row = section.slice(section.indexOf(`<td>${RULE}</td>`), section.indexOf('</tr>', section.indexOf(`<td>${RULE}</td>`)));
    assert.ok(row.length > 0, section);
    assert.ok(!/<td>0<\/td>/.test(row.split('</td>').slice(4).join('</td>')), `weak-only outcomes rendered as measured zeros: ${row}`);
    assert.match(row, /no data/);
  });
});
