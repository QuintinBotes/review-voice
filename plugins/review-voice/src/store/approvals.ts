import type { Database } from './db.ts';
import type { GitHubClient } from '../github/client.ts';
import { approvedRuns, isBot, sameHead, type ApprovedRun, type Strength } from './outcomes.ts';
import { independenceOf, ORIGINS } from './runs.ts';

/**
 * What became of each APPROVE Review Voice sent (docs/adr/0034), with ADR
 * 0004's strength rules: a revert, a person requesting changes on the approved
 * head, and a merge that outlived the window are strong; a merge at another
 * head, a merge the window has not closed on, and a pull request not merged are
 * weak. Silence before the window ends is `pending`, never `survived`.
 */
export type ApprovalOutcome = 'reverted' | 'changes_requested' | 'survived' | 'merged_other_head' | 'pending' | 'closed' | 'open' | 'unknown';

export interface OutcomesConfig {
  /** Days after the merge a revert or a request for changes still counts; after it a merge has survived. */
  approvalWindowDays: number;
  /** `status` warns when the escape rate's Wilson 95% upper bound is above this. */
  approvalEscapeWarn: number;
}

export const DEFAULT_OUTCOMES: Readonly<OutcomesConfig> = { approvalWindowDays: 14, approvalEscapeWarn: 0.05 };

/** Fewest settled approvals before `status` warns; below it one revert moves the bound too far. */
export const APPROVAL_WARN_MIN_SETTLED = 30;

export interface ApprovalEvidence {
  summary: string;
  state: string | null;
  mergedAt: string | null;
  /** The pull request's head as GitHub shows it now. */
  currentHead: string | null;
  windowEndsAt?: string;
  revertPull?: number;
  changesRequestedBy?: string;
  commitsAfterHead?: number | null;
}

export interface ApprovalOutcomeRow {
  reviewRunId: string;
  repository: string;
  pullNumber: number;
  head: string;
  reviewId: number | null;
  outcome: ApprovalOutcome;
  strength: Strength;
  evidence: ApprovalEvidence;
  checkedAt: string;
}

export interface ApprovalCheckOptions {
  db: Database;
  client: GitHubClient;
  /** ISO time; approvals sent at or after it are followed, and so is every approval whose row is not settled yet. */
  since: string;
  windowDays?: number | undefined;
  repository?: string | undefined;
  now?: (() => Date) | undefined;
}

export interface ApprovalCheckResult {
  outcomes: ApprovalOutcomeRow[];
  skipped: { repository: string; pullNumber: number; reason: string }[];
  warnings: string[];
}

interface RawPull {
  state?: unknown;
  merged?: unknown;
  merged_at?: unknown;
  closed_at?: unknown;
  body?: unknown;
  head?: { sha?: unknown };
}

interface RawReview {
  id?: unknown;
  state?: unknown;
  commit_id?: unknown;
  submitted_at?: unknown;
  user?: { login?: string; type?: string };
}

interface PullReads {
  pull: RawPull;
  reviews: RawReview[];
  commits: Promise<{ sha?: unknown }[]> | null;
  /** The revert search, run once per merged pull request however many approvals it has. */
  revert: Promise<number | null> | null;
}

const READ_LIMIT = 1000;
const EPOCH = '0000-01-01T00:00:00.000Z';

/**
 * Follows every approval of the matching runs to an outcome and stores it,
 * replacing an earlier check. Every request is a GET to a repository the
 * client allows; a run for any other repository is skipped without one. A
 * pull request that cannot be read is reported and its stored row left as it
 * was. An approval whose row is not settled is checked however old it is, so a
 * merge late in a pull request's life still reaches `survived`, a revert late
 * in the window still counts, and an approval a caller's `since` passed before
 * its first check is not dropped.
 */
export async function checkApprovals(options: ApprovalCheckOptions): Promise<ApprovalCheckResult> {
  const result: ApprovalCheckResult = { outcomes: [], skipped: [], warnings: [] };
  const settled = settledRuns(options.db, (options.now?.() ?? new Date()).toISOString());
  const runs = approvedRuns(options.db, { since: EPOCH, repository: options.repository }).filter(
    (run) => run.sentAt >= options.since || !settled.has(run.runId),
  );
  const reads = new Map<string, Promise<PullReads>>();
  for (const run of runs) {
    if (!options.client.allows(run.repository)) {
      result.skipped.push({ repository: run.repository, pullNumber: run.pullNumber, reason: 'not in the allowlist' });
      continue;
    }
    try {
      const key = `${run.repository.toLowerCase()}#${run.pullNumber}`;
      let read = reads.get(key);
      if (read === undefined) {
        read = readPull(options.client, run.repository, run.pullNumber);
        reads.set(key, read);
      }
      const outcome = await followApproval(options, run, await read);
      saveApprovalOutcome(options.db, outcome);
      result.outcomes.push(outcome);
    } catch (error) {
      result.warnings.push(
        `${run.repository}#${run.pullNumber}: approval not checked (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`,
      );
    }
  }
  return result;
}

async function readPull(client: GitHubClient, repository: string, pullNumber: number): Promise<PullReads> {
  const { data: pull } = await client.get<RawPull>(`/repos/${repository}/pulls/${pullNumber}`);
  const reviews = await client.paginate<RawReview>(`/repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`, READ_LIMIT);
  return { pull, reviews, commits: null, revert: null };
}

/**
 * The runs whose stored outcome no later check can change. A strong outcome is
 * final. A merge at another head can still be reverted, and a close can still
 * be reopened and merged, so those two are final only once their window has
 * passed. Pending, open and unknown are never final.
 */
function settledRuns(db: Database, now: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT review_run_id FROM approval_outcomes
       WHERE outcome IN ('reverted', 'changes_requested', 'survived')
          OR (outcome IN ('merged_other_head', 'closed')
              AND CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json, '$.windowEndsAt') END <= ?)`,
    )
    .all(now) as { review_run_id: string }[];
  return new Set(rows.map((row) => row.review_run_id));
}

/** Escapes a repository name for a regular expression; a dot in it is a dot. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The number of a merged pull request in the same repository whose body says it
 * reverts this one, merged inside the window, or null. One search, then one
 * read per hit to confirm the body text itself rather than the search's match.
 * A search GitHub did not finish cannot show there was no revert, so it throws
 * and the stored row stays as it was.
 */
async function findRevert(client: GitHubClient, run: ApprovedRun, mergedAt: string, windowEndsAt: string): Promise<number | null> {
  const found = await client.searchPullRequests(`reverts:${run.repository}#${run.pullNumber}`);
  const reverts = new RegExp(`\\bReverts ${escapeRegExp(run.repository)}#${run.pullNumber}\\b`, 'i');
  for (const candidate of found.pullRequests) {
    if (candidate.repository.toLowerCase() !== run.repository.toLowerCase() || candidate.number === run.pullNumber) continue;
    const { data: revert } = await client.get<RawPull>(`/repos/${run.repository}/pulls/${candidate.number}`);
    if (typeof revert.merged_at !== 'string' || typeof revert.body !== 'string' || !reverts.test(revert.body)) continue;
    if (revert.merged_at < mergedAt || revert.merged_at > windowEndsAt) continue;
    return candidate.number;
  }
  if (found.truncated) throw new Error('the revert search was incomplete');
  return null;
}

/** Commits after the approved head in the pull request's list, or null when the approved head is not in it. */
async function commitsAfter(client: GitHubClient, run: ApprovedRun, reads: PullReads): Promise<number | null> {
  reads.commits ??= client.paginate<{ sha?: unknown }>(`/repos/${run.repository}/pulls/${run.pullNumber}/commits?per_page=100`, READ_LIMIT);
  const commits = await reads.commits;
  const index = commits.findIndex((commit) => typeof commit.sha === 'string' && sameHead(commit.sha, run.head));
  return index === -1 ? null : commits.length - index - 1;
}

async function followApproval(options: ApprovalCheckOptions, run: ApprovedRun, reads: PullReads): Promise<ApprovalOutcomeRow> {
  const windowDays = options.windowDays ?? DEFAULT_OUTCOMES.approvalWindowDays;
  const now = options.now?.() ?? new Date();
  const { pull, reviews } = reads;
  const state = typeof pull.state === 'string' ? pull.state : null;
  const mergedAt = typeof pull.merged_at === 'string' ? pull.merged_at : null;
  const currentHead = typeof pull.head?.sha === 'string' ? pull.head.sha : null;
  const windowEnd = (from: string): string => new Date(Date.parse(from) + windowDays * 86_400_000).toISOString();
  const row = (outcome: ApprovalOutcome, strength: Strength, evidence: Omit<ApprovalEvidence, 'state' | 'mergedAt' | 'currentHead'>): ApprovalOutcomeRow => ({
    reviewRunId: run.runId,
    repository: run.repository,
    pullNumber: run.pullNumber,
    head: run.head,
    reviewId: run.reviewId,
    outcome,
    strength,
    evidence: { state, mergedAt, currentHead, ...evidence },
    checkedAt: now.toISOString(),
  });

  if (typeof pull.merged !== 'boolean' || state === null) {
    return row('unknown', 'weak', { summary: 'the pull request state could not be read' });
  }

  // The approval's own review says who posted it and when; the audit row stands in when it is not listed.
  const own = reviews.find((review) => review.id === run.reviewId);
  const poster = own?.user?.login?.toLowerCase() ?? null;
  const approvedAt = typeof own?.submitted_at === 'string' ? own.submitted_at : run.sentAt;
  // A review with no login (GitHub's user is null for a deleted account) cannot
  // be shown to come from a person who is not a bot and not the poster.
  const requestedBy = reviews.find(
    (review) =>
      review.state === 'CHANGES_REQUESTED' &&
      typeof review.user?.login === 'string' &&
      !isBot(review.user) &&
      review.user.login.toLowerCase() !== poster &&
      typeof review.commit_id === 'string' &&
      sameHead(review.commit_id, run.head) &&
      typeof review.submitted_at === 'string' &&
      review.submitted_at > approvedAt,
  )?.user?.login;
  const changesRequested = (by: string): ApprovalOutcomeRow =>
    row('changes_requested', 'strong', { summary: `${by} requested changes on the approved head after the approval`, changesRequestedBy: by });

  if (pull.merged) {
    // A merge whose head cannot be read cannot be said to be at the approved
    // head, and one whose time cannot be read has no window to have passed.
    if (currentHead === null || mergedAt === null) {
      return row('unknown', 'weak', { summary: 'the merged head or the merge time could not be read' });
    }
    // The table's rows in order: a revert or a request for changes counts
    // whichever head merged, before the head decides the weak outcomes.
    const windowEndsAt = windowEnd(mergedAt);
    reads.revert ??= findRevert(options.client, run, mergedAt, windowEndsAt);
    const revert = await reads.revert;
    if (revert !== null) return row('reverted', 'strong', { summary: `reverted by #${revert} inside the window`, windowEndsAt, revertPull: revert });
    if (requestedBy !== undefined) return changesRequested(requestedBy);
    if (!sameHead(currentHead, run.head)) {
      const after = await commitsAfter(options.client, run, reads);
      return row('merged_other_head', 'weak', {
        summary:
          after === null
            ? `merged at ${currentHead.slice(0, 8)}; the approved head is not among the pull request's commits`
            : `merged at ${currentHead.slice(0, 8)}, ${after} commit(s) after the approved head`,
        commitsAfterHead: after,
        // Kept so the row is read again until a revert can no longer count.
        windowEndsAt,
      });
    }
    if (now.toISOString() >= windowEndsAt) {
      return row('survived', 'strong', { summary: `merged at the approved head and not reverted in ${windowDays} days`, windowEndsAt });
    }
    return row('pending', 'weak', { summary: `merged at the approved head; the window ends ${windowEndsAt}`, windowEndsAt });
  }

  if (requestedBy !== undefined) return changesRequested(requestedBy);
  if (state === 'closed') {
    // Read again until the window from the close has passed, in case it is reopened and merged.
    return row('closed', 'weak', { summary: 'closed without merging', ...(typeof pull.closed_at === 'string' ? { windowEndsAt: windowEnd(pull.closed_at) } : {}) });
  }
  if (state === 'open') return row('open', 'weak', { summary: 'still open' });
  return row('unknown', 'weak', { summary: `the pull request state is ${state}` });
}

/** Stores an approval outcome, replacing the one an earlier check left. */
export function saveApprovalOutcome(db: Database, outcome: ApprovalOutcomeRow): void {
  db.prepare(
    `INSERT INTO approval_outcomes
       (review_run_id, repository, pull_number, head, review_id, outcome, strength, evidence_json, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (review_run_id) DO UPDATE SET
       repository = excluded.repository, pull_number = excluded.pull_number, head = excluded.head, review_id = excluded.review_id,
       outcome = excluded.outcome, strength = excluded.strength, evidence_json = excluded.evidence_json, checked_at = excluded.checked_at`,
  ).run(
    outcome.reviewRunId,
    outcome.repository,
    outcome.pullNumber,
    outcome.head,
    outcome.reviewId,
    outcome.outcome,
    outcome.strength,
    JSON.stringify(outcome.evidence),
    outcome.checkedAt,
  );
}

/** Stored approval outcomes, newest check first, with the evidence parsed. */
export function storedApprovalOutcomes(db: Database): ApprovalOutcomeRow[] {
  return (
    db.prepare('SELECT * FROM approval_outcomes ORDER BY checked_at DESC, rowid DESC').all() as unknown as {
      review_run_id: string;
      repository: string;
      pull_number: number;
      head: string;
      review_id: number | null;
      outcome: string;
      strength: string;
      evidence_json: string;
      checked_at: string;
    }[]
  ).map((row) => {
    let evidence: ApprovalEvidence = { summary: '', state: null, mergedAt: null, currentHead: null };
    try {
      evidence = { ...evidence, ...(JSON.parse(row.evidence_json) as Partial<ApprovalEvidence>) };
    } catch {
      // A row that will not parse keeps its outcome and loses only its words.
    }
    return {
      reviewRunId: row.review_run_id,
      repository: row.repository,
      pullNumber: row.pull_number,
      head: row.head,
      reviewId: row.review_id,
      outcome: row.outcome as ApprovalOutcome,
      strength: row.strength as Strength,
      evidence,
      checkedAt: row.checked_at,
    };
  });
}

/**
 * The Wilson score interval's 95% upper bound for `k` of `n`, which stays
 * honest at small `n` where the normal approximation says 0 of 5 is certainly 0.
 */
export function wilsonUpper(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 1;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, (centre + margin) / (1 + z2 / n));
}

export interface ApprovalStats {
  tracked: number;
  /** Strong `reverted` and `changes_requested`. */
  escaped: number;
  /** Strong `survived`. */
  survived: number;
  /** escaped + survived; the denominator. */
  settled: number;
  pending: number;
  /** Weak outcomes other than pending: merged at another head, closed, open, unknown. */
  weak: number;
  /** escaped / settled; null with nothing settled. */
  rate: number | null;
  /** Wilson 95% upper bound of the rate; null with nothing settled. */
  upperBound: number | null;
}

function statsOf(rows: { outcome: string; strength: string }[]): ApprovalStats {
  const strong = rows.filter((row) => row.strength === 'strong');
  const escaped = strong.filter((row) => row.outcome === 'reverted' || row.outcome === 'changes_requested').length;
  const survived = strong.filter((row) => row.outcome === 'survived').length;
  const settled = escaped + survived;
  const pending = rows.filter((row) => row.outcome === 'pending').length;
  return {
    tracked: rows.length,
    escaped,
    survived,
    settled,
    pending,
    weak: rows.length - settled - pending,
    rate: settled === 0 ? null : escaped / settled,
    upperBound: settled === 0 ? null : wilsonUpper(escaped, settled),
  };
}

/** The basis `evaluate` prints beside the rate, with the bound when there is one. */
export function approvalBasis(stats: ApprovalStats): string {
  const basis = `${stats.escaped} escaped / ${stats.settled} settled approvals; ${stats.pending} pending, ${stats.weak} weak excluded`;
  return stats.upperBound === null ? basis : `${basis}; Wilson 95% upper bound ${stats.upperBound.toFixed(2)}`;
}

/** The escape figures over every stored approval outcome. */
export function approvalStats(db: Database): ApprovalStats {
  return statsOf(db.prepare('SELECT outcome, strength FROM approval_outcomes').all() as unknown as { outcome: string; strength: string }[]);
}

export interface ApprovalBreakdown {
  byMode: Record<string, ApprovalStats>;
  byComplexity: Record<string, ApprovalStats>;
  byIndependence: Record<string, ApprovalStats>;
  byOrigin: Record<string, ApprovalStats>;
}

/** One string field of a stored JSON column, or `unknown` when the column or the field is missing. */
function field(raw: unknown, key: string): string {
  if (typeof raw !== 'string') return 'unknown';
  try {
    const value = (JSON.parse(raw) as Record<string, unknown> | null)?.[key];
    return typeof value === 'string' ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The same figures by the run's provenance mode, complexity level,
 * independence label and origin (`RunProvenance`). A run recorded before a
 * field existed is `unknown`. A group with nothing settled reports null rates.
 */
export function approvalBreakdown(db: Database): ApprovalBreakdown {
  const rows = db
    .prepare(
      `SELECT o.outcome AS outcome, o.strength AS strength, r.provenance_json AS provenance, r.complexity_json AS complexity
       FROM approval_outcomes o LEFT JOIN review_runs r ON r.review_run_id = o.review_run_id`,
    )
    .all() as unknown as { outcome: string; strength: string; provenance: string | null; complexity: string | null }[];
  const groups = { mode: new Map<string, typeof rows>(), complexity: new Map<string, typeof rows>(), independence: new Map<string, typeof rows>(), origin: new Map<string, typeof rows>() };
  const add = (map: Map<string, typeof rows>, key: string, row: (typeof rows)[number]): void => {
    map.set(key, [...(map.get(key) ?? []), row]);
  };
  for (const row of rows) {
    const origin = ORIGINS.find((known) => known === field(row.provenance, 'origin'));
    add(groups.mode, field(row.provenance, 'mode'), row);
    add(groups.complexity, field(row.complexity, 'level'), row);
    // Derived from the origin, never read back, as runs.ts does, so a hand-edited row cannot claim independence.
    add(groups.independence, origin === undefined ? 'unknown' : independenceOf(origin), row);
    add(groups.origin, origin ?? 'unknown', row);
  }
  const collect = (map: Map<string, typeof rows>): Record<string, ApprovalStats> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, statsOf(list)]));
  return { byMode: collect(groups.mode), byComplexity: collect(groups.complexity), byIndependence: collect(groups.independence), byOrigin: collect(groups.origin) };
}

/**
 * The `status` line when the escape rate's upper bound is above the configured
 * warning and enough approvals are settled, or null. Nothing is sent anywhere.
 */
export function approvalEscapeWarning(input: { escaped: number; settled: number; upperBound: number | null; threshold: number }): string | null {
  const { escaped, settled, upperBound, threshold } = input;
  if (settled < APPROVAL_WARN_MIN_SETTLED || upperBound === null || !(upperBound > threshold)) return null;
  return (
    `Warning: ${escaped} of ${settled} settled approvals escaped (reverted or changes requested); ` +
    `the 95% upper bound ${upperBound.toFixed(2)} is above outcomes.approval_escape_warn ${threshold}. ` +
    'Run `review-voice outcomes --approvals` to see them.'
  );
}
