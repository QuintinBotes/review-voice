import { GitHubClient } from '../github/client.ts';
import { redact } from '../redact/redact.ts';

/**
 * What has already been said on this pull request.
 *
 * Review Voice had no step that read the pull request's own review thread, and
 * `--exclude-pull` deliberately keeps that thread out of precedent - correctly,
 * because a review this tool posted coming back as evidence of the owner's
 * taste is circular.
 *
 * Deduplication is the opposite problem. On the first batch actually posted to
 * real pull requests, 16 of 30 candidates were already stated by an automated
 * reviewer running on those repositories, or already fixed by the author. That
 * removed more than every other stage combined, and nothing in the pipeline
 * could see it. Run as designed on a repository that already has a bot
 * reviewer, this one posts duplicates.
 */
export interface ThreadComment {
  /** Where the comment is anchored, when it is anchored at all. */
  path: string | null;
  line: number | null;
  author: string;
  /** Redacted. Only redacted text ever reaches a prompt or a comparison. */
  body: string;
  kind: 'review-comment' | 'review-body' | 'conversation' | 'description';
  /**
   * An inline comment GitHub no longer places on the current head, because the
   * code under it changed: often a sign it was addressed. `line` is then where
   * it was written. Whether a thread is resolved is not readable through the
   * REST API this client is limited to, so this is the nearest signal.
   */
  outdated?: boolean;
}

interface RawInline {
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  user?: { login?: string };
}

interface RawReview {
  body?: string;
  user?: { login?: string };
}

interface RawIssueComment {
  body?: string;
  user?: { login?: string };
}

const MAX_COMMENTS = 300;

function clean(body: string | undefined, author: string | undefined): { body: string; author: string } | null {
  if (body === undefined || body.trim().length === 0) return null;
  return { body: redact(body).text, author: author ?? 'unknown' };
}

/**
 * Reads every comment already on a pull request.
 *
 * Inline review comments, review bodies and conversation comments all count: a
 * point already made in any of them is a point this review should not repeat,
 * whoever made it.
 */
export async function readThread(options: {
  repository: string;
  pullNumber: number;
  /** Injectable so a test can stub fetch. */
  client?: GitHubClient;
}): Promise<{ comments: ThreadComment[]; truncated: boolean }> {
  // Naming a pull request is the consent for reading it, the same rule
  // `acquirePullRequestDiff` follows.
  const client = options.client ?? new GitHubClient({ allowlist: [options.repository] });
  const comments: ThreadComment[] = [];

  // The description counts as a comment: a deploy order, a trade-off the author
  // states or a question CI already answered is a point already made, and
  // field use showed about five candidates a day repeating one.
  const pull = await client.get<{ body?: string | null; user?: { login?: string } }>(
    `/repos/${options.repository}/pulls/${options.pullNumber}`,
  );
  const description = clean(pull.data.body ?? undefined, pull.data.user?.login);
  if (description !== null) {
    comments.push({ path: null, line: null, author: description.author, body: description.body, kind: 'description' });
  }

  const inline = await client.paginate<RawInline>(
    `/repos/${options.repository}/pulls/${options.pullNumber}/comments?per_page=100`,
    MAX_COMMENTS,
  );
  for (const raw of inline) {
    const kept = clean(raw.body, raw.user?.login);
    if (kept === null) continue;
    const outdated = (raw.line ?? null) === null && (raw.original_line ?? null) !== null;
    comments.push({
      path: raw.path ?? null,
      line: raw.line ?? raw.original_line ?? null,
      author: kept.author,
      body: kept.body,
      kind: 'review-comment',
      ...(outdated ? { outdated: true } : {}),
    });
  }

  const reviews = await client.paginate<RawReview>(
    `/repos/${options.repository}/pulls/${options.pullNumber}/reviews?per_page=100`,
    MAX_COMMENTS,
  );
  for (const raw of reviews) {
    const kept = clean(raw.body, raw.user?.login);
    if (kept === null) continue;
    comments.push({ path: null, line: null, author: kept.author, body: kept.body, kind: 'review-body' });
  }

  const conversation = await client.paginate<RawIssueComment>(
    `/repos/${options.repository}/issues/${options.pullNumber}/comments?per_page=100`,
    MAX_COMMENTS,
  );
  for (const raw of conversation) {
    const kept = clean(raw.body, raw.user?.login);
    if (kept === null) continue;
    comments.push({ path: null, line: null, author: kept.author, body: kept.body, kind: 'conversation' });
  }

  return {
    comments,
    truncated: inline.length >= MAX_COMMENTS || conversation.length >= MAX_COMMENTS,
  };
}
