export const QUICK_TARGET = 50;
export const QUICK_SINCE = '90d';

export interface SyncWindow {
  /** Explicit --target, or the quick preset's; null when neither was given. */
  target: number | null;
  /** Skip pull requests last updated before this instant; undefined for no bound. */
  updatedSince: string | undefined;
}

export type SyncWindowResult = SyncWindow | { error: string };

/**
 * Reads --quick, --target and --since for sync. --quick is a preset
 * (`--target 50 --since 90d`) that an explicit flag overrides.
 */
export function resolveSyncWindow(
  input: { quick: boolean; target: number | null | undefined; since: string | null },
  now: Date = new Date(),
): SyncWindowResult {
  const since = input.since ?? (input.quick ? QUICK_SINCE : null);
  let updatedSince: string | undefined;
  if (since !== null) {
    const days = /^(\d+)d$/.exec(since);
    if (days === null || Number(days[1]) === 0) {
      return { error: `--since ${JSON.stringify(since)} must be a number of days such as 90d.` };
    }
    updatedSince = new Date(now.getTime() - Number(days[1]) * 86_400_000).toISOString();
  }
  return { target: input.target ?? (input.quick ? QUICK_TARGET : null), updatedSince };
}
