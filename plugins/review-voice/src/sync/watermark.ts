import type { Database } from '../store/db.ts';

/**
 * Incremental sync at the pull-request level.
 *
 * A pull request is worth re-reading only when GitHub says it changed. That is
 * a comparison against state we actually hold, unlike an HTTP conditional
 * request, which tells us a response body is unchanged when we never kept the
 * body in the first place.
 */
export interface Watermark {
  repository: string;
  pullNumber: number;
  updatedAt: string;
}

export function loadWatermarks(db: Database, repository: string): Map<number, string> {
  const rows = db
    .prepare('SELECT pull_number, updated_at FROM sync_watermarks WHERE repository = ?')
    .all(repository) as { pull_number: number; updated_at: string }[];
  return new Map(rows.map((row) => [row.pull_number, row.updated_at]));
}

/**
 * Only ever called after the events from those pull requests have been stored.
 * Recording a watermark for work that was not persisted is what makes the next
 * sync skip data it never had.
 */
export function saveWatermarks(db: Database, marks: Watermark[]): void {
  const upsert = db.prepare(
    `INSERT INTO sync_watermarks (repository, pull_number, updated_at, processed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (repository, pull_number) DO UPDATE SET
       updated_at = excluded.updated_at,
       processed_at = excluded.processed_at`,
  );
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const mark of marks) upsert.run(mark.repository, mark.pullNumber, mark.updatedAt, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
