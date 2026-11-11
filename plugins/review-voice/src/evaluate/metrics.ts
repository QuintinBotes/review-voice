import type { Database } from '../store/db.ts';
import { validateOutput } from '../contract/validate.ts';
import { DEFAULT_LIMITS } from '../contract/limits.ts';
import { countWords } from '../contract/words.ts';
import { splitFindings, parseFinding } from '../contract/parse.ts';
import { hashDiff, storedFamilies } from '../store/runs.ts';
import { FAMILIES } from '../agents/types.ts';
import { postedBreakdown, postedStats, precisionBreakdown, type PostedStats, type PrecisionStats } from '../store/outcomes.ts';
import { activeSuppressions } from '../policy/versions.ts';
import { POLICY_SUPPRESSED_PREFIX } from '../scoring/score.ts';

export interface Metric {
  name: string;
  value: number | null;
  target: string;
  meets: boolean | null;
  /** How the number was arrived at, so a passing metric can be checked. */
  basis: string;
  /**
   * `gate` is a contract the reviewer must meet. `goal` is something to aim
   * at, reported but never failed.
   *
   * The two used to be reported identically, which produced a standing
   * failure on `median_words_per_finding`: the target said 28 while the
   * contract the validator enforces says 40, so every compliant review failed
   * a metric it had not broken. A number that cannot be met by following the
   * rules is not a target, it is a mislabelled aspiration.
   */
  kind: 'gate' | 'goal';
}

/**
 * How the text output and the rendered report print one figure: the same three
 * rules in one place, so the two can never disagree.
 */
export function formatMetricValue(metric: Metric): string {
  if (metric.value === null) return 'no data';
  return Number.isInteger(metric.value) && metric.name.endsWith('_tracked') ? String(metric.value) : metric.value.toFixed(2);
}

/** A goal that is not met is not a failure, and printing it as one trains the reader to ignore the word. */
export function metricMark(metric: Metric): 'ok' | 'FAIL' | 'over' | '-' {
  if (metric.meets === null || metric.target === 'no target') return '-';
  if (metric.meets) return 'ok';
  return metric.kind === 'goal' ? 'over' : 'FAIL';
}

export function metricTarget(metric: Metric): string {
  if (metric.target === 'no target') return 'reported, not scored';
  return `${metric.kind === 'goal' ? 'goal' : 'target'} ${metric.target}`;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? null;
}

function median(values: number[]): number | null {
  return percentile(values, 50);
}

interface RunRow {
  output_json: string;
}

/**
 * The window the rolling posted rates and the `status` warning use when the
 * caller names none. Thirty days is long enough to hold a useful number of
 * strong outcomes on a quiet repository and short enough that a change to the
 * reviewer shows up in it.
 */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Above this share of dismissed strong outcomes, `status` warns. The product
 * specification this programme draws on alerts when the invalid-comment rate on
 * human dismissals exceeds 20%; that figure is a starting point, not a measured
 * optimum, and moves when real windows say otherwise.
 */
export const DISMISSED_RATE_WARNING_THRESHOLD = 0.2;

/**
 * Fewest strong outcomes in the window before the warning can fire. Three
 * dismissals of four is 75% and means nothing; ten is a starting point chosen
 * so one reply cannot swing the rate by more than ten points.
 */
export const DISMISSED_RATE_WARNING_MIN_STRONG = 10;

/**
 * The `status` line for a dismissed rate over the threshold, or null.
 *
 * Pure so the boundary is testable: the rate must be strictly above the
 * threshold (exactly 20% is quiet) and the window must hold at least the
 * minimum of strong outcomes. Nothing is said below that, because a warning
 * from three outcomes would be noise the reader learns to ignore.
 */
export function dismissedRateWarning(input: { dismissed: number; strong: number; windowDays: number }): string | null {
  const { dismissed, strong, windowDays } = input;
  if (strong < DISMISSED_RATE_WARNING_MIN_STRONG) return null;
  const rate = dismissed / strong;
  if (!(rate > DISMISSED_RATE_WARNING_THRESHOLD)) return null;
  return (
    `Warning: ${dismissed} of ${strong} posted findings in the last ${windowDays} days were dismissed ` +
    `(${(rate * 100).toFixed(0)}%); run \`review-voice explain\` on the dismissed ones and consider /review-voice:feedback.`
  );
}

export interface ComputeOptions {
  /** Days the `_recent` posted rates look back; default 30. */
  windowDays?: number;
  now?: () => Date;
}

/** The ISO time `days` before now, the form `review_runs.created_at` is stored in. */
export function windowStart(days: number, now: () => Date = () => new Date()): string {
  return new Date(now().getTime() - days * 86_400_000).toISOString();
}

interface ParsedStage {
  name: string | null;
  seconds: number;
  cost: number | null;
}

/** The stages of one stored `stages_json`, or null when it will not parse. */
function parseStages(raw: string | null): ParsedStage[] | null {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map((stage: unknown): ParsedStage => {
    const record = typeof stage === 'object' && stage !== null ? (stage as Record<string, unknown>) : {};
    const seconds = record['seconds'];
    const cost = record['costUsd'];
    return {
      name: typeof record['name'] === 'string' ? record['name'] : null,
      // A non-finite duration contributes nothing, as it always has.
      seconds: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0,
      cost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    };
  });
}

function storedStages(db: Database): (ParsedStage[] | null)[] {
  const rows = db.prepare('SELECT stages_json FROM review_runs').all() as unknown as { stages_json: string | null }[];
  return rows.map((row) => parseStages(row.stages_json));
}

/**
 * Seconds per stage across runs: for each stage name, the median and 95th
 * percentile of the time that stage took in a run (summed when a run names it
 * twice) and the number of runs that recorded it.
 *
 * Not a `Metric`: its value is a map, and the tests that walk every metric
 * assert a number or null. `evaluate --json` carries it beside the metrics.
 */
export function stageSeconds(db: Database): Record<string, { median: number; p95: number; runs: number }> {
  const byName = new Map<string, number[]>();
  for (const stages of storedStages(db)) {
    if (stages === null) continue;
    const inRun = new Map<string, number>();
    for (const stage of stages) {
      if (stage.name === null) continue;
      inRun.set(stage.name, (inRun.get(stage.name) ?? 0) + stage.seconds);
    }
    for (const [name, total] of inRun) {
      // As with a whole run, zero seconds is an unmeasured stage.
      if (total > 0) byName.set(name, [...(byName.get(name) ?? []), total]);
    }
  }
  return Object.fromEntries(
    [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, values]) => [name, { median: median(values) as number, p95: percentile(values, 95) as number, runs: values.length }]),
  );
}

/**
 * Per-review cost over costed runs. A run is costed when it recorded at least
 * one stage and every stage carries a numeric `costUsd`; the slash command's
 * stages carry no cost at all, and an agent that reported none leaves the key
 * absent. Summing the stages that happen to have one would understate a run.
 */
function runCosts(db: Database): { costs: number[]; excluded: number } {
  const costs: number[] = [];
  let excluded = 0;
  for (const stages of storedStages(db)) {
    if (stages === null || stages.length === 0 || stages.some((stage) => stage.cost === null)) {
      excluded += 1;
      continue;
    }
    costs.push(stages.reduce((sum, stage) => sum + (stage.cost as number), 0));
  }
  return { costs, excluded };
}

/**
 * Held and judged counts from `output_json.scores[]`. An entry the challenger
 * judged carries a `challenge` key, and one it held also has a
 * `rejectedBecause` starting `challenge-`. The `held` array and the stage list
 * are not consulted, so held can never exceed judged.
 */
function challengeCounts(db: Database): { held: number; judged: number; runs: number } {
  const rows = db.prepare('SELECT output_json FROM review_runs').all() as unknown as RunRow[];
  let held = 0;
  let judged = 0;
  let runs = 0;
  for (const row of rows) {
    const counts = challengeOf(row.output_json);
    if (counts.judged === 0) continue;
    held += counts.held;
    judged += counts.judged;
    runs += 1;
  }
  return { held, judged, runs };
}

/** One run's judged and held counts, as challengeCounts reads them; zero for a row that will not parse. */
function challengeOf(outputJson: string): { held: number; judged: number } {
  let scores: unknown;
  try {
    scores = (JSON.parse(outputJson) as { scores?: unknown } | null)?.scores;
  } catch {
    return { held: 0, judged: 0 };
  }
  let held = 0;
  let judged = 0;
  for (const entry of Array.isArray(scores) ? scores : []) {
    if (typeof entry !== 'object' || entry === null || !Object.hasOwn(entry, 'challenge')) continue;
    judged += 1;
    const because = (entry as { rejectedBecause?: unknown }).rejectedBecause;
    if (typeof because === 'string' && because.startsWith('challenge-')) held += 1;
  }
  return { held, judged };
}

export interface FamilyFigures {
  second_pass: {
    verdicts: number;
    dropped: number;
    downgraded: number;
    tie_breaks: number;
    runs: number;
    drop_rate: number | null;
    downgrade_rate: number | null;
    tie_break_rate: number | null;
  } | null;
  challenge: { judged: number; held: number; runs: number; hold_rate: number | null } | null;
}

export interface ByFamily {
  /** Only families with data; a second pass recorded without a family is listed as `unknown`. */
  families: Record<string, FamilyFigures>;
  /** Runs recorded before families were stored, or without provenance. */
  runs_without_families: number;
}

/**
 * The second pass's and the challenger's figures per model family
 * (docs/adr/0034), grouped by the family each run recorded. Not a `Metric`,
 * since its value is a map, and every figure is reported, never a gate. A family
 * with no data for a half has null there, and one with neither is left out,
 * so nothing reads zero for an absence.
 */
export function byFamily(db: Database): ByFamily {
  const rows = db.prepare('SELECT review_run_id, output_json, provenance_json FROM review_runs').all() as unknown as {
    review_run_id: string;
    output_json: string;
    provenance_json: string | null;
  }[];
  const second = new Map<string, { verdicts: number; dropped: number; downgraded: number; tie_breaks: number; runs: number }>();
  const challenge = new Map<string, { judged: number; held: number; runs: number }>();
  let without = 0;
  const entries = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : [];
  for (const row of rows) {
    const families = storedFamilies(row.provenance_json, row.review_run_id);
    if (families === null) {
      without += 1;
      continue;
    }
    if (families.secondPass !== null) {
      let output: { verdicts?: unknown; tieBreaks?: unknown } = {};
      try {
        output = (JSON.parse(row.output_json) as typeof output | null) ?? {};
      } catch {
        // A row that will not parse adds a run with no verdicts.
      }
      const verdicts = entries(output.verdicts);
      const sum = second.get(families.secondPass) ?? { verdicts: 0, dropped: 0, downgraded: 0, tie_breaks: 0, runs: 0 };
      sum.verdicts += verdicts.length;
      sum.dropped += verdicts.filter((verdict) => verdict['outcome'] === 'dropped').length;
      sum.downgraded += verdicts.filter((verdict) => verdict['outcome'] === 'downgraded').length;
      sum.tie_breaks += entries(output.tieBreaks).filter((ruling) => ruling['applied'] === true).length;
      sum.runs += 1;
      second.set(families.secondPass, sum);
    }
    if (families.challenge !== null) {
      const counts = challengeOf(row.output_json);
      if (counts.judged > 0) {
        const sum = challenge.get(families.challenge) ?? { judged: 0, held: 0, runs: 0 };
        sum.judged += counts.judged;
        sum.held += counts.held;
        sum.runs += 1;
        challenge.set(families.challenge, sum);
      }
    }
  }
  const rate = (count: number, over: number): number | null => (over === 0 ? null : count / over);
  const listed = [...FAMILIES, 'unknown'].filter((name) => second.has(name) || challenge.has(name));
  return {
    families: Object.fromEntries(
      listed.map((name) => {
        const pass = second.get(name);
        const judged = challenge.get(name);
        const figures: FamilyFigures = {
          second_pass:
            pass === undefined
              ? null
              : {
                  ...pass,
                  drop_rate: rate(pass.dropped, pass.verdicts),
                  downgrade_rate: rate(pass.downgraded, pass.verdicts),
                  tie_break_rate: rate(pass.tie_breaks, pass.verdicts),
                },
          challenge: judged === undefined ? null : { ...judged, hold_rate: rate(judged.held, judged.judged) },
        };
        return [name, figures];
      }),
    ),
    runs_without_families: without,
  };
}

/** The `by family` block `evaluate` prints after the metrics. */
export function describeByFamily(figures: ByFamily): string[] {
  const names = Object.keys(figures.families);
  const before = figures.runs_without_families > 0 ? ` (${figures.runs_without_families} run(s) recorded before families were stored)` : '';
  if (names.length === 0) return [`by family  no data${before}`];
  const fixed = (value: number | null): string => (value === null ? 'no data' : value.toFixed(2));
  return [
    `by family${before}`,
    ...names.map((name) => {
      const { second_pass: pass, challenge } = figures.families[name]!;
      const second =
        pass === null
          ? 'second pass no data'
          : `second pass ${pass.verdicts} verdicts, drop ${fixed(pass.drop_rate)}, downgrade ${fixed(pass.downgrade_rate)}, tie-break ${fixed(pass.tie_break_rate)}, ${pass.runs} run(s)`;
      const challenged = challenge === null ? 'challenge no data' : `challenge ${challenge.judged} judged, hold ${fixed(challenge.hold_rate)}, ${challenge.runs} run(s)`;
      return `  ${name.padEnd(8)}${second}; ${challenged}`;
    }),
  ];
}


export interface RuleEffectiveness {
  rule_id: string;
  /** Every active suppression naming the rule; a null glob is everywhere. */
  suppressions: { glob: string | null; policy_version: number | null }[];
  /** The earliest approval among them, ISO; null when no row records one. */
  approved_at: string | null;
  /** Verified findings of the rule held since approval; null when approved_at is null or runs is 0. */
  held: number | null;
  /** Runs created at or after approval, the basis of held; null when approved_at is null. */
  runs: number | null;
  /** Strong outcomes of the rule's findings posted since approval; null with none. */
  posted: PostedStats | null;
  /** The owner's labels on the rule's findings posted since approval (promoted ones included); null with none. */
  feedback: PrecisionStats | null;
  basis: string;
}

/**
 * Whether each approved suppression is still right: how many verified findings
 * it held since approval, and what became of findings of the same rule posted
 * anyway (promoted, or on a path outside its glob). A version reactivated by
 * `policy rollback` keeps its first `approved_at`, so its window starts there
 * and includes the time it was inactive.
 */
export function ruleEffectiveness(db: Database): RuleEffectiveness[] {
  const byRule = new Map<string, ReturnType<typeof activeSuppressions>>();
  for (const suppression of activeSuppressions(db)) {
    byRule.set(suppression.ruleId, [...(byRule.get(suppression.ruleId) ?? []), suppression]);
  }
  return [...byRule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ruleId, list]) => {
      const suppressions = list.map((s) => ({ glob: s.glob, policy_version: s.policyVersion }));
      const approvedAt = list.map((s) => s.approvedAt).filter((at): at is string => at !== null).sort()[0] ?? null;
      if (approvedAt === null) {
        return {
          rule_id: ruleId,
          suppressions,
          approved_at: null,
          held: null,
          runs: null,
          posted: null,
          feedback: null,
          basis: `no approval time recorded for policy version ${list[0]?.policyVersion ?? 'unknown'}; nothing counted`,
        };
      }
      // Read the way challengeCounts reads scores[]: a row that will not parse or has no array is skipped.
      const rows = db.prepare('SELECT output_json FROM review_runs WHERE created_at >= ?').all(approvedAt) as unknown as RunRow[];
      let held = 0;
      let runs = 0;
      for (const row of rows) {
        let scores: unknown;
        try {
          scores = (JSON.parse(row.output_json) as { scores?: unknown } | null)?.scores;
        } catch {
          continue;
        }
        if (!Array.isArray(scores)) continue;
        runs += 1;
        held += scores.filter((entry) => (entry as { rejectedBecause?: unknown } | null)?.rejectedBecause === `${POLICY_SUPPRESSED_PREFIX}${ruleId}`).length;
      }
      const posted = postedBreakdown(db, { since: approvedAt }).byRule;
      const feedback = precisionBreakdown(db, { since: approvedAt }).byRule;
      // Own keys only, since a rule id such as constructor would otherwise read Object.prototype.
      const postedStats = Object.hasOwn(posted, ruleId) ? (posted[ruleId] ?? null) : null;
      return {
        rule_id: ruleId,
        suppressions,
        approved_at: approvedAt,
        // A count over no run is no data, not zero.
        held: runs === 0 ? null : held,
        runs,
        // Weak outcomes alone measure nothing, and their fixed and dismissed would read as measured zeros.
        posted: postedStats !== null && postedStats.fixed + postedStats.dismissed > 0 ? postedStats : null,
        feedback: Object.hasOwn(feedback, ruleId) ? (feedback[ruleId] ?? null) : null,
        basis:
          runs === 0
            ? `no run recorded since ${approvedAt}`
            : `${held} held in ${runs} run(s) since ${approvedAt}; posted outcomes count strong ones only`,
      };
    });
}

/** The object `evaluate --json` prints and `evaluate --html` renders. Keys stay snake case on the wire. */
export interface EvaluationReport {
  /** ISO time the report was computed, from ComputeOptions.now so a test can pin it. */
  generated_at: string;
  /** The window the `_recent` rates use, so the page can say which days it covers. */
  window_days: number;
  metrics: Metric[];
  posted_breakdown: {
    by_severity: Record<string, PostedStats>;
    by_lane: Record<string, PostedStats>;
    by_rule: Record<string, PostedStats>;
    /** S15's split by whether the posted comments carried an evidence block. */
    by_evidence_block: { with: PostedStats; without: PostedStats; unknown: PostedStats };
  };
  precision_breakdown: { by_lane: Record<string, PrecisionStats>; by_rule: Record<string, PrecisionStats> };
  stage_seconds: Record<string, { median: number; p95: number; runs: number }>;
  rule_effectiveness: RuleEffectiveness[];
  /** Per model family (docs/adr/0034), as `byFamily` returns it. */
  by_family: ByFamily;
}

/** The caller passes `metrics` so the recall figures ride along when `--recall` is given. */
export function evaluationReport(db: Database, metrics: Metric[], options: ComputeOptions = {}): EvaluationReport {
  const { bySeverity, byLane, byRule, byEvidenceBlock } = postedBreakdown(db);
  const precision = precisionBreakdown(db);
  return {
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    window_days: options.windowDays ?? DEFAULT_WINDOW_DAYS,
    metrics,
    posted_breakdown: { by_severity: bySeverity, by_lane: byLane, by_rule: byRule, by_evidence_block: byEvidenceBlock },
    precision_breakdown: { by_lane: precision.byLane, by_rule: precision.byRule },
    stage_seconds: stageSeconds(db),
    rule_effectiveness: ruleEffectiveness(db),
    by_family: byFamily(db),
  };
}

/**
 * Reproduction counts from `output_json.reproductions[]` (S16). Completed is a
 * record that `reproduced` or `did-not-fail`; held is a did-not-fail record
 * `record` marked as held, which a did-not-fail in a category no suppression
 * may reach never is. The mark, not the held list, because `decline` rewrites
 * a held entry's verdict after the run. A `did-not-run` says nothing either
 * way, so it is counted beside the rate and never in it.
 */
function reproductionCounts(db: Database): { held: number; completed: number; didNotRun: number; runs: number } {
  const rows = db.prepare('SELECT output_json FROM review_runs').all() as unknown as RunRow[];
  const counts = { held: 0, completed: 0, didNotRun: 0, runs: 0 };
  for (const row of rows) {
    let parsed: { reproductions?: unknown } | null;
    try {
      parsed = JSON.parse(row.output_json) as { reproductions?: unknown } | null;
    } catch {
      continue;
    }
    const records = Array.isArray(parsed?.reproductions) ? parsed.reproductions : [];
    if (records.length === 0) continue;
    counts.runs += 1;
    const outcome = (entry: unknown): unknown => (typeof entry === 'object' && entry !== null ? (entry as { outcome?: unknown }).outcome : undefined);
    counts.completed += records.filter((entry) => outcome(entry) === 'reproduced' || outcome(entry) === 'did-not-fail').length;
    counts.didNotRun += records.filter((entry) => outcome(entry) === 'did-not-run').length;
    counts.held += records.filter((entry) => outcome(entry) === 'did-not-fail' && (entry as { held?: unknown }).held === true).length;
  }
  return counts;
}

/**
 * Computes the specification's evaluation metrics from recorded runs and
 * feedback.
 *
 * A metric with no data reports null rather than a flattering default. A
 * reviewer that has never run is not a reviewer with perfect compliance, and
 * reporting 100% from zero samples is how a dashboard starts lying.
 */
export function computeMetrics(db: Database, options: ComputeOptions = {}): Metric[] {
  const runs = db.prepare('SELECT output_json FROM review_runs').all() as unknown as RunRow[];
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;

  // How long a review actually takes. Recorded per stage so the cadence
  // question - a recurring sweep at ten minutes cannot wrap a review that runs
  // for twenty-five - rests on a distribution rather than the one run somebody
  // happened to time.
  const runSeconds: number[] = [];
  for (const stages of storedStages(db)) {
    // A row that will not parse is not a measurement.
    if (stages === null) continue;
    const total = stages.reduce((sum, stage) => sum + stage.seconds, 0);
    if (total > 0) runSeconds.push(total);
  }
  const { costs, excluded: uncosted } = runCosts(db);
  const costBasis = `${costs.length} costed run(s), ${uncosted} excluded (no cost recorded)`;
  const challenge = challengeCounts(db);
  const reproduction = reproductionCounts(db);

  const agreement = candidateSetAgreement(db);

  const findingsPerRun: number[] = [];
  const wordsPerFinding: number[] = [];
  let compliantOutputs = 0;
  let noFindingsRuns = 0;
  let exactNoFindings = 0;

  for (const run of runs) {
    let output = '';
    try {
      output = (JSON.parse(run.output_json) as { output: string }).output ?? '';
    } catch {
      continue;
    }

    const parsed = splitFindings(output).map((block) => parseFinding(block.raw, block.startLine));
    findingsPerRun.push(parsed.length);

    for (const finding of parsed) {
      if (finding.prose.length > 0) wordsPerFinding.push(countWords(finding.prose));
    }

    if (validateOutput(output).valid) compliantOutputs += 1;

    if (parsed.length === 0) {
      noFindingsRuns += 1;
      if (output.trim() === DEFAULT_LIMITS.noFindingsResponse) exactNoFindings += 1;
    }
  }

  const feedback = db.prepare('SELECT action, COUNT(*) AS n FROM feedback GROUP BY action').all() as {
    action: string;
    n: number;
  }[];
  const by = Object.fromEntries(feedback.map((row) => [row.action, row.n]));
  const kept = (by['keep'] ?? 0) + (by['rewrite'] ?? 0);
  const dismissed = by['dismiss'] ?? 0;
  const labelled = kept + dismissed;

  const ratio = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : numerator / denominator;

  const posted = postedStats(db);
  const recent = postedStats(db, { since: windowStart(windowDays, options.now) });
  const recentDecided = recent.fixed + recent.dismissed;

  const metric = (
    name: string,
    value: number | null,
    target: string,
    meets: (v: number) => boolean,
    basis: string,
    kind: Metric['kind'] = 'gate',
  ): Metric => ({
    name,
    value,
    target,
    meets: value === null ? null : meets(value),
    basis,
    kind,
  });

  return [
    metric(
      'owner_accepted_precision',
      ratio(kept, labelled),
      '>= 0.80',
      (v) => v >= 0.8,
      // Unlabelled findings are excluded: counting silence as a dismissal
      // would make the reviewer look worse the quieter its user is.
      `(${kept} kept or rewritten) / (${labelled} labelled); unlabelled excluded`,
    ),
    // Counts are a property of the pull requests reviewed, not of the
    // reviewer. Since the output contract stopped capping findings, a run that
    // correctly reports nine defects in a large diff was failing a target that
    // asked it to report two.
    metric(
      'median_review_seconds',
      median(runSeconds),
      'no target',
      () => true,
      runSeconds.length === 0
        ? 'no run has recorded stage timings; pass `record --stages`'
        : `${runSeconds.length} run(s) with recorded stages`,
      'goal',
    ),
    metric(
      'p95_review_seconds',
      percentile(runSeconds, 95),
      'no target',
      () => true,
      runSeconds.length === 0
        ? 'no run has recorded stage timings; pass `record --stages`'
        : `${runSeconds.length} run(s) with recorded stages`,
      'goal',
    ),
    metric(
      'median_review_cost_usd',
      median(costs),
      'no target',
      () => true,
      costBasis,
      'goal',
    ),
    metric(
      'p95_review_cost_usd',
      percentile(costs, 95),
      'no target',
      () => true,
      costBasis,
      'goal',
    ),
    metric(
      'challenge_hold_rate',
      challenge.judged === 0 ? null : challenge.held / challenge.judged,
      'no target',
      () => true,
      `${challenge.held} held / ${challenge.judged} judged over ${challenge.runs} run(s)`,
      'goal',
    ),
    // How often a reproduction removed a finding that would otherwise have
    // posted. Not recall, since a did-not-run says nothing either way.
    metric(
      'reproduction_hold_rate',
      reproduction.completed === 0 ? null : reproduction.held / reproduction.completed,
      'no target',
      () => true,
      `${reproduction.held} held / ${reproduction.completed} completed, ${reproduction.didNotRun} did not run, over ${reproduction.runs} run(s)`,
      'goal',
    ),
    metric(
      'median_findings_per_review',
      median(findingsPerRun),
      'no target',
      () => true,
      `${runs.length} runs; a count reflects the diff, not the reviewer`,
      'goal',
    ),
    metric(
      'p95_findings_per_review',
      percentile(findingsPerRun, 95),
      'no target',
      () => true,
      `${runs.length} runs; a count reflects the diff, not the reviewer`,
      'goal',
    ),
    metric(
      'median_words_per_finding',
      median(wordsPerFinding),
      '<= 28',
      (v) => v <= 28,
      `${wordsPerFinding.length} findings; the contract ceiling is 40, this is the brevity to aim for`,
      'goal',
    ),
    metric(
      'p95_words_per_finding',
      percentile(wordsPerFinding, 95),
      '<= 40',
      (v) => v <= 40,
      `${wordsPerFinding.length} findings; this is the contract ceiling the validator enforces`,
    ),
    // The variance nobody was tracking. Severity stability was measured for
    // three releases while which findings exist at all was not, and on one
    // pull request reviewed twice the two runs agreed on two candidates of
    // eight. For a reviewer that is the more consequential variance: a single
    // run is a sample, not the answer.
    metric(
      'candidate_set_agreement',
      agreement.value,
      'no target',
      () => true,
      agreement.basis,
      'goal',
    ),
    metric(
      'contract_compliance',
      ratio(compliantOutputs, runs.length),
      '= 1.00',
      (v) => v >= 1,
      `${compliantOutputs}/${runs.length} recorded outputs pass validate-output`,
    ),
    metric(
      'exact_no_findings_compliance',
      ratio(exactNoFindings, noFindingsRuns),
      '= 1.00',
      (v) => v >= 1,
      `${exactNoFindings}/${noFindingsRuns} empty reviews used the exact string`,
    ),
    // What GitHub shows happened to the comments this tool posted (docs/adr/0029).
    // Rates count strong outcomes only, so an unanswered comment is neither
    // fixed nor dismissed, and are reported rather than gated.
    metric(
      'posted_findings_tracked',
      posted.tracked === 0 ? null : posted.tracked,
      'no target',
      () => true,
      'posted findings with any recorded outcome; run `review-voice outcomes` to check',
      'goal',
    ),
    metric(
      'posted_fixed_rate',
      posted.fixedRate,
      'no target',
      () => true,
      `${posted.fixed} fixed / (${posted.fixed + posted.dismissed} fixed or dismissed); weak outcomes excluded`,
      'goal',
    ),
    metric(
      'posted_dismissed_rate',
      posted.dismissedRate,
      'no target',
      () => true,
      `${posted.dismissed} dismissed / (${posted.fixed + posted.dismissed} fixed or dismissed); weak outcomes excluded`,
      'goal',
    ),
    // The same rates over a rolling window, so a change to the reviewer shows
    // up before the all-time figure moves. The window is by the run's creation
    // time, which is when the finding was posted.
    metric(
      'posted_fixed_rate_recent',
      recent.fixedRate,
      'no target',
      () => true,
      `${recent.fixed} fixed / ${recentDecided} fixed or dismissed from runs created in the last ${windowDays} days; weak outcomes excluded`,
      'goal',
    ),
    metric(
      'posted_dismissed_rate_recent',
      recent.dismissedRate,
      'no target',
      () => true,
      `${recent.dismissed} dismissed / ${recentDecided} fixed or dismissed from runs created in the last ${windowDays} days; weak outcomes excluded`,
      'goal',
    ),
  ];
}


/**
 * Lines within this of each other count as the same location.
 *
 * Wide enough to absorb an anchor drifting as a file is edited, narrow enough
 * that two genuinely different findings in one function are still two.
 *
 * Matched pairwise rather than by bucketing the line number. Dividing into
 * fixed buckets puts a hard edge somewhere, and 174 against 176 falls across
 * one exactly as confidence 0.82 against 0.90 fell across the severity
 * boundary. A tolerance has no edge to land on.
 */
export const AGREEMENT_LINE_TOLERANCE = 3;

interface Located {
  path: string;
  line: number | null;
}

/** Pairs each location in `a` with at most one within tolerance in `b`. */
function sharedLocations(a: Located[], b: Located[]): number {
  const taken = new Set<number>();
  let shared = 0;

  for (const left of a) {
    for (let i = 0; i < b.length; i += 1) {
      if (taken.has(i)) continue;
      const right = b[i] as Located;
      if (right.path !== left.path) continue;
      const near =
        left.line === null || right.line === null
          ? left.line === right.line
          : Math.abs(left.line - right.line) <= AGREEMENT_LINE_TOLERANCE;
      if (!near) continue;
      taken.add(i);
      shared += 1;
      break;
    }
  }

  return shared;
}

/**
 * How much two reviews of the same diff agree on which findings exist.
 *
 * Jaccard over `path:line`, across every diff reviewed more than once. Location
 * rather than wording, because the editor rewrites prose and two runs naming
 * the same defect at the same line are the same finding however they phrase it.
 *
 * Reported and never scored. There is no defensible target yet, and inventing
 * one would be worse than saying the number out loud.
 */
function candidateSetAgreement(db: Database): { value: number | null; basis: string } {
  // The hash of the empty string is what a run records when no diff was given
  // to hash. Every such run collides with every other, so grouping by it
  // compares unrelated pull requests and reports their disagreement as this
  // reviewer's variance. A number that falls as the tool is used more is worse
  // than no number, because it will be read as evidence.
  const EMPTY_DIFF = hashDiff('');

  const rows = db
    .prepare('SELECT diff_hash, candidates_json FROM review_runs WHERE diff_hash IS NOT NULL AND diff_hash != ?')
    .all(EMPTY_DIFF) as { diff_hash: string; candidates_json: string | null }[];

  const byDiff = new Map<string, Located[][]>();

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.candidates_json ?? '[]');
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : ((parsed as { candidates?: unknown[] }).candidates ?? []);
    // A comment anchored at line 174 in one run and 176 in the next is one
    // finding described twice. Exact matching scored that pair as two complete
    // misses, understating agreement on precisely the findings both runs did
    // agree about.
    const located: Located[] = (list as Record<string, unknown>[])
      .map((candidate) => {
        const line = Number(candidate['line']);
        return {
          path: String(candidate['path'] ?? ''),
          line: Number.isFinite(line) ? line : null,
        };
      })
      .filter((entry) => entry.path !== '');
    if (located.length === 0) continue;

    const existing = byDiff.get(row.diff_hash);
    if (existing === undefined) byDiff.set(row.diff_hash, [located]);
    else existing.push(located);
  }

  const scores: number[] = [];
  let pairs = 0;

  for (const sets of byDiff.values()) {
    if (sets.length < 2) continue;
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        const a = sets[i] as Located[];
        const b = sets[j] as Located[];
        const shared = sharedLocations(a, b);
        const union = a.length + b.length - shared;
        if (union === 0) continue;
        scores.push(shared / union);
        pairs += 1;
      }
    }
  }

  if (pairs === 0) {
    const unhashed = (
      db.prepare('SELECT COUNT(*) AS n FROM review_runs WHERE diff_hash = ?').get(EMPTY_DIFF) as { n: number }
    ).n;
    return {
      value: null,
      basis:
        unhashed > 0
          ? `not measurable: ${unhashed} run(s) recorded without --diff-file, so they carry no diff identity`
          : 'no diff has been reviewed twice; record two runs of one diff to measure this',
    };
  }

  return {
    value: median(scores),
    basis: `${pairs} pair(s) of runs over the same diff, by path and line within ${AGREEMENT_LINE_TOLERANCE}`,
  };
}
