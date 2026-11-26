import { parse as parseYaml } from 'yaml';
import type { Database } from '../store/db.ts';
import {
  DEFAULT_THRESHOLDS,
  holdReasonOf,
  reGateBreakdown,
  type HoldReason,
  type Thresholds,
} from '../scoring/score.ts';

/**
 * Calibration measured against human labels (#481, docs/adr/0040).
 *
 * Everything here reads stored runs and their score breakdowns. Nothing
 * calls a model, the network or the store's write path, and no number is
 * invented for a breakdown that does not carry it: an unbanded candidate is
 * counted as unbanded, and a breakdown that cannot be re-gated is counted
 * under `notReapplicable` with the missing field named.
 */

export const LABEL_VALUES = ['TRUE', 'TRUE-NOT-WORTH', 'PARTLY', 'FALSE', 'UNCHECKABLE'] as const;
export type LabelValue = (typeof LABEL_VALUES)[number];

/** One labels-file entry; an empty `label` is a blank sheet row, not yet labelled. */
export interface LabelEntry {
  run: string;
  candidate_id: string;
  label: LabelValue | '';
  note?: string;
}

/** A labels or thresholds file that cannot be read as given; the CLI exits 2 with its message. */
export class CalibrationInputError extends Error {}

function entryName(index: number, entry: Record<string, unknown>): string {
  const run = typeof entry['run'] === 'string' ? entry['run'] : '?';
  const id = entry['candidate_id'] ?? entry['candidateId'];
  return `labels entry ${index} (run ${run}, candidate_id ${typeof id === 'string' ? id : '?'})`;
}

/**
 * Parses and strictly validates a labels file: a JSON array of
 * `{run, candidate_id, label, note?}`. Context fields (the rest of a
 * labelling sheet) are ignored, so a sheet from `label-sample` passes as
 * is, blank labels included. Every problem names its entry and field.
 */
export function parseLabels(text: string): LabelEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CalibrationInputError(`labels file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new CalibrationInputError('labels file must be a JSON array of {run, candidate_id, label, note?} entries.');
  }
  const entries: LabelEntry[] = [];
  const labelled = new Set<string>();
  parsed.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new CalibrationInputError(`labels entry ${index}: must be an object with run, candidate_id and label.`);
    }
    const entry = raw as Record<string, unknown>;
    const who = entryName(index, entry);
    const run = entry['run'];
    if (typeof run !== 'string' || run.length === 0) {
      throw new CalibrationInputError(`${who}: field run must be a non-empty string.`);
    }
    const candidateId = entry['candidate_id'] ?? entry['candidateId'];
    if (typeof candidateId !== 'string' || candidateId.length === 0) {
      throw new CalibrationInputError(`${who}: field candidate_id must be a non-empty string.`);
    }
    if (!Object.hasOwn(entry, 'label')) {
      throw new CalibrationInputError(`${who}: field label is missing; use "" for a row not yet labelled.`);
    }
    const label = entry['label'];
    if (typeof label !== 'string' || (label !== '' && !(LABEL_VALUES as readonly string[]).includes(label))) {
      throw new CalibrationInputError(
        `${who}: field label must be one of ${LABEL_VALUES.join(', ')} (or "" when not yet labelled), not ${JSON.stringify(label)}.`,
      );
    }
    const note = entry['note'];
    if (note !== undefined && typeof note !== 'string') {
      throw new CalibrationInputError(`${who}: field note must be a string when present.`);
    }
    if (label !== '') {
      const key = `${run}\0${candidateId}`;
      if (labelled.has(key)) {
        throw new CalibrationInputError(`${who}: candidate_id ${candidateId} is labelled more than once for run ${run}.`);
      }
      labelled.add(key);
    }
    entries.push({ run, candidate_id: candidateId, label: label as LabelEntry['label'], ...(note === undefined ? {} : { note }) });
  });
  return entries;
}

/**
 * The Wilson score interval's 95% lower bound for `k` of `n`, the mirror of
 * `wilsonUpper` in `store/approvals.ts`. Null with nothing to bound, so an
 * empty band never reads as certainly 0 or certainly 1.
 */
export function wilsonLower(k: number, n: number, z = 1.96): number | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/** The Wilson 95% upper bound, for the false-reject share where the cautious end is the high one. */
export function wilsonUpperBound(k: number, n: number, z = 1.96): number | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, (centre + margin) / (1 + z2 / n));
}

/** Rounded for the report wire form, so 8 of 10 reads 0.49 in JSON and 0.490 in text. */
const round3 = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.round(value * 1000) / 1000;

export interface ConfidenceBand {
  band: string;
  min: number;
  max: number;
}

export const CONFIDENCE_BANDS: readonly ConfidenceBand[] = [
  { band: '[0, 0.5)', min: 0, max: 0.5 },
  { band: '[0.5, 0.6)', min: 0.5, max: 0.6 },
  { band: '[0.6, 0.7)', min: 0.6, max: 0.7 },
  { band: '[0.7, 0.8)', min: 0.7, max: 0.8 },
  { band: '[0.8, 0.9)', min: 0.8, max: 0.9 },
  { band: '[0.9, 1.0]', min: 0.9, max: 1 },
];

/** The band index a verifier confidence falls in, or null outside [0, 1]; 1.0 belongs to the last band. */
export function bandIndexOf(confidence: number | null): number | null {
  if (confidence === null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  for (let index = CONFIDENCE_BANDS.length - 1; index >= 0; index -= 1) {
    if (confidence >= CONFIDENCE_BANDS[index]!.min) return index;
  }
  return 0;
}

/** Every spelling a thresholds file may use for one gate, config-file spellings included. */
const THRESHOLD_KEYS: Record<keyof Thresholds, readonly string[]> = {
  technicalConfidence: ['technicalConfidence', 'technical_confidence', 'confidence_threshold', 'confidenceThreshold'],
  minorConfidence: ['minorConfidence', 'minor_confidence', 'minor_confidence_threshold', 'minorConfidenceThreshold'],
  analystOnlyConfidence: ['analystOnlyConfidence', 'analyst_only_confidence', 'analyst_confidence_threshold'],
  finalScore: ['finalScore', 'final_score', 'final_score_threshold', 'finalScoreThreshold'],
};

/**
 * A proposed threshold set from a YAML or JSON file. The document may be the
 * set itself or carry it under `thresholds:` or `review:` (the config file's
 * shape). An unnamed gate keeps its built-in default, an unknown key or a
 * value outside (0, 1] is refused with the key named, and nothing else in
 * the file is read.
 */
export function parseThresholds(text: string, source: string): Thresholds {
  let parsed: unknown;
  const trimmed = text.trim();
  try {
    parsed = trimmed.startsWith('{') ? (JSON.parse(trimmed) as unknown) : parseYaml(text);
  } catch (error) {
    throw new CalibrationInputError(`Cannot parse thresholds ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CalibrationInputError(`thresholds ${source} must be a YAML or JSON object of threshold values.`);
  }
  const doc = parsed as Record<string, unknown>;
  const nested = (key: string): Record<string, unknown> | null => {
    const value = doc[key];
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  };
  const body = nested('thresholds') ?? nested('review') ?? doc;
  const known = new Set<string>([...Object.values(THRESHOLD_KEYS).flat(), 'thresholds', 'review']);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) {
      throw new CalibrationInputError(
        `thresholds ${source}: unknown key ${JSON.stringify(key)}; use ${Object.keys(THRESHOLD_KEYS).join(', ')}.`,
      );
    }
  }
  const result: Thresholds = { ...DEFAULT_THRESHOLDS };
  for (const field of Object.keys(THRESHOLD_KEYS) as (keyof Thresholds)[]) {
    for (const key of THRESHOLD_KEYS[field]) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
        throw new CalibrationInputError(`thresholds ${source}: field ${key} must be a number above 0 and at most 1, not ${JSON.stringify(value)}.`);
      }
      result[field] = value;
    }
  }
  return result;
}

type Record_ = Record<string, unknown>;
const asRecord = (value: unknown): Record_ | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record_) : null;
const asString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

function parseJsonColumn(raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** One scored candidate as the store recorded it, score breakdown joined to its candidate hint. */
export interface StoredCandidate {
  run: string;
  candidateId: string;
  repository: string | null;
  pullNumber: number | null;
  headRef: string | null;
  createdAt: string;
  path: string;
  line: number;
  severity: string;
  category: string;
  claim: string;
  /** The verifier's confidence before any cap; null when no verifier number was recorded. */
  verifierConfidence: number | null;
  technicalConfidence: number | null;
  confidenceSource: string | null;
  finalScore: number | null;
  eligible: boolean | null;
  rejectedBecause: string | null;
  /** The verifier's verdict; null when the breakdown records none and none can be read from its reason. */
  verified: boolean | null;
  material: boolean | null;
  band: number | null;
  /** The raw breakdown, for re-gating fields this summary does not carry. */
  breakdown: Record_;
  candidate: Record_ | null;
}

export interface StoredRun {
  reviewRunId: string;
  repository: string | null;
  pullNumber: number | null;
  headRef: string | null;
  createdAt: string;
  candidates: StoredCandidate[];
}

const VERIFIER_REJECTED = 'the verifier did not verify this claim (verified: false)';

/**
 * The verifier's verdict for one breakdown. An explicit `verified` wins.
 * Otherwise the rejection `scoreCandidate` writes for `verified: false`
 * names a reject, and a breakdown the verifier's confidence gated on
 * (`confidenceSource: verifier`) with no such rejection was verified: the
 * chain reaches the confidence gates only past the `verified: false` check.
 * Anything else records no verdict, and is null rather than a guess.
 */
function verifiedOf(score: Record_, hint: Record_ | null): boolean | null {
  // A breakdown stored since #485 records the verdict, an explicit null meaning none was made.
  if ('verified' in score) return asBoolean(score['verified']);
  const verification = asRecord(score['verification']);
  const explicit = asBoolean(verification?.['verified']) ?? asBoolean(hint?.['verified']);
  if (explicit !== null) return explicit;
  const rejected = asString(score['rejectedBecause']);
  // Only the leading reason names the verdict; text after " Also: " or a quoted verifier reason does not.
  const leading = rejected?.split(' Also: ')[0] ?? null;
  // A rejected low-confidence question is recorded as "technical confidence ... and the verifier
  // rejected this question (verified: false)", which does not lead with the plain rejection.
  if (
    leading !== null &&
    (leading.startsWith(VERIFIER_REJECTED) ||
      (leading.startsWith('technical confidence ') && leading.includes('the verifier rejected this question (verified: false)')))
  ) {
    return false;
  }
  if (score['confidenceSource'] === 'verifier') return true;
  if (score['confidenceSource'] === 'unverifiable-cap' && asNumber(score['verifiedConfidence']) !== null) return true;
  return null;
}

function verifierConfidenceOf(score: Record_): number | null {
  const verification = asRecord(score['verification']);
  return (
    asNumber(score['verifiedConfidence']) ??
    asNumber(score['verifierConfidence']) ??
    asNumber(score['verifier_confidence']) ??
    asNumber(verification?.['technicalConfidence']) ??
    asNumber(verification?.['technical_confidence']) ??
    (score['confidenceSource'] === 'verifier' ? asNumber(score['technicalConfidence']) : null)
  );
}

function severityOf(score: Record_, hint: Record_ | null): string {
  const severity = score['severity'];
  const tier = typeof severity === 'string' ? severity : asString(asRecord(severity)?.['severity']);
  return tier ?? asString(hint?.['severity']) ?? 'unknown';
}

function materialOf(score: Record_, hint: Record_ | null): boolean | null {
  const verification = asRecord(score['verification']);
  return asBoolean(score['material']) ?? asBoolean(verification?.['material']) ?? asBoolean(hint?.['material']);
}

/**
 * Every stored run in scope with its scored candidates, oldest first.
 * A run whose JSON will not parse contributes no candidates; it is not
 * repaired by guessing at its contents.
 */
export function loadStoredRuns(
  db: Database | null,
  filter: { repository?: string | null; since?: string | null } = {},
): StoredRun[] {
  if (db === null) return [];
  const rows = db
    .prepare(
      'SELECT review_run_id, repository, pull_number, head_ref, created_at, candidates_json, output_json ' +
        'FROM review_runs ORDER BY created_at ASC, review_run_id ASC',
    )
    .all() as unknown as Record_[];
  const runs: StoredRun[] = [];
  for (const row of rows) {
    const repository = asString(row['repository']);
    if (filter.repository != null && repository !== filter.repository) continue;
    const createdAt = asString(row['created_at']) ?? '';
    if (filter.since != null && createdAt < filter.since) continue;
    const reviewRunId = asString(row['review_run_id']) ?? '';
    const hints = new Map<string, Record_>();
    const rawHints = parseJsonColumn(row['candidates_json']);
    for (const raw of Array.isArray(rawHints) ? rawHints : []) {
      const hint = asRecord(raw);
      const id = hint === null ? null : (asString(hint['candidate_id']) ?? asString(hint['candidateId']));
      if (hint !== null && id !== null) hints.set(id, hint);
    }
    const output = asRecord(parseJsonColumn(row['output_json']));
    // Context comes from the stored candidate with the same id, held or not (#486). A run stored
    // before that has none for a held candidate: its claim survives as its `held` entry's text,
    // matched by path and line, and its category stays `unknown` rather than borrowed from a finding.
    const held = Array.isArray(output?.['held']) ? (output['held'] as unknown[]) : [];
    const heldText = (path: string, line: number): string | null => {
      for (const raw of held) {
        const entry = asRecord(raw);
        if (entry !== null && entry['path'] === path && entry['line'] === line) return asString(entry['text']);
      }
      return null;
    };
    const candidates: StoredCandidate[] = [];
    for (const raw of Array.isArray(output?.['scores']) ? (output['scores'] as unknown[]) : []) {
      const score = asRecord(raw);
      if (score === null) continue;
      const candidateId = asString(score['candidateId']) ?? asString(score['candidate_id']);
      if (candidateId === null) continue;
      const hint = hints.get(candidateId) ?? null;
      const path = asString(score['path']) ?? asString(hint?.['path']) ?? '';
      const line = asNumber(score['line']) ?? asNumber(hint?.['line']) ?? 0;
      const verifierConfidence = verifierConfidenceOf(score);
      candidates.push({
        run: reviewRunId,
        candidateId,
        repository,
        pullNumber: asNumber(row['pull_number']),
        headRef: asString(row['head_ref']),
        createdAt,
        path,
        line,
        severity: severityOf(score, hint),
        category:
          asString(score['category']) ?? asString(hint?.['category']) ?? 'unknown',
        claim: asString(hint?.['claim']) ?? asString(score['claim']) ?? heldText(path, line) ?? '',
        verifierConfidence,
        technicalConfidence: asNumber(score['technicalConfidence']) ?? asNumber(score['technical_confidence']),
        confidenceSource: asString(score['confidenceSource']),
        finalScore: asNumber(score['finalScore']) ?? asNumber(score['final_score']),
        eligible: asBoolean(score['eligible']),
        rejectedBecause: typeof score['rejectedBecause'] === 'string' ? score['rejectedBecause'] : null,
        verified: verifiedOf(score, hint),
        material: materialOf(score, hint),
        band: bandIndexOf(verifierConfidence),
        breakdown: score,
        candidate: hint,
      });
    }
    runs.push({
      reviewRunId,
      repository,
      pullNumber: asNumber(row['pull_number']),
      headRef: asString(row['head_ref']),
      createdAt,
      candidates,
    });
  }
  return runs;
}

export type LabelCounts = Record<LabelValue, number>;

const emptyCounts = (): LabelCounts => ({ TRUE: 0, 'TRUE-NOT-WORTH': 0, PARTLY: 0, FALSE: 0, UNCHECKABLE: 0 });

export interface PrecisionRow {
  n: number;
  counts: LabelCounts;
  /** (TRUE + TRUE-NOT-WORTH) over those plus FALSE; PARTLY and UNCHECKABLE are reported, never in the denominator. */
  precision: number | null;
  wilsonLower: number | null;
}

function precisionRow(labels: readonly LabelValue[]): PrecisionRow {
  const counts = emptyCounts();
  for (const label of labels) counts[label] += 1;
  const truthy = counts.TRUE + counts['TRUE-NOT-WORTH'];
  const denominator = truthy + counts.FALSE;
  return {
    n: labels.length,
    counts,
    precision: denominator === 0 ? null : round3(truthy / denominator),
    wilsonLower: round3(wilsonLower(truthy, denominator)),
  };
}

export interface BandRow extends PrecisionRow {
  band: string;
  min: number;
  max: number;
}

export interface CategoryRow extends PrecisionRow {
  category: string;
}

interface MatchedLabel {
  candidate: StoredCandidate;
  label: LabelValue;
}

function byBandRows(matched: readonly MatchedLabel[]): BandRow[] {
  return CONFIDENCE_BANDS.map((band, index) => ({
    band: band.band,
    min: band.min,
    max: band.max,
    ...precisionRow(matched.filter((entry) => entry.candidate.band === index).map((entry) => entry.label)),
  }));
}

function byCategoryRows(matched: readonly MatchedLabel[]): CategoryRow[] {
  const categories = [...new Set(matched.map((entry) => entry.candidate.category))].sort();
  return categories.map((category) => ({
    category,
    ...precisionRow(matched.filter((entry) => entry.candidate.category === category).map((entry) => entry.label)),
  }));
}

const HOLD_REASONS: readonly HoldReason[] = [
  'confidenceFloor',
  'materiality',
  'ownerPrecedent',
  'unverifiable',
  'score',
  'policy',
  'other',
];

const emptyHolds = (): Record<HoldReason, number> =>
  Object.fromEntries(HOLD_REASONS.map((reason) => [reason, 0])) as Record<HoldReason, number>;

export interface EligiblePerReview {
  mean: number | null;
  median: number | null;
  max: number | null;
}

function eligiblePerReview(perRun: readonly number[]): EligiblePerReview {
  if (perRun.length === 0) return { mean: null, median: null, max: null };
  const sorted = [...perRun].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    mean: round3(perRun.reduce((sum, value) => sum + value, 0) / perRun.length),
    median: round3(median),
    max: sorted[sorted.length - 1]!,
  };
}

export interface VolumeStats {
  /** Runs with at least one stored score breakdown; a run that recorded none says nothing about volume. */
  reviews: number;
  candidates: number;
  eligible: number;
  eligiblePerReview: EligiblePerReview;
  holdsByReason: Record<HoldReason, number>;
}

function currentVolume(runs: readonly StoredRun[]): VolumeStats {
  const scored = runs.filter((run) => run.candidates.length > 0);
  const holds = emptyHolds();
  let candidates = 0;
  let eligible = 0;
  const perRun: number[] = [];
  for (const run of scored) {
    let runEligible = 0;
    for (const candidate of run.candidates) {
      candidates += 1;
      if (candidate.eligible === true) {
        eligible += 1;
        runEligible += 1;
      } else {
        holds[holdReasonOf(candidate.rejectedBecause, candidate.breakdown['gate']) ?? 'other'] += 1;
      }
    }
    perRun.push(runEligible);
  }
  return { reviews: scored.length, candidates, eligible, eligiblePerReview: eligiblePerReview(perRun), holdsByReason: holds };
}

export interface NotReapplicableEntry {
  run: string;
  candidate_id: string;
  reason: string;
}

export interface ProposedVolume extends VolumeStats {
  thresholds: Thresholds;
  notReapplicable: { count: number; byReason: Record<string, number>; entries: NotReapplicableEntry[] };
}

/** The derived tier from the breakdown alone; a hint's requested tier would be a guess at it. */
function strictTier(candidate: StoredCandidate): unknown {
  const severity = candidate.breakdown['severity'];
  return typeof severity === 'string' ? severity : asRecord(severity)?.['severity'];
}

/** The recorded category from the breakdown or its hint; the finding fallback and the `unknown` default are not recorded categories. */
function strictCategory(candidate: StoredCandidate): unknown {
  return candidate.breakdown['category'] ?? candidate.candidate?.['category'];
}

function proposedVolume(runs: readonly StoredRun[], thresholds: Thresholds): ProposedVolume {
  const scored = runs.filter((run) => run.candidates.length > 0);
  const holds = emptyHolds();
  const byReason: Record<string, number> = {};
  const entries: NotReapplicableEntry[] = [];
  let candidates = 0;
  let eligible = 0;
  const perRun: number[] = [];
  for (const run of scored) {
    let runEligible = 0;
    for (const candidate of run.candidates) {
      candidates += 1;
      const result = reGateBreakdown(
        {
          eligible: candidate.breakdown['eligible'],
          rejectedBecause: candidate.breakdown['rejectedBecause'],
          gate: candidate.breakdown['gate'],
          technicalConfidence: candidate.breakdown['technicalConfidence'],
          confidenceSource: candidate.breakdown['confidenceSource'],
          finalScore: candidate.breakdown['finalScore'],
          severityTier: strictTier(candidate),
          category: strictCategory(candidate),
          ownerPromotion: candidate.breakdown['ownerPromotion'],
        },
        thresholds,
      );
      if (!result.reapplicable) {
        byReason[result.reason] = (byReason[result.reason] ?? 0) + 1;
        entries.push({ run: candidate.run, candidate_id: candidate.candidateId, reason: result.reason });
      } else if (result.eligible) {
        eligible += 1;
        runEligible += 1;
      } else {
        holds[result.hold ?? 'other'] += 1;
      }
    }
    perRun.push(runEligible);
  }
  entries.sort((a, b) => a.run.localeCompare(b.run) || a.candidate_id.localeCompare(b.candidate_id));
  return {
    thresholds,
    reviews: scored.length,
    candidates,
    eligible,
    eligiblePerReview: eligiblePerReview(perRun),
    holdsByReason: holds,
    notReapplicable: { count: entries.length, byReason, entries },
  };
}

export interface UnmatchedLabel {
  run: string;
  candidate_id: string;
  label: LabelValue;
  reason: string;
}

export interface CalibrationReport {
  labels: {
    total: number;
    labelled: number;
    blank: number;
    matched: number;
    unmatched: UnmatchedLabel[];
  };
  precision: {
    byBand: BandRow[];
    byCategory: CategoryRow[];
    verified: { byBand: BandRow[]; byCategory: CategoryRow[] };
    rejected: { byBand: BandRow[]; byCategory: CategoryRow[] };
    /** Matched labels whose breakdown recorded no verifier confidence to band by. */
    unbanded: number;
    /** Matched labels whose breakdown records no verifier verdict, in neither split above. */
    unknownVerified: number;
  };
  volume: { current: VolumeStats; proposed?: ProposedVolume };
  materiality: {
    n: number;
    /** `material` against TRUE / TRUE-NOT-WORTH; a material true finding the labeller calls TRUE agrees. */
    table: { true: { TRUE: number; 'TRUE-NOT-WORTH': number }; false: { TRUE: number; 'TRUE-NOT-WORTH': number } };
    agreement: number | null;
  };
  rejectionAudit: {
    n: number;
    falseRejects: number;
    counts: LabelCounts;
    rate: number | null;
    wilsonLower: number | null;
    wilsonUpper: number | null;
  };
}

/**
 * The calibration report over one labelled set. Precision, materiality and
 * the rejection audit count matched labels only; volume counts every stored
 * breakdown in scope, labelled or not, since a threshold's effect on volume
 * is a property of the stored runs rather than of the sample that was
 * labelled. A `--repository` filter scopes both.
 */
export function calibrationReport(
  db: Database | null,
  labels: readonly LabelEntry[],
  options: { repository?: string | null; thresholds?: Thresholds | null } = {},
): CalibrationReport {
  const allRuns = loadStoredRuns(db);
  const runs =
    options.repository == null ? allRuns : allRuns.filter((run) => run.repository === options.repository);
  const knownRuns = new Set(allRuns.map((run) => run.reviewRunId));
  const byKey = new Map<string, StoredCandidate>();
  for (const run of runs) {
    for (const candidate of run.candidates) byKey.set(`${candidate.run}\0${candidate.candidateId}`, candidate);
  }
  const matched: MatchedLabel[] = [];
  const unmatched: UnmatchedLabel[] = [];
  let blank = 0;
  for (const entry of labels) {
    if (entry.label === '') {
      blank += 1;
      continue;
    }
    const candidate = byKey.get(`${entry.run}\0${entry.candidate_id}`);
    if (candidate === undefined) {
      unmatched.push({
        run: entry.run,
        candidate_id: entry.candidate_id,
        label: entry.label,
        reason: !knownRuns.has(entry.run)
          ? 'unknown run'
          : options.repository != null && !runs.some((run) => run.reviewRunId === entry.run)
            ? 'run outside --repository filter'
            : 'unknown candidate',
      });
      continue;
    }
    matched.push({ candidate, label: entry.label });
  }
  const verified = matched.filter((entry) => entry.candidate.verified === true);
  const rejected = matched.filter((entry) => entry.candidate.verified === false);
  const table = {
    true: { TRUE: 0, 'TRUE-NOT-WORTH': 0 },
    false: { TRUE: 0, 'TRUE-NOT-WORTH': 0 },
  };
  for (const entry of matched) {
    if (entry.candidate.material === null) continue;
    if (entry.label !== 'TRUE' && entry.label !== 'TRUE-NOT-WORTH') continue;
    table[entry.candidate.material ? 'true' : 'false'][entry.label] += 1;
  }
  const materialityN = table.true.TRUE + table.true['TRUE-NOT-WORTH'] + table.false.TRUE + table.false['TRUE-NOT-WORTH'];
  const rejectedCounts = emptyCounts();
  for (const entry of rejected) rejectedCounts[entry.label] += 1;
  const falseRejects = rejectedCounts.TRUE + rejectedCounts['TRUE-NOT-WORTH'];
  return {
    labels: {
      total: labels.length,
      labelled: labels.length - blank,
      blank,
      matched: matched.length,
      unmatched,
    },
    precision: {
      byBand: byBandRows(matched),
      byCategory: byCategoryRows(matched),
      verified: { byBand: byBandRows(verified), byCategory: byCategoryRows(verified) },
      rejected: { byBand: byBandRows(rejected), byCategory: byCategoryRows(rejected) },
      unbanded: matched.filter((entry) => entry.candidate.band === null).length,
      unknownVerified: matched.filter((entry) => entry.candidate.verified === null).length,
    },
    volume: {
      current: currentVolume(runs),
      ...(options.thresholds == null ? {} : { proposed: proposedVolume(runs, options.thresholds) }),
    },
    materiality: {
      n: materialityN,
      table,
      agreement:
        materialityN === 0 ? null : round3((table.true.TRUE + table.false['TRUE-NOT-WORTH']) / materialityN),
    },
    rejectionAudit: {
      n: rejected.length,
      falseRejects,
      counts: rejectedCounts,
      rate: rejected.length === 0 ? null : round3(falseRejects / rejected.length),
      wilsonLower: round3(wilsonLower(falseRejects, rejected.length)),
      wilsonUpper: round3(wilsonUpperBound(falseRejects, rejected.length)),
    },
  };
}

/** FNV-1a over the seed text, so any seed string seeds the same stream on every machine. */
function seedHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A mulberry32 stream: small, seeded and identical across runs and platforms. */
export function seededRandom(seed: string): () => number {
  let state = seedHash(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StratumStats {
  stratum: string;
  pool: number;
  sampled: number;
}

export interface SampleResult {
  selected: StoredCandidate[];
  strata: StratumStats[];
  /** Stored candidates with no band or no verifier verdict; no stratum can hold them. */
  unstratified: number;
}

const stratumOf = (candidate: StoredCandidate): string | null =>
  candidate.band === null || candidate.verified === null
    ? null
    : `${CONFIDENCE_BANDS[candidate.band]!.band}|${candidate.verified ? 'verified' : 'rejected'}`;

/**
 * A stratified draw over band crossed with verified-or-rejected.
 * Allocation is proportional by largest remainder, then any empty stratum
 * takes one seat from the largest allocation above one, so every non-empty
 * stratum is represented whenever `n` reaches the stratum count. Within a
 * stratum a seeded shuffle decides, over candidates sorted by run and id,
 * so the same seed over the same store selects the same candidates.
 */
export function sampleCandidates(
  pool: readonly StoredCandidate[],
  request: { n: number; seed: string },
): SampleResult {
  const groups = new Map<string, StoredCandidate[]>();
  let unstratified = 0;
  for (const candidate of pool) {
    const stratum = stratumOf(candidate);
    if (stratum === null) {
      unstratified += 1;
      continue;
    }
    groups.set(stratum, [...(groups.get(stratum) ?? []), candidate]);
  }
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    groups.get(key)!.sort((a, b) => a.run.localeCompare(b.run) || a.candidateId.localeCompare(b.candidateId));
  }
  const total = keys.reduce((sum, key) => sum + groups.get(key)!.length, 0);
  const wanted = Math.min(request.n, total);
  const allocation = new Map<string, number>();
  if (total > 0 && wanted > 0) {
    const remainders: { key: string; fraction: number }[] = [];
    let assigned = 0;
    for (const key of keys) {
      const raw = (wanted * groups.get(key)!.length) / total;
      const base = Math.min(Math.floor(raw), groups.get(key)!.length);
      allocation.set(key, base);
      assigned += base;
      remainders.push({ key, fraction: raw - Math.floor(raw) });
    }
    remainders.sort(
      (a, b) =>
        b.fraction - a.fraction || groups.get(b.key)!.length - groups.get(a.key)!.length || a.key.localeCompare(b.key),
    );
    for (const { key } of remainders) {
      if (assigned >= wanted) break;
      if (allocation.get(key)! >= groups.get(key)!.length) continue;
      allocation.set(key, allocation.get(key)! + 1);
      assigned += 1;
    }
    if (wanted >= keys.length) {
      for (const key of keys) {
        if (allocation.get(key)! > 0) continue;
        const donor = keys
          .filter((other) => allocation.get(other)! > 1)
          .sort((a, b) => allocation.get(b)! - allocation.get(a)! || b.localeCompare(a))[0];
        if (donor === undefined) break;
        allocation.set(donor, allocation.get(donor)! - 1);
        allocation.set(key, 1);
      }
    }
  } else {
    for (const key of keys) allocation.set(key, 0);
  }
  const random = seededRandom(request.seed);
  const selected: StoredCandidate[] = [];
  const strata: StratumStats[] = [];
  for (const key of keys) {
    const group = [...groups.get(key)!];
    for (let index = group.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [group[index], group[swap]] = [group[swap]!, group[index]!];
    }
    const take = allocation.get(key) ?? 0;
    selected.push(...group.slice(0, take));
    strata.push({ stratum: key, pool: group.length, sampled: take });
  }
  selected.sort((a, b) => a.run.localeCompare(b.run) || a.candidateId.localeCompare(b.candidateId));
  return { selected, strata, unstratified };
}

/**
 * One labelling-sheet row: the labels-file fields with an empty `label`,
 * plus the context a labeller needs to judge the claim. Key order is fixed
 * so the same selection serialises byte-identically.
 */
export function labellingSheet(selected: readonly StoredCandidate[]): Record<string, unknown>[] {
  return selected.map((candidate) => ({
    run: candidate.run,
    candidate_id: candidate.candidateId,
    label: '',
    repository: candidate.repository,
    pull_number: candidate.pullNumber,
    head_sha: candidate.headRef,
    path: candidate.path,
    line: candidate.line,
    location: `${candidate.path}:${candidate.line}`,
    severity: candidate.severity,
    category: candidate.category,
    claim: candidate.claim,
    verifier_confidence: candidate.verifierConfidence,
    verified: candidate.verified,
    band: candidate.band === null ? null : CONFIDENCE_BANDS[candidate.band]!.band,
  }));
}

const fixed3 = (value: number | null): string => (value === null ? 'no data' : value.toFixed(3));

const HOLD_TEXT: Record<HoldReason, string> = {
  confidenceFloor: 'confidence floor',
  materiality: 'materiality',
  ownerPrecedent: 'owner precedent',
  unverifiable: 'unverifiable',
  score: 'score',
  policy: 'policy',
  other: 'other',
};

function bandTable(title: string, rows: readonly BandRow[]): string[] {
  const lines = [
    title,
    '  band          n  TRUE  NOT-WORTH  PARTLY  FALSE  UNCHECKABLE  precision  wilson95lower',
  ];
  for (const row of rows) {
    lines.push(
      `  ${row.band.padEnd(12)} ${String(row.n).padStart(2)}  ${String(row.counts.TRUE).padStart(4)}  ` +
        `${String(row.counts['TRUE-NOT-WORTH']).padStart(9)}  ${String(row.counts.PARTLY).padStart(6)}  ` +
        `${String(row.counts.FALSE).padStart(5)}  ${String(row.counts.UNCHECKABLE).padStart(11)}  ` +
        `${fixed3(row.precision).padStart(9)}  ${fixed3(row.wilsonLower).padStart(13)}`,
    );
  }
  return lines;
}

function categoryTable(title: string, rows: readonly CategoryRow[]): string[] {
  const lines = [title, '  category        n  TRUE  NOT-WORTH  PARTLY  FALSE  UNCHECKABLE  precision  wilson95lower'];
  if (rows.length === 0) lines.push('  no labelled candidates');
  for (const row of rows) {
    lines.push(
      `  ${row.category.padEnd(14)} ${String(row.n).padStart(2)}  ${String(row.counts.TRUE).padStart(4)}  ` +
        `${String(row.counts['TRUE-NOT-WORTH']).padStart(9)}  ${String(row.counts.PARTLY).padStart(6)}  ` +
        `${String(row.counts.FALSE).padStart(5)}  ${String(row.counts.UNCHECKABLE).padStart(11)}  ` +
        `${fixed3(row.precision).padStart(9)}  ${fixed3(row.wilsonLower).padStart(13)}`,
    );
  }
  return lines;
}

function volumeLines(title: string, volume: VolumeStats): string[] {
  const holds = HOLD_REASONS.map((reason) => `${HOLD_TEXT[reason]} ${volume.holdsByReason[reason]}`).join(', ');
  return [
    `${title}: ${volume.eligible} eligible of ${volume.candidates} candidates in ${volume.reviews} review(s); ` +
      `eligible per review mean ${fixed3(volume.eligiblePerReview.mean)}, median ${fixed3(volume.eligiblePerReview.median)}, ` +
      `max ${volume.eligiblePerReview.max === null ? 'no data' : volume.eligiblePerReview.max}`,
    `  holds by reason: ${holds}`,
  ];
}

/** The readable form of the calibration report, for `--text`. */
export function formatCalibrationText(report: CalibrationReport): string {
  const lines: string[] = [
    `Calibration: ${report.labels.matched} matched label(s) of ${report.labels.labelled} labelled ` +
      `(${report.labels.blank} blank, ${report.labels.unmatched.length} unmatched)`,
    '',
    ...bandTable('Precision by band', report.precision.byBand),
    '',
    ...bandTable('Precision by band (verified)', report.precision.verified.byBand),
    '',
    ...bandTable('Precision by band (verifier-rejected)', report.precision.rejected.byBand),
    '',
    ...categoryTable('Precision by category', report.precision.byCategory),
    '',
    ...categoryTable('Precision by category (verified)', report.precision.verified.byCategory),
    '',
    ...categoryTable('Precision by category (verifier-rejected)', report.precision.rejected.byCategory),
    '',
  ];
  if (report.precision.unbanded > 0 || report.precision.unknownVerified > 0) {
    lines.push(
      `Not split: ${report.precision.unbanded} matched label(s) with no verifier confidence recorded, ` +
        `${report.precision.unknownVerified} with no verifier verdict recorded`,
      '',
    );
  }
  lines.push(...volumeLines('Volume under the recorded thresholds', report.volume.current));
  if (report.volume.proposed !== undefined) {
    const proposed = report.volume.proposed;
    const set = proposed.thresholds;
    lines.push(
      ...volumeLines(
        `Volume under the proposed thresholds (technicalConfidence ${set.technicalConfidence}, ` +
          `minorConfidence ${set.minorConfidence}, analystOnlyConfidence ${set.analystOnlyConfidence}, finalScore ${set.finalScore})`,
        proposed,
      ),
    );
    lines.push(`  not reapplicable: ${proposed.notReapplicable.count} breakdown(s) lacking a field needed to re-gate`);
    for (const [reason, count] of Object.entries(proposed.notReapplicable.byReason).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`    ${reason}: ${count}`);
    }
  }
  const materiality = report.materiality;
  lines.push(
    '',
    materiality.n === 0
      ? 'Materiality agreement: n 0 (no breakdown or verification records material)'
      : `Materiality agreement: n ${materiality.n}, agreement ${fixed3(materiality.agreement)} ` +
        `(material true: TRUE ${materiality.table.true.TRUE}, TRUE-NOT-WORTH ${materiality.table.true['TRUE-NOT-WORTH']}; ` +
        `material false: TRUE ${materiality.table.false.TRUE}, TRUE-NOT-WORTH ${materiality.table.false['TRUE-NOT-WORTH']})`,
    '',
    `Rejection audit: ${report.rejectionAudit.falseRejects} false reject(s) of ${report.rejectionAudit.n} labelled ` +
      `verifier-rejected candidate(s), rate ${fixed3(report.rejectionAudit.rate)}, ` +
      `Wilson 95% lower ${fixed3(report.rejectionAudit.wilsonLower)}, upper ${fixed3(report.rejectionAudit.wilsonUpper)}`,
  );
  if (report.labels.unmatched.length > 0) {
    lines.push('', 'Unmatched labels (not counted):');
    for (const entry of report.labels.unmatched) {
      lines.push(`  run ${entry.run} candidate_id ${entry.candidate_id} label ${entry.label}: ${entry.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
