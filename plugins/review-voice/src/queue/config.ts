/**
 * Why a pull request is in the queue (docs/adr/0026). `discovered` is the
 * relevance discovery source (docs/adr/0038): it is never a configured
 * `queue.sources` value, since `queue.relevance.discover` governs it, so it
 * is not in QUEUE_SOURCES below.
 */
export type QueueSource = 'requested' | 'assigned' | 'team' | 'follow-up' | 'dismissed' | 'discovered';

export const QUEUE_SOURCES: readonly QueueSource[] = ['requested', 'assigned', 'team', 'follow-up', 'dismissed'];

export interface QueueSkipConfig {
  /** Exact logins, matched case-insensitively. */
  authors: string[];
  /** Regular expressions, matched case-insensitively against the author's login. */
  authorPatterns: string[];
  /** A pattern-matched or Bot author is let through when it requested the owner personally. */
  allowBotsWhenRequested: boolean;
  /** Skipped when any assignee is one of these logins. */
  assignedTo: string[];
  /** Skipped when one of `logins` approved the current head, for entries from one of `sources`. */
  approvedAtHeadBy: { logins: string[]; sources: QueueSource[] };
  drafts: boolean;
}

/**
 * The deterministic relevance check (docs/adr/0038). Present only when
 * `queue.relevance` is configured; absent, the queue behaves as before.
 */
export interface RelevanceConfig {
  /** `org/slug`; CODEOWNERS owners are matched as `@org/slug`. Default: `queue.teams`. */
  teams: string[];
  /** Share (0..1) of changed lines in team-owned files that makes a pull request relevant. */
  minOwnedShare: number;
  /** Globs; owned files matching one contribute no owned lines to the share. */
  ignoreOwnedPaths: string[];
  /** Globs; any changed file matching one is a signal. */
  paths: string[];
  /** Regular expressions, matched case-insensitively against added lines. */
  addedLinePatterns: string[];
  /** Logins; the pull request's author being one is a signal. */
  authors: string[];
  /** Words matched case-insensitively, whole word, against title and description. */
  keywords: string[];
  /** Recent unrequested pull requests to surface; absent means no discovery. */
  discover?: { updatedWithinHours: number; maxPulls: number };
}

export interface QueueConfig {
  sources: QueueSource[];
  /** `org/slug`; each adds a `team` search. */
  teams: string[];
  maxPerPass: number;
  followUpDays: number;
  skip: QueueSkipConfig;
  /** The relevance check (docs/adr/0038); absent means off. */
  relevance?: RelevanceConfig;
}

export const DEFAULT_MIN_OWNED_SHARE = 0.2;
export const DEFAULT_DISCOVER_UPDATED_WITHIN_HOURS = 24;
export const DEFAULT_DISCOVER_MAX_PULLS = 50;

/** A relevance configuration with only the defaults, for the `relevance` command's trial run. */
export function defaultRelevanceConfig(teams: readonly string[] = []): RelevanceConfig {
  return {
    teams: [...teams],
    minOwnedShare: DEFAULT_MIN_OWNED_SHARE,
    ignoreOwnedPaths: [],
    paths: [],
    addedLinePatterns: [],
    authors: [],
    keywords: [],
  };
}

export const DEFAULT_AUTHOR_PATTERNS: readonly string[] = ['\\[bot\\]$', '-bot$', '^renovate', '^dependabot'];

export function defaultQueueConfig(): QueueConfig {
  return {
    sources: ['requested', 'assigned', 'follow-up', 'dismissed'],
    teams: [],
    maxPerPass: 20,
    followUpDays: 30,
    skip: {
      authors: [],
      authorPatterns: [...DEFAULT_AUTHOR_PATTERNS],
      allowBotsWhenRequested: true,
      assignedTo: [],
      approvedAtHeadBy: { logins: [], sources: ['team'] },
      drafts: true,
    },
  };
}
