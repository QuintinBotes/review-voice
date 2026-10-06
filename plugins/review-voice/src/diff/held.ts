import type { Database } from '../store/db.ts';
import { parseFinding } from '../contract/parse.ts';
import { overlap, significantWords, DUPLICATE_OVERLAP } from '../scoring/score.ts';
import { CarryError, type CarryInput } from './carry.ts';
import type { ThreadComment, ThreadReview } from './thread.ts';

/** A thread file as `RV thread` writes it, as far as holding findings back needs it. */
export interface ThreadFile {
  repository?: unknown;
  pullNumber?: unknown;
  comments: ThreadComment[];
  reviews: ThreadReview[];
}

/** Longest quoted reply or dismissal message in a reason. */
const QUOTE_LIMIT = 200;

/** Reads a thread file, refusing one that is not the thread of this run's pull request. */
export function parseThreadFile(text: string, file: string, run: { repository: string | null; pullNumber: number | null }): ThreadFile {
  let parsed: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Array.isArray((raw as Record<string, unknown>)['comments'])) {
      throw new Error('expected the thread.json that `RV thread` wrote');
    }
    parsed = raw as Record<string, unknown>;
  } catch (error) {
    throw new CarryError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sameRepository =
    typeof parsed['repository'] === 'string' &&
    run.repository !== null &&
    parsed['repository'].toLowerCase() === run.repository.toLowerCase();
  if (!sameRepository || run.pullNumber === null || parsed['pullNumber'] !== run.pullNumber) {
    throw new CarryError(
      `${file} is the thread of ${String(parsed['repository'])}#${String(parsed['pullNumber'])}, ` +
        `not of this run's pull request (${run.repository ?? 'no repository'}#${run.pullNumber ?? '?'}). ` +
        'Pass the thread.json that `RV thread` wrote for it.',
    );
  }
  return {
    repository: parsed['repository'],
    pullNumber: parsed['pullNumber'],
    comments: parsed['comments'] as ThreadComment[],
    reviews: Array.isArray(parsed['reviews']) ? (parsed['reviews'] as ThreadReview[]) : [],
  };
}

/**
 * The ids GitHub gave the reviews `post` sent for one run, from the audit log.
 *
 * An attempt names its run, and the sent row that answers it names the review.
 * Empty when the run was never posted from this machine.
 */
export function postedReviewIds(db: Database, runId: string): number[] {
  const attempts = db
    .prepare(`SELECT audit_id FROM audit_events WHERE action = 'review_post_attempted' AND json_extract(metadata_json, '$.run') = ?`)
    .all(runId) as { audit_id: string }[];
  const ids = new Set(attempts.map((row) => row.audit_id));
  if (ids.size === 0) return [];
  const sent = db.prepare(`SELECT metadata_json FROM audit_events WHERE action = 'review_post_sent'`).all() as { metadata_json: string }[];
  const reviewIds: number[] = [];
  for (const row of sent) {
    const meta = JSON.parse(row.metadata_json) as { attempt?: unknown; reviewId?: unknown };
    const id = Number(meta.reviewId);
    if (typeof meta.attempt === 'string' && ids.has(meta.attempt) && Number.isInteger(id)) reviewIds.push(id);
  }
  return reviewIds;
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `"${flat.length > QUOTE_LIMIT ? `${flat.slice(0, QUOTE_LIMIT)}...` : flat}"`;
}

/**
 * The inline comment that is this finding as `post` sent it, or null.
 *
 * Only a root comment counts, on the finding's file, opening `**<severity>** - `
 * and saying what the finding said. The line is not used: GitHub moves it. The
 * comment must also come from this run's posted review when the store knows it,
 * else have been written after the run was recorded, so an earlier comment that
 * happens to say the same thing is not taken for it.
 */
function postedComment(
  finding: CarryInput,
  thread: ThreadComment[],
  run: { createdAt: string },
  reviewIds: number[],
): ThreadComment | null {
  const parsed = parseFinding(finding.text, 1);
  if (parsed.severity === null || parsed.prose.length === 0) return null;
  const opening = `**${parsed.severity}** - `;
  const prose = significantWords(parsed.prose);
  const recordedAt = Date.parse(run.createdAt);
  for (const comment of thread) {
    if (comment.kind !== 'review-comment' || comment.inReplyTo !== undefined) continue;
    if (comment.path !== finding.path || !comment.body.startsWith(opening)) continue;
    if (reviewIds.length > 0) {
      if (comment.reviewId === undefined || !reviewIds.includes(comment.reviewId)) continue;
    } else {
      const written = typeof comment.createdAt === 'string' ? Date.parse(comment.createdAt) : Number.NaN;
      if (Number.isNaN(written) || Number.isNaN(recordedAt) || written <= recordedAt) continue;
    }
    if (overlap(prose, significantWords(comment.body)) >= DUPLICATE_OVERLAP) return comment;
  }
  return null;
}

/**
 * Which findings of an earlier run the author already answered on the pull
 * request, by finding id and with the reason: the thread of its posted comment
 * is resolved, or the review it was posted in was dismissed. A dismissed review
 * holds back all of the run's findings when the store knows its id, matched
 * comment or not. Nothing here is posted or written.
 */
export function heldBackFindings(
  findings: CarryInput[],
  thread: ThreadFile,
  run: { createdAt: string },
  reviewIds: number[],
): Map<string, string> {
  const dismissed = new Map(thread.reviews.filter((review) => review.state === 'DISMISSED').map((review) => [review.id, review]));
  const held = new Map<string, string>();
  for (const finding of findings) {
    const comment = postedComment(finding, thread.comments, run, reviewIds);
    const review =
      (comment?.reviewId !== undefined ? dismissed.get(comment.reviewId) : undefined) ??
      reviewIds.map((id) => dismissed.get(id)).find((candidate) => candidate !== undefined);
    const resolved = comment?.resolved === true;
    if (!resolved && review === undefined) continue;

    const parts: string[] = [];
    if (resolved) parts.push(`its thread was resolved${comment?.resolvedBy === undefined ? '' : ` by ${comment.resolvedBy}`}`);
    if (review !== undefined) {
      parts.push(`the review was dismissed${review.dismissalMessage === undefined ? '' : `: ${quote(review.dismissalMessage)}`}`);
    }
    const replies = comment?.id === undefined ? [] : thread.comments.filter((c) => c.inReplyTo === comment.id);
    // The latest by time; the thread's own order breaks a tie or a missing time.
    const last = replies.reduce<ThreadComment | undefined>(
      (latest, reply) => (latest === undefined || (reply.createdAt ?? '') >= (latest.createdAt ?? '') ? reply : latest),
      undefined,
    );
    if (last !== undefined) parts.push(`${last.author} replied: ${quote(last.body)}`);
    held.set(finding.findingId, parts.join('; '));
  }
  return held;
}
