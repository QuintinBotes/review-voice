import { randomUUID, createHash } from 'node:crypto';
import type { Database } from './db.ts';
import { recordAudit } from './audit.ts';
import { splitFindings, parseFinding } from '../contract/parse.ts';

export interface StoredFinding {
  findingId: string;
  severity: string;
  path: string;
  line: number;
  text: string;
  /**
   * Carried from the candidate that produced this finding. The rendered output
   * has no category — the contract allows no text beyond the finding — so it
   * has to arrive alongside rather than be parsed back out.
   */
  category?: string | undefined;
}

/** Just enough of a scored candidate to attribute a finding to its category. */
export interface CandidateHint {
  path: string;
  line: number;
  category?: string | undefined;
}

export interface RecordRunInput {
  repository: string | null;
  baseRef: string | null;
  headRef: string | null;
  diff: string;
  output: string;
  candidates?: CandidateHint[] | undefined;
  /** Score breakdowns, so `explain` can answer "why this finding". */
  scores?: unknown;
  /** Precedent ids that informed the review, for the same reason. */
  precedents?: unknown;
}

/**
 * Finding identifiers are positional: rv_01 is the first finding displayed,
 * rv_02 the second. They are assigned here rather than printed alongside the
 * findings, because the output contract permits no text beyond the findings
 * themselves and a visible id would cost characters the writing needs more.
 */
function assignIds(output: string, hints: CandidateHint[]): StoredFinding[] {
  return splitFindings(output)
    .map((block) => parseFinding(block.raw, block.startLine))
    .filter((finding) => finding.severity !== null && finding.path !== null)
    .map((finding, index) => {
      const hint = hints.find((c) => c.path === finding.path && c.line === finding.line);
      return {
        findingId: `rv_${String(index + 1).padStart(2, '0')}`,
        severity: finding.severity!,
        path: finding.path!,
        line: finding.line ?? 0,
        text: finding.raw,
        // Absent when a review ran without candidates to hand. Null is honest;
        // guessing a category from the wording would invent evidence.
        category: hint?.category,
      };
    });
}

export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff).digest('hex').slice(0, 32);
}

export function recordRun(db: Database, input: RecordRunInput): { reviewRunId: string; findings: StoredFinding[] } {
  const reviewRunId = randomUUID();
  const findings = assignIds(input.output, input.candidates ?? []);

  db.prepare(
    `INSERT INTO review_runs (
       review_run_id, repository, base_ref, head_ref, diff_hash,
       active_policy_versions_json, retrieved_precedents_json,
       candidates_json, output_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reviewRunId,
    input.repository,
    input.baseRef,
    input.headRef,
    hashDiff(input.diff),
    JSON.stringify([]),
    JSON.stringify(input.precedents ?? []),
    JSON.stringify(input.candidates ?? []),
    JSON.stringify({ output: input.output, findings, scores: input.scores ?? [] }),
    new Date().toISOString(),
  );

  recordAudit(db, 'review_run_recorded', { type: 'review_run', id: reviewRunId }, {
    repository: input.repository,
    findingCount: findings.length,
  });

  return { reviewRunId, findings };
}

export interface RunDetail {
  reviewRunId: string;
  repository: string | null;
  createdAt: string;
  output: string;
  findings: StoredFinding[];
  scores: unknown;
  precedents: unknown;
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
  };

  return {
    reviewRunId: row['review_run_id'] as string,
    repository: row['repository'] as string | null,
    createdAt: row['created_at'] as string,
    output: parsed.output,
    findings: parsed.findings,
    scores: parsed.scores ?? [],
    precedents: JSON.parse(row['retrieved_precedents_json'] as string),
  };
}

export function latestRun(db: Database): { reviewRunId: string; findings: StoredFinding[] } | null {
  const row = db
    .prepare('SELECT review_run_id, output_json FROM review_runs ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as { review_run_id: string; output_json: string } | undefined;
  if (row === undefined) return null;
  const parsed = JSON.parse(row.output_json) as { findings: StoredFinding[] };
  return { reviewRunId: row.review_run_id, findings: parsed.findings };
}
