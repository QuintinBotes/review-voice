/** `watch:` in the repository config (docs/adr/0027). */
export interface WatchConfig {
  /** Where the clones live; null is `<dataDir>/clones`. */
  workspace: string | null;
  intervalMs: number;
  post: boolean;
  maxAttemptsPerHead: number;
  /** How long one `review` may run before its process group is killed. */
  reviewTimeoutMs: number;
  /** Off: the review runs with REVIEW_VOICE_NO_COMMANDS=1, so no configured repository command runs unattended. */
  runRepositoryCommands: boolean;
  /** The 127.0.0.1 port that holds the one-watcher lock; null derives it from the data directory. */
  lockPort: number | null;
}

export const MAX_REVIEW_TIMEOUT_MS = 6 * 3_600_000;

export function defaultWatchConfig(): WatchConfig {
  return { workspace: null, intervalMs: 2 * 3_600_000, post: false, maxAttemptsPerHead: 2, reviewTimeoutMs: 45 * 60_000, runRepositoryCommands: false, lockPort: null };
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30m`, `2h` and the like in milliseconds, or null when it is not a whole number above zero with a unit. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(text.trim());
  if (match === null || Number(match[1]) === 0) return null;
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

/** The largest unit that divides the duration evenly: 2700000 is `45m`. */
export function formatDuration(ms: number): string {
  for (const unit of ['d', 'h', 'm', 's']) {
    if (ms % UNIT_MS[unit]! === 0) return `${ms / UNIT_MS[unit]!}${unit}`;
  }
  return `${ms}ms`;
}
