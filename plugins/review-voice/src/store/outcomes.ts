import type { Database } from './db.ts';
import { GitHubClient, REVIEW_THREADS_QUERY } from '../github/client.ts';
import { overlap, significantWords, suggestedPatchOf } from '../scoring/score.ts';
import { fileAtRef, suggestionApplied } from '../publish/suggestion.ts';
import { ruleIdFor } from '../policy/rules.ts';
import { runDetail, type StoredFinding } from './runs.ts';
import { stripEvidenceBlock } from '../publish/evidence-block.ts';
import { parseFinding } from '../contract/parse.ts';
import { terminalSafeDeep } from '../terminal.ts';

/**
 * What became of each inline comment Review Voice posted (docs/adr/0029).
 *
 * The strength rules are 0004's: only a change the author made, or an author
 * who answered, is strong. A thread resolved with no change, lines that moved
 * under an open thread, and silence are weak, and silence is never a dismissal.
 */
export type Outcome = 'fixed' | 'dismissed' | 'resolved' | 'outdated' | 'open' | 'unknown';
export type Strength = 'strong' | 'weak';

export interface FindingOutcome {
  reviewRunId: string;
  findingId: string;
  repository: string;
  pullNumber: number;
  commentId: number;
  outcome: Outcome;
  strength: Strength;
  evidence: string;
  checkedAt: string;
  path: string;
  line: number;
  /** Where the posted review's id came from; not stored. */
  reviewIdSource: 'audit' | 'reviews-list';
  /**
   * Who decided a strong dismissal: the replying login, or the owner's when an
   * owner `dismiss` feedback row did. Null for every other outcome, so a weak
   * or fixed outcome never reads as anyone's decision.
   */
  decidedBy: string | null;
}

export type ReplyStance = 'acknowledge' | 'reject' | 'other';

const NEGATED_ACK = /\bnot (?:yet )?(?:fixed|done|addressed|changed|updated)\b/i;
const REJECT =
  /\b(?:won'?t fix|wontfix|not a (?:bug|issue|problem)|false positive|by design|intentional(?:ly)?|working as (?:intended|designed)|disagree|(?:does not|doesn'?t) apply|not applicable|not needed|unnecessary|incorrect|this is wrong|that'?s wrong)\b/i;
const ACKNOWLEDGE =
  /\b(?:fixed|done|addressed|good catch|nice catch|will fix|will do|updated|applied|agreed|makes sense|you'?re right|thanks|thank you)\b/i;

/** Whether a reply agrees with the comment or turns it down. Rejection is checked first: "thanks, but this is intentional" rejects. */
export function classifyReply(body: string): ReplyStance {
  if (REJECT.test(body)) return 'reject';
  if (NEGATED_ACK.test(body)) return 'other';
  if (ACKNOWLEDGE.test(body)) return 'acknowledge';
  return 'other';
}

/**
 * Whether a patch touches the old-side lines `first` to `last`: a deleted line
 * in the range, or an insertion inside it. An insertion next to the range
 * leaves the anchored lines as they were.
 */
export function patchTouches(patch: string, first: number, last: number): boolean {
  let oldLine = 0;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+/.exec(line);
    if (header !== null) {
      oldLine = Number(header[1]);
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) {
      if (oldLine >= first && oldLine <= last) return true;
      oldLine += 1;
    } else if (line.startsWith('+')) {
      if (oldLine > first && oldLine <= last) return true;
    } else {
      oldLine += 1;
    }
  }
  return false;
}

export interface RawComment {
  id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
  body?: string;
  created_at?: string;
  in_reply_to_id?: number | null;
  user?: { login?: string; type?: string };
}

interface RawFile {
  filename?: string;
  previous_filename?: string;
  patch?: string;
}

interface RawReview {
  id?: number;
  commit_id?: string;
  user?: { login?: string };
}

export interface ThreadState {
  resolved: boolean;
  outdated: boolean;
}

interface RawThreads {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: { isResolved?: boolean; isOutdated?: boolean; comments?: { nodes?: { databaseId?: number | null }[] } }[];
      };
    } | null;
  } | null;
}

const READ_LIMIT = 1000;

/** Thread state by REST comment id. Throws on anything it cannot read, so the caller reports unknown rather than open. */
async function readStates(client: GitHubClient, repository: string, pullNumber: number): Promise<Map<number, ThreadState>> {
  const states = new Map<number, ThreadState>();
  let cursor: string | null = null;
  for (let read = 0; read < READ_LIMIT; read += 100) {
    const data: RawThreads = await client.graphql<RawThreads>(repository, REVIEW_THREADS_QUERY, { number: pullNumber, cursor });
    const threads = data?.repository?.pullRequest?.reviewThreads;
    if (threads === undefined || !Array.isArray(threads.nodes)) throw new Error('no reviewThreads in the answer');
    for (const thread of threads.nodes) {
      const state = { resolved: thread?.isResolved === true, outdated: thread?.isOutdated === true };
      for (const comment of thread?.comments?.nodes ?? []) {
        if (typeof comment?.databaseId === 'number') states.set(comment.databaseId, state);
      }
    }
    if (threads.pageInfo?.hasNextPage !== true || typeof threads.pageInfo.endCursor !== 'string') break;
    cursor = threads.pageInfo.endCursor;
  }
  return states;
}

interface SentRun {
  runId: string;
  repository: string;
  pullNumber: number;
  headRef: string | null;
  /** Review ids the audit log recorded; empty when a sent row names none. */
  reviewIds: number[];
}

/** The run each `review_post_attempted` row names, by audit id; a sent row points at its attempt, not its run. */
function attemptRuns(db: Database): Map<string, string> {
  const attempts = new Map<string, string>();
  for (const row of db
    .prepare(`SELECT audit_id, json_extract(metadata_json, '$.run') AS run FROM audit_events WHERE action = 'review_post_attempted'`)
    .all() as { audit_id: string; run: string | null }[]) {
    if (typeof row.run === 'string') attempts.set(row.audit_id, row.run);
  }
  return attempts;
}

/** Runs with a `review_post_sent` row at or after `since`, oldest first. */
export function sentRuns(db: Database, options: { since: string; repository?: string | undefined }): SentRun[] {
  const attempts = attemptRuns(db);
  const reviewIdsByRun = new Map<string, number[]>();
  for (const row of db
    .prepare(`SELECT metadata_json FROM audit_events WHERE action = 'review_post_sent' AND created_at >= ?`)
    .all(options.since) as { metadata_json: string }[]) {
    let meta: { attempt?: unknown; reviewId?: unknown };
    try {
      meta = JSON.parse(row.metadata_json) as typeof meta;
    } catch {
      continue;
    }
    const run = typeof meta.attempt === 'string' ? attempts.get(meta.attempt) : undefined;
    if (run === undefined) continue;
    const ids = reviewIdsByRun.get(run) ?? [];
    const id = Number(meta.reviewId);
    if (Number.isInteger(id) && id > 0) ids.push(id);
    reviewIdsByRun.set(run, ids);
  }

  const rows = db
    .prepare(
      `SELECT review_run_id, repository, pull_number, head_ref FROM review_runs
       WHERE repository IS NOT NULL AND pull_number IS NOT NULL ORDER BY created_at, rowid`,
    )
    .all() as { review_run_id: string; repository: string; pull_number: number; head_ref: string | null }[];
  const wanted = options.repository?.toLowerCase();
  const runs: SentRun[] = [];
  for (const row of rows) {
    const reviewIds = reviewIdsByRun.get(row.review_run_id);
    if (reviewIds === undefined) continue;
    if (wanted !== undefined && row.repository.toLowerCase() !== wanted) continue;
    runs.push({ runId: row.review_run_id, repository: row.repository, pullNumber: row.pull_number, headRef: row.head_ref, reviewIds });
  }
  return runs;
}

export interface ApprovedRun {
  runId: string;
  repository: string;
  pullNumber: number;
  /** The head the approval read: the sent payload's `commit_id`, else the run's head. */
  head: string;
  /** The review id the audit log recorded; null when the sent row names none. */
  reviewId: number | null;
  /** When the approval was sent (the audit row's time). */
  sentAt: string;
}

/**
 * Runs whose `review_post_sent` row at or after `since` carries `event:
 * 'APPROVE'`, oldest first (docs/adr/0036). A run sent more than once keeps its
 * newest approval. `sentRuns` is unchanged: it follows findings, this follows
 * the verdict.
 */
export function approvedRuns(db: Database, options: { since: string; repository?: string | undefined }): ApprovedRun[] {
  const attempts = attemptRuns(db);
  const approvals = new Map<string, Pick<ApprovedRun, 'head' | 'reviewId' | 'sentAt'>>();
  for (const row of db
    .prepare(`SELECT metadata_json, created_at FROM audit_events WHERE action = 'review_post_sent' AND created_at >= ? ORDER BY created_at, rowid`)
    .all(options.since) as { metadata_json: string; created_at: string }[]) {
    let meta: { attempt?: unknown; event?: unknown; head?: unknown; reviewId?: unknown };
    try {
      meta = JSON.parse(row.metadata_json) as typeof meta;
    } catch {
      continue;
    }
    if (meta.event !== 'APPROVE') continue;
    const run = typeof meta.attempt === 'string' ? attempts.get(meta.attempt) : undefined;
    if (run === undefined) continue;
    const id = Number(meta.reviewId);
    approvals.set(run, {
      head: typeof meta.head === 'string' ? meta.head : '',
      reviewId: Number.isInteger(id) && id > 0 ? id : null,
      sentAt: row.created_at,
    });
  }
  const wanted = options.repository?.toLowerCase();
  const runs: ApprovedRun[] = [];
  for (const row of db
    .prepare(
      `SELECT review_run_id, repository, pull_number, head_ref FROM review_runs
       WHERE repository IS NOT NULL AND pull_number IS NOT NULL ORDER BY created_at, rowid`,
    )
    .all() as { review_run_id: string; repository: string; pull_number: number; head_ref: string | null }[]) {
    const sent = approvals.get(row.review_run_id);
    if (sent === undefined) continue;
    if (wanted !== undefined && row.repository.toLowerCase() !== wanted) continue;
    const head = sent.head !== '' ? sent.head : row.head_ref;
    // An approval with no head cannot be compared with what was merged.
    if (head === null) continue;
    runs.push({ runId: row.review_run_id, repository: row.repository, pullNumber: row.pull_number, head, reviewId: sent.reviewId, sentAt: sent.sentAt });
  }
  return runs;
}

export const isBot = (user: { login?: string; type?: string } | undefined): boolean =>
  user?.type === 'Bot' || (user?.login ?? '').endsWith('[bot]');

/** A reply under one of this tool's inline comments that is waiting for an answer (docs/adr/0035). */
export interface PendingQuestion {
  reviewRunId: string;
  findingId: string;
  repository: string;
  pullNumber: number;
  rootCommentId: number;
  path: string;
  line: number;
  askedBy: string;
  askedAt: string;
  stance: 'question' | 'reject';
}

/** Whether a line outside a blockquote asks something; a quoted question is the tool's own text or someone else's. */
const asksQuestion = (body: string): boolean => body.split('\n').some((line) => !/^\s*>/.test(line) && line.includes('?'));

/**
 * Whether the thread under `root` wants this tool's one reply, and from whom.
 * Each rule returns null when it fails. The thread state must be known and
 * open; no reply under the root may be by the poster, since one reply per
 * thread is the bound whoever wrote it; the newest reply that is not a bot's,
 * the poster's or the owner's decides; and it must ask something (a `?` outside
 * a blockquote), whether as a question or as a disagreement. Silence,
 * agreement and a disagreement that asks nothing are not questions (docs/adr/0004).
 */
export function replyWanted(
  root: RawComment,
  replies: RawComment[],
  state: ThreadState | null,
  ownerReviewer: string | null,
): Pick<PendingQuestion, 'askedBy' | 'askedAt' | 'stance'> | null {
  if (state === null || state.resolved) return null;
  const login = (user: RawComment['user']): string | null => user?.login?.toLowerCase() ?? null;
  const poster = login(root.user);
  // With no poster login the one-per-thread rule cannot be checked, so nothing is asked.
  if (poster === null) return null;
  const under = replies
    .filter((reply) => reply.in_reply_to_id === root.id)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  if (under.some((reply) => login(reply.user) === poster)) return null;
  const owner = ownerReviewer?.toLowerCase() ?? null;
  const latest = [...under].reverse().find((reply) => {
    const author = login(reply.user);
    return author !== null && !isBot(reply.user) && author !== owner;
  });
  if (latest === undefined) return null;
  const body = latest.body ?? '';
  const stance = classifyReply(body);
  if (stance === 'acknowledge' || !asksQuestion(body)) return null;
  return { askedBy: latest.user!.login!, askedAt: latest.created_at ?? '', stance: stance === 'reject' ? 'reject' : 'question' };
}

export function sameHead(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || (left.length >= 7 && right.startsWith(left)) || (right.length >= 7 && left.startsWith(right));
}

export interface CheckOptions {
  db: Database;
  client: GitHubClient;
  /** Repositories that may be read; a run for any other is skipped without a request. */
  allowlist: string[];
  repository?: string | undefined;
  /** One pull request only; every other is skipped before any request. */
  pullNumber?: number | undefined;
  /** ISO time; only sends at or after it are followed. */
  since: string;
  now?: () => Date;
  /**
   * The owner's login from config. A reject reply by this login is read even on
   * a comment posted under the same login (docs/adr/0002 posts with the owner's
   * credential), and an owner feedback dismissal is attributed to it. Absent,
   * the poster's replies stay ignored and a feedback dismissal records no one.
   */
  ownerReviewer?: string | null | undefined;
}

export interface CheckResult {
  outcomes: FindingOutcome[];
  skipped: { repository: string; pullNumber: number; reason: string }[];
  warnings: string[];
  /** Threads awaiting this tool's one reply, found from the same reads as the outcomes. */
  questions: PendingQuestion[];
}

interface PullContext {
  repository: string;
  pullNumber: number;
  currentHead: string | null;
  replies: RawComment[];
  states: Map<number, ThreadState> | null;
  compares: Map<string, Promise<RawFile[] | null>>;
}

/**
 * Follows every posted inline comment of the matching runs to an outcome and
 * stores it, replacing an earlier check. Reads only: nothing is written to
 * GitHub, and a pull request that cannot be read leaves its stored outcomes as
 * they were.
 */
export async function checkOutcomes(options: CheckOptions): Promise<CheckResult> {
  const allowed = new Set(options.allowlist.map((name) => name.toLowerCase()));
  const result: CheckResult = { outcomes: [], skipped: [], warnings: [], questions: [] };
  const byPull = new Map<string, SentRun[]>();
  for (const run of sentRuns(options.db, { since: options.since, repository: options.repository })) {
    if (options.pullNumber !== undefined && run.pullNumber !== options.pullNumber) continue;
    const key = `${run.repository.toLowerCase()}#${run.pullNumber}`;
    byPull.set(key, [...(byPull.get(key) ?? []), run]);
  }

  let viewer: Promise<string | null> | null = null;
  const viewerLogin = (): Promise<string | null> => {
    viewer ??= options.client
      .get<{ login?: string }>('/user')
      .then(({ data }) => data.login?.toLowerCase() ?? null)
      .catch(() => null);
    return viewer;
  };

  for (const runs of byPull.values()) {
    const first = runs[0]!;
    const { repository, pullNumber } = first;
    if (!allowed.has(repository.toLowerCase())) {
      result.skipped.push({ repository, pullNumber, reason: 'not in the allowlist' });
      continue;
    }
    try {
      const context = await readPull(options.client, repository, pullNumber, result.warnings);
      // The list is read oldest first and cut at the limit, so the newest
      // replies, a poster's answer among them, may be missing: no thread on it
      // is known to be unanswered, as with an unknown thread state. Only the
      // reply command narrows to one pull request and offers a reply, so only
      // it is told; the watcher and `outcomes` never offer one here.
      const cut = context.replies.length >= READ_LIMIT;
      if (cut && options.pullNumber !== undefined) result.warnings.push(`${repository}#${pullNumber}: only the first ${READ_LIMIT} inline comments were read, so no reply is offered on it`);
      for (const run of runs) {
        const followed = await followRun(options, context, run, viewerLogin);
        result.outcomes.push(...followed.outcomes);
        if (!cut) result.questions.push(...followed.questions);
      }
    } catch (error) {
      result.warnings.push(`${repository}#${pullNumber}: not checked (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`);
    }
  }
  // A stored path is the pull request's file name, which can hold any byte but NUL.
  return terminalSafeDeep(result);
}

async function readPull(client: GitHubClient, repository: string, pullNumber: number, warnings: string[]): Promise<PullContext> {
  const { data: pull } = await client.get<{ head?: { sha?: unknown } }>(`/repos/${repository}/pulls/${pullNumber}`);
  const replies = await client.paginate<RawComment>(`/repos/${repository}/pulls/${pullNumber}/comments?per_page=100`, READ_LIMIT);
  let states: Map<number, ThreadState> | null = null;
  try {
    states = await readStates(client, repository, pullNumber);
  } catch (error) {
    warnings.push(
      `${repository}#${pullNumber}: could not read which threads are resolved (${error instanceof Error ? error.message.slice(0, 120) : String(error)}); resolution is unknown`,
    );
  }
  const sha = pull?.head?.sha;
  return { repository, pullNumber, currentHead: typeof sha === 'string' ? sha : null, replies, states, compares: new Map() };
}

/** The review ids of a run, and how they were found. */
async function reviewIdsOf(
  options: CheckOptions,
  run: SentRun,
  viewerLogin: () => Promise<string | null>,
): Promise<{ ids: number[]; source: FindingOutcome['reviewIdSource'] }> {
  if (run.reviewIds.length > 0) return { ids: run.reviewIds, source: 'audit' };
  // The sent row names no review. Fall back to the reviews on the pull request:
  // the authenticated user's, made at the head the run reviewed.
  const login = await viewerLogin();
  if (login === null || run.headRef === null) return { ids: [], source: 'reviews-list' };
  const reviews = await options.client.paginate<RawReview>(`/repos/${run.repository}/pulls/${run.pullNumber}/reviews?per_page=100`, READ_LIMIT);
  const ids = reviews
    .filter((review) => typeof review.id === 'number' && review.user?.login?.toLowerCase() === login)
    .filter((review) => typeof review.commit_id === 'string' && sameHead(review.commit_id, run.headRef!))
    .map((review) => review.id as number);
  return { ids, source: 'reviews-list' };
}

function severityPrefix(finding: StoredFinding): string {
  return `**${finding.severity}** - `;
}

/** A root comment's prose as posted: the evidence and suggestion blocks removed, as `commentSignature` removes them. */
function postedProse(body: string): string {
  const prose = stripEvidenceBlock(body);
  const block = prose.lastIndexOf('\n\n```suggestion\n');
  return block >= 0 && prose.endsWith('```') ? prose.slice(0, block) : prose;
}

/** Whether a root comment is exactly this finding's text as `post` renders it. */
function postedAs(comment: RawComment, finding: StoredFinding): boolean {
  return postedProse(comment.body ?? '') === `${severityPrefix(finding)}${parseFinding(finding.text, 0).prose}`;
}

/**
 * Pairs each finding with the root comment it was posted as: same file and
 * line, a comment holding exactly the finding's text first, then the closest
 * wording. Exact pairs go first so a finding that was not posted again (an
 * earlier review already carried it) cannot take another finding's comment
 * at the same line.
 */
function matchComments(findings: StoredFinding[], comments: RawComment[]): Map<string, RawComment> {
  const taken = new Set<number>();
  const matched = new Map<string, RawComment>();
  const at = (comment: RawComment, finding: StoredFinding): boolean =>
    typeof comment.id === 'number' &&
    !taken.has(comment.id) &&
    comment.in_reply_to_id == null &&
    comment.path === finding.path &&
    (comment.original_line === finding.line || comment.line === finding.line);
  for (const finding of findings) {
    const exact = comments.find((comment) => at(comment, finding) && postedAs(comment, finding));
    if (exact !== undefined) {
      taken.add(exact.id!);
      matched.set(finding.findingId, exact);
    }
  }
  for (const finding of findings) {
    if (matched.has(finding.findingId)) continue;
    const words = significantWords(finding.text);
    const candidates = comments.filter((comment) => at(comment, finding));
    let best: RawComment | undefined;
    let bestScore = -1;
    for (const comment of candidates) {
      // Paired by the finding's words alone, never by the derived evidence block.
      const body = stripEvidenceBlock(comment.body ?? '');
      const score = overlap(words, significantWords(body)) + (body.startsWith(severityPrefix(finding)) ? 0.01 : 0);
      if (score > bestScore) {
        best = comment;
        bestScore = score;
      }
    }
    if (best !== undefined) {
      taken.add(best.id!);
      matched.set(finding.findingId, best);
    }
  }
  return matched;
}

async function followRun(
  options: CheckOptions,
  context: PullContext,
  run: SentRun,
  viewerLogin: () => Promise<string | null>,
): Promise<{ outcomes: FindingOutcome[]; questions: PendingQuestion[] }> {
  const detail = runDetail(options.db, run.runId);
  if (detail === null) return { outcomes: [], questions: [] };
  const { ids, source } = await reviewIdsOf(options, run, viewerLogin);
  const comments: RawComment[] = [];
  for (const id of ids) {
    comments.push(
      ...(await options.client.paginate<RawComment>(
        `/repos/${run.repository}/pulls/${run.pullNumber}/reviews/${id}/comments?per_page=100`,
        READ_LIMIT,
      )),
    );
  }
  const matched = matchComments(detail.findings, comments);
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const outcomes: FindingOutcome[] = [];
  const questions: PendingQuestion[] = [];
  for (const finding of detail.findings) {
    const comment = matched.get(finding.findingId);
    if (comment === undefined) continue;
    // From the same root, replies and states as the outcome, so detection costs no request.
    // Only a review id this tool recorded proves the comment is its own; one
    // found by commit and author may be a person's comment at the same line.
    // And only a comment holding exactly this finding's text is its thread, so
    // the reply quotes the evidence of the finding the person asked about.
    const wanted =
      source === 'audit' && postedAs(comment, finding)
        ? replyWanted(comment, context.replies, context.states?.get(comment.id!) ?? null, options.ownerReviewer ?? null)
        : null;
    if (wanted !== null) {
      questions.push({
        reviewRunId: run.runId,
        findingId: finding.findingId,
        repository: run.repository,
        pullNumber: run.pullNumber,
        rootCommentId: comment.id!,
        path: finding.path,
        line: finding.line,
        ...wanted,
      });
    }
    const decided = await decide(options, context, run, finding, comment);
    const outcome: FindingOutcome = {
      reviewRunId: run.runId,
      findingId: finding.findingId,
      repository: run.repository,
      pullNumber: run.pullNumber,
      commentId: comment.id!,
      ...decided,
      evidence: source === 'reviews-list' ? `${decided.evidence}; review found by commit and author` : decided.evidence,
      checkedAt,
      path: finding.path,
      line: finding.line,
      reviewIdSource: source,
    };
    // The matcher gives a comment to one finding of the run. A row an earlier
    // matcher stored, pairing it with another finding, would count its thread twice.
    options.db
      .prepare('DELETE FROM finding_outcomes WHERE review_run_id = ? AND comment_id = ? AND finding_id <> ?')
      .run(run.runId, outcome.commentId, outcome.findingId);
    saveOutcome(options.db, outcome);
    outcomes.push(outcome);
  }
  return { outcomes, questions };
}

/** Whether the anchored lines changed between the run's head and the current one; null when that cannot be told. */
async function linesChanged(
  options: CheckOptions,
  context: PullContext,
  run: SentRun,
  comment: RawComment,
  finding: StoredFinding,
): Promise<boolean | null> {
  if (run.headRef === null || context.currentHead === null) return null;
  if (sameHead(run.headRef, context.currentHead)) return false;
  const key = run.headRef.toLowerCase();
  let compare = context.compares.get(key);
  if (compare === undefined) {
    compare = options.client
      .paginateWrapped<RawFile>(`/repos/${run.repository}/compare/${run.headRef}...${context.currentHead}?per_page=100`, 'files', READ_LIMIT)
      .catch(() => null);
    context.compares.set(key, compare);
  }
  const files = await compare;
  if (files === null) return null;
  const file = files.find((entry) => entry.filename === finding.path || entry.previous_filename === finding.path);
  if (file === undefined) return false;
  if (typeof file.patch !== 'string') return null;
  const start = comment.start_line ?? comment.original_start_line ?? finding.line;
  return patchTouches(file.patch, Math.min(start, finding.line), finding.line);
}

async function decide(
  options: CheckOptions,
  context: PullContext,
  run: SentRun,
  finding: StoredFinding,
  comment: RawComment,
): Promise<Pick<FindingOutcome, 'outcome' | 'strength' | 'evidence' | 'decidedBy'>> {
  const dismissedByOwner = options.db
    .prepare(`SELECT 1 FROM feedback WHERE review_run_id = ? AND finding_id = ? AND action = 'dismiss'`)
    .get(run.runId, finding.findingId);
  // Explicit feedback wins. A recorded `keep` or `rewrite` says the finding was
  // right, not that the author acted on it, so it does not make an outcome.
  if (dismissedByOwner !== undefined) {
    return {
      outcome: 'dismissed',
      strength: 'strong',
      evidence: 'the owner recorded dismiss for this finding',
      decidedBy: options.ownerReviewer ?? null,
    };
  }

  const poster = comment.user?.login?.toLowerCase();
  const owner = options.ownerReviewer?.toLowerCase();
  const classified = context.replies
    .filter((reply) => reply.in_reply_to_id === comment.id && !isBot(reply.user))
    .map((reply) => ({
      stance: classifyReply(reply.body ?? ''),
      at: reply.created_at ?? '',
      author: reply.user?.login ?? 'unknown',
      login: reply.user?.login ?? null,
    }))
    .filter((answer) => answer.stance !== 'other')
    .sort((a, b) => a.at.localeCompare(b.at));
  // The owner's latest word decides first, read before the poster filter below
  // so that an owner who posted the review can still take a rejection back. A
  // rejection the owner has not taken back holds against whatever a teammate
  // says afterwards, and one the owner did take back is not revived by a
  // teammate's reject: the order of teammates' replies must not decide what
  // counts as the owner's evidence.
  const ownerLatest = owner === undefined ? undefined : [...classified].reverse().find((answer) => answer.login?.toLowerCase() === owner);
  if (ownerLatest?.stance === 'reject') {
    return { outcome: 'dismissed', strength: 'strong', evidence: `${ownerLatest.author} replied turning it down`, decidedBy: ownerLatest.login };
  }
  // The posting account agreeing with itself is not evidence of a fix, so its
  // replies are ignored from here on; its rejection, when it is the owner's,
  // was read above (docs/adr/0029).
  const answers = classified.filter((answer) => answer.login?.toLowerCase() !== poster);
  const latest = answers[answers.length - 1];

  if (latest?.stance === 'reject') {
    return { outcome: 'dismissed', strength: 'strong', evidence: `${latest.author} replied turning it down`, decidedBy: latest.login };
  }

  const state = context.states?.get(comment.id!) ?? null;
  const changed = (await linesChanged(options, context, run, comment, finding)) ?? (state?.outdated === true ? true : null);
  const resolved = state === null ? null : state.resolved;
  const agreed = latest?.stance === 'acknowledge';

  // The suggested replacement now stands where it was offered: the author
  // took it, which is as strong as a reply. An empty one is a deletion, and no
  // remaining text can show that, so it is left to the rules below, as is a
  // file that cannot be read (docs/adr/0033).
  // Only a block that was actually posted can have been applied: the comment
  // as GitHub holds it is the evidence, read with both heads around the range.
  const patch = suggestedPatchOf(finding.suggestedPatch);
  const offered = (comment.body ?? '').includes('\n```suggestion\n');
  // Not gated on `changed`: an insertion at the range's edge is not a change to
  // its lines, and the reading of both heads is the proof on its own.
  if (
    offered &&
    patch !== null &&
    patch.replacement !== '' &&
    patch.replacement !== patch.original &&
    context.currentHead !== null &&
    run.headRef !== null &&
    !sameHead(run.headRef, context.currentHead)
  ) {
    const [reviewed, current] = await Promise.all([
      fileAtRef(options.client, run.repository, finding.path, run.headRef),
      fileAtRef(options.client, run.repository, finding.path, context.currentHead),
    ]);
    if (reviewed !== null && current !== null && suggestionApplied(reviewed, current, patch)) {
      return { outcome: 'fixed', strength: 'strong', evidence: 'suggestion applied', decidedBy: null };
    }
  }

  if (changed === true && (resolved === true || agreed)) {
    return {
      outcome: 'fixed',
      strength: 'strong',
      evidence: `the anchored lines changed after the comment and ${resolved === true ? 'the thread was resolved' : `${latest!.author} agreed`}`,
      decidedBy: null,
    };
  }
  if (resolved === true) {
    return {
      outcome: 'resolved',
      strength: 'weak',
      evidence: changed === false ? 'the thread was resolved and the anchored lines are unchanged' : 'the thread was resolved; whether the lines changed could not be read',
      decidedBy: null,
    };
  }
  if (resolved === false && changed === true) {
    return { outcome: 'outdated', strength: 'weak', evidence: 'the anchored lines changed and the thread is still open', decidedBy: null };
  }
  if (resolved === false && changed === false) {
    return {
      outcome: 'open',
      strength: 'weak',
      evidence: agreed ? 'agreed in reply, but the lines are unchanged and the thread is open' : 'nothing has changed and the thread is open',
      decidedBy: null,
    };
  }
  return { outcome: 'unknown', strength: 'weak', evidence: 'the thread state or the later commits could not be read', decidedBy: null };
}

/** Stores an outcome, replacing the one an earlier check left. */
export function saveOutcome(db: Database, outcome: FindingOutcome): void {
  db.prepare(
    `INSERT INTO finding_outcomes
       (review_run_id, finding_id, repository, pull_number, comment_id, outcome, strength, evidence, checked_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (review_run_id, finding_id) DO UPDATE SET
       repository = excluded.repository, pull_number = excluded.pull_number, comment_id = excluded.comment_id,
       outcome = excluded.outcome, strength = excluded.strength, evidence = excluded.evidence, checked_at = excluded.checked_at,
       decided_by = excluded.decided_by`,
  ).run(
    outcome.reviewRunId,
    outcome.findingId,
    outcome.repository,
    outcome.pullNumber,
    outcome.commentId,
    outcome.outcome,
    outcome.strength,
    outcome.evidence,
    outcome.checkedAt,
    // Only a strong dismissal names its decider; anything else is stored as null.
    outcome.outcome === 'dismissed' && outcome.strength === 'strong' ? (outcome.decidedBy ?? null) : null,
  );
}

export interface PostedStats {
  tracked: number;
  fixed: number;
  dismissed: number;
  /** fixed / (fixed + dismissed) over strong outcomes; null with none. */
  fixedRate: number | null;
  dismissedRate: number | null;
}

function statsOf(rows: { outcome: string; strength: string }[]): PostedStats {
  const strong = rows.filter((row) => row.strength === 'strong');
  const fixed = strong.filter((row) => row.outcome === 'fixed').length;
  const dismissed = strong.filter((row) => row.outcome === 'dismissed').length;
  const decided = fixed + dismissed;
  return {
    tracked: rows.length,
    fixed,
    dismissed,
    fixedRate: decided === 0 ? null : fixed / decided,
    dismissedRate: decided === 0 ? null : dismissed / decided,
  };
}

interface OutcomeRow {
  review_run_id: string;
  finding_id: string;
  outcome: string;
  strength: string;
}

/**
 * Strong-outcome figures over every stored outcome, or with `since` (an ISO
 * time) only those whose run was created at or after it. The window joins
 * `review_runs`, so an outcome with no run row falls outside any window and
 * stays in the all-time figures only.
 */
export function postedStats(db: Database, { since }: { since?: string } = {}): PostedStats {
  if (since === undefined) {
    return statsOf(db.prepare('SELECT outcome, strength FROM finding_outcomes').all() as unknown as OutcomeRow[]);
  }
  return statsOf(
    db
      .prepare(
        `SELECT o.outcome AS outcome, o.strength AS strength FROM finding_outcomes o
         JOIN review_runs r ON r.review_run_id = o.review_run_id WHERE r.created_at >= ?`,
      )
      .all(since) as unknown as OutcomeRow[],
  );
}

export interface ReplyStats {
  /** Findings with a `review_reply_sent` row (docs/adr/0035). */
  replied: number;
  fixed: number;
  dismissed: number;
  /** fixed / (fixed + dismissed) over the replied findings' strong outcomes; null with none. */
  fixedRate: number | null;
}

/**
 * What became of the findings this tool replied under, joining each sent reply
 * row to the finding's stored outcome by run and finding. A replied finding
 * with no outcome yet, or a weak one, counts as replied and nothing more.
 */
export function replyStats(db: Database): ReplyStats {
  const rows = db
    .prepare(
      `SELECT o.outcome AS outcome, o.strength AS strength FROM (
         SELECT DISTINCT json_extract(metadata_json, '$.run') AS run, json_extract(metadata_json, '$.finding') AS finding
         FROM audit_events WHERE action = 'review_reply_sent' AND json_valid(metadata_json)
       ) r LEFT JOIN finding_outcomes o ON o.review_run_id = r.run AND o.finding_id = r.finding`,
    )
    .all() as unknown as OutcomeRow[];
  const { tracked, fixed, dismissed, fixedRate } = statsOf(rows);
  return { replied: tracked, fixed, dismissed, fixedRate };
}

export interface PostedBreakdown {
  bySeverity: Record<string, PostedStats>;
  byLane: Record<string, PostedStats>;
  /** By rule id (docs/adr/0032), the key an approved suppression names. */
  byRule: Record<string, PostedStats>;
  /** By whether the run's posted comments carried the evidence block (S15); `unknown` for posts recorded before the count. */
  byEvidenceBlock: { with: PostedStats; without: PostedStats; unknown: PostedStats };
}

/**
 * Each run's evidence block group, from the `evidenceBlocks` count of the
 * attempts a `review_post_sent` row names, the join `sentRuns` makes, so an
 * attempt that never sent counts for nothing. Any count above 0 is `with`;
 * otherwise a count of 0 is `without`, since an attempt from before the count
 * could not carry a block. A run with no count is not in the map, so its
 * outcomes are `unknown`.
 */
function evidenceBlockGroups(db: Database): Map<string, 'with' | 'without'> {
  const sent = new Set<string>();
  for (const row of db.prepare(`SELECT metadata_json FROM audit_events WHERE action = 'review_post_sent'`).all() as { metadata_json: string }[]) {
    try {
      const attempt = (JSON.parse(row.metadata_json) as { attempt?: unknown }).attempt;
      if (typeof attempt === 'string') sent.add(attempt);
    } catch {
      // A row that will not parse names no attempt.
    }
  }
  const groups = new Map<string, 'with' | 'without'>();
  for (const row of db
    .prepare(
      `SELECT audit_id, json_extract(metadata_json, '$.run') AS run, json_extract(metadata_json, '$.evidenceBlocks') AS blocks
       FROM audit_events WHERE action = 'review_post_attempted' AND json_valid(metadata_json)`,
    )
    .all() as { audit_id: string; run: unknown; blocks: unknown }[]) {
    if (!sent.has(row.audit_id) || typeof row.run !== 'string' || typeof row.blocks !== 'number') continue;
    if (row.blocks > 0) groups.set(row.run, 'with');
    else if (!groups.has(row.run)) groups.set(row.run, 'without');
  }
  return groups;
}

interface Placement {
  severity: string;
  lane: string;
  rule: string;
}

/**
 * Where a stored finding sits: its severity, lane (a finding with no lane is a
 * `diff` finding) and rule. A finding recorded before rule ids existed has none
 * stored, so its rule is derived the way `compileProposals` derives it; one
 * with no category has no rule and is counted as `unknown`. Both breakdowns
 * place through this one lookup, so they can never place a finding differently.
 */
function findingPlacer(db: Database): (runId: string, findingId: string) => Placement {
  const findings = new Map<string, Map<string, Placement>>();
  return (runId, findingId) => {
    let known = findings.get(runId);
    if (known === undefined) {
      known = new Map();
      findings.set(runId, known);
      const stored = db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(runId) as { output_json: string } | undefined;
      try {
        const parsed = JSON.parse(stored?.output_json ?? '{}') as { findings?: Record<string, unknown>[] };
        for (const finding of parsed.findings ?? []) {
          const lane = typeof finding['lane'] === 'string' ? finding['lane'] : 'diff';
          known.set(String(finding['findingId']), {
            severity: typeof finding['severity'] === 'string' ? finding['severity'] : 'unknown',
            lane,
            rule:
              typeof finding['ruleId'] === 'string' && finding['ruleId'].length > 0
                ? finding['ruleId']
                : (ruleIdFor(typeof finding['category'] === 'string' ? finding['category'] : null, lane) ?? 'unknown'),
          });
        }
      } catch {
        // A run that will not parse leaves its findings unplaced, not uncounted.
      }
    }
    return known.get(findingId) ?? { severity: 'unknown', lane: 'diff', rule: 'unknown' };
  };
}

const collect = <R, S>(map: Map<string, R[]>, statsOf: (rows: R[]) => S): Record<string, S> =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, statsOf(list)]));

/**
 * The same figures by the finding's severity, lane and rule, placed by
 * `findingPlacer`, over every stored outcome or with `since` (an ISO time) only
 * those whose run was created at or after it, the window `postedStats` uses.
 */
export function postedBreakdown(db: Database, { since }: { since?: string } = {}): PostedBreakdown {
  const rows = (
    since === undefined
      ? db.prepare('SELECT review_run_id, finding_id, outcome, strength FROM finding_outcomes').all()
      : db
          .prepare(
            `SELECT o.review_run_id AS review_run_id, o.finding_id AS finding_id, o.outcome AS outcome, o.strength AS strength
             FROM finding_outcomes o JOIN review_runs r ON r.review_run_id = o.review_run_id WHERE r.created_at >= ?`,
          )
          .all(since)
  ) as unknown as OutcomeRow[];
  const place = findingPlacer(db);
  const groups = { severity: new Map<string, OutcomeRow[]>(), lane: new Map<string, OutcomeRow[]>(), rule: new Map<string, OutcomeRow[]>() };
  const blockGroups = evidenceBlockGroups(db);
  const byBlock = { with: [] as OutcomeRow[], without: [] as OutcomeRow[], unknown: [] as OutcomeRow[] };
  for (const row of rows) {
    const info = place(row.review_run_id, row.finding_id);
    groups.severity.set(info.severity, [...(groups.severity.get(info.severity) ?? []), row]);
    groups.lane.set(info.lane, [...(groups.lane.get(info.lane) ?? []), row]);
    groups.rule.set(info.rule, [...(groups.rule.get(info.rule) ?? []), row]);
    byBlock[blockGroups.get(row.review_run_id) ?? 'unknown'].push(row);
  }
  return {
    bySeverity: collect(groups.severity, statsOf),
    byLane: collect(groups.lane, statsOf),
    byRule: collect(groups.rule, statsOf),
    byEvidenceBlock: { with: statsOf(byBlock.with), without: statsOf(byBlock.without), unknown: statsOf(byBlock.unknown) },
  };
}

export interface PrecisionStats {
  /** keep and rewrite rows, as owner_accepted_precision counts them. */
  kept: number;
  dismissed: number;
  /** kept / (kept + dismissed); null with no labelled finding. */
  precision: number | null;
}

function precisionOf(rows: { action: string }[]): PrecisionStats {
  const kept = rows.filter((row) => row.action !== 'dismiss').length;
  const dismissed = rows.length - kept;
  return { kept, dismissed, precision: rows.length === 0 ? null : kept / rows.length };
}

/**
 * The owner's labels by the finding's lane and rule, placed as `postedBreakdown`
 * places outcomes. `keep` and `rewrite` are kept and `dismiss` is dismissed;
 * `never_flag` and any later action are not labels for this figure, as they are
 * not for the global metric, and an unlabelled finding appears nowhere because
 * silence is never a label. `since` windows by the run's creation time.
 */
export function precisionBreakdown(db: Database, { since }: { since?: string } = {}): { byLane: Record<string, PrecisionStats>; byRule: Record<string, PrecisionStats> } {
  const labels = `f.action IN ('keep', 'rewrite', 'dismiss')`;
  const rows = (
    since === undefined
      ? db.prepare(`SELECT review_run_id, finding_id, action FROM feedback f WHERE ${labels}`).all()
      : db
          .prepare(
            `SELECT f.review_run_id AS review_run_id, f.finding_id AS finding_id, f.action AS action
             FROM feedback f JOIN review_runs r ON r.review_run_id = f.review_run_id WHERE ${labels} AND r.created_at >= ?`,
          )
          .all(since)
  ) as unknown as { review_run_id: string; finding_id: string; action: string }[];
  const place = findingPlacer(db);
  const byLane = new Map<string, typeof rows>();
  const byRule = new Map<string, typeof rows>();
  for (const row of rows) {
    const info = place(row.review_run_id, row.finding_id);
    byLane.set(info.lane, [...(byLane.get(info.lane) ?? []), row]);
    byRule.set(info.rule, [...(byRule.get(info.rule) ?? []), row]);
  }
  return { byLane: collect(byLane, precisionOf), byRule: collect(byRule, precisionOf) };
}
