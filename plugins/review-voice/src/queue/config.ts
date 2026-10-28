/** Why a pull request is in the queue (docs/adr/0026). */
export type QueueSource = 'requested' | 'assigned' | 'team' | 'follow-up' | 'dismissed';

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

export interface QueueConfig {
  sources: QueueSource[];
  /** `org/slug`; each adds a `team` search. */
  teams: string[];
  maxPerPass: number;
  followUpDays: number;
  skip: QueueSkipConfig;
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
