import { randomUUID } from 'node:crypto';
import type { Database } from '../store/db.ts';

// The ETag helpers that lived here are gone with the sync_state table they
// read. Migration v6 drops that table, so keeping them would have left two
// exported functions that throw on call - worse than dead code, because the
// signature still reads as usable. Incremental sync is in ./watermark.ts.

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

/**
 * A sync that is still running writes the same row as one that died, so a
 * recent start is not yet evidence of anything.
 */
const ASSUME_STILL_RUNNING_MINUTES = 30;

/**
 * Sync runs that began and never recorded a finish.
 *
 * `lastSync` only ever returns finished runs, and the corpus count is the same
 * zero whether a sync has never run or one started and died. Those need
 * different actions from the user, so they cannot look identical.
 */
export function unfinishedSyncRuns(db: Database, now: Date = new Date()): SyncRunSummary[] {
  const cutoff = new Date(now.getTime() - ASSUME_STILL_RUNNING_MINUTES * 60_000).toISOString();
  return (
    db
      .prepare(
        `SELECT * FROM sync_runs
         WHERE finished_at IS NULL
           AND started_at < ?
           -- A sync that completed afterwards did the work this one abandoned,
           -- so the dangling row is history rather than an outstanding task.
           -- Reporting it beside "last sync 07:46, 250 imported" told the user
           -- to run a sync they had already run four times.
           AND NOT EXISTS (
             SELECT 1 FROM sync_runs later
             WHERE later.finished_at IS NOT NULL AND later.finished_at > sync_runs.started_at
           )
         ORDER BY started_at DESC`,
      )
      .all(cutoff) as Record<string, unknown>[]
  ).map((row) => ({
    syncRunId: row['sync_run_id'] as string,
    startedAt: row['started_at'] as string,
    finishedAt: null,
    repositories: JSON.parse(row['repositories_json'] as string) as string[],
    imported: row['imported'] as number,
  }));
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
