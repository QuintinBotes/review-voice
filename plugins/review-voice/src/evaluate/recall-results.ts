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
  /** Positives: a validated finding sits on an accepted anchor, within the tolerance. Null when the run failed. */
  hit?: boolean | null;
  /** Positives: the smallest line distance of a finding from an accepted anchor on its own path; null when no finding is on an anchor's path. */
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

/** A place a positive fixture accepts a finding at. */
export interface Anchor {
  path: string;
  line: number;
}

/** What a fixture's `case.yaml` says the harness needs. */
export interface Expectation {
  class: RecallClass;
  name: string;
  path: string | null;
  line: number | null;
  /** The further places the seeded defect can honestly be commented on, from `expect.anchors`. `path` and `line` are the first. */
  anchors: Anchor[];
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
  expectation: Pick<Expectation, 'class' | 'path' | 'line' | 'category'> & Partial<Pick<Expectation, 'anchors'>>,
  outcome: RunOutcome,
): Pick<FixtureResult, 'hit' | 'lineDelta' | 'categoryMatch' | 'silent' | 'findings'> {
  if (expectation.class !== 'positive') {
    return { silent: outcome.completed ? outcome.silent : null, findings: outcome.findings.length };
  }
  if (!outcome.completed || expectation.path === null || expectation.line === null) {
    return { hit: null, lineDelta: null, categoryMatch: null, findings: outcome.findings.length };
  }
  const anchors: Anchor[] = [{ path: expectation.path, line: expectation.line }, ...(expectation.anchors ?? [])];
  // Distance, not equality: an anchor drifts a line or two as a file is edited.
  const onPath = outcome.findings
    .flatMap((finding) => anchors.filter((anchor) => anchor.path === finding.path).map((anchor) => ({ finding, delta: Math.abs(finding.line - anchor.line) })))
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
  /** Completed positives with at least one finding on the path of an accepted anchor. */
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
 * Why one fixture record, whose fields already have the right types, cannot
 * be true as written; null when it can. `scoreFixture` is the reference: a
 * record the command wrote always passes, and one that says both "hit" and
 * "a thousand lines away" is an edit, not a measurement.
 */
function recordProblem(entry: Record<string, unknown>): string | null {
  const count = (key: string): string | null =>
    entry[key] === undefined || entry[key] === null || (Number.isInteger(entry[key]) && (entry[key] as number) >= 0) ? null : `${key} is not a whole number`;
  if (entry['skipped'] !== undefined) {
    const carried = ['hit', 'silent', 'lineDelta', 'findings', 'exitCode', 'error'].filter((key) => entry[key] !== undefined);
    return carried.length === 0 ? null : `a skipped fixture carries no result, but this one has ${carried.join(', ')}`;
  }
  const badCount = count('findings') ?? count('lineDelta');
  if (badCount !== null) return badCount;
  if (entry['exitCode'] !== 0 || entry['error'] !== undefined) {
    return (entry['hit'] ?? null) === null && (entry['silent'] ?? null) === null ? null : 'a failed run scores nothing, but this one has a hit or silent value';
  }
  if (entry['class'] === 'positive') {
    if (typeof entry['hit'] !== 'boolean') return 'a completed positive has no hit value';
    const delta = entry['lineDelta'];
    // A distance is measured from a finding, so there was one.
    if (typeof delta === 'number' && entry['findings'] === 0) return 'lineDelta is set but findings is 0';
    const within = typeof delta === 'number' && delta <= AGREEMENT_LINE_TOLERANCE;
    if (entry['hit'] !== within) return `hit is ${String(entry['hit'])} but lineDelta is ${delta === undefined || delta === null ? 'absent' : String(delta)} against a tolerance of ${AGREEMENT_LINE_TOLERANCE}`;
    return null;
  }
  if (typeof entry['silent'] !== 'boolean') return 'a completed clean fixture has no silent value';
  if (entry['silent'] === true && typeof entry['findings'] === 'number' && entry['findings'] > 0) return `silent is true but findings is ${entry['findings']}`;
  return null;
}

/**
 * Reads a results file defensively: it is an operator-supplied file, and a
 * truncated or hand-edited one must be a clear error, not a figure computed
 * from garbage. The summary must be the one its fixtures give. Throws an Error
 * whose message names the file and the problem.
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
    for (const key of ['skipped', 'error'] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') throw bad(`fixtures[${index}].${key} is not a string`);
    }
    const problem = recordProblem(entry);
    if (problem !== null) throw bad(`fixtures[${index}]: ${problem}`);
  }
  const summary = document['summary'];
  if (!isRecord(summary)) throw bad('summary is not an object');
  for (const key of ['keyBugRecall', 'causalLineHit', 'cleanSilence'] as const) {
    if (!isFigure(summary[key])) throw bad(`summary.${key} is not a number from 0 to 1, or null`);
  }
  // The figures are shown beside counts taken from the fixtures, so a summary
  // that no longer follows from them (an edited or merged file) would print a
  // ratio next to a tally that contradicts it.
  const recomputed = summariseResults(fixtures as FixtureResult[]);
  for (const key of Object.keys(recomputed) as (keyof RecallSummary)[]) {
    if (summary[key] !== recomputed[key]) throw bad(`summary.${key} is ${JSON.stringify(summary[key])} but the fixtures give ${JSON.stringify(recomputed[key])}`);
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
    metric('fixture_key_bug_recall', results.summary.keyBugRecall, `${tally.hits}/${tally.completedPositives} completed positives had a finding on an accepted anchor`),
    metric('fixture_causal_line_hit', results.summary.causalLineHit, `${tally.hits}/${tally.onPath} positives with a finding on an expected file hit an accepted anchor within ${AGREEMENT_LINE_TOLERANCE}`),
    metric('fixture_clean_silence', results.summary.cleanSilence, `${tally.silent}/${tally.completedClean} completed clean fixtures ended with exactly the no-findings sentence`),
  ];
}
