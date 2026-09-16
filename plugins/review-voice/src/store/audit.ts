import { randomUUID } from 'node:crypto';
import type { Database } from './db.ts';

/**
 * Every consequential action is recorded locally. The point is that a user can
 * answer "what did this thing do with my code" from their own machine, without
 * taking the tool's word for it.
 */
export type AuditAction =
  | 'review_run_recorded'
  | 'corpus_ingested'
  | 'consent_granted'
  | 'policy_proposed'
  | 'policy_approved'
  | 'policy_rolled_back'
  | 'feedback_recorded'
  | 'purge'
  | 'prompt_injection_detected'
  | 'external_write_attempted';

export function recordAudit(
  db: Database,
  action: AuditAction,
  subject: { type: string; id: string } | null,
  metadata: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_events (audit_id, action, subject_type, subject_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, action, subject?.type ?? null, subject?.id ?? null, JSON.stringify(metadata), new Date().toISOString());
  return id;
}
