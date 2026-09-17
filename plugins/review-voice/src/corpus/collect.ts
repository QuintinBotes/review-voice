import type { GitHubClient } from '../github/client.ts';
import { classifyReviewer, type ReviewerRole } from '../github/roles.ts';
import { redact, REDACTION_VERSION } from '../redact/redact.ts';
import { ineligibleReason, type Ineligible } from './eligibility.ts';
import { contentKey } from './dedup.ts';

export interface CollectedEvent {
  eventId: string;
  source: 'github';
  repository: string;
  pullNumber: number;
  pullRequestUrl: string;
  commentId: string;
  reviewerLogin: string;
  role: ReviewerRole;
  createdAt: string;
  /** Redacted. The original is never retained. */
  bodyRedacted: string;
  filePath?: string | undefined;
  lineStart?: number | undefined;
  diffHunkRedacted?: string | undefined;
  contentKey: string;
  redactionVersion: string;
  redactionCounts: Record<string, number>;
}

export interface CollectionStats {
  pullRequestsScanned: number;
  /** Skipped because GitHub reports them unchanged since the last sync. */
  pullRequestsUnchanged: number;
  commentsSeen: number;
  /** Broken down by source, because they are not equally informative. */
  bySource: { inline: number; reviewSummary: number; conversation: number };
  eligible: number;
  duplicates: number;
  excluded: Record<string, number>;
}

interface RawComment {
  id: number;
  body?: string;
  user?: { login?: string; type?: string };
  created_at?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  html_url?: string;
  author_association?: string;
  pull_request_url?: string;
}

interface RawPull {
  number: number;
  html_url: string;
  updated_at: string;
  head?: { repo?: { fork?: boolean } | null };
}

export interface CollectOptions {
  repository: string;
  ownerLogin: string;
  teamLogins?: readonly string[];
  /** Upper bound on pull requests inspected, so one sync cannot run away. */
  maxPullRequests: number;
  maxCommentsPerPull: number;
  includeForks: boolean;
  /**
   * Pull-request conversation comments. Off by default: the thread is where
   * scheduling, CI chatter and "rebased, ptal" live, and only sometimes
   * review judgement.
   */
  includeConversationComments: boolean;
  /** Pull requests already processed, by number, with the updatedAt seen then. */
  watermarks?: Map<number, string> | undefined;
}

interface RawReview {
  id: number;
  body?: string;
  user?: { login?: string; type?: string };
  submitted_at?: string;
  html_url?: string;
  author_association?: string;
  state?: string;
}

/**
 * Downloads review comments and turns them into redacted, classified events.
 *
 * Redaction happens here, at the boundary, before anything is returned - the
 * original text never exists anywhere a caller could accidentally persist it.
 */
export interface CollectionResult {
  events: CollectedEvent[];
  /** Only returned for pull requests actually read, so a caller cannot record
   *  a watermark for work it never did. */
  watermarks: { pullNumber: number; updatedAt: string }[];
}

export async function collectRepository(
  client: GitHubClient,
  options: CollectOptions,
  stats: CollectionStats,
): Promise<CollectionResult> {
  const pulls = await client.paginate<RawPull>(
    `/repos/${options.repository}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
    options.maxPullRequests,
  );

  const events: CollectedEvent[] = [];
  const seenKeys = new Set<string>();
  const watermarks: { pullNumber: number; updatedAt: string }[] = [];

  for (const pull of pulls) {
    // Fork content is somebody else's repository; it is opt-in.
    if (!options.includeForks && pull.head?.repo?.fork === true) continue;

    // Unchanged since we last read it. This is a comparison against state we
    // hold, so skipping is safe in a way an HTTP 304 was not.
    if (options.watermarks?.get(pull.number) === pull.updated_at) {
      stats.pullRequestsUnchanged += 1;
      continue;
    }

    stats.pullRequestsScanned += 1;
    watermarks.push({ pullNumber: pull.number, updatedAt: pull.updated_at });

    const comments = await client.paginate<RawComment>(
      `/repos/${options.repository}/pulls/${pull.number}/comments?per_page=100`,
      options.maxCommentsPerPull,
    );

    const ingest = (raw: {
      id: number;
      body: string;
      login: string | undefined;
      accountType: string | undefined;
      association: string | undefined;
      createdAt: string | undefined;
      filePath?: string | undefined;
      line?: number | undefined;
      diffHunk?: string | undefined;
      idPrefix: string;
    }): void => {
      stats.commentsSeen += 1;
      if (raw.login === undefined || raw.body.length === 0) return;

      const role = classifyReviewer({
        login: raw.login,
        accountType: raw.accountType,
        ownerLogin: options.ownerLogin,
        teamLogins: options.teamLogins,
        authorAssociation: raw.association,
      });

      const reason: Ineligible | null = ineligibleReason({
        body: raw.body,
        role,
        filePath: raw.filePath,
        hasCodeContext: (raw.diffHunk ?? '').length > 0,
      });

      if (reason !== null) {
        stats.excluded[reason] = (stats.excluded[reason] ?? 0) + 1;
        return;
      }

      const key = contentKey({
        repository: options.repository,
        reviewerLogin: raw.login,
        body: raw.body,
        filePath: raw.filePath,
        lineStart: raw.line,
      });

      // Rebases and copied discussion resurface the same comment under a new
      // id, and a review summary often repeats an inline comment verbatim.
      if (seenKeys.has(key)) {
        stats.duplicates += 1;
        return;
      }
      seenKeys.add(key);

      const redactedBody = redact(raw.body);
      const redactedHunk = raw.diffHunk === undefined ? undefined : redact(raw.diffHunk);

      events.push({
        eventId: `${raw.idPrefix}${raw.id}`,
        source: 'github',
        repository: options.repository,
        pullNumber: pull.number,
        pullRequestUrl: pull.html_url,
        commentId: String(raw.id),
        reviewerLogin: raw.login,
        role,
        createdAt: raw.createdAt ?? pull.updated_at,
        bodyRedacted: redactedBody.text,
        filePath: raw.filePath,
        lineStart: raw.line,
        diffHunkRedacted: redactedHunk?.text,
        contentKey: key,
        redactionVersion: REDACTION_VERSION,
        redactionCounts: {
          ...redactedBody.counts,
          ...(redactedHunk === undefined ? {} : redactedHunk.counts),
        },
      });
      stats.eligible += 1;
    };

    for (const comment of comments) {
      stats.bySource.inline += 1;
      ingest({
        id: comment.id,
        body: comment.body ?? '',
        login: comment.user?.login,
        accountType: comment.user?.type,
        association: comment.author_association,
        createdAt: comment.created_at,
        filePath: comment.path,
        line: comment.line ?? comment.original_line ?? undefined,
        diffHunk: comment.diff_hunk,
        idPrefix: 'ghc_',
      });
    }

    // Submitted review summaries. Measured against a real repository these
    // outnumber inline comments roughly two to one, and some pull requests
    // have no inline comments at all - collecting only inline comments was
    // capturing a minority of the review evidence.
    const reviews = await client.paginate<RawReview>(
      `/repos/${options.repository}/pulls/${pull.number}/reviews?per_page=100`,
      options.maxCommentsPerPull,
    );

    for (const review of reviews) {
      const body = review.body ?? '';
      if (body.length === 0) continue; // An approval with no words says nothing.
      stats.bySource.reviewSummary += 1;
      ingest({
        id: review.id,
        body,
        login: review.user?.login,
        accountType: review.user?.type,
        association: review.author_association,
        createdAt: review.submitted_at,
        idPrefix: 'ghr_',
      });
    }

    if (options.includeConversationComments) {
      const conversation = await client.paginate<RawComment>(
        `/repos/${options.repository}/issues/${pull.number}/comments?per_page=100`,
        options.maxCommentsPerPull,
      );
      for (const comment of conversation) {
        stats.bySource.conversation += 1;
        ingest({
          id: comment.id,
          body: comment.body ?? '',
          login: comment.user?.login,
          accountType: comment.user?.type,
          association: comment.author_association,
          createdAt: comment.created_at,
          idPrefix: 'ghi_',
        });
      }
    }
  }

  return { events, watermarks };
}
