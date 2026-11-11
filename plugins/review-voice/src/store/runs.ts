import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Database } from './db.ts';
import { recordAudit } from './audit.ts';
import { activePolicyVersions } from '../policy/versions.ts';
import { ruleIdFor } from '../policy/rules.ts';
import { splitFindings, parseFinding } from '../contract/parse.ts';
import { parseReviewScope, type ReviewScope } from '../diff/incremental.ts';
import { parseComplexity, type ComplexityAssessment } from '../diff/complexity.ts';
import { matchCarried, type CarriedFinding } from '../diff/carry.ts';
import type { RemovedControlKind } from '../diff/removed-controls.ts';
import type { RiskMarkerKind } from '../diff/risk-markers.ts';
import type { TieBreak } from '../verify/reconcile.ts';
import type { FollowUpState } from './follow-ups.ts';
import type { VerifiedSimplification } from '../simplification.ts';
import { suggestedPatchOf, type SuggestedPatch } from '../scoring/score.ts';
import { redact } from '../redact/redact.ts';
import type { EvidenceSignal } from '../evidence/types.ts';
import type { ReproductionRecord, ReproductionRun } from '../evidence/reproduce.ts';
import { flatten, MACHINE_PATH } from '../publish/evidence-block.ts';
import { FAMILIES, type Family } from '../agents/types.ts';

export interface StoredFinding {
  findingId: string;
  severity: string;
  path: string;
  line: number;
  text: string;
  /**
   * Carried from the candidate that produced this finding. The rendered output
   * has no category - the contract allows no text beyond the finding - so it
   * has to arrive alongside rather than be parsed back out.
   */
  category?: string | undefined;
  /**
   * How this finding was paired with its candidate, when the analyst's cited
   * path and the rendered one disagreed.
   */
  attributedBy?: 'basename' | 'line' | undefined;
  /** True when candidates were supplied and none could be paired with this. */
  unattributed?: boolean | undefined;
  /** The earlier run and finding this one was carried forward from, unchanged. */
  carriedFrom?: { runId: string; findingId: string } | undefined;
  /**
   * This finding follows up the owner's earlier comment, which the author only
   * partly addressed, and records what was still open at this run. It stays as
   * recorded; a later run of the same pull request records whether it is still
   * open or resolved, in its `followUps` (see `store/follow-ups.ts`). The
   * follow-up is posted as an ordinary inline comment.
   */
  partlyAddressed?: PartlyAddressedFinding | undefined;
  /** The lane of the candidate this finding came from; `diff` when none (docs/adr/0023). */
  lane?: string | undefined;
  /** The candidate's claimed blocker class, when it claimed one. */
  blockerClass?: string | undefined;
  /**
   * What kind of finding this is: `category:lane` or `category:lane:blocker_class`
   * (docs/adr/0032). Absent when no candidate classified it, because a rule
   * cannot be keyed on a category nothing recorded.
   */
  ruleId?: string | undefined;
  /**
   * The candidate's replacement for the lines ending at its anchor. Kept as
   * the candidate gave it even when the finding was moved since, so posting can
   * withhold the block and say why (docs/adr/0033).
   */
  suggestedPatch?: SuggestedPatch | undefined;
  /**
   * Where the patch was written and by which candidate: a block posts only on
   * that file, from that candidate's own verified fix (docs/adr/0033).
   */
  suggestedPatchSource?: { path: string; candidateId: string | null } | undefined;
  /**
   * The first static signal on this finding's own path and line, from
   * `record --evidence`. The same line only, because a candidate restating a
   * nearby signal was already held as `restates-tool`, so this is a tool that
   * spoke about the line in other words. The text is redacted and capped.
   */
  toolSignal?: { tool: string; line: number; text: string } | undefined;
  /**
   * Convention quotes the analyst cited that occur verbatim in the named
   * document, from `record --conventions`. A paraphrase is never stored here.
   */
  conventionQuotes?: { path: string; quote: string }[] | undefined;
  /** The candidate whose evidence cited the quotes; they post only beside that candidate's score. */
  conventionQuotesCandidate?: string | null | undefined;
}

export interface PartlyAddressedFinding {
  status: 'partly-addressed';
  /**
   * The earlier comment, where it sat when this review read the thread, and
   * its GitHub id when the thread file carried it.
   */
  prior: { author: string; path: string; line: number; commentId?: number };
  remaining: string[];
  addressed: string[];
}

/**
 * The partly-addressed state a scored candidate carries from `score`, as
 * `possibleRepeatOf` of `kind: own-comment` and `status: partly-addressed`.
 * Anything else is no state, not an error: the finding is then recorded as an
 * ordinary one.
 */
export function partlyAddressedOf(value: unknown): PartlyAddressedFinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v['kind'] !== 'own-comment' || v['status'] !== 'partly-addressed') return undefined;
  const strings = (list: unknown): string[] | null =>
    Array.isArray(list) && list.length > 0 && list.every((item) => typeof item === 'string') ? (list as string[]) : null;
  const remaining = strings(v['remaining']);
  const addressed = strings(v['addressed']);
  if (remaining === null || addressed === null) return undefined;
  if (typeof v['author'] !== 'string' || typeof v['path'] !== 'string' || !Number.isInteger(v['line'])) return undefined;
  return {
    status: 'partly-addressed',
    prior: {
      author: v['author'],
      path: v['path'],
      line: v['line'] as number,
      ...(Number.isInteger(v['commentId']) ? { commentId: v['commentId'] as number } : {}),
    },
    remaining,
    addressed,
  };
}

/**
 * Why a candidate was held back rather than reported.
 *
 * `below-gate` is a verified finding whose score fell short of the gate. It
 * says nothing against the finding, so the next review never treats it as a
 * reason to drop the same candidate.
 *
 * `owner-declined` is the owner's answer to a held finding put to them: not
 * worth posting. It is set after the run by `decline` (#173) and holds a
 * repeat back like `refuted`, including on a related pull request.
 *
 * `challenge-refuted` and `challenge-partly` come from the independent
 * challenge (docs/adr/0024), and hold a later repeat back like `refuted` and
 * `partly`.
 *
 * `policy-suppressed` is a verified finding the owner's approved policy holds
 * back (docs/adr/0032). Like `below-gate` it says nothing against the finding:
 * it is preference, so the owner can still post it and a later review never
 * treats it as a reason to drop the same candidate.
 *
 * `restates-tool` is a candidate that repeats a static-analysis signal at the
 * same place (docs/adr/0003). It is not carried to the next head: the tool
 * reports the defect again there, so nothing needs remembering.
 *
 * `reproduction-did-not-fail` is a finding whose reproduction passed at least
 * once in the confined runner (S16). It is not carried to the next head either:
 * the reproduction runs again there, so `carriedHeldFindings` does not list it.
 */
export type HeldVerdict =
  | 'partly'
  | 'refuted'
  | 'unverified'
  | 'repeat'
  | 'below-gate'
  | 'policy-suppressed'
  | 'owner-declined'
  | 'challenge-refuted'
  | 'challenge-partly'
  | 'restates-tool'
  | 'reproduction-did-not-fail';

export interface HeldFinding {
  path: string;
  line: number;
  verdict: HeldVerdict;
  /** What held it back: a verifier, a cross-check, or the existing thread. */
  source: string;
  reason: string;
  severity?: string | undefined;
  candidateId?: string | undefined;
  text?: string | undefined;
}

export const HELD_VERDICTS: readonly HeldVerdict[] = [
  'partly',
  'refuted',
  'unverified',
  'repeat',
  'below-gate',
  'policy-suppressed',
  'owner-declined',
  'challenge-refuted',
  'challenge-partly',
  'restates-tool',
  'reproduction-did-not-fail',
];

/**
 * A hold for a challenge the configuration asked for and did not get. Nothing
 * judged the finding, so the hold caps the verdict and a carry keeps it (docs/adr/0024).
 */
export function challengeNotRun(entry: HeldFinding): boolean {
  return typeof entry.reason === 'string' && entry.reason.startsWith('challenger not run:');
}

/** Null when the entry is well formed, else what is wrong with it. */
export function heldProblem(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'not an object';
  const e = entry as Record<string, unknown>;
  if (typeof e['path'] !== 'string' || e['path'].length === 0) return 'path must be a non-empty string';
  if (!Number.isInteger(e['line']) || (e['line'] as number) < 1) return 'line must be a positive integer';
  if (!HELD_VERDICTS.includes(e['verdict'] as HeldVerdict)) return `verdict must be one of ${HELD_VERDICTS.join(', ')}`;
  for (const key of ['source', 'reason'] as const) {
    const value = e[key];
    if (typeof value !== 'string' || value.trim().length === 0) return `${key} must be a non-empty string`;
  }
  for (const key of ['severity', 'candidateId', 'text'] as const) {
    if (e[key] !== undefined && typeof e[key] !== 'string') return `${key} must be a string when present`;
  }
  return null;
}

/**
 * A run built from candidates carried to a pushed head (docs/adr/0017).
 *
 * `covered` is true only when the commits between the two heads were reviewed
 * and no candidate was refused. A run that is not covered never approves, and
 * a run carried from it inherits the marker.
 */
export interface CarryMarker {
  since: string;
  head: string;
  interdiffReviewed: boolean;
  refused: string[];
  covered: boolean;
  /** The run this marker was inherited from, when it was. */
  inheritedFrom?: string | undefined;
}

/** The marker as stored, or null when it is absent or not one. */
export function parseCarryMarker(value: unknown): CarryMarker | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['since'] !== 'string' || typeof v['head'] !== 'string') return null;
  const refused = Array.isArray(v['refused']) ? v['refused'].filter((id): id is string => typeof id === 'string') : [];
  const interdiffReviewed = v['interdiffReviewed'] === true;
  return {
    since: v['since'],
    head: v['head'],
    interdiffReviewed,
    refused,
    // Recomputed rather than trusted, so a hand-edited row cannot claim cover.
    covered: interdiffReviewed && refused.length === 0 && v['covered'] === true,
    ...(typeof v['inheritedFrom'] === 'string' ? { inheritedFrom: v['inheritedFrom'] } : {}),
  };
}

/** Raised when a recorded finding repeats a carried one but sits on another line. */
export class CarryMismatch extends Error {}

/** Just enough of a scored candidate to attribute a finding to its category. */
export interface CandidateHint {
  path: string;
  line: number;
  category?: string | undefined;
  lane?: unknown;
  blocker_class?: unknown;
  blockerClass?: unknown;
  /** As `score` hands it on; read with `partlyAddressedOf`. */
  possibleRepeatOf?: unknown;
  /** As `score` hands it on; read with `suggestedPatchOf`. */
  suggested_patch?: unknown;
  /** The candidate this hint was scored as, so a patch is tied to its own verified fix. */
  candidate_id?: unknown;
  /** The analyst's evidence strings, read for the convention quotes they cite. */
  evidence?: unknown;
}

export const ORIGINS = ['driver', 'interactive', 'watch', 'action'] as const;
export type RunOrigin = (typeof ORIGINS)[number];
export const PROVENANCE_MODES = ['fast', 'standard', 'thorough'] as const;
export type ProvenanceMode = (typeof PROVENANCE_MODES)[number];

export type Independence = 'independent' | 'not-independent';

/**
 * The label is derived from the origin and from nothing else, so it cannot be
 * stored out of step with it. An interactive review ran inside the host session
 * that may have written the change; every other origin starts fresh agents on a
 * committed head.
 */
export function independenceOf(origin: RunOrigin): Independence {
  return origin === 'interactive' ? 'not-independent' : 'independent';
}

export interface PolicyVersionRef {
  scopeType: string;
  scopeKey: string;
  policyId: string;
  version: number;
}

/** What produced a run: where it came from, with which versions, under which policy. */
export interface RunProvenance {
  origin: RunOrigin;
  independence: Independence;
  pluginVersion: string;
  /** The first line of `claude --version`; null when it could not be read. */
  claudeVersion: string | null;
  /** The plan's cost mode; null for the slash command, which has no plan. */
  mode: ProvenanceMode | null;
  /** The active approved policy rows at record time. */
  policyVersions: PolicyVersionRef[];
}

/** The caller supplies everything but the policy rows, which `recordRun` reads itself. */
export type RunProvenanceInput = Omit<RunProvenance, 'independence' | 'policyVersions'> &
  Partial<Pick<RunProvenance, 'independence' | 'policyVersions'>>;

/**
 * Which model family ran each cross-checking stage (docs/adr/0021, amended).
 * Stored beside the provenance, not in it: the independence label keeps its
 * two values, and a family is a separate recorded fact.
 */
export interface RunFamilies {
  /** `unknown` when verdicts exist without a family; null when there was no second pass. */
  secondPass: Family | 'unknown' | null;
  /** Null when no challenge stage ran. */
  challenge: Family | null;
}

const isFamily = (value: unknown): value is Family => (FAMILIES as readonly unknown[]).includes(value);

/** The `Families` line the driver report and `explain` print. */
export function describeFamilies(families: RunFamilies | null): string {
  if (families === null) return 'Families not recorded';
  return `Families second-pass ${families.secondPass ?? 'none'}, challenge ${families.challenge ?? 'none'}`;
}

/**
 * Derived from the record, never trusted: the first second-pass verdict's
 * family, and the challenge stage's, `claude` when it names none (the only
 * runner before families were recorded).
 */
function familiesOf(verdicts: unknown, stages: readonly StageTiming[]): RunFamilies {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const first = list.length === 0 ? undefined : (asRecord(list[0])?.['family'] as unknown);
  const challenge = stages.find((stage) => stage.name === 'challenge');
  return {
    secondPass: list.length === 0 ? null : isFamily(first) ? first : 'unknown',
    challenge: challenge === undefined ? null : isFamily(challenge.family) ? challenge.family : 'claude',
  };
}

const reportedFamilies = new Set<string>();

/** The stored families, or null for a row without the key; a malformed value is null too, said once on stderr. */
export function storedFamilies(raw: unknown, reviewRunId: string): RunFamilies | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = asRecord(JSON.parse(raw))?.['families'];
  } catch {
    return null;
  }
  if (value === undefined) return null;
  const v = asRecord(value);
  const secondPass = v?.['secondPass'];
  const challenge = v?.['challenge'];
  if (v !== null && (secondPass === null || secondPass === 'unknown' || isFamily(secondPass)) && (challenge === null || isFamily(challenge))) {
    return { secondPass: secondPass as RunFamilies['secondPass'], challenge: challenge as Family | null };
  }
  if (!reportedFamilies.has(reviewRunId)) {
    reportedFamilies.add(reviewRunId);
    console.error(`The families recorded for run ${reviewRunId} are malformed; reading them as not recorded.`);
  }
  return null;
}

/**
 * The `Provenance` line `explain` and the driver report print, and `status`
 * borrows the origin clause of.
 */
export function describeProvenance(provenance: RunProvenance | null): string {
  if (provenance === null) return 'Provenance not recorded';
  const policy =
    provenance.policyVersions.length === 0
      ? 'none'
      : provenance.policyVersions.map((p) => `${p.scopeType}/${p.scopeKey} v${p.version}`).join(', ');
  return (
    `Provenance ${describeOrigin(provenance)}, plugin ${provenance.pluginVersion}, ` +
    `claude ${provenance.claudeVersion ?? 'unknown'}, mode ${provenance.mode ?? 'unknown'}, policy ${policy}`
  );
}

/** `origin <origin> (<label>)`. */
export function describeOrigin(provenance: Pick<RunProvenance, 'origin' | 'independence'>): string {
  return `origin ${provenance.origin} (${provenance.independence})`;
}

/**
 * The approved policy versions a stored run was held to, from its own column,
 * or null when the run is missing or the column is empty or will not parse.
 * Read on its own rather than through the provenance, because a run recorded
 * before provenance existed still has the column, and a carry of that run
 * must keep those versions rather than take whatever is active now.
 */
export function storedPolicyVersions(db: Database, runId: string): PolicyVersionRef[] | null {
  const row = db.prepare('SELECT active_policy_versions_json FROM review_runs WHERE review_run_id = ?').get(runId) as
    | { active_policy_versions_json: string | null }
    | undefined;
  if (row === undefined || row.active_policy_versions_json === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.active_policy_versions_json);
    if (!Array.isArray(parsed)) return null;
    const versions: PolicyVersionRef[] = [];
    for (const entry of parsed) {
      const p = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      if (typeof p['scopeType'] !== 'string' || typeof p['scopeKey'] !== 'string' || typeof p['policyId'] !== 'string' || typeof p['version'] !== 'number') return null;
      versions.push({ scopeType: p['scopeType'], scopeKey: p['scopeKey'], policyId: p['policyId'], version: p['version'] });
    }
    return versions;
  } catch {
    return null;
  }
}

const reportedProvenance = new Set<string>();

/** The stored provenance, or null when absent or not one; a malformed value is said once on stderr. */
function storedProvenance(raw: unknown, reviewRunId: string): RunProvenance | null {
  if (typeof raw !== 'string') return null;
  const malformed = (): null => {
    if (!reportedProvenance.has(reviewRunId)) {
      reportedProvenance.add(reviewRunId);
      console.error(`The provenance recorded for run ${reviewRunId} is malformed; reading it as not recorded.`);
    }
    return null;
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return malformed();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed();
  const v = value as Record<string, unknown>;
  const origin = ORIGINS.find((known) => known === v['origin']);
  const mode = v['mode'] === null ? null : (PROVENANCE_MODES.find((known) => known === v['mode']) ?? undefined);
  const policies = v['policyVersions'];
  if (
    origin === undefined ||
    mode === undefined ||
    typeof v['pluginVersion'] !== 'string' ||
    !(v['claudeVersion'] === null || typeof v['claudeVersion'] === 'string') ||
    !Array.isArray(policies)
  ) {
    return malformed();
  }
  const policyVersions: PolicyVersionRef[] = [];
  for (const entry of policies) {
    const p = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof p['scopeType'] !== 'string' || typeof p['scopeKey'] !== 'string' || typeof p['policyId'] !== 'string' || typeof p['version'] !== 'number') {
      return malformed();
    }
    policyVersions.push({ scopeType: p['scopeType'], scopeKey: p['scopeKey'], policyId: p['policyId'], version: p['version'] });
  }
  return {
    origin,
    // Recomputed, never read back, so a hand-edited row cannot claim independence.
    independence: independenceOf(origin),
    pluginVersion: v['pluginVersion'],
    claudeVersion: v['claudeVersion'] as string | null,
    mode,
    policyVersions,
  };
}

export interface RecordRunInput {
  repository: string | null;
  baseRef: string | null;
  headRef: string | null;
  /** Present only for a review acquired with `diff --pr`. */
  pullNumber?: number | undefined;
  /** The full or incremental boundary that produced this run. */
  scope?: ReviewScope | undefined;
  /** Whether the change was assessed as needing a human's approval; see docs/adr/0012. */
  complexity?: ComplexityAssessment | null | undefined;
  diff: string;
  output: string;
  candidates?: CandidateHint[] | undefined;
  /** Score breakdowns, so `explain` can answer "why this finding". */
  scores?: unknown;
  /** Precedent ids that informed the review, for the same reason. */
  precedents?: unknown;
  /**
   * Verification verdicts, including findings that were dropped. A suppressed
   * finding leaves no other trace, so this is the only record that it existed.
   */
  verdicts?: unknown;
  /**
   * Tie-break rulings on findings the two verification passes disagreed
   * about. A dropped finding an upheld ruling restored would otherwise read
   * as suppressed in `explain`.
   */
  tieBreaks?: TieBreak[] | undefined;
  /**
   * Candidates held back rather than reported, with the reason. Unlike a
   * verdict, this also covers repeats of an existing comment and cross-check
   * results, which no verifier pass produces.
   */
  held?: HeldFinding[] | undefined;
  /** The earlier run's carried findings, to be matched against what is recorded. */
  carried?: { runId: string; findings: CarriedFinding[] } | undefined;
  /** Present when the run was built from candidates carried to this head. */
  carry?: CarryMarker | undefined;
  /** Earlier runs' partly-addressed follow-ups, as this run found them: open or resolved. */
  followUps?: FollowUpState[] | undefined;
  /** Verified, optional restructuring advice rendered only in the review body. */
  bodyFindings?: VerifiedSimplification[] | undefined;
  /**
   * How long each stage took, and what it cost.
   *
   * Recorded so the cadence question is answered by a distribution rather than
   * by the one run somebody happened to time.
   */
  stages?: StageTiming[] | undefined;
  /**
   * Where the run came from and what produced it. Optional so direct callers
   * keep working (the column is then NULL); the `record` command always sets it.
   * The independence label and the policy rows are filled in here, not trusted.
   */
  provenance?: RunProvenanceInput | undefined;
  /** What the static checks and the symbol search did; see `recordedChecks`. Absent for a run that was not given them. */
  checks?: RecordedChecks | undefined;
  /** The manifest's structural signals as per-file counts; see `recordedStructure`. Absent for a run recorded without them. */
  structure?: RecordedStructure | undefined;
  /** The static signals of `evidence.json`, with repository-relative paths, for each finding's `toolSignal`. */
  toolSignals?: readonly EvidenceSignal[] | undefined;
  /** The convention documents `conventions` returned, for each finding's `conventionQuotes`. */
  conventions?: readonly { path: string; content: string }[] | undefined;
  /** What the `reproduce` stage did, without the output; see `recordedReproductions`. Absent when the run was not given it. */
  reproductions?: RecordedReproduction[] | undefined;
}

/**
 * One reproduction as the store keeps it, which is the record `reproduce`
 * wrote without any run's output. The output can hold anything the copy of the
 * worktree could read, so it stays in the run directory under retention.
 */
export type RecordedReproduction = Omit<ReproductionRecord, 'runs'> & { runs: Omit<ReproductionRun, 'output'>[] };

const OUTCOMES: readonly ReproductionRecord['outcome'][] = ['reproduced', 'did-not-fail', 'did-not-run'];

/** One stored record, or null when it is not the shape `reproduce` writes. */
function reproductionOf(entry: unknown): RecordedReproduction | null {
  const r = asRecord(entry);
  if (r === null || !Array.isArray(r['runs']) || !OUTCOMES.includes(r['outcome'] as ReproductionRecord['outcome'])) return null;
  const texts = ['candidateId', 'path', 'runner', 'file', 'copy', 'expected'] as const;
  if (texts.some((key) => typeof r[key] !== 'string') || !Number.isInteger(r['line'])) return null;
  const runs: RecordedReproduction['runs'] = [];
  for (const raw of r['runs']) {
    const run = asRecord(raw);
    if (run === null || typeof run['reached'] !== 'boolean' || typeof run['durationMs'] !== 'number') return null;
    runs.push({ exitCode: Number.isInteger(run['exitCode']) ? (run['exitCode'] as number) : null, durationMs: run['durationMs'], reached: run['reached'] });
  }
  return {
    candidateId: r['candidateId'] as string,
    path: r['path'] as string,
    line: r['line'] as number,
    runner: r['runner'] as string,
    file: r['file'] as string,
    copy: r['copy'] as string,
    expected: r['expected'] as string,
    outcome: r['outcome'] as ReproductionRecord['outcome'],
    ...(typeof r['reason'] === 'string' ? { reason: r['reason'] } : {}),
    runs,
  };
}

/**
 * The records of a `reproductions.json`, without output. Throws on a shape the
 * command does not write, so a hand-edited file cannot record a result that
 * looks complete.
 */
export function recordedReproductions(report: unknown): RecordedReproduction[] {
  const value = asRecord(report);
  if (value === null || !Array.isArray(value['reproductions'])) throw new Error('the reproductions report has no reproductions list');
  return value['reproductions'].map((entry, index) => {
    const record = reproductionOf(entry);
    if (record === null) throw new Error(`reproductions entry ${index} is not a record reproduce writes`);
    return record;
  });
}

/**
 * Marks each did-not-fail record whose finding this run held, from the held
 * list as it is at record time. `decline` later rewrites a held entry's
 * verdict, so a measure that read the held list would forget the hold.
 */
function markHeld(records: readonly RecordedReproduction[], held: readonly HeldFinding[]): (RecordedReproduction & { held?: true })[] {
  const ids = new Set(held.filter((entry) => entry.verdict === 'reproduction-did-not-fail').map((entry) => entry.candidateId));
  return records.map((record) => (record.outcome === 'did-not-fail' && ids.has(record.candidateId) ? { ...record, held: true } : record));
}

/** The stored records, or null for a row recorded before they existed or without them. */
function storedReproductions(raw: unknown): RecordedReproduction[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map(reproductionOf).filter((record): record is RecordedReproduction => record !== null);
}

/**
 * What the static checks and the symbol search did for one run, kept with the
 * run so the review scope block (docs/adr/0028) is built from the record and
 * never from whatever the working tree or the environment says later.
 */
export interface RecordedChecks {
  /** Commands that executed, in the report's order; one that could not start is not here. */
  staticRan: { name: string; exitCode: number | null; signals: number; version?: string }[];
  /** Every name the report lists as not having run, in its order, each once. */
  staticDidNotRun: { name: string; reason: string }[];
  /** Changed files whose symbol search was left unfinished. */
  symbolsInconclusive: number;
  /** True when the symbol search stopped on its time budget. */
  symbolsBudgetExhausted: boolean;
  /**
   * The linked issues the thread read for intent (`review.linked_issues`), by
   * number; `[]` when the thread read none. Absent on a row recorded before
   * the thread said, which never claims it read no issues.
   */
  issuesRead?: number[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The checks summary from an `evidence` report and a `symbols` report.
 *
 * A name in both `commands` and `didNotRun` (a command that could not start,
 * exit 126 or 127) is reported once, as not run: it never produced a verdict, so
 * listing it as ran would imply a check that passed. The reason is the command's
 * own `unavailable` text, else the report's `skipped` switch, else `not run`.
 * Throws on a shape the commands do not write, so a hand-edited file cannot
 * record a summary that looks complete.
 */
export function recordedChecks(evidence: unknown, symbols: unknown): RecordedChecks {
  const report = asRecord(evidence);
  if (report === null) throw new Error('the evidence report is not an object');
  const commands = report['commands'];
  const didNotRun = report['didNotRun'];
  if (!Array.isArray(commands)) throw new Error('the evidence report has no commands list');
  if (!Array.isArray(didNotRun) || !didNotRun.every((name) => typeof name === 'string')) {
    throw new Error('the evidence report has no didNotRun list of names');
  }
  const skipped = typeof report['skipped'] === 'string' && report['skipped'].trim() !== '' ? report['skipped'] : null;

  const entries = commands.map((entry, index) => {
    const command = asRecord(entry);
    if (command === null || typeof command['name'] !== 'string') throw new Error(`commands entry ${index} has no name`);
    return command as Record<string, unknown> & { name: string };
  });
  const notRun = [...new Set(didNotRun as string[])];

  const staticRan = entries
    .filter((command) => !notRun.includes(command.name))
    .map((command) => ({
      name: command.name,
      exitCode: Number.isInteger(command['exitCode']) ? (command['exitCode'] as number) : null,
      signals: Array.isArray(command['signals']) ? command['signals'].length : 0,
      ...(typeof command['version'] === 'string' && command['version'] !== '' ? { version: command['version'] } : {}),
    }));
  const staticDidNotRun = notRun.map((name) => {
    const unavailable = entries.find((command) => command.name === name)?.['unavailable'];
    return {
      name,
      reason: typeof unavailable === 'string' && unavailable.trim() !== '' ? unavailable : (skipped ?? 'not run'),
    };
  });

  const search = asRecord(symbols);
  if (search === null || !Array.isArray(search['files'])) throw new Error('the symbols report has no files list');
  const budget = asRecord(search['budget']);
  return {
    staticRan,
    staticDidNotRun,
    symbolsInconclusive: search['files'].filter((file) => asRecord(file)?.['inconclusive'] === true).length,
    symbolsBudgetExhausted: budget?.['exhausted'] === true,
  };
}

/** The stored checks, or null for a row recorded before they existed or one that does not hold them. */
function storedChecks(raw: unknown): RecordedChecks | null {
  const value = asRecord(raw);
  if (value === null || !Array.isArray(value['staticRan']) || !Array.isArray(value['staticDidNotRun'])) return null;
  if (!Number.isInteger(value['symbolsInconclusive']) || typeof value['symbolsBudgetExhausted'] !== 'boolean') return null;
  const ran: RecordedChecks['staticRan'] = [];
  for (const entry of value['staticRan']) {
    const c = asRecord(entry);
    if (c === null || typeof c['name'] !== 'string' || !Number.isInteger(c['signals'])) return null;
    ran.push({
      name: c['name'],
      exitCode: Number.isInteger(c['exitCode']) ? (c['exitCode'] as number) : null,
      signals: c['signals'] as number,
      ...(typeof c['version'] === 'string' ? { version: c['version'] } : {}),
    });
  }
  const didNot: RecordedChecks['staticDidNotRun'] = [];
  for (const entry of value['staticDidNotRun']) {
    const c = asRecord(entry);
    if (c === null || typeof c['name'] !== 'string' || typeof c['reason'] !== 'string') return null;
    didNot.push({ name: c['name'], reason: c['reason'] });
  }
  const issuesRead = value['issuesRead'];
  return {
    staticRan: ran,
    staticDidNotRun: didNot,
    symbolsInconclusive: value['symbolsInconclusive'] as number,
    symbolsBudgetExhausted: value['symbolsBudgetExhausted'] as boolean,
    ...(Array.isArray(issuesRead) ? { issuesRead: issuesRead.filter((n): n is number => Number.isInteger(n)) } : {}),
  };
}

/** The `Checks` line `explain` prints. */
export function describeChecks(checks: RecordedChecks | null): string {
  if (checks === null) return 'Checks not recorded';
  const ran = checks.staticRan.map((c) => `${c.name} ran (exit ${c.exitCode ?? 'none'}, ${c.signals} signal${c.signals === 1 ? '' : 's'})`);
  const didNot = checks.staticDidNotRun.map((c) => `${c.name} did not run (${c.reason})`);
  const staticParts = [...ran, ...didNot];
  const symbols =
    checks.symbolsInconclusive === 0
      ? 'every symbol file finished'
      : `${checks.symbolsInconclusive} symbol file${checks.symbolsInconclusive === 1 ? '' : 's'} not finished${checks.symbolsBudgetExhausted ? ' (time budget)' : ''}`;
  const issues =
    checks.issuesRead === undefined ? '' : `; linked issues ${checks.issuesRead.length === 0 ? 'none' : checks.issuesRead.map((n) => `#${n}`).join(', ')}`;
  return `Checks ${staticParts.length === 0 ? 'no static checks' : staticParts.join('; ')}; ${symbols}${issues}`;
}

/**
 * The order the reading guide names kinds in. A `Record` keyed by each closed
 * union, so a kind added to the scanners without a place here fails the
 * typecheck; an array checked with `satisfies` would not.
 */
export const REMOVED_CONTROL_ORDER: Readonly<Record<RemovedControlKind, number>> = { guard: 0, refusal: 1, decorator: 2, middleware: 3, 'allowlist-entry': 4 };
export const RISK_MARKER_ORDER: Readonly<Record<RiskMarkerKind, number>> = { 'new-route': 0, 'lock-or-async': 1, 'string-built-query': 2, unsafe: 3 };

export interface RecordedFileSignals {
  path: string;
  /** True when every entry for the path came from a deleted file (`removedControls[].deletedFile`). */
  deletedFile: boolean;
  removedControls: Partial<Record<RemovedControlKind, number>>;
  riskMarkers: Partial<Record<RiskMarkerKind, number>>;
  /** The first crossing recorded for the path, or null. */
  sizeCrossing: { headLines: number; threshold: number } | null;
  /** Functions whose added decision points crossed the threshold. */
  branchGrowth: number;
  typeEscapes: number;
}

/**
 * A manifest's structural signals as per-file counts, kept with the run so the
 * reading guide (docs/adr/0028) is built from the record. Counts and not the
 * signals themselves: the store keeps no source text beyond a finding's own
 * words, `removedControls[].text` is a removed source line, and the guide needs
 * none of it.
 */
export interface RecordedStructure {
  /** Every changed path with at least one signal, sorted by path. Counts only; no source text. */
  files: RecordedFileSignals[];
  /** `StructureSignals.unmeasured.count`. */
  unmeasured: number;
}

const STRUCTURE_LISTS = ['sizeCrossings', 'branchGrowth', 'typeEscapes', 'removedControls', 'riskMarkers'] as const;

/** A manifest's `structure` aggregated per path; null for a value that is not an object with its five lists. */
/**
 * A path as the repository names it. An absolute, home-relative, drive or
 * parent-climbing path can only come from a machine's own layout, and the
 * reading guide posts paths, so such an entry is dropped rather than shown.
 */
export const repositoryPath = (path: string): boolean => path !== '' && !/^[\\/]/u.test(path) && !MACHINE_PATH.test(path);

export function recordedStructure(raw: unknown): RecordedStructure | null {
  const value = asRecord(raw);
  if (value === null || !STRUCTURE_LISTS.every((list) => Array.isArray(value[list]))) return null;
  const files = new Map<string, RecordedFileSignals>();
  // Entries per path, and how many of them a deleted file produced; only a
  // removed control can say so, since every other signal is on an added line.
  const entries = new Map<string, number>();
  const deleted = new Map<string, number>();
  const entryOf = (entry: unknown): Record<string, unknown> | null => {
    const record = asRecord(entry);
    return record !== null && typeof record['path'] === 'string' && repositoryPath(record['path']) ? record : null;
  };
  // Called only for an entry that counts, so a path with no signal is never listed.
  const fileOf = (record: Record<string, unknown>): RecordedFileSignals => {
    const path = record['path'] as string;
    let file = files.get(path);
    if (file === undefined) {
      file = { path, deletedFile: false, removedControls: {}, riskMarkers: {}, sizeCrossing: null, branchGrowth: 0, typeEscapes: 0 };
      files.set(path, file);
    }
    entries.set(path, (entries.get(path) ?? 0) + 1);
    return file;
  };
  // Own-property checks: `in` would admit `constructor` and the other prototype names.
  for (const entry of value['removedControls'] as unknown[]) {
    const record = entryOf(entry);
    const kind = record?.['kind'];
    if (record === null || typeof kind !== 'string' || !Object.hasOwn(REMOVED_CONTROL_ORDER, kind)) continue;
    const file = fileOf(record);
    file.removedControls[kind as RemovedControlKind] = (file.removedControls[kind as RemovedControlKind] ?? 0) + 1;
    if (record['deletedFile'] === true) deleted.set(file.path, (deleted.get(file.path) ?? 0) + 1);
  }
  for (const entry of value['riskMarkers'] as unknown[]) {
    const record = entryOf(entry);
    const kind = record?.['kind'];
    if (record === null || typeof kind !== 'string' || !Object.hasOwn(RISK_MARKER_ORDER, kind)) continue;
    const file = fileOf(record);
    file.riskMarkers[kind as RiskMarkerKind] = (file.riskMarkers[kind as RiskMarkerKind] ?? 0) + 1;
  }
  for (const entry of value['typeEscapes'] as unknown[]) {
    const record = entryOf(entry);
    if (record !== null) fileOf(record).typeEscapes += 1;
  }
  for (const entry of value['branchGrowth'] as unknown[]) {
    const record = entryOf(entry);
    if (record !== null) fileOf(record).branchGrowth += 1;
  }
  for (const entry of value['sizeCrossings'] as unknown[]) {
    const record = entryOf(entry);
    if (record === null || !Number.isInteger(record['headLines']) || !Number.isInteger(record['threshold'])) continue;
    const file = fileOf(record);
    // The first crossing per path counts; a second is ignored, not summed.
    if (file.sizeCrossing === null) file.sizeCrossing = { headLines: record['headLines'] as number, threshold: record['threshold'] as number };
  }
  for (const file of files.values()) file.deletedFile = (deleted.get(file.path) ?? 0) === entries.get(file.path);
  const unmeasured = asRecord(value['unmeasured'])?.['count'];
  return {
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    unmeasured: Number.isInteger(unmeasured) ? (unmeasured as number) : 0,
  };
}

/** The stored structure, or null for a row recorded before it existed or one that does not hold it. */
function storedStructure(raw: unknown): RecordedStructure | null {
  const value = asRecord(raw);
  if (value === null || !Array.isArray(value['files']) || !Number.isInteger(value['unmeasured'])) return null;
  // A kind outside its table is as malformed as a non-integer count: the guide prints kinds as text.
  const counts = (table: unknown, order: Readonly<Record<string, number>>): Partial<Record<string, number>> | null => {
    const record = asRecord(table);
    return record !== null && Object.entries(record).every(([kind, count]) => Object.hasOwn(order, kind) && Number.isInteger(count))
      ? (record as Partial<Record<string, number>>)
      : null;
  };
  const files: RecordedFileSignals[] = [];
  for (const entry of value['files']) {
    const file = asRecord(entry);
    if (file === null || typeof file['path'] !== 'string' || typeof file['deletedFile'] !== 'boolean') return null;
    const removedControls = counts(file['removedControls'], REMOVED_CONTROL_ORDER);
    const riskMarkers = counts(file['riskMarkers'], RISK_MARKER_ORDER);
    const crossing = file['sizeCrossing'] === null ? null : asRecord(file['sizeCrossing']);
    if (removedControls === null || riskMarkers === null || !Number.isInteger(file['branchGrowth']) || !Number.isInteger(file['typeEscapes'])) return null;
    if (crossing !== null && !(Number.isInteger(crossing['headLines']) && Number.isInteger(crossing['threshold']))) return null;
    files.push({
      path: file['path'],
      deletedFile: file['deletedFile'],
      removedControls: removedControls as Partial<Record<RemovedControlKind, number>>,
      riskMarkers: riskMarkers as Partial<Record<RiskMarkerKind, number>>,
      sizeCrossing: crossing === null ? null : { headLines: crossing['headLines'] as number, threshold: crossing['threshold'] as number },
      branchGrowth: file['branchGrowth'] as number,
      typeEscapes: file['typeEscapes'] as number,
    });
  }
  return { files, unmeasured: value['unmeasured'] as number };
}

/** The `Structure` line `explain` prints. */
export function describeStructure(structure: RecordedStructure | null): string {
  if (structure === null) return 'Structure not recorded';
  const count = structure.files.length;
  return `Structure ${count} file${count === 1 ? '' : 's'} with a signal, ${structure.unmeasured} unmeasured`;
}

export interface StageTiming {
  /** `analyst`, `verifier`, `editor`, and so on. */
  name: string;
  seconds: number;
  toolCalls?: number | undefined;
  tokens?: number | undefined;
  /** Distinct files the stage read, as the stage itself counted them. */
  filesRead?: number | undefined;
  /** Added and removed lines of the diff the stage read; set on `analyst` at record time. */
  diffLines?: number | undefined;
  /** Files of that diff with a hunk at the head, so not deleted, empty, binary or only renamed; set on `analyst` at record time. */
  diffFiles?: number | undefined;
  /** The model and cost of an agent stage the review driver ran (docs/adr/0021). */
  model?: string | undefined;
  /** One model per agent call, in order: the challenge stage picks one per finding. */
  models?: string[] | undefined;
  costUsd?: number | undefined;
  /** The model family the stage ran on; `claude` unless a configured runner ran it. */
  family?: Family | undefined;
}

/**
 * Finding identifiers are positional: rv_01 is the first finding displayed,
 * rv_02 the second. They are assigned here rather than printed alongside the
 * findings, because the output contract permits no text beyond the findings
 * themselves and a visible id would cost characters the writing needs more.
 */
const basename = (path: string): string => path.split('/').pop()?.toLowerCase() ?? path.toLowerCase();

/**
 * Finds the candidate a rendered finding came from.
 *
 * Exact path and line first, because that is what agreement looks like. The
 * ladder below it exists because the two can legitimately disagree: the analyst
 * supplies `path` as free text and the verifier reads the actual code, so on one
 * pull request the analyst cited `InvoicePaymentRequest/InvoicePaymentRequestDetail.tsx`
 * and the finding that shipped, correctly, cited `bankTransfer/BankTransferCard.tsx`.
 *
 * The anchors stored are the rendered ones, which is right - the validated
 * output is the only artefact that passed the contract. But an exact-match
 * lookup then failed, and `category` went missing **precisely when the analyst
 * was least reliable**, silently. A category-less finding is one the corpus
 * cannot classify and `explain` cannot account for.
 */
function attribute(
  finding: { path: string; line: number },
  hints: CandidateHint[],
  taken: Set<CandidateHint>,
): { hint: CandidateHint | undefined; how: 'exact' | 'basename' | 'line' | 'none' } {
  const free = hints.filter((hint) => !taken.has(hint));

  const exact = free.find((hint) => hint.path === finding.path && hint.line === finding.line);
  if (exact !== undefined) return { hint: exact, how: 'exact' };

  // A path differing only in case or directory is the miss actually observed.
  const sameFile = free.filter(
    (hint) => basename(hint.path) === basename(finding.path) && hint.line === finding.line,
  );
  if (sameFile.length === 1) return { hint: sameFile[0], how: 'basename' };

  // Line alone, and only when it is unambiguous. Matching on line alone is how
  // one rendered finding was paired with the wrong one of two candidates.
  const sameLine = free.filter((hint) => hint.line === finding.line);
  if (sameLine.length === 1) return { hint: sameLine[0], how: 'line' };

  return { hint: undefined, how: 'none' };
}

const laneOf = (hint: CandidateHint | undefined): string =>
  typeof hint?.lane === 'string' && hint.lane.length > 0 ? hint.lane : 'diff';

/** The blocker class a candidate claimed, as either spelling `score` accepts; undefined when none. */
const blockerClassOf = (hint: CandidateHint | undefined): string | undefined => {
  const claimed = hint?.blocker_class ?? hint?.blockerClass;
  return typeof claimed === 'string' && claimed.length > 0 ? claimed : undefined;
};

/** The stored form of a candidate: its lane (default `diff`) and blocker class are always kept. */
function storedCandidate(hint: CandidateHint): CandidateHint {
  const blocker = hint.blocker_class ?? hint.blockerClass;
  const { blockerClass: _camel, ...rest } = hint;
  return { ...rest, lane: laneOf(hint), ...(blocker === undefined ? {} : { blocker_class: blocker }) };
}

/** Where a patch was checked: the path `score` put inside it, else the candidate's own. */
function patchPath(hint: CandidateHint): string {
  const inside = (hint.suggested_patch as { path?: unknown } | null | undefined)?.path;
  return typeof inside === 'string' ? inside : hint.path;
}

/** Longest stored tool text, in code points, ellipsis included. */
const TOOL_TEXT_CAP = 160;
const MAX_CONVENTION_QUOTES = 2;

/** By code point, so a surrogate pair is never split. */
function cut(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text;
}

/** The anchor checks accept `./src/a.ts`, and the signals were made relative the same way. */
const plainPath = (path: string): string => posix.normalize(path.split('\\').join('/')).replace(/^\.\//, '');

/** The first signal at exactly this path and line, as stored on the finding. */
function toolSignalFor(finding: { path: string; line: number }, signals: readonly EvidenceSignal[]): StoredFinding['toolSignal'] {
  const path = plainPath(finding.path);
  const signal = signals.find((entry) => entry.path === path && entry.line === finding.line);
  if (signal === undefined) return undefined;
  // A configured check's name is the operator's own words and can be a path
  // on their machine, so a signal from one named that way is not stored.
  if (MACHINE_PATH.test(flatten(signal.tool, Number.POSITIVE_INFINITY))) return undefined;
  // A tool's line can name where it ran, which under the driver is the run
  // directory in the reviewer's home, so it gives way to the claim, which the
  // adapters build without the file. Checked as the block will flatten it.
  const shown = [signal.evidence[0], signal.claim].find(
    (text): text is string => text !== undefined && !MACHINE_PATH.test(flatten(text, Number.POSITIVE_INFINITY)),
  );
  if (shown === undefined) return undefined;
  // A secret scanner's message can quote the secret it found.
  return { tool: signal.tool, line: finding.line, text: cut(redactedAsPosted(shown), TOOL_TEXT_CAP) };
}

/**
 * Redacted as given and again as the block will flatten it, since removing a
 * backtick or an invisible character can join a secret the raw text split,
 * and can also remove the boundary a raw match needed.
 */
const redactedAsPosted = (text: string): string => redact(flatten(redact(text).text, Number.POSITIVE_INFINITY)).text;

const squashed = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A quoted segment of at least four words, between straight or curly double quotes. */
const QUOTED = /["\u201c]([^"\u201c\u201d]+)["\u201d]/g;

/**
 * Whether `name` stands alone in `text`, so `packages/web/CLAUDE.md` or
 * `NOT_AGENTS.md` names neither `CLAUDE.md` nor `AGENTS.md`. A leading `./`
 * and a full stop ending the sentence are allowed.
 */
function namesWhole(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w./\\\\-])(?:\\./)?${escaped}(?![\\w/\\\\-]|\\.\\w)`).test(text);
}

/**
 * The document an evidence string names. A document path it names wins, the
 * longest first, else a basename exactly one document in the report has.
 */
function documentNamed(text: string, documents: readonly { path: string; content: string }[]): { path: string; content: string } | undefined {
  const exact = documents.filter((doc) => doc.path !== '' && namesWhole(text, doc.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (exact !== undefined) return exact;
  const base = (path: string): string => path.split('/').pop() ?? path;
  return documents.find((doc) => namesWhole(text, base(doc.path)) && documents.filter((other) => base(other.path) === base(doc.path)).length === 1);
}

/**
 * The quotes the analyst's evidence cites from a convention document, kept
 * only when the document contains them, whitespace collapsed and case folded.
 * It is the verbatim check `check-intent` applies to the description, applied
 * to the other repository text the analyst is told to cite.
 */
function conventionQuotesFor(evidence: unknown, documents: readonly { path: string; content: string }[]): StoredFinding['conventionQuotes'] {
  if (!Array.isArray(evidence) || documents.length === 0) return undefined;
  const found: { path: string; quote: string }[] = [];
  for (const entry of evidence) {
    if (found.length >= MAX_CONVENTION_QUOTES) break;
    if (typeof entry !== 'string') continue;
    const document = documentNamed(entry, documents);
    if (document === undefined) continue;
    const content = squashed(document.content).toLowerCase();
    const quote = [...entry.matchAll(QUOTED)]
      .map((match) => squashed(match[1] ?? ''))
      .find((segment) => segment.split(' ').length >= 4 && content.includes(segment.toLowerCase()));
    if (quote !== undefined) found.push({ path: document.path, quote: redactedAsPosted(quote) });
  }
  return found.length === 0 ? undefined : found;
}

function assignIds(
  output: string,
  hints: CandidateHint[],
  facts: { toolSignals?: readonly EvidenceSignal[] | undefined; conventions?: readonly { path: string; content: string }[] | undefined } = {},
): StoredFinding[] {
  const taken = new Set<CandidateHint>();
  return splitFindings(output)
    .map((block) => parseFinding(block.raw, block.startLine))
    .filter((finding) => finding.severity !== null && finding.path !== null)
    .map((finding, index) => {
      const anchor = { path: finding.path!, line: finding.line ?? 0 };
      const { hint, how } = attribute(anchor, hints, taken);
      if (hint !== undefined) taken.add(hint);
      const partly = partlyAddressedOf(hint?.possibleRepeatOf);
      // A malformed one is not stored: nothing could render it.
      const patch = suggestedPatchOf(hint?.suggested_patch);
      const blockerClass = blockerClassOf(hint);
      const ruleId = ruleIdFor(hint?.category, laneOf(hint), blockerClass);
      const toolSignal = toolSignalFor(anchor, facts.toolSignals ?? []);
      const conventionQuotes = conventionQuotesFor(hint?.evidence, facts.conventions ?? []);
      return {
        findingId: `rv_${String(index + 1).padStart(2, '0')}`,
        severity: finding.severity!,
        path: anchor.path,
        line: anchor.line,
        text: finding.raw,
        // Absent when a review ran without candidates to hand. Null is honest;
        // guessing a category from the wording would invent evidence.
        category: hint?.category,
        lane: laneOf(hint),
        ...(blockerClass === undefined ? {} : { blockerClass }),
        // Null when there is no category: a finding nothing classified has no rule.
        ...(ruleId === null ? {} : { ruleId }),
        // Stated so a disagreement between what the analyst cited and what
        // shipped is visible rather than showing up as a missing category.
        ...(how === 'exact' || how === 'none' ? {} : { attributedBy: how }),
        ...(how === 'none' && hints.length > 0 ? { unattributed: true } : {}),
        ...(partly === undefined ? {} : { partlyAddressed: partly }),
        ...(patch === null || hint === undefined
          ? {}
          : { suggestedPatch: patch, suggestedPatchSource: { path: patchPath(hint), candidateId: typeof hint.candidate_id === 'string' ? hint.candidate_id : null } }),
        ...(toolSignal === undefined ? {} : { toolSignal }),
        // Tied to the candidate that cited them, so the block shows them only
        // beside that candidate's own verified score (as S14 ties a patch).
        ...(conventionQuotes === undefined
          ? {}
          : { conventionQuotes, conventionQuotesCandidate: typeof hint?.candidate_id === 'string' ? hint.candidate_id : null }),
      };
    });
}

export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff).digest('hex').slice(0, 32);
}

export function recordRun(
  db: Database,
  input: RecordRunInput,
): { reviewRunId: string; findings: StoredFinding[]; provenance: RunProvenance | null; families: RunFamilies | null } {
  if ((input.bodyFindings?.length ?? 0) > 1) {
    throw new Error('A review may record at most one body-only simplification finding.');
  }
  const reviewRunId = randomUUID();
  const findings = assignIds(input.output, input.candidates ?? [], { toolSignals: input.toolSignals, conventions: input.conventions });

  // Checked before anything is written, so a refused record leaves no run behind.
  if (input.carried !== undefined) {
    const { matches, mismatches } = matchCarried(findings, input.carried.findings);
    if (mismatches.length > 0) throw new CarryMismatch(mismatches.join('\n'));
    for (const finding of findings) {
      const from = matches.get(finding.findingId);
      if (from !== undefined) finding.carriedFrom = { runId: input.carried.runId, findingId: from };
    }
  }

  // Read once so the two columns that name the policy cannot disagree. The
  // caller's snapshot, the versions `score` loaded, wins when it has one, so a
  // policy approved or rolled back between scoring and recording cannot make
  // the run say it was held to versions it was not; otherwise it is the same
  // read `loadConfig` reports (docs/adr/0032).
  const policyVersions = input.provenance?.policyVersions ?? activePolicyVersions(db);
  const provenance: RunProvenance | null =
    input.provenance === undefined
      ? null
      : {
          origin: input.provenance.origin,
          independence: independenceOf(input.provenance.origin),
          pluginVersion: input.provenance.pluginVersion,
          claudeVersion: input.provenance.claudeVersion,
          mode: input.provenance.mode,
          policyVersions,
        };
  // A run recorded without provenance has no families either.
  const families = provenance === null ? null : familiesOf(input.verdicts, input.stages ?? []);

  // The run row and its audit event land together or not at all: a row left by
  // a failed audit write would read as a recorded review while the caller saw
  // a failure. A savepoint nests inside a caller's own transaction.
  db.exec('SAVEPOINT record_run');
  try {
    db.prepare(
      `INSERT INTO review_runs (
         review_run_id, repository, base_ref, head_ref, diff_hash,
         active_policy_versions_json, retrieved_precedents_json,
         candidates_json, output_json, created_at, stages_json,
         pull_number, scope_json, complexity_json, provenance_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      reviewRunId,
      input.repository,
      input.baseRef,
      input.headRef,
      hashDiff(input.diff),
      JSON.stringify(policyVersions),
      JSON.stringify(input.precedents ?? []),
      JSON.stringify((input.candidates ?? []).map(storedCandidate)),
      JSON.stringify({
        output: input.output,
        findings,
        scores: input.scores ?? [],
        verdicts: input.verdicts ?? [],
        tieBreaks: input.tieBreaks ?? [],
        held: input.held ?? [],
        ...(input.bodyFindings === undefined || input.bodyFindings.length === 0 ? {} : { bodyFindings: input.bodyFindings }),
        ...(input.carry === undefined ? {} : { carry: input.carry }),
        ...(input.followUps === undefined || input.followUps.length === 0 ? {} : { followUps: input.followUps }),
        ...(input.checks === undefined ? {} : { checks: input.checks }),
        ...(input.reproductions === undefined ? {} : { reproductions: markHeld(input.reproductions, input.held ?? []) }),
        ...(input.structure === undefined ? {} : { structure: input.structure }),
      }),
      new Date().toISOString(),
      JSON.stringify(input.stages ?? []),
      input.pullNumber ?? null,
      input.scope === undefined ? null : JSON.stringify(input.scope),
      input.complexity === undefined || input.complexity === null ? null : JSON.stringify(input.complexity),
      // Beside the provenance in its column, no migration; storedProvenance reads only the keys it knows.
      provenance === null ? null : JSON.stringify({ ...provenance, families }),
    );

    recordAudit(db, 'review_run_recorded', { type: 'review_run', id: reviewRunId }, {
      repository: input.repository,
      findingCount: findings.length,
      ...(provenance === null ? {} : { origin: provenance.origin }),
    });
    db.exec('RELEASE record_run');
  } catch (error) {
    db.exec('ROLLBACK TO record_run');
    db.exec('RELEASE record_run');
    throw error;
  }

  return { reviewRunId, findings, provenance, families };
}

export interface RunDetail {
  /** Per-stage timings, empty when the run did not record any. */
  stages: StageTiming[];
  reviewRunId: string;
  repository: string | null;
  pullNumber: number | null;
  /** Null is expected for rows recorded before pull-request scopes existed. */
  scope: ReviewScope | null;
  /** Null for rows recorded before the assessment existed, or without a manifest. */
  complexity: ComplexityAssessment | null;
  /** Null for rows recorded before provenance existed, and for a malformed value. */
  provenance: RunProvenance | null;
  /** Null for rows recorded before families were stored, without provenance, or with a malformed value. */
  families: RunFamilies | null;
  /** The commit reviewed. Null for runs recorded without `--head`. */
  headRef: string | null;
  createdAt: string;
  output: string;
  findings: StoredFinding[];
  scores: unknown;
  precedents: unknown;
  verdicts: unknown;
  /** Empty for runs recorded before tie-breaks existed. */
  tieBreaks: TieBreak[];
  /** Empty for runs recorded before held findings were kept. */
  held: HeldFinding[];
  /** Null unless the run was built from carried candidates. */
  carry: CarryMarker | null;
  /** Empty unless an earlier run of the pull request left a follow-up open. */
  followUps: FollowUpState[];
  /** Verified body-only restructuring advice; never contributes to the verdict. */
  bodyFindings: VerifiedSimplification[];
  /** Null for rows recorded before checks were kept, or recorded without `--evidence` and `--symbols`. */
  checks: RecordedChecks | null;
  /** Null for rows recorded before reproductions were kept, or recorded without `--reproductions`. */
  reproductions: RecordedReproduction[] | null;
  /** Null for rows recorded before the structure was kept, or from a manifest without one. */
  structure: RecordedStructure | null;
}

function storedComplexity(raw: unknown): ComplexityAssessment | null {
  if (typeof raw !== 'string') return null;
  try {
    return parseComplexity(JSON.parse(raw));
  } catch {
    return null;
  }
}

function storedScope(raw: unknown): ReviewScope | null {
  if (typeof raw !== 'string') return null;
  try {
    return parseReviewScope(JSON.parse(raw));
  } catch {
    // A row from an interrupted or manually repaired store must not prevent
    // users from inspecting its otherwise intact review.
    return null;
  }
}

/**
 * Marks the run's held findings at `path:line` as declined by the owner. The
 * held entries are rewritten in place; everything else in the run is kept.
 */
export function declineHeld(
  db: Database,
  reviewRunId: string,
  at: { path: string; line: number },
  reason: string,
): { ok: true; declined: number } | { ok: false; error: string } {
  const row = db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(reviewRunId) as
    | { output_json: string }
    | undefined;
  if (row === undefined) return { ok: false, error: `No recorded run ${reviewRunId}.` };
  const parsed = JSON.parse(row.output_json) as { held?: unknown };
  const held = Array.isArray(parsed.held) ? (parsed.held as HeldFinding[]) : [];
  const matching = held.filter((entry) => entry.path === at.path && entry.line === at.line);
  if (matching.length === 0) {
    const anchors = held.map((entry) => `${entry.path}:${entry.line}`);
    return {
      ok: false,
      error: `No held finding at ${at.path}:${at.line} in run ${reviewRunId}. ${anchors.length === 0 ? 'It holds none.' : `Held: ${anchors.join(', ')}.`}`,
    };
  }
  for (const entry of matching) {
    entry.verdict = 'owner-declined';
    entry.source = 'owner';
    entry.reason = reason;
  }
  db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?').run(JSON.stringify(parsed), reviewRunId);
  recordAudit(db, 'held_declined', { type: 'review_run', id: reviewRunId }, { path: at.path, line: at.line });
  return { ok: true, declined: matching.length };
}

/** Everything `explain` needs about a run, without re-deriving any of it. */
export function runDetail(db: Database, reviewRunId?: string): RunDetail | null {
  const row = (
    reviewRunId === undefined
      // rowid breaks the tie: two runs recorded in the same millisecond would
      // otherwise return in arbitrary order, and "the last review" has to mean
      // one specific review or feedback lands on the wrong finding.
      ? db.prepare('SELECT * FROM review_runs ORDER BY created_at DESC, rowid DESC LIMIT 1').get()
      : db.prepare('SELECT * FROM review_runs WHERE review_run_id = ?').get(reviewRunId)
  ) as Record<string, unknown> | undefined;

  if (row === undefined) return null;

  const parsed = JSON.parse(row['output_json'] as string) as {
    output: string;
    findings: StoredFinding[];
    scores?: unknown;
    verdicts?: unknown;
    tieBreaks?: unknown;
    held?: unknown;
    carry?: unknown;
    followUps?: unknown;
    bodyFindings?: unknown;
    checks?: unknown;
    reproductions?: unknown;
    structure?: unknown;
  };

  return {
    reviewRunId: row['review_run_id'] as string,
    repository: row['repository'] as string | null,
    pullNumber: Number.isInteger(row['pull_number']) ? (row['pull_number'] as number) : null,
    scope: storedScope(row['scope_json']),
    complexity: storedComplexity(row['complexity_json']),
    provenance: storedProvenance(row['provenance_json'], row['review_run_id'] as string),
    families: storedFamilies(row['provenance_json'], row['review_run_id'] as string),
    headRef: typeof row['head_ref'] === 'string' ? row['head_ref'] : null,
    createdAt: row['created_at'] as string,
    output: parsed.output,
    findings: parsed.findings,
    scores: parsed.scores ?? [],
    verdicts: parsed.verdicts ?? [],
    tieBreaks: Array.isArray(parsed.tieBreaks) ? (parsed.tieBreaks as TieBreak[]) : [],
    held: Array.isArray(parsed.held) ? (parsed.held as HeldFinding[]) : [],
    carry: parseCarryMarker(parsed.carry),
    followUps: Array.isArray(parsed.followUps) ? (parsed.followUps as FollowUpState[]) : [],
    bodyFindings: Array.isArray(parsed.bodyFindings) ? (parsed.bodyFindings as VerifiedSimplification[]) : [],
    checks: storedChecks(parsed.checks),
    reproductions: storedReproductions(parsed.reproductions),
    structure: storedStructure(parsed.structure),
    // Older rows predate the column, so absence is normal rather than an error.
    stages: ((): StageTiming[] => {
      const raw = row['stages_json'];
      if (typeof raw !== 'string') return [];
      try {
        const parsedStages: unknown = JSON.parse(raw);
        return Array.isArray(parsedStages) ? (parsedStages as StageTiming[]) : [];
      } catch {
        return [];
      }
    })(),
    precedents: JSON.parse(row['retrieved_precedents_json'] as string),
  };
}

/**
 * Finds the last completed review of one pull request.
 *
 * Repository spelling comes from remotes and APIs, which can disagree only by
 * case. Matching it case-insensitively keeps that cosmetic difference from
 * silently turning a repeat review into a first review.
 */
export function latestRunForPull(
  db: Database,
  repository: string,
  pullNumber: number,
): { reviewRunId: string; headRef: string; createdAt: string } | null {
  const row = db
    .prepare(
      `SELECT review_run_id, head_ref, created_at
       FROM review_runs
       WHERE LOWER(repository) = LOWER(?)
         AND pull_number = ?
         AND head_ref IS NOT NULL
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(repository, pullNumber) as
    | { review_run_id: string; head_ref: string; created_at: string }
    | undefined;

  if (row === undefined) return null;
  return {
    reviewRunId: row.review_run_id,
    headRef: row.head_ref,
    createdAt: row.created_at,
  };
}

/** Every recorded run of one pull request, newest first. */
export function recordedRunsForPull(
  db: Database,
  repository: string,
  pullNumber: number,
  limit = 10,
): { runId: string; head: string; createdAt: string }[] {
  const rows = db
    .prepare(
      `SELECT review_run_id, head_ref, created_at
       FROM review_runs
       WHERE LOWER(repository) = LOWER(?)
         AND pull_number = ?
         AND head_ref IS NOT NULL
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(repository, pullNumber, limit) as { review_run_id: string; head_ref: string; created_at: string }[];
  return rows.map((row) => ({ runId: row.review_run_id, head: row.head_ref, createdAt: row.created_at }));
}

export function latestRun(db: Database): { reviewRunId: string; findings: StoredFinding[] } | null {
  const row = db
    .prepare('SELECT review_run_id, output_json FROM review_runs ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as { review_run_id: string; output_json: string } | undefined;
  if (row === undefined) return null;
  const parsed = JSON.parse(row.output_json) as { findings: StoredFinding[] };
  return { reviewRunId: row.review_run_id, findings: parsed.findings };
}
