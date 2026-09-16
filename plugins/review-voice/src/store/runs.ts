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
}

export interface RecordRunInput {
  repository: string | null;
  baseRef: string | null;
  headRef: string | null;
  diff: string;
  output: string;
  candidates?: unknown;
}

/**
 * Finding identifiers are positional: rv_01 is the first finding displayed,
 * rv_02 the second. They are assigned here rather than printed alongside the
 * findings, because the output contract permits no text beyond the findings
 * themselves and a visible id would cost characters the writing needs more.
 */
function assignIds(output: string): StoredFinding[] {
  return splitFindings(output)
    .map((block) => parseFinding(block.raw, block.startLine))
    .filter((finding) => finding.severity !== null && finding.path !== null)
    .map((finding, index) => ({
      findingId: `rv_${String(index + 1).padStart(2, '0')}`,
      severity: finding.severity!,
      path: finding.path!,
      line: finding.line ?? 0,
      text: finding.raw,
    }));
}

export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff).digest('hex').slice(0, 32);
}

export function recordRun(db: Database, input: RecordRunInput): { reviewRunId: string; findings: StoredFinding[] } {
  const reviewRunId = randomUUID();
  const findings = assignIds(input.output);

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
    // Policy layering and precedent retrieval arrive in later milestones; the
    // columns exist now so a run recorded today stays readable then.
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify(input.candidates ?? []),
    JSON.stringify({ output: input.output, findings }),
    new Date().toISOString(),
  );

  recordAudit(db, 'review_run_recorded', { type: 'review_run', id: reviewRunId }, {
    repository: input.repository,
    findingCount: findings.length,
  });

  return { reviewRunId, findings };
}

export function latestRun(db: Database): { reviewRunId: string; findings: StoredFinding[] } | null {
  const row = db
    .prepare('SELECT review_run_id, output_json FROM review_runs ORDER BY created_at DESC LIMIT 1')
    .get() as { review_run_id: string; output_json: string } | undefined;
  if (row === undefined) return null;
  const parsed = JSON.parse(row.output_json) as { findings: StoredFinding[] };
  return { reviewRunId: row.review_run_id, findings: parsed.findings };
}
