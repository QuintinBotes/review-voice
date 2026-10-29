import type { Database } from '../store/db.ts';
import { watchHead, type WatchHead } from '../store/watch.ts';

/**
 * The queue's reads of the local store, kept apart so a caller with its own
 * record of each head (the watcher) can add a filter beside them.
 */

/** Each pull request with a run recorded since `since` (ISO), and the head its latest run read. */
export function recentlyReviewedPulls(db: Database, since: string): { repository: string; pull: number; head: string }[] {
  const rows = db
    .prepare(
      `SELECT repository, pull_number, head_ref
       FROM review_runs
       WHERE repository IS NOT NULL AND pull_number IS NOT NULL AND head_ref IS NOT NULL
         AND created_at >= ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(since) as { repository: string; pull_number: number; head_ref: string }[];
  const latest = new Map<string, { repository: string; pull: number; head: string }>();
  for (const row of rows) {
    const key = `${row.repository.toLowerCase()}#${row.pull_number}`;
    if (!latest.has(key)) latest.set(key, { repository: row.repository, pull: row.pull_number, head: row.head_ref });
  }
  return [...latest.values()];
}

/** Whether a run was recorded for this pull request at this head. */
export function runRecordedAtHead(db: Database, repository: string, pull: number, head: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM review_runs
       WHERE LOWER(repository) = LOWER(?) AND pull_number = ? AND LOWER(head_ref) = LOWER(?)
       LIMIT 1`,
    )
    .get(repository, pull, head);
  return row !== undefined;
}

/**
 * The watcher's row for this head when it is done with it (docs/adr/0027): it
 * posted, carried, skipped or held it, or it failed as often as it may.
 * `waiting-ci`, `reviewed` and a failure under the cap are worth another look.
 */
export function settledByWatcher(db: Database, repository: string, pull: number, head: string, maxAttemptsPerHead = 2): WatchHead | null {
  const row = watchHead(db, repository, pull, head);
  if (row === null) return null;
  if (row.status === 'failed') return row.attempts >= maxAttemptsPerHead ? row : null;
  return ['posted', 'carried', 'skipped', 'held'].includes(row.status) ? row : null;
}

/**
 * The last review `post` sent to this pull request at this head, or null.
 *
 * `cappedByCi` is read from the sent row when it is there: a COMMENT sent only
 * because CI was red is worth posting again once CI recovers, even after the
 * watcher recorded it as posted, unless the watcher has since settled the head
 * some other way. With no sent row, a head the watcher settled counts as sent,
 * so the queue leaves it out.
 */
export function lastSentAtHead(
  db: Database,
  repository: string,
  pull: number,
  head: string,
  maxAttemptsPerHead = 2,
): { event: string | null; cappedByCi: boolean } | null {
  const sent = lastSentRow(db, repository, pull, head);
  if (sent !== null && !sent.cappedByCi) return sent;
  const settled = settledByWatcher(db, repository, pull, head, maxAttemptsPerHead);
  if (settled === null) return sent;
  if (sent !== null) return settled.status === 'posted' ? sent : { ...sent, cappedByCi: false };
  return { event: settled.event, cappedByCi: false };
}

function lastSentRow(
  db: Database,
  repository: string,
  pull: number,
  head: string,
): { event: string | null; cappedByCi: boolean } | null {
  const rows = db
    .prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action = 'review_post_sent' AND subject_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(`${repository.toLowerCase()}#${pull}`) as { metadata_json: string }[];
  for (const row of rows) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof meta['head'] !== 'string' || meta['head'].toLowerCase() !== head.toLowerCase()) continue;
    const event = typeof meta['event'] === 'string' ? meta['event'] : null;
    return { event, cappedByCi: event === 'COMMENT' && (meta['cappedByCi'] === true || meta['cappedBy'] === 'ci') };
  }
  return null;
}
