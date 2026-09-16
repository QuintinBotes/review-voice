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
  commentsSeen: number;
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
}

/**
 * Downloads review comments and turns them into redacted, classified events.
 *
 * Redaction happens here, at the boundary, before anything is returned — the
 * original text never exists anywhere a caller could accidentally persist it.
 */
export async function collectRepository(
  client: GitHubClient,
  options: CollectOptions,
  stats: CollectionStats,
): Promise<CollectedEvent[]> {
  const pulls = await client.paginate<RawPull>(
    `/repos/${options.repository}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
    options.maxPullRequests,
  );

  const events: CollectedEvent[] = [];
  const seenKeys = new Set<string>();

  for (const pull of pulls) {
    // Fork content is somebody else's repository; it is opt-in.
    if (!options.includeForks && pull.head?.repo?.fork === true) continue;
    stats.pullRequestsScanned += 1;

    const comments = await client.paginate<RawComment>(
      `/repos/${options.repository}/pulls/${pull.number}/comments?per_page=100`,
      options.maxCommentsPerPull,
    );

    for (const comment of comments) {
      stats.commentsSeen += 1;

      const login = comment.user?.login;
      const body = comment.body ?? '';
      if (login === undefined || body.length === 0) continue;

      const role = classifyReviewer({
        login,
        accountType: comment.user?.type,
        ownerLogin: options.ownerLogin,
        teamLogins: options.teamLogins,
        authorAssociation: comment.author_association,
      });

      const line = comment.line ?? comment.original_line ?? undefined;
      const reason: Ineligible | null = ineligibleReason({
        body,
        role,
        filePath: comment.path,
        hasCodeContext: (comment.diff_hunk ?? '').length > 0,
      });

      if (reason !== null) {
        stats.excluded[reason] = (stats.excluded[reason] ?? 0) + 1;
        continue;
      }

      const key = contentKey({
        repository: options.repository,
        reviewerLogin: login,
        body,
        filePath: comment.path,
        lineStart: line,
      });

      // Rebases and copied discussion resurface the same comment under a new id.
      if (seenKeys.has(key)) {
        stats.duplicates += 1;
        continue;
      }
      seenKeys.add(key);

      const redactedBody = redact(body);
      const redactedHunk = comment.diff_hunk === undefined ? undefined : redact(comment.diff_hunk);

      events.push({
        eventId: `gh_${comment.id}`,
        source: 'github',
        repository: options.repository,
        pullNumber: pull.number,
        pullRequestUrl: pull.html_url,
        commentId: String(comment.id),
        reviewerLogin: login,
        role,
        createdAt: comment.created_at ?? pull.updated_at,
        bodyRedacted: redactedBody.text,
        filePath: comment.path,
        lineStart: line,
        diffHunkRedacted: redactedHunk?.text,
        contentKey: key,
        redactionVersion: REDACTION_VERSION,
        redactionCounts: {
          ...redactedBody.counts,
          ...(redactedHunk === undefined ? {} : redactedHunk.counts),
        },
      });
      stats.eligible += 1;
    }
  }

  return events;
}
