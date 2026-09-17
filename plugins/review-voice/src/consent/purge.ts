import type { Database } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';

export interface PurgeScope {
  repository?: string | undefined;
  before?: string | undefined;
  all?: boolean | undefined;
}

export interface PurgePreview {
  events: number;
  reviewRuns: number;
  feedback: number;
  auditEvents: number;
  /** Sync watermarks removed, so the next sync rebuilds rather than tops up. */
  watermarks: number;
  byRepository: Record<string, number>;
}

function scopeClause(scope: PurgeScope): { where: string; params: string[] } {
  if (scope.all === true) return { where: '1=1', params: [] };
  if (scope.repository !== undefined) return { where: 'repository = ?', params: [scope.repository] };
  if (scope.before !== undefined) return { where: 'created_at < ?', params: [scope.before] };
  return { where: '1=0', params: [] };
}

/**
 * Counts what a purge would remove. Deletion is irreversible, so the user sees
 * the damage before agreeing to it rather than after.
 */
export function previewPurge(db: Database, scope: PurgeScope): PurgePreview {
  const { where, params } = scopeClause(scope);

  const events = (
    db.prepare(`SELECT COUNT(*) AS n FROM review_events WHERE ${where}`).get(...params) as { n: number }
  ).n;

  const byRepository = Object.fromEntries(
    (
      db
        .prepare(`SELECT repository, COUNT(*) AS n FROM review_events WHERE ${where} GROUP BY repository`)
        .all(...params) as { repository: string; n: number }[]
    ).map((row) => [row.repository, row.n]),
  );

  const all = scope.all === true;

  // Watermarks record which pull requests have already been read. Deleting
  // events while leaving them behind means the next sync skips everything it
  // previously imported as "unchanged" and rebuilds nothing - the corpus comes
  // back as whatever happened to be updated since, which is not a rebuild.
  const watermarks = all
    ? (db.prepare('SELECT COUNT(*) AS n FROM sync_watermarks').get() as { n: number }).n
    : scope.repository !== undefined
      ? (
          db
            .prepare('SELECT COUNT(*) AS n FROM sync_watermarks WHERE repository = ?')
            .get(scope.repository) as { n: number }
        ).n
      : 0;

  const reviewRuns = all
    ? (db.prepare('SELECT COUNT(*) AS n FROM review_runs').get() as { n: number }).n
    : 0;
  const feedback = all ? (db.prepare('SELECT COUNT(*) AS n FROM feedback').get() as { n: number }).n : 0;
  const auditEvents = all
    ? (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n
    : 0;

  return { events, reviewRuns, feedback, auditEvents, watermarks, byRepository };
}

export function executePurge(db: Database, scope: PurgeScope): PurgePreview {
  const preview = previewPurge(db, scope);
  const { where, params } = scopeClause(scope);

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM review_events WHERE ${where}`).run(...params);

    if (scope.all === true) {
      db.prepare('DELETE FROM sync_watermarks').run();
      db.prepare('DELETE FROM review_runs').run();
      db.prepare('DELETE FROM feedback').run();
    } else if (scope.repository !== undefined) {
      db.prepare('DELETE FROM sync_watermarks WHERE repository = ?').run(scope.repository);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // The audit entry survives the purge it records. Deleting the evidence that
  // a deletion happened would make the audit trail useless precisely when it
  // matters most.
  recordAudit(db, 'purge', null, { scope, removed: preview });
  return preview;
}
