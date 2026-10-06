import { randomUUID, createHash } from 'node:crypto';
import type { Database } from './db.ts';
import { recordAudit } from './audit.ts';
import { splitFindings, parseFinding } from '../contract/parse.ts';
import { parseReviewScope, type ReviewScope } from '../diff/incremental.ts';
import { parseComplexity, type ComplexityAssessment } from '../diff/complexity.ts';
import { matchCarried, type CarriedFinding } from '../diff/carry.ts';
import type { TieBreak } from '../verify/reconcile.ts';

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
   * partly addressed, and records what was still open at this run. Nothing
   * marks it resolved later: a later review links to the comment on the thread
   * again. The follow-up is posted as an ordinary inline comment.
   */
  partlyAddressed?: PartlyAddressedFinding | undefined;
}

export interface PartlyAddressedFinding {
  status: 'partly-addressed';
  /** The earlier comment, where it sat when this review read the thread. */
  prior: { author: string; path: string; line: number };
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
    prior: { author: v['author'], path: v['path'], line: v['line'] as number },
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
 */
export type HeldVerdict = 'partly' | 'refuted' | 'unverified' | 'repeat' | 'below-gate';

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

export const HELD_VERDICTS: readonly HeldVerdict[] = ['partly', 'refuted', 'unverified', 'repeat', 'below-gate'];

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

/** Raised when a recorded finding repeats a carried one but sits on another line. */
export class CarryMismatch extends Error {}

/** Just enough of a scored candidate to attribute a finding to its category. */
export interface CandidateHint {
  path: string;
  line: number;
  category?: string | undefined;
  /** As `score` hands it on; read with `partlyAddressedOf`. */
  possibleRepeatOf?: unknown;
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
  /**
   * How long each stage took, and what it cost.
   *
   * Recorded so the cadence question is answered by a distribution rather than
   * by the one run somebody happened to time.
   */
  stages?: StageTiming[] | undefined;
}

export interface StageTiming {
  /** `analyst`, `verifier`, `editor`, and so on. */
  name: string;
  seconds: number;
  toolCalls?: number | undefined;
  tokens?: number | undefined;
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
      return {
        findingId: `rv_${String(index + 1).padStart(2, '0')}`,
        severity: finding.severity!,
        path: anchor.path,
        line: anchor.line,
        text: finding.raw,
        // Absent when a review ran without candidates to hand. Null is honest;
        // guessing a category from the wording would invent evidence.
        category: hint?.category,
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

export function recordRun(db: Database, input: RecordRunInput): { reviewRunId: string; findings: StoredFinding[] } {
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

  db.prepare(
    `INSERT INTO review_runs (
       review_run_id, repository, base_ref, head_ref, diff_hash,
       active_policy_versions_json, retrieved_precedents_json,
       candidates_json, output_json, created_at, stages_json,
       pull_number, scope_json, complexity_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reviewRunId,
    input.repository,
    input.baseRef,
    input.headRef,
    hashDiff(input.diff),
    JSON.stringify([]),
    JSON.stringify(input.precedents ?? []),
    JSON.stringify(input.candidates ?? []),
    JSON.stringify({
      output: input.output,
      findings,
      scores: input.scores ?? [],
      verdicts: input.verdicts ?? [],
      tieBreaks: input.tieBreaks ?? [],
      held: input.held ?? [],
    }),
    new Date().toISOString(),
    JSON.stringify(input.stages ?? []),
    input.pullNumber ?? null,
    input.scope === undefined ? null : JSON.stringify(input.scope),
    input.complexity === undefined || input.complexity === null ? null : JSON.stringify(input.complexity),
  );

  recordAudit(db, 'review_run_recorded', { type: 'review_run', id: reviewRunId }, {
    repository: input.repository,
    findingCount: findings.length,
  });

  return { reviewRunId, findings };
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
  };

  return {
    reviewRunId: row['review_run_id'] as string,
    repository: row['repository'] as string | null,
    pullNumber: Number.isInteger(row['pull_number']) ? (row['pull_number'] as number) : null,
    scope: storedScope(row['scope_json']),
    complexity: storedComplexity(row['complexity_json']),
    headRef: typeof row['head_ref'] === 'string' ? row['head_ref'] : null,
    createdAt: row['created_at'] as string,
    output: parsed.output,
    findings: parsed.findings,
    scores: parsed.scores ?? [],
    verdicts: parsed.verdicts ?? [],
    tieBreaks: Array.isArray(parsed.tieBreaks) ? (parsed.tieBreaks as TieBreak[]) : [],
    held: Array.isArray(parsed.held) ? (parsed.held as HeldFinding[]) : [],
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
