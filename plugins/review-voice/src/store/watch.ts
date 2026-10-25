import type { Database } from './db.ts';

/** What the watcher did with one head (docs/adr/0027). */
export type HeadStatus = 'reviewed' | 'posted' | 'carried' | 'waiting-ci' | 'held' | 'failed' | 'skipped';

export interface WatchHead {
  repository: string;
  pull: number;
  head: string;
  runId: string | null;
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' | null;
  reviewUrl: string | null;
  status: HeadStatus;
  detail: string | null;
  /** Failed attempts on this head. */
  attempts: number;
  updatedAt: string;
}

interface Row {
  repository: string;
  pull_number: number;
  head_sha: string;
  run_id: string | null;
  event: WatchHead['event'];
  review_url: string | null;
  status: HeadStatus;
  detail: string | null;
  attempts: number;
  updated_at: string;
}

const fromRow = (row: Row): WatchHead => ({
  repository: row.repository,
  pull: row.pull_number,
  head: row.head_sha,
  runId: row.run_id,
  event: row.event,
  reviewUrl: row.review_url,
  status: row.status,
  detail: row.detail,
  attempts: row.attempts,
  updatedAt: row.updated_at,
});

// Stored lower case: the queue, the audit log and the API spell names differently by case.
const key = (repository: string, head: string): [string, string] => [repository.toLowerCase(), head.toLowerCase()];

export function watchHead(db: Database, repository: string, pull: number, head: string): WatchHead | null {
  const [name, sha] = key(repository, head);
  const row = db
    .prepare('SELECT * FROM watch_heads WHERE repository = ? AND pull_number = ? AND head_sha = ?')
    .get(name, pull, sha) as Row | undefined;
  return row === undefined ? null : fromRow(row);
}

/** Writes the head's row, replacing an earlier one; a failure adds one to the attempts, anything else keeps them. */
export function saveWatchHead(
  db: Database,
  row: Omit<WatchHead, 'attempts' | 'updatedAt'>,
  now: Date,
): WatchHead {
  const [name, sha] = key(row.repository, row.head);
  const attempts = (watchHead(db, name, row.pull, sha)?.attempts ?? 0) + (row.status === 'failed' ? 1 : 0);
  const saved: WatchHead = { ...row, repository: name, head: sha, attempts, updatedAt: now.toISOString() };
  db.prepare(
    `INSERT INTO watch_heads (repository, pull_number, head_sha, run_id, event, review_url, status, detail, attempts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repository, pull_number, head_sha) DO UPDATE SET
       run_id = excluded.run_id, event = excluded.event, review_url = excluded.review_url, status = excluded.status,
       detail = excluded.detail, attempts = excluded.attempts, updated_at = excluded.updated_at`,
  ).run(name, row.pull, sha, row.runId, row.event, row.reviewUrl, row.status, row.detail, attempts, saved.updatedAt);
  return saved;
}

/**
 * The pull requests `post` sent a review to since `since` (ISO), newest send
 * first, at most `limit`, with the time of each one's newest send.
 */
export function recentlySentPulls(
  db: Database,
  since: string,
  limit: number,
): { repository: string; pull: number; sentAt: string }[] {
  const rows = db
    .prepare(
      `SELECT subject_id, MAX(created_at) AS sent_at FROM audit_events
       WHERE action = 'review_post_sent' AND created_at >= ?
       GROUP BY subject_id ORDER BY sent_at DESC LIMIT ?`,
    )
    .all(since, limit) as { subject_id: string; sent_at: string }[];
  const pulls: { repository: string; pull: number; sentAt: string }[] = [];
  for (const row of rows) {
    const match = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(row.subject_id);
    if (match !== null) pulls.push({ repository: match[1]!, pull: Number(match[2]), sentAt: row.sent_at });
  }
  return pulls;
}

/** For `status`: counts by status and the five newest rows, or nothing when the watcher has no rows. */
export function watchSummary(db: Database): string[] {
  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM watch_heads GROUP BY status ORDER BY status')
    .all() as { status: string; n: number }[];
  if (counts.length === 0) return [];
  const recent = db
    .prepare('SELECT * FROM watch_heads ORDER BY updated_at DESC, rowid DESC LIMIT 5')
    .all() as unknown as Row[];
  return [
    `watcher          ${counts.map((row) => `${row.n} ${row.status}`).join(', ')}`,
    ...recent.map((row) => `  ${row.repository}#${row.pull_number} ${row.head_sha.slice(0, 7)} ${row.status}${row.detail === null ? '' : ` ${row.detail}`}`),
  ];
}

/** Heads the watcher left for a person: held, skipped, or failed `maxAttemptsPerHead` times. Newest first. */
export function settledHeads(db: Database, maxAttemptsPerHead: number): WatchHead[] {
  const rows = db
    .prepare(
      `SELECT * FROM watch_heads
       WHERE status IN ('held', 'skipped') OR (status = 'failed' AND attempts >= ?)
       ORDER BY updated_at DESC, rowid DESC`,
    )
    .all(maxAttemptsPerHead) as unknown as Row[];
  return rows.map(fromRow);
}
