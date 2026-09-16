import type { Database } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import type { CollectedEvent } from './collect.ts';

export interface StoreResult {
  inserted: number;
  alreadyPresent: number;
}

/**
 * Persists collected events. Only redacted text reaches this layer — there is
 * no column for the original, so there is no way for one to be written by
 * mistake.
 */
export function storeEvents(db: Database, events: CollectedEvent[]): StoreResult {
  const insert = db.prepare(
    `INSERT INTO review_events (
       event_id, source, repository, pull_number, pull_request_url, comment_id,
       reviewer_login, reviewer_role, created_at, body_redacted, content_key,
       file_path, line_start, diff_hunk_redacted, outcome_status,
       outcome_certainty, redaction_version, redaction_counts_json, created_db_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (content_key) DO NOTHING`,
  );

  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const event of events) {
      const result = insert.run(
        event.eventId,
        event.source,
        event.repository,
        event.pullNumber,
        event.pullRequestUrl,
        event.commentId,
        event.reviewerLogin,
        event.role,
        event.createdAt,
        event.bodyRedacted,
        event.contentKey,
        event.filePath ?? null,
        event.lineStart ?? null,
        event.diffHunkRedacted ?? null,
        // Outcomes are inferred in a later pass; unknown is the honest default
        // and carries a middling weight rather than zero.
        'unknown',
        'weak',
        event.redactionVersion,
        JSON.stringify(event.redactionCounts),
        new Date().toISOString(),
      );
      if (result.changes > 0) inserted += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const redactionTotals: Record<string, number> = {};
  for (const event of events) {
    for (const [label, count] of Object.entries(event.redactionCounts)) {
      redactionTotals[label] = (redactionTotals[label] ?? 0) + count;
    }
  }

  // Counts only. The values they describe were never retained.
  recordAudit(db, 'corpus_ingested', null, {
    offered: events.length,
    inserted,
    redactions: redactionTotals,
  });

  return { inserted, alreadyPresent: events.length - inserted };
}

export interface CorpusCoverage {
  total: number;
  byRepository: Record<string, number>;
  byRole: Record<string, number>;
  oldest: string | null;
  newest: string | null;
}

export function corpusCoverage(db: Database): CorpusCoverage {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM review_events').get() as { n: number }).n;
  const byRepository = Object.fromEntries(
    (db.prepare('SELECT repository, COUNT(*) AS n FROM review_events GROUP BY repository').all() as {
      repository: string;
      n: number;
    }[]).map((row) => [row.repository, row.n]),
  );
  const byRole = Object.fromEntries(
    (db.prepare('SELECT reviewer_role, COUNT(*) AS n FROM review_events GROUP BY reviewer_role').all() as {
      reviewer_role: string;
      n: number;
    }[]).map((row) => [row.reviewer_role, row.n]),
  );
  const range = db
    .prepare('SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM review_events')
    .get() as { oldest: string | null; newest: string | null };

  return { total, byRepository, byRole, oldest: range.oldest, newest: range.newest };
}
