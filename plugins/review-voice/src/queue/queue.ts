import type { GitHubClient, SearchSource } from '../github/client.ts';
import type { Database } from '../store/db.ts';
import type { QueueConfig, QueueSource } from './config.ts';
import { checkRelevance, type RelevancePull, type RelevanceSignal } from './relevance.ts';
import { lastSentAtHead, recentlyReviewedPulls, runRecordedAtHead } from './store.ts';

export type { QueueSource } from './config.ts';

export type QueueAction =
  | { kind: 'review' }
  | { kind: 'verdict-only' }
  | { kind: 'recheck-ci' }
  | { kind: 'skip'; rule: string; reasons?: string[] }
  /** A discovered pull request that concerns the team: listed, never reviewed or recorded (docs/adr/0038). */
  | { kind: 'surface'; signals: RelevanceSignal[] };

export interface QueueEntry {
  repository: string;
  pull: number;
  head: string;
  author: string;
  sources: QueueSource[];
  action: QueueAction;
  createdAt: string;
}

export interface QueueResult {
  entries: QueueEntry[];
  /** `review` entries past `max_per_pass`, oldest first. */
  notReached: QueueEntry[];
  outsideAllowlist: number;
  truncated: boolean;
}

export interface QueueDeps {
  client: GitHubClient;
  db: Database;
  config: QueueConfig;
  /** The authenticated user's login. */
  me: string;
  now: Date;
  /** `watch.max_attempts_per_head`: a head the watcher failed this often is left out (docs/adr/0027). */
  maxAttemptsPerHead?: number;
  /**
   * The allowlist entries discovery searches, one scope each (docs/adr/0038).
   * Absent, the client's own entries are used.
   */
  allowlist?: string[];
}

interface RawPull {
  state?: string;
  draft?: boolean;
  created_at?: string;
  title?: string;
  body?: string | null;
  head?: { sha?: string };
  base?: { sha?: string };
  user?: { login?: string; type?: string } | null;
  assignees?: { login?: string }[] | null;
}

interface RawReview {
  state?: string;
  commit_id?: string | null;
  submitted_at?: string | null;
  user?: { login?: string } | null;
}

interface Candidate {
  repository: string;
  pull: number;
  sources: Set<QueueSource>;
  /** The head the latest recorded run read, for a follow-up candidate. */
  followUpFrom?: string;
}

const SOURCE_ORDER: QueueSource[] = ['requested', 'assigned', 'team', 'follow-up', 'dismissed', 'discovered'];
const MAX_REVIEWS = 1000;

const lower = (value: string): string => value.toLowerCase();

function reviewsOf(client: GitHubClient, repository: string, pull: number): Promise<RawReview[]> {
  return client.paginate<RawReview>(`/repos/${repository}/pulls/${pull}/reviews?per_page=100`, MAX_REVIEWS);
}

/**
 * The pull requests that need the owner's review, with skip rules applied
 * (docs/adr/0026). Reads GitHub search, each candidate pull request and the
 * local store; writes nothing.
 */
export async function buildQueue(deps: QueueDeps): Promise<QueueResult> {
  const { client, db, config, me } = deps;
  const candidates = new Map<string, Candidate>();
  let outsideAllowlist = 0;
  let truncated = false;

  const add = (repository: string, pull: number, source: QueueSource): Candidate => {
    const key = `${lower(repository)}#${pull}`;
    let candidate = candidates.get(key);
    if (candidate === undefined) {
      candidate = { repository, pull, sources: new Set() };
      candidates.set(key, candidate);
    }
    candidate.sources.add(source);
    return candidate;
  };

  const search = async (source: SearchSource) => {
    const result = await client.searchPullRequests(source);
    outsideAllowlist += result.outsideAllowlist;
    truncated ||= result.truncated;
    return result.pullRequests;
  };

  const enabled = new Set(config.sources);
  if (enabled.has('requested')) for (const pr of await search('requested')) add(pr.repository, pr.number, 'requested');
  if (enabled.has('assigned')) for (const pr of await search('assigned')) add(pr.repository, pr.number, 'assigned');
  if (enabled.has('team')) {
    for (const team of config.teams) {
      for (const pr of await search(`team:${team}`)) add(pr.repository, pr.number, 'team');
    }
  }
  if (enabled.has('dismissed')) {
    for (const pr of await search('reviewed')) {
      if (await latestOwnReviewDismissed(client, pr.repository, pr.number, me)) add(pr.repository, pr.number, 'dismissed');
    }
  }
  if (enabled.has('follow-up')) {
    const since = new Date(deps.now.getTime() - config.followUpDays * 86_400_000).toISOString();
    for (const recent of recentlyReviewedPulls(db, since)) {
      // A store row is not consent: only a repository still in the allowlist is read.
      if (!client.allows(recent.repository)) continue;
      add(recent.repository, recent.pull, 'follow-up').followUpFrom = recent.head;
    }
  }

  const listed: QueueEntry[] = [];
  for (const candidate of candidates.values()) {
    const entry = await classify(deps, candidate);
    if (entry !== null) listed.push(entry);
  }

  if (config.relevance?.discover !== undefined) {
    const found = await discover(deps, new Set(candidates.keys()));
    outsideAllowlist += found.outsideAllowlist;
    truncated ||= found.truncated;
    listed.push(...found.entries);
  }

  listed.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.repository.localeCompare(b.repository) ||
      a.pull - b.pull,
  );

  const entries: QueueEntry[] = [];
  const notReached: QueueEntry[] = [];
  let reviews = 0;
  for (const entry of listed) {
    if (entry.action.kind === 'review') {
      if (reviews >= config.maxPerPass) {
        notReached.push(entry);
        continue;
      }
      reviews += 1;
    }
    entries.push(entry);
  }

  return { entries, notReached, outsideAllowlist, truncated };
}

/** Whether the authenticated user's latest submitted review on this pull request was dismissed. */
async function latestOwnReviewDismissed(client: GitHubClient, repository: string, pull: number, me: string): Promise<boolean> {
  const own = (await reviewsOf(client, repository, pull)).filter(
    (review) => lower(review.user?.login ?? '') === lower(me) && review.state !== 'PENDING',
  );
  return own.at(-1)?.state === 'DISMISSED';
}

/** The entry for one candidate, or null when it is not listed at all. */
async function classify(deps: QueueDeps, candidate: Candidate): Promise<QueueEntry | null> {
  const { client, db } = deps;
  const { data: pull } = await client.get<RawPull>(`/repos/${candidate.repository}/pulls/${candidate.pull}`);
  const head = pull.head?.sha;
  if (pull.state !== 'open' || typeof head !== 'string' || head.length === 0) return null;

  // A follow-up is a pull request whose head moved since its latest run.
  if (candidate.followUpFrom !== undefined && lower(candidate.followUpFrom) === lower(head)) {
    candidate.sources.delete('follow-up');
    if (candidate.sources.size === 0) return null;
  }

  const sources = SOURCE_ORDER.filter((source) => candidate.sources.has(source));
  const sent = lastSentAtHead(db, candidate.repository, candidate.pull, head, deps.maxAttemptsPerHead);
  if (sent !== null && !sent.cappedByCi) return null;

  const author = pull.user?.login ?? '';
  const entry = (action: QueueAction): QueueEntry => ({
    repository: candidate.repository,
    pull: candidate.pull,
    head,
    author,
    sources,
    action,
    createdAt: pull.created_at ?? '',
  });

  const rule = await skipRule(deps, candidate, pull, head, sources);
  if (rule !== null) return entry({ kind: 'skip', rule });
  if (sent !== null) return entry({ kind: 'recheck-ci' });
  if (runRecordedAtHead(db, candidate.repository, candidate.pull, head)) return entry({ kind: 'verdict-only' });

  // Relevance last, after every cheaper rule, and only for a candidate that
  // is here by team request alone: a personal request, an assignment, a
  // follow-up or a dismissal is never filtered by it (docs/adr/0038). A
  // verdict-only or CI recheck above already had its review decided, so
  // it is not re-decided here either.
  if (deps.config.relevance !== undefined && sources.length === 1 && sources[0] === 'team') {
    const relevance = await checkRelevance({
      client,
      config: deps.config.relevance,
      repository: candidate.repository,
      pull: candidate.pull,
      pullRequest: relevancePullOf(pull),
    });
    if (!relevance.relevant) return entry({ kind: 'skip', rule: 'relevance', reasons: relevance.reasons });
  }
  return entry({ kind: 'review' });
}

/** The fields of one read pull request the relevance check takes. */
function relevancePullOf(pull: RawPull): RelevancePull {
  return {
    title: pull.title ?? '',
    body: pull.body ?? '',
    author: pull.user?.login ?? '',
    baseSha: pull.base?.sha ?? '',
  };
}

/**
 * Recently updated open pull requests nobody asked this owner to review,
 * surfaced when they concern the team (docs/adr/0038). Every allowlist
 * entry is one discovery search; at most `max_pulls` pull requests are
 * considered in total. One already in the queue, the owner's own, or one
 * the existing skip rules would skip, is dropped unread any further. A
 * surfaced entry is report-only: it is never a review.
 */
async function discover(
  deps: QueueDeps,
  known: ReadonlySet<string>,
): Promise<{ entries: QueueEntry[]; outsideAllowlist: number; truncated: boolean }> {
  const { client, config } = deps;
  const relevance = config.relevance!;
  const discoverConfig = relevance.discover!;
  const updatedSince = new Date(deps.now.getTime() - discoverConfig.updatedWithinHours * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const fresh: { repository: string; number: number }[] = [];
  const seen = new Set<string>(known);
  let outsideAllowlist = 0;
  let truncated = false;
  for (const scope of deps.allowlist ?? client.allowlistEntries()) {
    const result = await client.searchPullRequests(`discovered:${scope}`, { updatedSince });
    outsideAllowlist += result.outsideAllowlist;
    truncated ||= result.truncated;
    for (const found of result.pullRequests) {
      const key = `${lower(found.repository)}#${found.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(found);
    }
  }

  const entries: QueueEntry[] = [];
  for (const found of fresh.slice(0, discoverConfig.maxPulls)) {
    const { data: pull } = await client.get<RawPull>(`/repos/${found.repository}/pulls/${found.number}`);
    const head = pull.head?.sha;
    if (pull.state !== 'open' || typeof head !== 'string' || head.length === 0) continue;
    const candidate: Candidate = { repository: found.repository, pull: found.number, sources: new Set(['discovered']) };
    if ((await skipRule(deps, candidate, pull, head, ['discovered'])) !== null) continue;
    const result = await checkRelevance({
      client,
      config: relevance,
      repository: found.repository,
      pull: found.number,
      pullRequest: relevancePullOf(pull),
    });
    if (!result.relevant) continue;
    entries.push({
      repository: found.repository,
      pull: found.number,
      head,
      author: pull.user?.login ?? '',
      sources: ['discovered'],
      action: { kind: 'surface', signals: result.signals },
      createdAt: pull.created_at ?? '',
    });
  }
  return { entries, outsideAllowlist, truncated };
}

/** The first skip rule that matches, by its configuration name, or null. */
async function skipRule(
  deps: QueueDeps,
  candidate: Candidate,
  pull: RawPull,
  head: string,
  sources: QueueSource[],
): Promise<string | null> {
  const { client, me } = deps;
  const skip = deps.config.skip;
  const author = lower(pull.user?.login ?? '');

  if (author === lower(me)) return 'own';
  if (skip.drafts && pull.draft === true) return 'drafts';
  if (skip.authors.some((login) => lower(login) === author)) return 'authors';

  const botLike =
    lower(pull.user?.type ?? '') === 'bot' ||
    skip.authorPatterns.some((pattern) => new RegExp(pattern, 'i').test(author));
  if (botLike && !(skip.allowBotsWhenRequested && sources.includes('requested'))) return 'author_patterns';

  const assignees = (pull.assignees ?? []).map((assignee) => lower(assignee.login ?? ''));
  if (skip.assignedTo.some((login) => assignees.includes(lower(login)))) return 'assigned_to';

  const approvers = skip.approvedAtHeadBy.logins.map(lower);
  if (approvers.length > 0 && sources.some((source) => skip.approvedAtHeadBy.sources.includes(source))) {
    // GitHub's own rule: a login's standing review is its latest one that is
    // neither pending nor a plain comment, so a later request for changes
    // withdraws an earlier approval.
    const standing = new Map<string, RawReview>();
    for (const review of await reviewsOf(client, candidate.repository, candidate.pull)) {
      const login = lower(review.user?.login ?? '');
      if (approvers.includes(login) && review.state !== 'PENDING' && review.state !== 'COMMENTED') standing.set(login, review);
    }
    const approved = [...standing.values()].some(
      (review) => review.state === 'APPROVED' && lower(review.commit_id ?? '') === lower(head),
    );
    if (approved) return 'approved_at_head_by';
  }
  return null;
}
