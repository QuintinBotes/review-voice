import { githubToken } from './auth.ts';
import { GitHubError, NotAllowlisted } from './client.ts';

/** Raised for any write other than the two this writer exists to make. */
export class WriteViolation extends Error {}

export type ReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export const REVIEW_EVENTS: readonly ReviewEvent[] = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'];

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
  /** The first line of a multi-line comment, for a suggestion that replaces `start_line..line`. */
  start_line?: number;
  start_side?: 'RIGHT';
}

/** The create-review request body, exactly as it is sent. */
export interface ReviewPayload {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

export interface WriterOptions {
  /** Repositories this writer may post to. Empty means none. */
  allowlist: string[];
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The first path a write may take. Owner and repository are GitHub names, the
 * number is a pull request, and nothing may follow `reviews`: no review id, so
 * no submit, dismiss or edit of an existing review, and no query string.
 */
const REVIEW_PATH = /^\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pulls\/([1-9][0-9]*)\/reviews$/;

/**
 * The second: a reply to one of this tool's own inline comments (docs/adr/0035).
 * Nothing may follow `replies`, so no edit, reaction or deletion of a comment.
 */
const REPLY_PATH = /^\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pulls\/([1-9][0-9]*)\/comments\/([1-9][0-9]*)\/replies$/;

/** The longest reply body; the renderer holds the same bound. */
export const REPLY_MAX_LENGTH = 600;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The only thing in Review Voice that writes to GitHub (docs/adr/0010, 0035).
 *
 * Kept apart from `GitHubClient` on purpose. That client still refuses every
 * non-GET request, and its test still says so; widening it would have turned
 * one permitted write into a general capability that every reader holds. This
 * class can make exactly two requests, `POST /repos/{owner}/{repo}/pulls/{n}/reviews`
 * and `POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies`, and checks
 * that in code before anything reaches the network.
 *
 * It never retries. Neither request is idempotent, so a retry after a timeout
 * is how one review becomes two; the caller's audit log is what decides
 * whether another attempt is safe.
 */
export class ReviewWriter {
  private readonly allowlist: Set<string>;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private token: string | null;

  constructor(options: WriterOptions) {
    this.allowlist = new Set(options.allowlist.map((name) => name.toLowerCase()));
    this.baseUrl = options.baseUrl ?? 'https://api.github.com';
    this.doFetch = options.fetchImpl ?? fetch;
    this.token = options.token ?? null;
  }

  /** Submits a review with its event in one request. Never a pending review. */
  async submitReview(
    repository: string,
    pullNumber: number,
    payload: ReviewPayload,
  ): Promise<{ id: number | null; htmlUrl: string | null; state: string | null }> {
    if (!Number.isInteger(pullNumber) || pullNumber < 1) {
      throw new WriteViolation(`Refused a review on pull request ${String(pullNumber)}: not a pull request number.`);
    }
    assertPayload(payload);
    const data = await this.request('POST', `/repos/${repository}/pulls/${pullNumber}/reviews`, payload);
    const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
    return {
      id: typeof record['id'] === 'number' ? record['id'] : null,
      htmlUrl: typeof record['html_url'] === 'string' ? record['html_url'] : null,
      state: typeof record['state'] === 'string' ? record['state'] : null,
    };
  }

  /** Replies under one of this tool's own inline comments, with exactly `{ body }`. */
  async replyToComment(
    repository: string,
    pullNumber: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number | null; htmlUrl: string | null }> {
    if (!Number.isInteger(pullNumber) || pullNumber < 1) {
      throw new WriteViolation(`Refused a reply on pull request ${String(pullNumber)}: not a pull request number.`);
    }
    if (!Number.isInteger(commentId) || commentId < 1) {
      throw new WriteViolation(`Refused a reply to comment ${String(commentId)}: not a comment id.`);
    }
    const data = await this.request('POST', `/repos/${repository}/pulls/${pullNumber}/comments/${commentId}/replies`, { body });
    const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
    return {
      id: typeof record['id'] === 'number' ? record['id'] : null,
      htmlUrl: typeof record['html_url'] === 'string' ? record['html_url'] : null,
    };
  }

  /**
   * Every request goes through here, and here admits one method and two paths.
   * Public so the refusal can be tested directly rather than inferred.
   */
  async request(method: string, path: string, body: unknown): Promise<unknown> {
    if (method !== 'POST') {
      throw new WriteViolation(`Review Voice writes two things, a review and a reply to its own comment; refused a ${method} to ${path}.`);
    }
    const match = REVIEW_PATH.exec(path) ?? REPLY_PATH.exec(path);
    if (match === null) {
      throw new WriteViolation(`Review Voice writes two things, a review and a reply to its own comment; refused a POST to ${path}.`);
    }
    if (REPLY_PATH.test(path)) assertReplyBody(body);
    const repository = `${match[1]}/${match[2]}`;
    if (!this.allowlist.has(repository.toLowerCase())) {
      throw new NotAllowlisted(`${repository} is not a repository this writer may post to.`);
    }

    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${(this.token ??= githubToken())}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'review-voice',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Reported as GitHub said it. Approving your own pull request is refused
      // with a 422, and the honest response is to say so, not to retry or
      // quietly downgrade the event.
      throw new GitHubError(
        `GitHub returned ${response.status} for ${path}: ${(await response.text()).slice(0, 300)}`,
        response.status,
      );
    }
    // The review exists once GitHub says 2xx. A body that does not parse must
    // not turn a sent review into a reported failure.
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}

/**
 * An event is required: GitHub creates a pending review when it is missing,
 * and a pending review is a draft the user has to find and submit by hand,
 * which is exactly what posting with the event was meant to remove.
 */
function assertPayload(payload: ReviewPayload): void {
  if (!REVIEW_EVENTS.includes(payload.event)) {
    throw new WriteViolation(`Refused a review with event ${String(payload.event)}; it must be one of ${REVIEW_EVENTS.join(', ')}.`);
  }
  if (typeof payload.commit_id !== 'string' || !SHA.test(payload.commit_id)) {
    throw new WriteViolation('Refused a review without the full commit it was written against.');
  }
  if (typeof payload.body !== 'string') {
    throw new WriteViolation('Refused a review without a body.');
  }
  if (!Array.isArray(payload.comments)) {
    throw new WriteViolation('Refused a review whose comments are not a list.');
  }
  for (const comment of payload.comments) {
    if (
      typeof comment.path !== 'string' ||
      comment.path.length === 0 ||
      !Number.isInteger(comment.line) ||
      comment.line < 1 ||
      comment.side !== 'RIGHT' ||
      typeof comment.body !== 'string' ||
      comment.body.length === 0
    ) {
      throw new WriteViolation('Refused a review with a comment that is not anchored to a line.');
    }
    // A range is both fields or neither, on the new side, ending at the anchor.
    if (
      (comment.start_line !== undefined || comment.start_side !== undefined) &&
      (!Number.isInteger(comment.start_line) ||
        (comment.start_line as number) < 1 ||
        (comment.start_line as number) > comment.line ||
        comment.start_side !== 'RIGHT')
    ) {
      throw new WriteViolation('Refused a review with a comment whose range does not end at its line on the new side.');
    }
  }
  const keys = Object.keys(payload).sort().join(',');
  if (keys !== 'body,comments,commit_id,event') {
    throw new WriteViolation(`Refused a review with unexpected fields: ${keys}.`);
  }
}

/** A reply is `{ body }` and nothing else: no event, no anchor, no edit of what it answers. */
function assertReplyBody(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WriteViolation('Refused a reply whose payload is not an object.');
  }
  const body = (payload as Record<string, unknown>)['body'];
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new WriteViolation('Refused a reply without a body.');
  }
  if (body.length > REPLY_MAX_LENGTH) {
    throw new WriteViolation(`Refused a reply over ${REPLY_MAX_LENGTH} characters.`);
  }
  const keys = Object.keys(payload).join(',');
  if (keys !== 'body') {
    throw new WriteViolation(`Refused a reply with unexpected fields: ${keys}.`);
  }
}
