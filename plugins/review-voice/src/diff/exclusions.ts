import type { FileClass } from './classify.ts';

/**
 * What a diff left out of the review, counted (issue 351).
 *
 * Each excluded file already carries a reason, but a reason on ten entries of
 * a manifest is not a signal, and a review once read two of a pull request's
 * twelve files with nothing to say so. The summary is one line a person reads
 * and counts a later stage can show, with no path in it, so it can be posted.
 */
export interface ExclusionSummary {
  /** Changed files in the scope being reviewed. */
  changedFiles: number;
  /** Those of them the review does not read. */
  excludedFiles: number;
  /** The count for each reason, most files first. */
  reasons: { reason: string; files: number }[];
  /** The line `diff` prints on stderr. */
  note: string;
}

export const FILE_DELETED = 'file deleted';
export const NO_PATCH = 'no patch returned (binary or too large)';
export const SAME_AS_BASE_TIP = 'identical to the base branch tip (already merged there)';
/** Why a narrowed review does not read a file the earlier one covered; that review's head follows in brackets. */
export const COVERED_EARLIER = 'unchanged since the last review';

/**
 * The paths a diff leaves out by its own rules, whether or not they are in
 * the scope: the files no review of the pull request has read. The next
 * review is told, so it cannot call one of them covered by this one.
 */
export function leftOutPaths(files: readonly { path: string; reviewed: boolean; excludedBecause?: string }[]): string[] {
  return files.filter((file) => file.reviewed === false && !String(file.excludedBecause ?? '').startsWith(COVERED_EARLIER)).map((file) => file.path);
}

/** Why a file of this class is left out, as its entry in the file list says it. */
export function excludedReason(cls: FileClass): string {
  switch (cls) {
    case 'lockfile': return 'lock file; use --include-generated if the dependency change is the point';
    case 'vendored': return 'vendored dependency';
    case 'generated': return 'generated or minified';
    case 'binary': return 'binary';
    default: return '';
  }
}

/** A reason without the advice that follows its `;`, which belongs on the file's own entry. */
const short = (reason: string): string => reason.split(';')[0]!.trim();

const KNOWN_REASONS: ReadonlySet<string> = new Set(
  [...(['lockfile', 'vendored', 'generated', 'binary'] as const).map(excludedReason), FILE_DELETED, NO_PATCH, SAME_AS_BASE_TIP].map(short),
);
const OTHER_REASON = 'other reason';

const plural = (count: number): string => `${count} changed file${count === 1 ? '' : 's'}`;

function summary(changedFiles: number, counts: ReadonlyMap<string, number>): ExclusionSummary | null {
  // Most files first; a stable sort keeps equal counts in the order they were met.
  const reasons = [...counts].map(([reason, files]) => ({ reason, files })).sort((a, b) => b.files - a.files);
  const excludedFiles = reasons.reduce((sum, entry) => sum + entry.files, 0);
  if (excludedFiles === 0) return null;
  return {
    changedFiles,
    excludedFiles,
    reasons,
    note: `Excluded ${excludedFiles} of ${plural(changedFiles)}: ${reasons.map((entry) => `${entry.files} ${entry.reason}`).join(', ')}.`,
  };
}

/**
 * Counts the files a diff leaves out, by reason. `files` is the scope being
 * reviewed, so a caller narrowing to a follow-up leaves out the files the
 * earlier review covered. Null when every file is read.
 */
export function summariseExclusions(files: readonly { reviewed: boolean; excludedBecause?: string }[]): ExclusionSummary | null {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.reviewed) continue;
    const reason = short(file.excludedBecause ?? '') || OTHER_REASON;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return summary(files.length, counts);
}

/**
 * Reads a summary back from a manifest or the store, or null when it is not
 * one. The note is rebuilt from the counts and a reason this code does not
 * word itself is counted as another one, so a crafted manifest cannot put a
 * path or markup into a posted review.
 */
export function parseExclusions(raw: unknown): ExclusionSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const whole = (count: unknown): count is number => Number.isInteger(count) && (count as number) > 0;
  if (!whole(value['changedFiles']) || !whole(value['excludedFiles']) || !Array.isArray(value['reasons'])) return null;
  const counts = new Map<string, number>();
  for (const entry of value['reasons'] as unknown[]) {
    const reason = (entry as { reason?: unknown } | null)?.reason;
    const files = (entry as { files?: unknown } | null)?.files;
    if (typeof reason !== 'string' || !whole(files)) return null;
    const known = KNOWN_REASONS.has(reason) ? reason : OTHER_REASON;
    counts.set(known, (counts.get(known) ?? 0) + files);
  }
  const parsed = summary(value['changedFiles'], counts);
  return parsed !== null && parsed.excludedFiles === value['excludedFiles'] && parsed.excludedFiles <= parsed.changedFiles ? parsed : null;
}
