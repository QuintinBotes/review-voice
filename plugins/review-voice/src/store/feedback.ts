import { randomUUID } from 'node:crypto';
import type { Database } from './db.ts';
import { recordAudit } from './audit.ts';
import { latestRun } from './runs.ts';

export const FEEDBACK_ACTIONS = [
  'keep',
  'dismiss',
  'rewrite',
  'raise_severity',
  'lower_severity',
  'repo_specific',
  'never_flag',
] as const;

export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

/** Accepts the hyphenated spelling users type as well as the stored form. */
export function normaliseAction(input: string): FeedbackAction | null {
  const candidate = input.trim().toLowerCase().replace(/-/g, '_');
  return (FEEDBACK_ACTIONS as readonly string[]).includes(candidate)
    ? (candidate as FeedbackAction)
    : null;
}

export interface RecordFeedbackInput {
  findingRef: string;
  action: FeedbackAction;
  reason?: string | undefined;
  replacementText?: string | undefined;
  actor: string;
}

export type FeedbackOutcome =
  | { ok: true; feedbackId: string; reviewRunId: string; findingId: string }
  | { ok: false; error: string };

export function recordFeedback(db: Database, input: RecordFeedbackInput): FeedbackOutcome {
  // A reference is either "rv_01" against the most recent run, or an explicit
  // "<run-id>:rv_01" for feedback on an older review.
  const [left, right] = input.findingRef.includes(':')
    ? (input.findingRef.split(':', 2) as [string, string])
    : [null, input.findingRef];

  let reviewRunId: string;
  let known: string[];

  if (left === null) {
    const run = latestRun(db);
    if (run === null) return { ok: false, error: 'No review has been recorded yet.' };
    reviewRunId = run.reviewRunId;
    known = run.findings.map((finding) => finding.findingId);
  } else {
    const row = db
      .prepare('SELECT review_run_id, output_json FROM review_runs WHERE review_run_id = ?')
      .get(left) as { review_run_id: string; output_json: string } | undefined;
    if (row === undefined) return { ok: false, error: `No review run ${left}.` };
    reviewRunId = row.review_run_id;
    known = (JSON.parse(row.output_json) as { findings: { findingId: string }[] }).findings.map(
      (finding) => finding.findingId,
    );
  }

  const findingId = right.trim();
  if (!known.includes(findingId)) {
    // Naming the valid ids matters: they are positional and never displayed,
    // so an invalid reference is an easy and unremarkable mistake to make.
    return {
      ok: false,
      error: `No finding ${findingId} in that review. Available: ${known.join(', ') || 'none'}.`,
    };
  }

  if (input.action === 'rewrite' && (input.replacementText ?? '').trim().length === 0) {
    return { ok: false, error: 'A rewrite needs the replacement text.' };
  }

  const feedbackId = randomUUID();
  db.prepare(
    `INSERT INTO feedback (feedback_id, review_run_id, finding_id, action, replacement_text, reason, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (review_run_id, finding_id, action) DO UPDATE SET
       replacement_text = excluded.replacement_text,
       reason = excluded.reason,
       created_at = excluded.created_at`,
  ).run(
    feedbackId,
    reviewRunId,
    findingId,
    input.action,
    input.replacementText ?? null,
    input.reason ?? null,
    input.actor,
    new Date().toISOString(),
  );

  recordAudit(db, 'feedback_recorded', { type: 'finding', id: findingId }, {
    reviewRunId,
    action: input.action,
  });

  return { ok: true, feedbackId, reviewRunId, findingId };
}

export interface FeedbackTotals {
  kept: number;
  rewritten: number;
  dismissed: number;
  other: number;
  /** (kept + rewritten) / (kept + rewritten + dismissed); null when unmeasured. */
  ownerPrecision: number | null;
}

export function feedbackTotals(db: Database): FeedbackTotals {
  const rows = db.prepare('SELECT action, COUNT(*) AS n FROM feedback GROUP BY action').all() as {
    action: string;
    n: number;
  }[];
  const by = Object.fromEntries(rows.map((row) => [row.action, row.n]));

  const kept = by['keep'] ?? 0;
  const rewritten = by['rewrite'] ?? 0;
  const dismissed = by['dismiss'] ?? 0;
  const other = rows.reduce((sum, row) => sum + row.n, 0) - kept - rewritten - dismissed;

  // Unlabelled findings are excluded: silence is not a negative signal, and
  // counting it as one would make the reviewer look worse the quieter its user is.
  const labelled = kept + rewritten + dismissed;
  return {
    kept,
    rewritten,
    dismissed,
    other,
    ownerPrecision: labelled === 0 ? null : (kept + rewritten) / labelled,
  };
}
