import { githubToken } from './auth.ts';
import { GitHubError, NotAllowlisted } from './client.ts';

/** Raised for any write other than the one this writer exists to make. */
export class WriteViolation extends Error {}

export type ReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export const REVIEW_EVENTS: readonly ReviewEvent[] = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'];

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
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
 * The one path a write may take. Owner and repository are GitHub names, the
 * number is a pull request, and nothing may follow `reviews`: no review id, so
 * no submit, dismiss or edit of an existing review, and no query string.
 */
const REVIEW_PATH = /^\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pulls\/([1-9][0-9]*)\/reviews$/;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The only thing in Review Voice that writes to GitHub (docs/adr/0010).
 *
 * Kept apart from `GitHubClient` on purpose. That client still refuses every
 * non-GET request, and its test still says so; widening it would have turned
 * one permitted write into a general capability that every reader holds. This
 * class can make exactly one request, `POST /repos/{owner}/{repo}/pulls/{n}/reviews`,
 * and checks that in code before anything reaches the network.
 *
 * It never retries. A create-review request is not idempotent, so a retry
 * after a timeout is how one review becomes two; the caller's audit log is
 * what decides whether another attempt is safe.
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

  /**
   * Every request goes through here, and here admits one method and one path.
   * Public so the refusal can be tested directly rather than inferred.
   */
  async request(method: string, path: string, body: unknown): Promise<unknown> {
    if (method !== 'POST') {
      throw new WriteViolation(`Review Voice writes one thing; refused a ${method} to ${path}.`);
    }
    const match = REVIEW_PATH.exec(path);
    if (match === null) {
      throw new WriteViolation(`Review Voice writes one thing; refused a POST to ${path}.`);
    }
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
  }
  const keys = Object.keys(payload).sort().join(',');
  if (keys !== 'body,comments,commit_id,event') {
    throw new WriteViolation(`Refused a review with unexpected fields: ${keys}.`);
  }
}
