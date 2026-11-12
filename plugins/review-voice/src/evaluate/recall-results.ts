import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { AGREEMENT_LINE_TOLERANCE, type Metric } from './metrics.ts';

/**
 * What `review-voice recall` writes and `evaluate --recall` reads: one result
 * per fixture, the scoring rules, and the three figures the specification
 * asks for. Pure, so the scoring edge cases can be tested without a run.
 */

/** The fixture classes the harness scores; `prompt-injection/` and `confinement/` never are. */
export const RECALL_CLASSES = ['positive', 'negative', 'no-findings'] as const;
export type RecallClass = (typeof RECALL_CLASSES)[number];

/**
 * Where a missed positive lost its expected finding, from the nearest stage to
 * the furthest. With no candidate on an accepted anchor it is `not-raised`
 * when the review posted nothing and `posted-elsewhere` when it posted. With
 * one, it is the furthest stage such a candidate reached. `dropped-at-check`
 * means the candidate check dropped it before verification,
 * `verifier-rejected` that the verifier did not verify it, `held-other` that
 * it was held by neither a gate nor the challenger, `challenge` that the
 * challenger held it or did not run, and `below-gate` that it was verified and
 * then held under a gate. A candidate still eligible at the end of a miss is
 * `posted-elsewhere` when a finding posted where the challenger moved it, and
 * `held-other` when none did, since the editor left it out.
 */
export const LOST_AT = ['not-raised', 'dropped-at-check', 'verifier-rejected', 'held-other', 'challenge', 'below-gate', 'posted-elsewhere'] as const;
export type LostAt = (typeof LOST_AT)[number];

/** The fields one run of a fixture gives. With `--runs` above 1 they live in `attempts`, one entry per run. */
const RUN_FIELDS = ['hit', 'silent', 'lineDelta', 'categoryMatch', 'findings', 'lostAt', 'event', 'seconds', 'costUsd', 'exitCode', 'error'] as const;
export type Attempt = Pick<FixtureResult, (typeof RUN_FIELDS)[number]>;

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
  /** Completed positives: null on a hit, otherwise where the expected finding was lost. */
  lostAt?: LostAt | null;
  /** Completed fixtures: the verdict the run reached, such as APPROVE; null when it reached none. */
  event?: string | null;
  /** With `--runs` above 1: the number of runs, and no single-run field beside it, so nothing reads one run as the answer. */
  runs?: number;
  /** With `--runs` above 1, positives: how many runs hit. */
  hits?: number;
  /** With `--runs` above 1, clean fixtures: how many runs were silent. */
  silentRuns?: number;
  /** With `--runs` above 1: each run's result, in run order. */
  attempts?: Attempt[];
  lanes?: string[];
  seconds?: number;
  costUsd?: number | null;
  /** The run's exit code; null when no run happened (the fixture would not build). */
  exitCode?: number | null;
  /** Why the run did not complete. */
  error?: string;
}

const RATES = ['keyBugRecall', 'causalLineHit', 'cleanSilence'] as const;
type Rate = (typeof RATES)[number];

/** One rate over several runs, as its lowest and highest run and the value of every run in run order. */
export interface RateRange {
  lowest: number | null;
  highest: number | null;
  runs: (number | null)[];
}

/**
 * With `--runs` above 1 each rate is the mean of the runs' rates, `runs` and
 * `ranges` are present, and `failedRuns`, `completedPositives`, `approved` and
 * `lost` are totals over every run. A file written before `lost` existed has
 * none of the three counts beside it.
 */
export interface RecallSummary {
  keyBugRecall: number | null;
  causalLineHit: number | null;
  cleanSilence: number | null;
  /** Positives that were scored: every positive except the skipped ones, failed runs included. */
  positives: number;
  skipped: number;
  cleanFixtures: number;
  failedRuns: number;
  /** Positive runs that completed, which `approved` and `lost` are read against. */
  completedPositives?: number;
  /** Completed positive runs that ended in APPROVE. */
  approved?: number;
  /** The completed positive runs that missed, by where the expected finding was lost. */
  lost?: Record<LostAt, number>;
  runs?: number;
  ranges?: Record<Rate, RateRange>;
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

/** What each stage of one run did with the candidates, as the run's own files record it. */
export interface RunTrail {
  /** Every candidate the lanes raised. */
  candidates: { id: string; path: string; line: number }[];
  /** The ids the candidate check kept. */
  kept: string[];
  /** The ids the verifier verified. */
  verified: string[];
  held: { candidateId?: string | undefined; verdict: string }[];
  /** The candidates still eligible after the challenge, each where the challenger left it, which the review was written from. */
  eligible: ({ id: string } & Anchor)[];
  /** Where each finding the review posted sits. */
  posted: Anchor[];
}

type Anchored = Pick<Expectation, 'path' | 'line'> & Partial<Pick<Expectation, 'anchors'>>;

/** Every place a positive accepts a finding at: `expect.path` and `expect.line` first, then `expect.anchors`. */
function acceptedAnchors(expectation: Anchored): Anchor[] {
  if (expectation.path === null || expectation.line === null) return [];
  return [{ path: expectation.path, line: expectation.line }, ...(expectation.anchors ?? [])];
}

/**
 * Where a positive that missed lost its expected finding. The candidates
 * within the tolerance of an accepted anchor are followed through the run, and
 * the one that got furthest decides. With none there, the review either posted
 * somewhere else or raised nothing.
 */
export function lostAt(expectation: Anchored, trail: RunTrail): LostAt {
  const anchors = acceptedAnchors(expectation);
  const near = trail.candidates.filter((candidate) => anchors.some((anchor) => anchor.path === candidate.path && Math.abs(candidate.line - anchor.line) <= AGREEMENT_LINE_TOLERANCE));
  if (near.length === 0) return trail.posted.length > 0 ? 'posted-elsewhere' : 'not-raised';
  const furthest = (stages: readonly LostAt[]): LostAt => stages.reduce((a, b) => (LOST_AT.indexOf(b) > LOST_AT.indexOf(a) ? b : a));
  const stage = (id: string): LostAt => {
    // A repeat the check dropped is in the held list too, and it never reached the verifier.
    if (!trail.kept.includes(id)) return 'dropped-at-check';
    const holds = trail.held.filter((hold) => hold.candidateId === id).map((hold): LostAt => (hold.verdict === 'below-gate' ? 'below-gate' : hold.verdict.startsWith('challenge-') ? 'challenge' : 'held-other'));
    if (holds.length > 0) return furthest(holds);
    if (!trail.verified.includes(id)) return 'verifier-rejected';
    // One still eligible at the end of a miss posted only if the challenger
    // moved it out of the tolerance, and then a finding sits where it was
    // moved to. A finding from another candidate says nothing about this one,
    // which the editor left out or the score turned away without a hold.
    const left = trail.eligible.find((entry) => entry.id === id);
    return left !== undefined && trail.posted.some((finding) => finding.path === left.path && finding.line === left.line) ? 'posted-elsewhere' : 'held-other';
  };
  return furthest(near.map((candidate) => stage(candidate.id)));
}

/**
 * The scored part of one fixture's result. A run that did not complete scores
 * nothing, so a crash is never read as a miss or as silence.
 */
export function scoreFixture(
  expectation: Pick<Expectation, 'class' | 'category'> & Anchored,
  outcome: RunOutcome,
): Pick<FixtureResult, 'hit' | 'lineDelta' | 'categoryMatch' | 'silent' | 'findings'> {
  if (expectation.class !== 'positive') {
    return { silent: outcome.completed ? outcome.silent : null, findings: outcome.findings.length };
  }
  const anchors = acceptedAnchors(expectation);
  if (!outcome.completed || anchors.length === 0) {
    return { hit: null, lineDelta: null, categoryMatch: null, findings: outcome.findings.length };
  }
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
  /** Completed positives that ended in APPROVE. */
  approved: number;
  /** Completed positives that missed, by `lostAt`. */
  lost: Record<LostAt, number>;
}

/** The counts behind the three figures of one run, so `evaluate` can show them beside the ratios. */
export function tallyResults(results: readonly FixtureResult[]): RecallTally {
  const lost = Object.fromEntries(LOST_AT.map((stage) => [stage, 0])) as Record<LostAt, number>;
  const tally: RecallTally = { hits: 0, completedPositives: 0, onPath: 0, silent: 0, completedClean: 0, positives: 0, skipped: 0, cleanFixtures: 0, failedRuns: 0, approved: 0, lost };
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
      if (result.event === 'APPROVE') tally.approved += 1;
      if (result.hit === false && result.lostAt !== undefined && result.lostAt !== null) tally.lost[result.lostAt] += 1;
    } else {
      tally.cleanFixtures += 1;
      if (broken) continue;
      tally.completedClean += 1;
      if (result.silent === true) tally.silent += 1;
    }
  }
  return tally;
}

/** Several runs of one fixture as the results file holds them, with the counts and each run under `attempts`. */
export function combineAttempts(attempts: readonly FixtureResult[]): FixtureResult {
  const first = attempts[0] as FixtureResult;
  return {
    name: first.name,
    class: first.class,
    runs: attempts.length,
    ...(first.class === 'positive' ? { hits: attempts.filter((attempt) => attempt.hit === true).length } : { silentRuns: attempts.filter((attempt) => attempt.silent === true).length }),
    // The lanes follow from the diff and the mode, not from the run; a failed run names none.
    lanes: attempts.find((attempt) => (attempt.lanes ?? []).length > 0)?.lanes ?? [],
    attempts: attempts.map((attempt) => Object.fromEntries(RUN_FIELDS.filter((key) => attempt[key] !== undefined).map((key) => [key, attempt[key]])) as Attempt),
  };
}

/** The fixtures as one run saw them, in the single-run shape every tally reads. */
function runView(results: readonly FixtureResult[], run: number): FixtureResult[] {
  // The fixture's name and class go last, so an attempt is never counted under a class of its own.
  return results.map((result) => (result.attempts === undefined ? result : { ...result.attempts[run], name: result.name, class: result.class }));
}

/**
 * The summary the specification gives. Failed runs are counted and left out of
 * every denominator, so a figure is over what completed and `failedRuns` says
 * how much did not. A zero denominator is null: no data, not a perfect score.
 * With `runs` above 1 every fixture that was not skipped carries that many
 * attempts, each run is summarised on its own, and a rate is the mean of the
 * runs that have one.
 */
export function summariseResults(results: readonly FixtureResult[], runs = 1): RecallSummary {
  const one = (run: readonly FixtureResult[]): Required<Omit<RecallSummary, 'runs' | 'ranges'>> => {
    const tally = tallyResults(run);
    return {
      keyBugRecall: ratio(tally.hits, tally.completedPositives),
      causalLineHit: ratio(tally.hits, tally.onPath),
      cleanSilence: ratio(tally.silent, tally.completedClean),
      positives: tally.positives,
      skipped: tally.skipped,
      cleanFixtures: tally.cleanFixtures,
      failedRuns: tally.failedRuns,
      completedPositives: tally.completedPositives,
      approved: tally.approved,
      lost: tally.lost,
    };
  };
  if (runs === 1) return one(results);
  const each = Array.from({ length: runs }, (_, run) => one(runView(results, run)));
  const first = each[0] as (typeof each)[number];
  const total = (pick: (summary: (typeof each)[number]) => number): number => each.reduce((sum, summary) => sum + pick(summary), 0);
  const range = (rate: Rate): RateRange => {
    const values = each.map((summary) => summary[rate]);
    const known = values.filter((value) => value !== null);
    return { lowest: known.length === 0 ? null : Math.min(...known), highest: known.length === 0 ? null : Math.max(...known), runs: values };
  };
  const ranges = { keyBugRecall: range('keyBugRecall'), causalLineHit: range('causalLineHit'), cleanSilence: range('cleanSilence') };
  const mean = (rate: Rate): number | null => {
    const known = ranges[rate].runs.filter((value) => value !== null);
    return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
  };
  return {
    keyBugRecall: mean('keyBugRecall'),
    causalLineHit: mean('causalLineHit'),
    cleanSilence: mean('cleanSilence'),
    positives: first.positives,
    skipped: first.skipped,
    cleanFixtures: first.cleanFixtures,
    failedRuns: total((summary) => summary.failedRuns),
    completedPositives: total((summary) => summary.completedPositives),
    approved: total((summary) => summary.approved),
    lost: Object.fromEntries(LOST_AT.map((stage) => [stage, total((summary) => summary.lost[stage])])) as Record<LostAt, number>,
    runs,
    ranges,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** What a fixture carries in place of the single-run fields when the file holds several runs. */
const MULTI_RUN_FIELDS = ['runs', 'hits', 'silentRuns', 'attempts'] as const;

/** Why a per-run field of a fixture or an attempt has the wrong type, as the text after its name; null when none has. */
function fieldProblem(entry: Record<string, unknown>): string | null {
  for (const key of ['hit', 'silent'] as const) {
    if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== 'boolean') return `${key} is not true, false or null`;
  }
  if (entry['lineDelta'] !== undefined && entry['lineDelta'] !== null && typeof entry['lineDelta'] !== 'number') return 'lineDelta is not a number';
  if (entry['exitCode'] !== undefined && entry['exitCode'] !== null && typeof entry['exitCode'] !== 'number') return 'exitCode is not a number';
  for (const key of ['skipped', 'error'] as const) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') return `${key} is not a string`;
  }
  if (entry['lostAt'] !== undefined && entry['lostAt'] !== null && !LOST_AT.some((stage) => stage === entry['lostAt'])) return `lostAt is not null or one of ${LOST_AT.join(', ')}`;
  if (entry['event'] !== undefined && entry['event'] !== null && typeof entry['event'] !== 'string') return 'event is not a string or null';
  return null;
}
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
    const carried = ['hit', 'silent', 'lineDelta', 'findings', 'exitCode', 'error', ...MULTI_RUN_FIELDS].filter((key) => entry[key] !== undefined);
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
    // A file written before `lostAt` existed has none; one that has it loses a finding exactly when it missed.
    if (entry['lostAt'] !== undefined && (entry['lostAt'] === null) !== entry['hit']) return `lostAt is ${String(entry['lostAt'])} but hit is ${String(entry['hit'])}`;
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
  const summary = document['summary'];
  if (!isRecord(summary)) throw bad('summary is not an object');
  // One run writes no `runs`, so the two shapes are told apart by it alone and every fixture must agree with it.
  const runs = summary['runs'] === undefined ? 1 : summary['runs'];
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < (summary['runs'] === undefined ? 1 : 2)) throw bad('summary.runs is not a whole number above 1');
  const checked = (entry: Record<string, unknown>, label: string): void => {
    const field = fieldProblem(entry);
    if (field !== null) throw bad(`${label}.${field}`);
    const problem = recordProblem(entry);
    if (problem !== null) throw bad(`${label}: ${problem}`);
  };
  for (const [index, entry] of fixtures.entries()) {
    const label = `fixtures[${index}]`;
    if (!isRecord(entry) || typeof entry['name'] !== 'string') throw bad(`${label} has no name`);
    if (!RECALL_CLASSES.some((known) => known === entry['class'])) throw bad(`${label} has no known class`);
    if (runs === 1 || entry['skipped'] !== undefined) {
      const several = MULTI_RUN_FIELDS.filter((key) => entry[key] !== undefined);
      if (several.length > 0 && entry['skipped'] === undefined) throw bad(`${label} carries ${several.join(', ')}, but the summary records one run`);
      checked(entry, label);
      continue;
    }
    const attempts = entry['attempts'];
    if (!Array.isArray(attempts) || attempts.length !== runs || entry['runs'] !== runs) throw bad(`${label} does not carry the ${runs} attempts the summary records`);
    const single = RUN_FIELDS.filter((key) => entry[key] !== undefined);
    if (single.length > 0) throw bad(`${label} carries ${single.join(', ')} beside its attempts, and one run is not the answer`);
    for (const [run, attempt] of attempts.entries()) {
      if (!isRecord(attempt) || attempt['skipped'] !== undefined) throw bad(`${label}.attempts[${run}] is not one run's result`);
      // Anything else, a class above all, would let one run be checked as one thing and counted as another.
      const foreign = Object.keys(attempt).filter((key) => !RUN_FIELDS.some((field) => field === key));
      if (foreign.length > 0) throw bad(`${label}.attempts[${run}] carries ${foreign.join(', ')}, which one run does not record`);
      checked({ ...attempt, class: entry['class'] }, `${label}.attempts[${run}]`);
    }
    const [counted, scored, other] = entry['class'] === 'positive' ? (['hits', 'hit', 'silentRuns'] as const) : (['silentRuns', 'silent', 'hits'] as const);
    const count = attempts.filter((attempt) => (attempt as Record<string, unknown>)[scored] === true).length;
    if (entry[counted] !== count) throw bad(`${label}.${counted} is ${JSON.stringify(entry[counted])} but its attempts give ${count}`);
    if (entry[other] !== undefined) throw bad(`${label} is a ${String(entry['class'])} fixture and carries ${other}`);
  }
  for (const key of RATES) {
    if (!isFigure(summary[key])) throw bad(`summary.${key} is not a number from 0 to 1, or null`);
  }
  // The figures are shown beside counts taken from the fixtures, so a summary
  // that no longer follows from them (an edited or merged file) would print a
  // ratio next to a tally that contradicts it.
  // Checked before the runs are summarised, so a run count is never larger than a list the file itself holds.
  const ranges = summary['ranges'];
  if (runs > 1 && !RATES.every((rate) => isRecord(ranges) && isRecord(ranges[rate]) && Array.isArray(ranges[rate]['runs']) && ranges[rate]['runs'].length === runs)) {
    throw bad(`summary.ranges does not give every rate a value for each of the ${runs} runs`);
  }
  if (runs === 1 && ranges !== undefined) throw bad('summary.ranges is given, but the summary records one run');
  const recomputed = summariseResults(fixtures as FixtureResult[], runs);
  // A file written before the loss counts existed has none of them; one that has any must have all three, and right.
  const lossCounts = ['completedPositives', 'approved', 'lost'];
  const optional = runs === 1 && lossCounts.every((key) => summary[key] === undefined) ? lossCounts : [];
  for (const key of Object.keys(recomputed) as (keyof RecallSummary)[]) {
    if (summary[key] === undefined && optional.includes(key)) continue;
    if (!isDeepStrictEqual(summary[key], recomputed[key])) throw bad(`summary.${key} is ${JSON.stringify(summary[key])} but the fixtures give ${JSON.stringify(recomputed[key])}`);
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
  const { summary } = results;
  const where = `plugin ${results.pluginVersion}, runner ${results.runner}, mode ${results.mode}`;
  const left = `${summary.skipped} skipped, ${summary.failedRuns} failed run(s) excluded`;
  const metric = (name: (typeof names)[number], value: number | null, basis: string): Metric => ({
    name,
    value,
    target: 'no target',
    meets: value === null ? null : true,
    basis: `${basis}; ${left} (${where})`,
    kind: 'goal',
  });
  const { runs, ranges } = summary;
  if (runs !== undefined && ranges !== undefined) {
    // Several runs have no one count to show, so the basis is how many there were and how far apart they landed.
    const figure = (value: number | null): string => (value === null ? 'no data' : value.toFixed(2));
    const over = (rate: Rate, what: string): string => `mean of ${runs} runs, lowest ${figure(ranges[rate].lowest)}, highest ${figure(ranges[rate].highest)}, of ${what}`;
    return [
      metric('fixture_key_bug_recall', summary.keyBugRecall, over('keyBugRecall', 'completed positives with a finding on an accepted anchor')),
      metric('fixture_causal_line_hit', summary.causalLineHit, over('causalLineHit', `positives with a finding on an expected file that hit an accepted anchor within ${AGREEMENT_LINE_TOLERANCE}`)),
      metric('fixture_clean_silence', summary.cleanSilence, over('cleanSilence', 'completed clean fixtures that ended with exactly the no-findings sentence')),
    ];
  }
  const tally = tallyResults(results.fixtures);
  return [
    metric('fixture_key_bug_recall', summary.keyBugRecall, `${tally.hits}/${tally.completedPositives} completed positives had a finding on an accepted anchor`),
    metric('fixture_causal_line_hit', summary.causalLineHit, `${tally.hits}/${tally.onPath} positives with a finding on an expected file hit an accepted anchor within ${AGREEMENT_LINE_TOLERANCE}`),
    metric('fixture_clean_silence', summary.cleanSilence, `${tally.silent}/${tally.completedClean} completed clean fixtures ended with exactly the no-findings sentence`),
  ];
}
