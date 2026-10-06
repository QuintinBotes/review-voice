import type { ChangedFile } from './acquire.ts';
import { unquoteGitPath } from './hunks.ts';
import { globToRegExp } from '../conventions/globs.ts';

/**
 * Whether a change is complex enough that a person, not this tool, should
 * approve it (docs/adr/0012). Assessed from the diff alone, so the same diff
 * and the same limits always give the same answer.
 */
export interface HumanReviewConfig {
  maxDecisionPoints: number;
  maxHunkDecisionPoints: number;
  sensitivePaths: string[];
}

export const DEFAULT_SENSITIVE_PATHS = ['.github/workflows/**', '**/migrations/**', '**/auth/**', '**/security/**'];

export const DEFAULT_HUMAN_REVIEW: HumanReviewConfig = {
  maxDecisionPoints: 40,
  maxHunkDecisionPoints: 15,
  sensitivePaths: DEFAULT_SENSITIVE_PATHS,
};

export interface ComplexityAssessment {
  level: 'normal' | 'high';
  /** One short clause per signal that fired, e.g. "62 decision points added (limit 40)". */
  reasons: string[];
  decisionPoints: number;
  densestHunk: { path: string; line: number; decisionPoints: number } | null;
  /** Matched changed paths, at most 20, sorted. */
  sensitivePaths: string[];
  limits: { maxDecisionPoints: number; maxHunkDecisionPoints: number; sensitivePaths: string[] };
}

const MAX_SENSITIVE_LISTED = 20;

const KEYWORDS = /\b(?:if|elif|for|foreach|while|case|catch|except|when)\b/g;
// A space either side keeps `?.`, `??` and an optional `?:` out of the count.
const TERNARY = / \? /g;
const COMMENT_START = /^(?:\/\/|#|\*|\/\*|--)/;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * Branches introduced by one added line. Lexical on purpose, like changed-symbol
 * context: no parser, so no language is left out, and a count that is off by a
 * few on a string or a trailing comment is still the right order of magnitude.
 */
function decisionPointsIn(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0 || COMMENT_START.test(trimmed)) return 0;
  return count(trimmed, KEYWORDS) + count(trimmed, /&&/g) + count(trimmed, /\|\|/g) + count(trimmed, TERNARY);
}

interface HunkCount {
  path: string;
  line: number;
  decisionPoints: number;
}

/** The new-side path of a `+++` header, or null for a deletion. */
function headerPath(raw: string): string | null {
  const text = raw.replace(/\t.*$/, '');
  if (text === '/dev/null') return null;
  const unquoted = unquoteGitPath(text);
  return unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
}

/**
 * Decision points per hunk, for the files that count. The header's line
 * counts say where a hunk ends, so an added line whose text starts with `++ `
 * is still a line of the hunk rather than a file header.
 */
function countHunks(diff: string, counted: ReadonlySet<string>): HunkCount[] {
  const hunks: HunkCount[] = [];
  let path: string | null = null;
  let current: HunkCount | null = null;
  let remainingOld = 0;
  let remainingNew = 0;

  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (current !== null && (remainingOld > 0 || remainingNew > 0)) {
      if (line.startsWith('+')) {
        current.decisionPoints += decisionPointsIn(line.slice(1));
        remainingNew -= 1;
        continue;
      }
      if (line.startsWith('-')) {
        remainingOld -= 1;
        continue;
      }
      if (line.startsWith(' ') || line === '') {
        remainingOld -= 1;
        remainingNew -= 1;
        continue;
      }
      if (line.startsWith('\\')) continue;
    }

    if (line.startsWith('diff --git ')) {
      path = null;
      current = null;
      remainingOld = 0;
      remainingNew = 0;
      continue;
    }
    if (line.startsWith('+++ ')) {
      path = headerPath(line.slice(4));
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header !== null && path !== null) {
      remainingOld = header[1] === undefined ? 1 : Number(header[1]);
      remainingNew = header[3] === undefined ? 1 : Number(header[3]);
      current = { path, line: Number(header[2]), decisionPoints: 0 };
      if (counted.has(path)) hunks.push(current);
    }
  }
  return hunks;
}

function config(partial: Partial<HumanReviewConfig> | undefined): HumanReviewConfig {
  return {
    maxDecisionPoints: partial?.maxDecisionPoints ?? DEFAULT_HUMAN_REVIEW.maxDecisionPoints,
    maxHunkDecisionPoints: partial?.maxHunkDecisionPoints ?? DEFAULT_HUMAN_REVIEW.maxHunkDecisionPoints,
    sensitivePaths: partial?.sensitivePaths ?? DEFAULT_HUMAN_REVIEW.sensitivePaths,
  };
}

export function assessComplexity(
  diff: string,
  files: readonly ChangedFile[],
  partial?: Partial<HumanReviewConfig>,
): ComplexityAssessment {
  const limits = config(partial);

  const counted = new Set(files.filter((file) => file.class === 'source' && file.reviewed).map((file) => file.path));
  const hunks = countHunks(diff, counted);
  const decisionPoints = hunks.reduce((sum, hunk) => sum + hunk.decisionPoints, 0);
  // The first of equally dense hunks wins, so the report is stable.
  const densest = hunks.reduce<HunkCount | null>(
    (best, hunk) => (hunk.decisionPoints > 0 && (best === null || hunk.decisionPoints > best.decisionPoints) ? hunk : best),
    null,
  );

  // Every changed path, reviewed or not: a path left out of the review is no
  // less sensitive for it, and a rename touches both of its names.
  const matchers = limits.sensitivePaths.map((glob) => globToRegExp(glob));
  const changed = new Set<string>();
  for (const file of files) {
    changed.add(file.path);
    if (file.previousPath !== undefined) changed.add(file.previousPath);
  }
  const sensitive = [...changed].filter((path) => matchers.some((matcher) => matcher.test(path))).sort();
  const listed = sensitive.slice(0, MAX_SENSITIVE_LISTED);

  const reasons: string[] = [];
  if (decisionPoints > limits.maxDecisionPoints) {
    reasons.push(`${decisionPoints} decision points added (limit ${limits.maxDecisionPoints})`);
  }
  if (densest !== null && densest.decisionPoints > limits.maxHunkDecisionPoints) {
    reasons.push(
      `${densest.decisionPoints} decision points in one hunk at ${densest.path}:${densest.line} (limit ${limits.maxHunkDecisionPoints})`,
    );
  }
  if (sensitive.length > 0) {
    const shown = listed.slice(0, 3).join(', ');
    const more = sensitive.length - Math.min(3, listed.length);
    reasons.push(`touches sensitive paths (${shown}${more > 0 ? `, +${more} more` : ''})`);
  }

  return {
    level: reasons.length > 0 ? 'high' : 'normal',
    reasons,
    decisionPoints,
    densestHunk: densest === null ? null : { path: densest.path, line: densest.line, decisionPoints: densest.decisionPoints },
    sensitivePaths: listed,
    limits: { ...limits },
  };
}

/** The one line for the agent and the user; never posted to the pull request. Null unless the change is high-complexity. */
export function humanReviewNote(assessment: ComplexityAssessment | null): string | null {
  if (assessment === null || assessment.level !== 'high') return null;
  return `Needs a human reviewer: ${assessment.reasons.join('; ')}. Review Voice will not approve this change; this is not posted to the pull request.`;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Reads a stored or manifest value back; null on anything malformed, since unknown is not high. */
export function parseComplexity(value: unknown): ComplexityAssessment | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v['level'] !== 'normal' && v['level'] !== 'high') return null;
  if (!isStrings(v['reasons']) || !isCount(v['decisionPoints']) || !isStrings(v['sensitivePaths'])) return null;

  let densestHunk: ComplexityAssessment['densestHunk'] = null;
  if (v['densestHunk'] !== null) {
    const h = v['densestHunk'] as Record<string, unknown> | undefined;
    if (typeof h !== 'object' || h === null || typeof h['path'] !== 'string' || !isCount(h['line']) || !isCount(h['decisionPoints'])) {
      return null;
    }
    densestHunk = { path: h['path'], line: h['line'], decisionPoints: h['decisionPoints'] };
  }

  const l = v['limits'] as Record<string, unknown> | null | undefined;
  if (
    typeof l !== 'object' ||
    l === null ||
    !isCount(l['maxDecisionPoints']) ||
    !isCount(l['maxHunkDecisionPoints']) ||
    !isStrings(l['sensitivePaths'])
  ) {
    return null;
  }

  return {
    level: v['level'],
    reasons: v['reasons'],
    decisionPoints: v['decisionPoints'],
    densestHunk,
    sensitivePaths: v['sensitivePaths'],
    limits: {
      maxDecisionPoints: l['maxDecisionPoints'],
      maxHunkDecisionPoints: l['maxHunkDecisionPoints'],
      sensitivePaths: l['sensitivePaths'],
    },
  };
}
