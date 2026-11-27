import type { Database } from './db.ts';
import type { GitHubClient } from '../github/client.ts';
import { SEVERITIES } from '../contract/limits.ts';
import { recordAudit } from './audit.ts';
import { postedProse } from './outcomes.ts';
import { recordRun } from './runs.ts';

/**
 * Reviews the Action posted, found on GitHub and recorded as runs here, so the
 * owner's replies and resolutions become outcomes (#529, docs/adr/0042).
 *
 * The Action keeps its store in the runner's cache, so no local command could
 * follow what it posted. A review by one of `logins` whose inline comments are
 * findings as `post` renders them (`**severity** - text`) is rebuilt as a run
 * with the findings it posted, and a `review_post_sent` row that names the
 * review, which is all `outcomes` needs. Reads only GitHub; writes only the
 * local store.
 */

/** Who the Action posts as. A GitHub App installation token is `github-actions[bot]`. */
export const DEFAULT_RECOVER_FROM: readonly string[] = ['github-actions[bot]'];

/** Pull requests read per repository, newest update first. */
export const RECOVER_MAX_PULLS = 100;

const READ_LIMIT = 1000;

interface RawPull {
  number?: number;
  updated_at?: string;
}

interface RawReview {
  id?: number;
  state?: string;
  commit_id?: string;
  user?: { login?: string } | null;
}

interface RawReviewComment {
  id?: number;
  pull_request_review_id?: number | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  in_reply_to_id?: number | null;
}

export interface RecoverOptions {
  db: Database;
  client: GitHubClient;
  /** Repositories that may be read. */
  allowlist: string[];
  repository?: string | undefined;
  /** ISO time; only pull requests updated at or after it are read. */
  since: string;
  /** The logins whose reviews are recovered; default `github-actions[bot]`. */
  logins?: readonly string[] | undefined;
  maxPulls?: number | undefined;
}

export interface RecoveredReview {
  repository: string;
  pullNumber: number;
  reviewId: number;
  runId: string;
  findings: number;
}

export interface RecoverResult {
  recovered: RecoveredReview[];
  warnings: string[];
}

const FINDING_COMMENT = new RegExp(`^\\*\\*(${SEVERITIES.join('|')})\\*\\* - ([\\s\\S]+)$`);

/** The review ids a sent row already names, whether the review was posted from here or recovered. */
function knownReviewIds(db: Database): Set<number> {
  const known = new Set<number>();
  for (const row of db.prepare(`SELECT metadata_json FROM audit_events WHERE action = 'review_post_sent'`).all() as { metadata_json: string }[]) {
    try {
      const id = Number((JSON.parse(row.metadata_json) as { reviewId?: unknown }).reviewId);
      if (Number.isInteger(id) && id > 0) known.add(id);
    } catch {
      // A row nobody could read names no review.
    }
  }
  return known;
}

/** `[severity] \`path:line\` - text` for each inline comment that is a finding as `post` renders one, in the order posted. */
export function postedFindings(comments: readonly RawReviewComment[]): string[] {
  const lines: string[] = [];
  for (const comment of comments) {
    // A reply is somebody answering, not a finding.
    if (comment.in_reply_to_id !== undefined && comment.in_reply_to_id !== null) continue;
    const line = comment.line ?? comment.original_line;
    if (typeof comment.path !== 'string' || typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue;
    const match = FINDING_COMMENT.exec(postedProse(comment.body ?? '').trim());
    if (match === null) continue;
    const prose = match[2]!.replace(/\s*\n\s*/g, ' ').trim();
    if (prose === '') continue;
    lines.push(`[${match[1]}] \`${comment.path}:${line}\` - ${prose}`);
  }
  return lines;
}

/**
 * Records each not-yet-known review by `logins` on the allowlisted repositories'
 * recently updated pull requests as a run. A review with no finding comment, a
 * review already named by a sent row, and a login not listed are left alone, so
 * running it again records nothing twice.
 */
export async function recoverPostedReviews(options: RecoverOptions): Promise<RecoverResult> {
  const result: RecoverResult = { recovered: [], warnings: [] };
  const logins = new Set((options.logins ?? DEFAULT_RECOVER_FROM).map((login) => login.toLowerCase()));
  const repositories = options.repository === undefined ? options.allowlist : [options.repository];
  const known = knownReviewIds(options.db);
  const limit = options.maxPulls ?? RECOVER_MAX_PULLS;

  for (const repository of repositories) {
    let pulls: RawPull[];
    try {
      pulls = await options.client.paginate<RawPull>(`/repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=100`, limit);
    } catch (error) {
      result.warnings.push(`${repository}: pull requests not read (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`);
      continue;
    }
    for (const pull of pulls) {
      // Newest update first, so the first one older than the window ends the list.
      if (typeof pull.updated_at === 'string' && pull.updated_at < options.since) break;
      if (typeof pull.number !== 'number') continue;
      try {
        const reviews = await options.client.paginate<RawReview>(`/repos/${repository}/pulls/${pull.number}/reviews?per_page=100`, READ_LIMIT);
        const wanted = reviews.filter((review) => {
          const author = review.user?.login?.toLowerCase();
          return author !== undefined && logins.has(author) && typeof review.id === 'number' && !known.has(review.id);
        });
        if (wanted.length === 0) continue;
        // The pull request's own list, which has each comment's line and review; the list per review has neither (#531).
        const all = await options.client.paginate<RawReviewComment>(`/repos/${repository}/pulls/${pull.number}/comments?per_page=100`, READ_LIMIT);
        for (const review of wanted) {
          if (review.state === 'PENDING' || typeof review.commit_id !== 'string' || review.commit_id === '') continue;
          const comments = all.filter((comment) => comment.pull_request_review_id === review.id);
          const findings = postedFindings(comments);
          if (findings.length === 0) continue;
          result.recovered.push(recordReview(options.db, repository, pull.number, review.id!, review.commit_id, findings));
          known.add(review.id!);
        }
      } catch (error) {
        result.warnings.push(`${repository}#${pull.number}: not recovered (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`);
      }
    }
  }
  return result;
}

/** The run, and the attempt and sent rows `outcomes` follows a posted review through, written together or not at all. */
function recordReview(db: Database, repository: string, pullNumber: number, reviewId: number, head: string, findings: string[]): RecoveredReview {
  db.exec('SAVEPOINT recover_review');
  try {
    const run = recordRun(db, {
      repository,
      baseRef: null,
      headRef: head,
      pullNumber,
      // No diff was read: the hash only has to be stable per review.
      diff: `recovered from review ${reviewId} on ${repository}#${pullNumber}`,
      output: findings.join('\n'),
    });
    const subject = { type: 'pull_request', id: `${repository.toLowerCase()}#${pullNumber}` };
    const key = `recovered:${repository.toLowerCase()}#${pullNumber}:${reviewId}`;
    const attempt = recordAudit(db, 'review_post_attempted', subject, { key, run: run.reviewRunId, recovered: true });
    recordAudit(db, 'review_post_sent', subject, { key, attempt, head, reviewId, inline: [], recovered: true });
    db.exec('RELEASE recover_review');
    return { repository, pullNumber, reviewId, runId: run.reviewRunId, findings: run.findings.length };
  } catch (error) {
    db.exec('ROLLBACK TO recover_review');
    db.exec('RELEASE recover_review');
    throw error;
  }
}
