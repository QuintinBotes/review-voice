import type { Database } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import type { CollectedEvent } from './collect.ts';
import { unfinishedSyncRuns } from '../sync/state.ts';

export interface StoreResult {
  inserted: number;
  alreadyPresent: number;
}

/**
 * Persists collected events. Only redacted text reaches this layer - there is
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
  /** Problems with the corpus that would otherwise only show up as silence. */
  warnings: string[];
}

export interface CoverageOptions {
  /** Repositories the user allowlisted, so absent ones can be named. */
  allowlist?: readonly string[];
  maxRepositoryShare?: number;
  /** Fixed clock, so the unfinished-sync grace period is testable. */
  now?: Date;
}

export function corpusCoverage(db: Database, options: CoverageOptions = {}): CorpusCoverage {
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

  const warnings: string[] = [];

  // An unhealthy corpus is otherwise only visible by querying the database by
  // hand, and its symptoms show up as silence: retrieval returning the same
  // few documents, calibrate proposing nothing.
  const anchored = (
    db
      .prepare("SELECT COUNT(*) AS n FROM review_events WHERE reviewer_role = 'owner' AND file_path IS NOT NULL")
      .get() as { n: number }
  ).n;
  const ownerTotal = byRole['owner'] ?? 0;

  if (ownerTotal > 0 && anchored * 2 < ownerTotal) {
    warnings.push(
      `${ownerTotal - anchored} of ${ownerTotal} owner events have no file anchor. ` +
        'Unanchored summaries match any candidate, so with the owner weighting applied they surface ' +
        'for every finding regardless of topic. Sync more repositories, or expect weak precedent.',
    );
  }

  // An empty corpus reads the same whether a sync has never run or one began
  // and died. Two of the seven sync runs on the first machine to use this
  // ended that way, and the only way to tell was to query the table by hand.
  for (const run of unfinishedSyncRuns(db, options.now ?? new Date())) {
    warnings.push(
      `A sync started ${run.startedAt} and never recorded a finish. ` +
        `It covered ${run.repositories.join(', ') || 'no repositories'}, and anything it read was not stored. ` +
        'Run sync again.',
    );
  }

  for (const repository of options.allowlist ?? []) {
    if ((byRepository[repository] ?? 0) === 0) {
      warnings.push(`${repository} is allowlisted but contributed no events. Check it has review history you can read.`);
    }
  }

  const share = options.maxRepositoryShare;
  if (share !== undefined && total > 0) {
    for (const [repository, count] of Object.entries(byRepository)) {
      if (count / total > share) {
        warnings.push(
          `${repository} is ${Math.round((count / total) * 100)}% of the corpus, above the configured ` +
            `${Math.round(share * 100)}% share. Policy compiled from it will mostly describe that repository.`,
        );
      }
    }
  }

  if (total > 0 && (byRole['owner'] ?? 0) === 0) {
    // Rule activation requires at least one owner signal, so a corpus with
    // none can never produce a rule. Without this the failure is silent:
    // calibrate simply keeps proposing nothing.
    warnings.push(
      'No events authored by the owner reviewer. Policy rules need at least one owner signal, ' +
        'so nothing in this corpus can activate a rule. Check identity.owner_reviewer matches your GitHub login.',
    );
  }

  return { total, byRepository, byRole, oldest: range.oldest, newest: range.newest, warnings };
}
