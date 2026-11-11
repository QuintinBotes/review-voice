import { GitHubClient, REVIEW_THREADS_QUERY } from '../github/client.ts';
import { redact } from '../redact/redact.ts';
import { stripEvidenceBlock } from '../publish/evidence-block.ts';

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
   * it was written.
   */
  outdated?: boolean;
  /**
   * The inline comment's thread is marked resolved on the pull request: most
   * often because it was addressed. Read through one GraphQL query, the only
   * place GitHub exposes it (docs/adr/0018); absent when that read failed.
   */
  resolved?: boolean;
  /** Who resolved the thread, when it is resolved and GitHub said. */
  resolvedBy?: string;
  /** GitHub's id for an inline comment, and when it was written (submitted, for a review body). */
  id?: number;
  createdAt?: string;
  /** The review an inline comment was posted in, and the comment it replies to. */
  reviewId?: number;
  inReplyTo?: number;
  /** GitHub's link to the comment, or to the review a review body belongs to. */
  url?: string;
}

/**
 * One review on the pull request, whatever its body. A review with no body adds
 * no `review-body` comment but still has a state, and `carry` needs to know
 * which of this tool's reviews the author dismissed.
 */
export interface ThreadReview {
  id: number;
  author: string;
  /** GitHub's state, such as `COMMENTED`, `APPROVED` or `DISMISSED`. */
  state: string;
  submittedAt?: string;
  /**
   * Redacted. Why a dismissed review was dismissed, from the pull request's
   * `review_dismissed` event; absent when it was not dismissed or that read
   * failed.
   */
  dismissalMessage?: string;
}

interface RawInline {
  id?: number;
  created_at?: string;
  pull_request_review_id?: number | null;
  in_reply_to_id?: number | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  user?: { login?: string };
  html_url?: string;
}

interface RawReview {
  id?: number;
  state?: string;
  submitted_at?: string | null;
  body?: string;
  user?: { login?: string };
  html_url?: string;
}

interface RawIssueEvent {
  event?: string;
  dismissed_review?: { review_id?: number; dismissal_message?: string | null } | null;
}

interface RawIssueComment {
  body?: string;
  user?: { login?: string };
  html_url?: string;
  created_at?: string;
}

interface RawIssue {
  number?: number;
  repository_url?: string;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  /** Present when the number is a pull request, which the issues endpoint also answers for. */
  pull_request?: unknown;
}

/**
 * An issue the description closes, read with `review.linked_issues` on. Its
 * body is a second source the intent extractor may quote, held to the same
 * whole-sentence check as the description.
 */
export interface LinkedIssue {
  number: number;
  /** Redacted, never quoted by the extractor; context only. */
  title: string;
  /** Redacted first, then cut at 10000 characters and back to the last blank line, so a cut never hides part of a secret from redaction or splits a sentence. */
  body: string;
  state: string;
  url: string;
  truncated?: true;
}

const MAX_COMMENTS = 300;
const MAX_LINKED_ISSUES = 5;
const MAX_ISSUE_BODY = 10000;

/**
 * The body cut at the cap, back to a boundary no sentence crosses, so no
 * sentence the cap split survives: the cut would read as a sentence end, and
 * a quote of the clipped half would pass without the condition that followed
 * it. The last blank line first, since a hard-wrapped sentence runs across a
 * single line break; then a line break, then a sentence end; else nothing.
 */
const cappedBody = (body: string): string => {
  if (body.length <= MAX_ISSUE_BODY) return body;
  const cut = body.slice(0, MAX_ISSUE_BODY);
  const paragraph = cut.lastIndexOf('\n\n');
  if (paragraph !== -1) return cut.slice(0, paragraph);
  const line = cut.lastIndexOf('\n');
  if (line !== -1) return cut.slice(0, line);
  const sentence = [...cut.matchAll(/[.!?](?=\s)/gu)].at(-1);
  return sentence === undefined ? '' : cut.slice(0, sentence.index + 1);
};
// GitHub's closing keywords, an optional colon, whitespace, then `#N`, `owner/repo#N` or an issue URL.
const CLOSING_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)#(\d+)|#(\d+))\b/giu;

/**
 * The issues the description closes with a GitHub closing keyword, in first
 * mention order and without duplicates. Only `repository`'s own issues are
 * read: naming a pull request is the consent for reading it and nothing else,
 * so a reference to another repository goes to `skipped`, even an allowlisted
 * one. A same-repository number past the fifth goes to `beyond`, so the cap is
 * named rather than silent. A bare `#N` with no keyword is a mention, not a
 * requirement of this change.
 */
export function closingReferences(description: string, repository: string): { numbers: number[]; beyond: number[]; skipped: string[] } {
  const numbers: number[] = [];
  const beyond: number[] = [];
  const skipped: string[] = [];
  for (const match of description.matchAll(CLOSING_REFERENCE)) {
    const [, text, urlRepository, urlNumber, shortRepository, shortNumber, bareNumber] = match;
    const named = urlRepository ?? shortRepository;
    if (named !== undefined && named.toLowerCase() !== repository.toLowerCase()) {
      skipped.push(text!);
      continue;
    }
    const number = Number(urlNumber ?? shortNumber ?? bareNumber);
    if (numbers.includes(number) || beyond.includes(number)) continue;
    (numbers.length < MAX_LINKED_ISSUES ? numbers : beyond).push(number);
  }
  return { numbers, beyond, skipped };
}

function clean(body: string | undefined, author: string | undefined): { body: string; author: string } | null {
  if (body === undefined || body.trim().length === 0) return null;
  // The evidence block is derived text whose decisive lines name other
  // locations, which must not read as points raised there.
  return { body: redact(stripEvidenceBlock(body)).text, author: author ?? 'unknown' };
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
  /** `review.linked_issues`: also read the same-repository issues the description closes. */
  linkedIssues?: boolean;
}): Promise<{
  repository: string;
  pullNumber: number;
  comments: ThreadComment[];
  reviews: ThreadReview[];
  linkedIssues?: LinkedIssue[];
  truncated: boolean;
  warnings?: string[];
}> {
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

  const warnings: string[] = [];
  const linkedIssues: LinkedIssue[] = [];
  if (options.linkedIssues === true) {
    // Over the redacted text, so the CLI and the extractor read the same description.
    const references = closingReferences(description?.body ?? '', options.repository);
    for (const text of references.skipped) warnings.push(`Skipped ${text}: a linked issue outside ${options.repository} is not read.`);
    if (references.beyond.length > 0) {
      warnings.push(`Read the first ${MAX_LINKED_ISSUES} linked issues; not read: ${references.beyond.map((n) => `#${n}`).join(', ')}.`);
    }
    for (const number of references.numbers) {
      try {
        // Optional: the review goes on without an issue it cannot read.
        const { data } = await client.get<RawIssue>(`/repos/${options.repository}/issues/${number}`, { retryRateLimits: false, followRedirects: false });
        // A transferred issue answers with a 301 that fetch follows after the allowlist check, so only the issue asked for counts.
        if (data.number !== number || !(data.repository_url ?? '').toLowerCase().endsWith(`/repos/${options.repository}`.toLowerCase())) {
          warnings.push(`Could not read issue #${number} (GitHub answered for another issue or repository); continuing without it.`);
          continue;
        }
        // A pull request is not a requirement of this change; this also covers a description that closes its own number.
        if (data.pull_request !== undefined) continue;
        const body = redact(data.body ?? '').text;
        linkedIssues.push({
          number,
          title: redact(data.title ?? '').text,
          body: cappedBody(body),
          state: data.state ?? 'unknown',
          url: data.html_url ?? '',
          ...(body.length > MAX_ISSUE_BODY ? { truncated: true as const } : {}),
        });
      } catch (error) {
        warnings.push(
          `Could not read issue #${number} (${error instanceof Error ? error.message.slice(0, 160) : String(error)}); continuing without it.`,
        );
      }
    }
  }

  const inline = await client.paginate<RawInline>(
    `/repos/${options.repository}/pulls/${options.pullNumber}/comments?per_page=100`,
    MAX_COMMENTS,
  );
  let states = new Map<number, ThreadState>();
  if (inline.length > 0) {
    try {
      states = await readThreadStates(client, options.repository, options.pullNumber);
    } catch (error) {
      // Optional: without it a resolved thread reads as an open one, which
      // only means the verifier is not told. The review goes on.
      warnings.push(
        'Could not read which review threads are resolved ' +
          `(${error instanceof Error ? error.message.slice(0, 160) : String(error)}); ` +
          'continuing with the REST data, so no comment is marked resolved.',
      );
    }
  }
  for (const raw of inline) {
    const kept = clean(raw.body, raw.user?.login);
    if (kept === null) continue;
    const state = typeof raw.id === 'number' ? states.get(raw.id) : undefined;
    const outdated = ((raw.line ?? null) === null && (raw.original_line ?? null) !== null) || state?.outdated === true;
    comments.push({
      path: raw.path ?? null,
      line: raw.line ?? raw.original_line ?? null,
      author: kept.author,
      body: kept.body,
      kind: 'review-comment',
      ...(outdated ? { outdated: true } : {}),
      ...(typeof raw.id === 'number' ? { id: raw.id } : {}),
      ...(typeof raw.created_at === 'string' ? { createdAt: raw.created_at } : {}),
      ...(typeof raw.pull_request_review_id === 'number' ? { reviewId: raw.pull_request_review_id } : {}),
      ...(typeof raw.in_reply_to_id === 'number' ? { inReplyTo: raw.in_reply_to_id } : {}),
      ...(state?.resolved === true ? { resolved: true } : {}),
      ...(state?.resolved === true && state.resolvedBy !== null ? { resolvedBy: state.resolvedBy } : {}),
      ...(typeof raw.html_url === 'string' ? { url: raw.html_url } : {}),
    });
  }

  const reviews = await client.paginate<RawReview>(
    `/repos/${options.repository}/pulls/${options.pullNumber}/reviews?per_page=100`,
    MAX_COMMENTS,
  );
  const threadReviews: ThreadReview[] = [];
  for (const raw of reviews) {
    if (typeof raw.id === 'number') {
      threadReviews.push({
        id: raw.id,
        author: raw.user?.login ?? 'unknown',
        state: raw.state ?? 'UNKNOWN',
        ...(typeof raw.submitted_at === 'string' ? { submittedAt: raw.submitted_at } : {}),
      });
    }
    const kept = clean(raw.body, raw.user?.login);
    if (kept === null) continue;
    comments.push({
      path: null,
      line: null,
      author: kept.author,
      body: kept.body,
      kind: 'review-body',
      ...(typeof raw.submitted_at === 'string' ? { createdAt: raw.submitted_at } : {}),
      ...(typeof raw.html_url === 'string' ? { url: raw.html_url } : {}),
    });
  }
  // Only a dismissed review has a message to read, and only the issue's
  // events carry it, so the extra read is made when there is one.
  if (threadReviews.some((review) => review.state === 'DISMISSED')) {
    try {
      const events = await client.paginate<RawIssueEvent>(
        `/repos/${options.repository}/issues/${options.pullNumber}/events?per_page=100`,
        MAX_COMMENTS,
      );
      for (const event of events) {
        const dismissed = event.event === 'review_dismissed' ? event.dismissed_review : null;
        if (typeof dismissed?.review_id !== 'number') continue;
        const message = clean(dismissed.dismissal_message ?? undefined, undefined);
        const review = threadReviews.find((candidate) => candidate.id === dismissed.review_id);
        if (review !== undefined && message !== null) review.dismissalMessage = message.body;
      }
    } catch (error) {
      warnings.push(
        'Could not read why a review was dismissed ' +
          `(${error instanceof Error ? error.message.slice(0, 160) : String(error)}); ` +
          'continuing, so no dismissal message is recorded.',
      );
    }
  }

  const conversation = await client.paginate<RawIssueComment>(
    `/repos/${options.repository}/issues/${options.pullNumber}/comments?per_page=100`,
    MAX_COMMENTS,
  );
  for (const raw of conversation) {
    const kept = clean(raw.body, raw.user?.login);
    if (kept === null) continue;
    comments.push({
      path: null,
      line: null,
      author: kept.author,
      body: kept.body,
      kind: 'conversation',
      ...(typeof raw.created_at === 'string' ? { createdAt: raw.created_at } : {}),
      ...(typeof raw.html_url === 'string' ? { url: raw.html_url } : {}),
    });
  }

  // Named, so a thread file cannot be applied to another pull request's run.
  return {
    repository: options.repository,
    pullNumber: options.pullNumber,
    comments,
    reviews: threadReviews,
    // Absent when the option is off, so every existing reader of a thread file sees what it saw before.
    ...(options.linkedIssues === true ? { linkedIssues } : {}),
    truncated: inline.length >= MAX_COMMENTS || conversation.length >= MAX_COMMENTS,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

interface ThreadState {
  resolved: boolean;
  outdated: boolean;
  resolvedBy: string | null;
}

interface RawThreads {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: {
          isResolved?: boolean;
          isOutdated?: boolean;
          resolvedBy?: { login?: string } | null;
          comments?: { nodes?: { databaseId?: number | null }[] };
        }[];
      };
    } | null;
  } | null;
}

/**
 * Each inline comment's thread state, by REST comment id. Throws on anything
 * it cannot read, including an answer in the wrong shape, so the caller falls
 * back to REST alone rather than half-trusting it.
 */
async function readThreadStates(client: GitHubClient, repository: string, pullNumber: number): Promise<Map<number, ThreadState>> {
  const states = new Map<number, ThreadState>();
  let cursor: string | null = null;
  for (let read = 0; read < MAX_COMMENTS; read += 100) {
    const data: RawThreads = await client.graphql<RawThreads>(repository, REVIEW_THREADS_QUERY, { number: pullNumber, cursor });
    const threads = data?.repository?.pullRequest?.reviewThreads;
    if (threads === undefined || !Array.isArray(threads.nodes)) throw new Error('no reviewThreads in the answer');
    for (const thread of threads.nodes) {
      const state = {
        resolved: thread?.isResolved === true,
        outdated: thread?.isOutdated === true,
        resolvedBy: typeof thread?.resolvedBy?.login === 'string' ? thread.resolvedBy.login : null,
      };
      for (const comment of thread?.comments?.nodes ?? []) {
        if (typeof comment?.databaseId === 'number') states.set(comment.databaseId, state);
      }
    }
    if (threads.pageInfo?.hasNextPage !== true || typeof threads.pageInfo.endCursor !== 'string') break;
    cursor = threads.pageInfo.endCursor;
  }
  return states;
}
