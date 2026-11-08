import { readFileSync } from 'node:fs';
import { AGREEMENT_LINE_TOLERANCE, type Metric } from './metrics.ts';

/**
 * What `review-voice recall` writes and `evaluate --recall` reads: one result
 * per fixture, the scoring rules, and the three figures the specification
 * asks for. Pure, so the scoring edge cases can be tested without a run.
 */

/** The fixture classes the harness scores; `prompt-injection/` and `confinement/` never are. */
export const RECALL_CLASSES = ['positive', 'negative', 'no-findings'] as const;
export type RecallClass = (typeof RECALL_CLASSES)[number];

export interface FixtureResult {
  /** `<class>/<directory>`, the name every error and `--only` uses. */
  name: string;
  class: RecallClass;
  /** Why the fixture was left out; present means it is in no denominator. */
  skipped?: string;
  /** Positives: a validated finding sits on the causal line, within the tolerance. Null when the run failed. */
  hit?: boolean | null;
  /** Positives: the smallest line distance of a finding on `expect.path`; null when there is none. */
  lineDelta?: number | null;
  /** Positives: the nearest finding's category equals `expect.category`; null when either side has none. */
  categoryMatch?: boolean | null;
  /** Clean fixtures: the validated output is exactly the no-findings sentence. Null when the run failed. */
  silent?: boolean | null;
  /** The validated findings the run produced. */
  findings?: number;
  lanes?: string[];
  seconds?: number;
  costUsd?: number | null;
  /** The run's exit code; null when no run happened (the fixture would not build). */
  exitCode?: number | null;
  /** Why the run did not complete. */
  error?: string;
}

export interface RecallSummary {
  keyBugRecall: number | null;
  causalLineHit: number | null;
  cleanSilence: number | null;
  /** Positives that were scored: every positive except the skipped ones, failed runs included. */
  positives: number;
  skipped: number;
  cleanFixtures: number;
  failedRuns: number;
}

export interface RecallResults {
  pluginVersion: string;
  mode: string;
  runner: string;
  fixtures: FixtureResult[];
  summary: RecallSummary;
}

/** What a fixture's `case.yaml` says the harness needs. */
export interface Expectation {
  class: RecallClass;
  name: string;
  path: string | null;
  line: number | null;
  category: string | null;
  /** The reason from `harness_reason`, or a stock one; null when the fixture is scored. */
  skip: string | null;
}

/** A validated finding as the run recorded it. */
export interface FoundFinding {
  path: string;
  line: number;
  category?: string | undefined;
}

export interface RunOutcome {
  completed: boolean;
  findings: FoundFinding[];
  /** The review text was exactly the no-findings sentence. */
  silent: boolean;
}

/**
 * The scored part of one fixture's result. A run that did not complete scores
 * nothing, so a crash is never read as a miss or as silence.
 */
export function scoreFixture(
  expectation: Pick<Expectation, 'class' | 'path' | 'line' | 'category'>,
  outcome: RunOutcome,
): Pick<FixtureResult, 'hit' | 'lineDelta' | 'categoryMatch' | 'silent' | 'findings'> {
  if (expectation.class !== 'positive') {
    return { silent: outcome.completed ? outcome.silent : null, findings: outcome.findings.length };
  }
  if (!outcome.completed || expectation.path === null || expectation.line === null) {
    return { hit: null, lineDelta: null, categoryMatch: null, findings: outcome.findings.length };
  }
  const line = expectation.line;
  // Distance, not equality: an anchor drifts a line or two as a file is edited.
  const onPath = outcome.findings
    .filter((finding) => finding.path === expectation.path)
    .map((finding) => ({ finding, delta: Math.abs(finding.line - line) }))
    .sort((a, b) => a.delta - b.delta);
  const nearest = onPath[0];
  if (nearest === undefined) return { hit: false, lineDelta: null, categoryMatch: null, findings: outcome.findings.length };
  const category = nearest.finding.category;
  return {
    hit: nearest.delta <= AGREEMENT_LINE_TOLERANCE,
    lineDelta: nearest.delta,
    categoryMatch: category === undefined || expectation.category === null ? null : category === expectation.category,
    findings: outcome.findings.length,
  };
}

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator);

/** A result whose run did not complete: no exit code, a non-zero one, or an error. */
const failed = (result: FixtureResult): boolean => result.exitCode !== 0 || result.error !== undefined;

export interface RecallTally {
  hits: number;
  completedPositives: number;
  /** Completed positives with at least one finding on `expect.path`. */
  onPath: number;
  silent: number;
  completedClean: number;
  positives: number;
  skipped: number;
  cleanFixtures: number;
  failedRuns: number;
}

/** The counts behind the three figures, so `evaluate` can show them beside the ratios. */
export function tallyResults(results: readonly FixtureResult[]): RecallTally {
  const tally: RecallTally = { hits: 0, completedPositives: 0, onPath: 0, silent: 0, completedClean: 0, positives: 0, skipped: 0, cleanFixtures: 0, failedRuns: 0 };
  for (const result of results) {
    if (result.skipped !== undefined) {
      tally.skipped += 1;
      continue;
    }
    const broken = failed(result);
    if (broken) tally.failedRuns += 1;
    if (result.class === 'positive') {
      tally.positives += 1;
      if (broken) continue;
      tally.completedPositives += 1;
      if (result.hit === true) tally.hits += 1;
      if (result.lineDelta !== undefined && result.lineDelta !== null) tally.onPath += 1;
    } else {
      tally.cleanFixtures += 1;
      if (broken) continue;
      tally.completedClean += 1;
      if (result.silent === true) tally.silent += 1;
    }
  }
  return tally;
}

/**
 * The summary the specification gives. Failed runs are counted and left out of
 * every denominator, so a figure is over what completed and `failedRuns` says
 * how much did not. A zero denominator is null: no data, not a perfect score.
 */
export function summariseResults(results: readonly FixtureResult[]): RecallSummary {
  const tally = tallyResults(results);
  return {
    keyBugRecall: ratio(tally.hits, tally.completedPositives),
    causalLineHit: ratio(tally.hits, tally.onPath),
    cleanSilence: ratio(tally.silent, tally.completedClean),
    positives: tally.positives,
    skipped: tally.skipped,
    cleanFixtures: tally.cleanFixtures,
    failedRuns: tally.failedRuns,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFigure = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);

/**
 * Reads a results file defensively: it is an operator-supplied file, and a
 * truncated or hand-edited one must be a clear error, not a figure computed
 * from garbage. Throws an Error whose message names the file and the problem.
 */
export function readRecallResults(path: string): RecallResults {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the recall results ${path}: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (error as Error).message}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`The recall results ${path} are not valid JSON: ${(error as Error).message}`);
  }
  const bad = (why: string): Error => new Error(`The recall results ${path} are malformed: ${why}`);
  if (!isRecord(document)) throw bad('the top level is not an object');
  for (const key of ['pluginVersion', 'mode', 'runner'] as const) {
    if (typeof document[key] !== 'string') throw bad(`${key} is not a string`);
  }
  const fixtures = document['fixtures'];
  if (!Array.isArray(fixtures)) throw bad('fixtures is not a list');
  for (const [index, entry] of fixtures.entries()) {
    if (!isRecord(entry) || typeof entry['name'] !== 'string') throw bad(`fixtures[${index}] has no name`);
    if (!RECALL_CLASSES.some((known) => known === entry['class'])) throw bad(`fixtures[${index}] has no known class`);
    for (const key of ['hit', 'silent'] as const) {
      if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== 'boolean') throw bad(`fixtures[${index}].${key} is not true, false or null`);
    }
    if (entry['lineDelta'] !== undefined && entry['lineDelta'] !== null && typeof entry['lineDelta'] !== 'number') throw bad(`fixtures[${index}].lineDelta is not a number`);
    if (entry['exitCode'] !== undefined && entry['exitCode'] !== null && typeof entry['exitCode'] !== 'number') throw bad(`fixtures[${index}].exitCode is not a number`);
    if (entry['skipped'] !== undefined && typeof entry['skipped'] !== 'string') throw bad(`fixtures[${index}].skipped is not a string`);
  }
  const summary = document['summary'];
  if (!isRecord(summary)) throw bad('summary is not an object');
  for (const key of ['keyBugRecall', 'causalLineHit', 'cleanSilence'] as const) {
    if (!isFigure(summary[key])) throw bad(`summary.${key} is not a number from 0 to 1, or null`);
  }
  return document as unknown as RecallResults;
}

const NO_RECALL_BASIS = 'pass evaluate --recall <results.json>';

/**
 * The three recall figures as `evaluate` reports them: goals, never gates. The
 * suite is small and one pass per fixture is a noisy sample, so a number below
 * what the product specification hopes for is information, not a failure.
 * With no file they report `no data` and say how to get one.
 */
export function recallMetrics(results: RecallResults | null): Metric[] {
  const names = ['fixture_key_bug_recall', 'fixture_causal_line_hit', 'fixture_clean_silence'] as const;
  if (results === null) {
    return names.map((name) => ({ name, value: null, target: 'no target', meets: null, basis: NO_RECALL_BASIS, kind: 'goal' as const }));
  }
  const tally = tallyResults(results.fixtures);
  const where = `plugin ${results.pluginVersion}, runner ${results.runner}, mode ${results.mode}`;
  const left = `${tally.skipped} skipped, ${tally.failedRuns} failed run(s) excluded`;
  const metric = (name: (typeof names)[number], value: number | null, basis: string): Metric => ({
    name,
    value,
    target: 'no target',
    meets: value === null ? null : true,
    basis: `${basis}; ${left} (${where})`,
    kind: 'goal',
  });
  return [
    metric('fixture_key_bug_recall', results.summary.keyBugRecall, `${tally.hits}/${tally.completedPositives} completed positives had a finding on the causal line`),
    metric('fixture_causal_line_hit', results.summary.causalLineHit, `${tally.hits}/${tally.onPath} positives with a finding on the expected file hit the causal line within ${AGREEMENT_LINE_TOLERANCE}`),
    metric('fixture_clean_silence', results.summary.cleanSilence, `${tally.silent}/${tally.completedClean} completed clean fixtures ended with exactly the no-findings sentence`),
  ];
}
