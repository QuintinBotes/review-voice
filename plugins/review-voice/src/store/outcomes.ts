import type { Database } from './db.ts';
import { GitHubClient, REVIEW_THREADS_QUERY } from '../github/client.ts';
import { overlap, significantWords } from '../scoring/score.ts';
import { runDetail, type StoredFinding } from './runs.ts';

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

interface RawComment {
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

interface ThreadState {
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

/** Runs with a `review_post_sent` row at or after `since`, oldest first. */
export function sentRuns(db: Database, options: { since: string; repository?: string | undefined }): SentRun[] {
  const attempts = new Map<string, string>();
  for (const row of db
    .prepare(`SELECT audit_id, json_extract(metadata_json, '$.run') AS run FROM audit_events WHERE action = 'review_post_attempted'`)
    .all() as { audit_id: string; run: string | null }[]) {
    if (typeof row.run === 'string') attempts.set(row.audit_id, row.run);
  }
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

const isBot = (user: RawComment['user']): boolean => user?.type === 'Bot' || (user?.login ?? '').endsWith('[bot]');

function sameHead(a: string, b: string): boolean {
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
  /** ISO time; only sends at or after it are followed. */
  since: string;
  now?: () => Date;
}

export interface CheckResult {
  outcomes: FindingOutcome[];
  skipped: { repository: string; pullNumber: number; reason: string }[];
  warnings: string[];
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
  const result: CheckResult = { outcomes: [], skipped: [], warnings: [] };
  const byPull = new Map<string, SentRun[]>();
  for (const run of sentRuns(options.db, { since: options.since, repository: options.repository })) {
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
      for (const run of runs) {
        result.outcomes.push(...(await followRun(options, context, run, viewerLogin)));
      }
    } catch (error) {
      result.warnings.push(`${repository}#${pullNumber}: not checked (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`);
    }
  }
  return result;
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

/** Pairs each finding with the root comment it was posted as: same file and line, the closest wording when two share a line. */
function matchComments(findings: StoredFinding[], comments: RawComment[]): Map<string, RawComment> {
  const taken = new Set<number>();
  const matched = new Map<string, RawComment>();
  for (const finding of findings) {
    const words = significantWords(finding.text);
    const candidates = comments.filter(
      (comment) =>
        typeof comment.id === 'number' &&
        !taken.has(comment.id) &&
        comment.in_reply_to_id == null &&
        comment.path === finding.path &&
        (comment.original_line === finding.line || comment.line === finding.line),
    );
    let best: RawComment | undefined;
    let bestScore = -1;
    for (const comment of candidates) {
      const body = comment.body ?? '';
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
): Promise<FindingOutcome[]> {
  const detail = runDetail(options.db, run.runId);
  if (detail === null) return [];
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
  for (const finding of detail.findings) {
    const comment = matched.get(finding.findingId);
    if (comment === undefined) continue;
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
    saveOutcome(options.db, outcome);
    outcomes.push(outcome);
  }
  return outcomes;
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
): Promise<Pick<FindingOutcome, 'outcome' | 'strength' | 'evidence'>> {
  const dismissedByOwner = options.db
    .prepare(`SELECT 1 FROM feedback WHERE review_run_id = ? AND finding_id = ? AND action = 'dismiss'`)
    .get(run.runId, finding.findingId);
  // Explicit feedback wins. A recorded `keep` or `rewrite` says the finding was
  // right, not that the author acted on it, so it does not make an outcome.
  if (dismissedByOwner !== undefined) {
    return { outcome: 'dismissed', strength: 'strong', evidence: 'the owner recorded dismiss for this finding' };
  }

  const poster = comment.user?.login?.toLowerCase();
  const answers = context.replies
    .filter((reply) => reply.in_reply_to_id === comment.id && !isBot(reply.user) && reply.user?.login?.toLowerCase() !== poster)
    .map((reply) => ({ stance: classifyReply(reply.body ?? ''), at: reply.created_at ?? '', author: reply.user?.login ?? 'unknown' }))
    .filter((answer) => answer.stance !== 'other')
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = answers[answers.length - 1];

  if (latest?.stance === 'reject') {
    return { outcome: 'dismissed', strength: 'strong', evidence: `${latest.author} replied turning it down` };
  }

  const state = context.states?.get(comment.id!) ?? null;
  const changed = (await linesChanged(options, context, run, comment, finding)) ?? (state?.outdated === true ? true : null);
  const resolved = state === null ? null : state.resolved;
  const agreed = latest?.stance === 'acknowledge';

  if (changed === true && (resolved === true || agreed)) {
    return {
      outcome: 'fixed',
      strength: 'strong',
      evidence: `the anchored lines changed after the comment and ${resolved === true ? 'the thread was resolved' : `${latest!.author} agreed`}`,
    };
  }
  if (resolved === true) {
    return {
      outcome: 'resolved',
      strength: 'weak',
      evidence: changed === false ? 'the thread was resolved and the anchored lines are unchanged' : 'the thread was resolved; whether the lines changed could not be read',
    };
  }
  if (resolved === false && changed === true) {
    return { outcome: 'outdated', strength: 'weak', evidence: 'the anchored lines changed and the thread is still open' };
  }
  if (resolved === false && changed === false) {
    return {
      outcome: 'open',
      strength: 'weak',
      evidence: agreed ? 'agreed in reply, but the lines are unchanged and the thread is open' : 'nothing has changed and the thread is open',
    };
  }
  return { outcome: 'unknown', strength: 'weak', evidence: 'the thread state or the later commits could not be read' };
}

/** Stores an outcome, replacing the one an earlier check left. */
export function saveOutcome(db: Database, outcome: FindingOutcome): void {
  db.prepare(
    `INSERT INTO finding_outcomes
       (review_run_id, finding_id, repository, pull_number, comment_id, outcome, strength, evidence, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (review_run_id, finding_id) DO UPDATE SET
       repository = excluded.repository, pull_number = excluded.pull_number, comment_id = excluded.comment_id,
       outcome = excluded.outcome, strength = excluded.strength, evidence = excluded.evidence, checked_at = excluded.checked_at`,
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

export function postedStats(db: Database): PostedStats {
  return statsOf(db.prepare('SELECT outcome, strength FROM finding_outcomes').all() as unknown as OutcomeRow[]);
}

/** The same figures by the finding's severity and lane (a finding with no lane is a `diff` finding). */
export function postedBreakdown(db: Database): { bySeverity: Record<string, PostedStats>; byLane: Record<string, PostedStats> } {
  const rows = db.prepare('SELECT review_run_id, finding_id, outcome, strength FROM finding_outcomes').all() as unknown as OutcomeRow[];
  const findings = new Map<string, Map<string, { severity: string; lane: string }>>();
  const groups = { severity: new Map<string, OutcomeRow[]>(), lane: new Map<string, OutcomeRow[]>() };
  for (const row of rows) {
    let known = findings.get(row.review_run_id);
    if (known === undefined) {
      known = new Map();
      findings.set(row.review_run_id, known);
      const stored = db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(row.review_run_id) as
        | { output_json: string }
        | undefined;
      try {
        const parsed = JSON.parse(stored?.output_json ?? '{}') as { findings?: Record<string, unknown>[] };
        for (const finding of parsed.findings ?? []) {
          known.set(String(finding['findingId']), {
            severity: typeof finding['severity'] === 'string' ? finding['severity'] : 'unknown',
            lane: typeof finding['lane'] === 'string' ? finding['lane'] : 'diff',
          });
        }
      } catch {
        // A run that will not parse leaves its findings unplaced, not uncounted.
      }
    }
    const info = known.get(row.finding_id) ?? { severity: 'unknown', lane: 'diff' };
    groups.severity.set(info.severity, [...(groups.severity.get(info.severity) ?? []), row]);
    groups.lane.set(info.lane, [...(groups.lane.get(info.lane) ?? []), row]);
  }
  const collect = (map: Map<string, OutcomeRow[]>): Record<string, PostedStats> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, statsOf(list)]));
  return { bySeverity: collect(groups.severity), byLane: collect(groups.lane) };
}
