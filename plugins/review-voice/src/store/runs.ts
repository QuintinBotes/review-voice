import { randomUUID, createHash } from 'node:crypto';
import type { Database } from './db.ts';
import { recordAudit } from './audit.ts';
import { activePolicyVersions } from '../policy/versions.ts';
import { ruleIdFor } from '../policy/rules.ts';
import { splitFindings, parseFinding } from '../contract/parse.ts';
import { parseReviewScope, type ReviewScope } from '../diff/incremental.ts';
import { parseComplexity, type ComplexityAssessment } from '../diff/complexity.ts';
import { matchCarried, type CarriedFinding } from '../diff/carry.ts';
import type { TieBreak } from '../verify/reconcile.ts';
import type { FollowUpState } from './follow-ups.ts';
import type { VerifiedSimplification } from '../simplification.ts';

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
  | 'restates-tool';

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
];

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
  /** The model and cost of an agent stage the review driver ran (docs/adr/0021). */
  model?: string | undefined;
  /** One model per agent call, in order: the challenge stage picks one per finding. */
  models?: string[] | undefined;
  costUsd?: number | undefined;
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

function assignIds(output: string, hints: CandidateHint[]): StoredFinding[] {
  const taken = new Set<CandidateHint>();
  return splitFindings(output)
    .map((block) => parseFinding(block.raw, block.startLine))
    .filter((finding) => finding.severity !== null && finding.path !== null)
    .map((finding, index) => {
      const anchor = { path: finding.path!, line: finding.line ?? 0 };
      const { hint, how } = attribute(anchor, hints, taken);
      if (hint !== undefined) taken.add(hint);
      const partly = partlyAddressedOf(hint?.possibleRepeatOf);
      const blockerClass = blockerClassOf(hint);
      const ruleId = ruleIdFor(hint?.category, laneOf(hint), blockerClass);
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
      };
    });
}

export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff).digest('hex').slice(0, 32);
}

export function recordRun(
  db: Database,
  input: RecordRunInput,
): { reviewRunId: string; findings: StoredFinding[]; provenance: RunProvenance | null } {
  if ((input.bodyFindings?.length ?? 0) > 1) {
    throw new Error('A review may record at most one body-only simplification finding.');
  }
  const reviewRunId = randomUUID();
  const findings = assignIds(input.output, input.candidates ?? []);

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
      }),
      new Date().toISOString(),
      JSON.stringify(input.stages ?? []),
      input.pullNumber ?? null,
      input.scope === undefined ? null : JSON.stringify(input.scope),
      input.complexity === undefined || input.complexity === null ? null : JSON.stringify(input.complexity),
      provenance === null ? null : JSON.stringify(provenance),
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

  return { reviewRunId, findings, provenance };
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
  };

  return {
    reviewRunId: row['review_run_id'] as string,
    repository: row['repository'] as string | null,
    pullNumber: Number.isInteger(row['pull_number']) ? (row['pull_number'] as number) : null,
    scope: storedScope(row['scope_json']),
    complexity: storedComplexity(row['complexity_json']),
    provenance: storedProvenance(row['provenance_json'], row['review_run_id'] as string),
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
