import { randomUUID } from 'node:crypto';
import type { Database } from '../store/db.ts';

export function loadEtags(db: Database): Record<string, string> {
  const rows = db.prepare('SELECT url, etag FROM sync_state').all() as { url: string; etag: string }[];
  return Object.fromEntries(rows.map((row) => [row.url, row.etag]));
}

export function saveEtags(db: Database, etags: Record<string, string>): void {
  const upsert = db.prepare(
    `INSERT INTO sync_state (url, etag, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET etag = excluded.etag, updated_at = excluded.updated_at`,
  );
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const [url, etag] of Object.entries(etags)) upsert.run(url, etag, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export interface SyncRunSummary {
  syncRunId: string;
  startedAt: string;
  finishedAt: string | null;
  repositories: string[];
  imported: number;
}

export function beginSyncRun(db: Database, repositories: string[]): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO sync_runs (sync_run_id, started_at, finished_at, repositories_json, stats_json, imported) VALUES (?, ?, NULL, ?, ?, 0)',
  ).run(id, new Date().toISOString(), JSON.stringify(repositories), JSON.stringify({}));
  return id;
}

export function finishSyncRun(db: Database, id: string, stats: unknown, imported: number): void {
  db.prepare('UPDATE sync_runs SET finished_at = ?, stats_json = ?, imported = ? WHERE sync_run_id = ?').run(
    new Date().toISOString(),
    JSON.stringify(stats),
    imported,
    id,
  );
}

export function lastSync(db: Database): SyncRunSummary | null {
  const row = db
    .prepare('SELECT * FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    syncRunId: row['sync_run_id'] as string,
    startedAt: row['started_at'] as string,
    finishedAt: row['finished_at'] as string | null,
    repositories: JSON.parse(row['repositories_json'] as string) as string[],
    imported: row['imported'] as number,
  };
}
