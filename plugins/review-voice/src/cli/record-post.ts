import { openDatabase } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import { runDetail } from '../store/runs.ts';
import { flag } from './shared.ts';

const EVENTS = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'];

/**
 * Records a review posted outside `post` (#473) as the attempted and sent rows `post --confirm`
 * writes, so `carry` and anything else reading posted state sees it. The same run and url is a no-op.
 */
export function recordPostCommand(argv: string[]): number {
  const run = flag(argv, '--run');
  const event = flag(argv, '--event');
  const url = flag(argv, '--url');
  const reviewId = flag(argv, '--review-id');
  if (run === null || url === null || url.trim() === '' || event === null || !EVENTS.includes(event)) {
    console.error(`record-post needs --run <id>, --url <review url> and --event ${EVENTS.join('|')}.`);
    return 2;
  }
  if (reviewId !== null && !/^[1-9]\d*$/u.test(reviewId)) {
    console.error('record-post --review-id must be a positive integer.');
    return 2;
  }
  const db = openDatabase();
  try {
    const detail = runDetail(db, run);
    if (detail === null) {
      console.error(`No recorded run ${run}.`);
      return 2;
    }
    if (detail.repository === null || detail.pullNumber === null) {
      console.error(`Run ${run} has no repository and pull request, so a posted review cannot be recorded for it.`);
      return 2;
    }
    // The lookup and both rows land together or not at all, and a second caller waits for the first.
    db.exec('BEGIN IMMEDIATE');
    let known: unknown;
    try {
      known = db
        .prepare(`SELECT 1 FROM audit_events WHERE action = 'review_post_attempted' AND json_extract(metadata_json, '$.run') = ? AND json_extract(metadata_json, '$.url') = ?`)
        .get(run, url);
      if (known === undefined) {
        const subject = { type: 'pull_request', id: `${detail.repository.toLowerCase()}#${detail.pullNumber}` };
        const attempt = recordAudit(db, 'review_post_attempted', subject, { run, event, url, external: true });
        recordAudit(db, 'review_post_sent', subject, {
          attempt,
          head: detail.headRef,
          event,
          url,
          external: true,
          ...(reviewId !== null ? { reviewId: Number(reviewId) } : {}),
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(JSON.stringify({ run, event, url, recorded: known === undefined }));
    return 0;
  } finally {
    db.close();
  }
}
