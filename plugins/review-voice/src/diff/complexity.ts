import type { ChangedFile } from './acquire.ts';
import { unquoteGitPath } from './hunks.ts';
import { globToRegExp } from '../conventions/globs.ts';
import { isDocumentation } from './classify.ts';

/**
 * Whether a change is complex enough that a person, not this tool, should
 * approve it (docs/adr/0012). Assessed from the diff alone, so the same diff
 * and the same limits always give the same answer.
 */
export interface HumanReviewConfig {
  maxDecisionPoints: number;
  maxHunkDecisionPoints: number;
  sensitivePaths: string[];
  /**
   * A changed path matching one of these is not sensitive, although it matches
   * `sensitivePaths`: a UI subtree of an auth module, say. Opt-in; the defaults
   * stay as strict as they are, and `SENSITIVE_NEVER_EXEMPT` paths ignore it.
   */
  sensitiveExemptPaths: string[];
  /** Tests and fixtures: reviewed, but their decision points are not counted. */
  testPaths: string[];
  /**
   * Generated output that classification and `linguist-generated` miss, such
   * as files a generator in the repository writes. Not counted either.
   */
  generatedPaths: string[];
}

/**
 * `.review-voice/**` is here because the review's own configuration, exclusion
 * globs included, is read from the checked-out tree: a change to it is a
 * change to what this assessment measures.
 */
export const DEFAULT_SENSITIVE_PATHS = [
  '.github/workflows/**', '**/migrations/**', '**/auth/**', '**/security/**', '.review-voice/**',
];

/**
 * Paths no exemption reaches. The review's own configuration is read from the
 * checked-out tree, so a pull request could otherwise exempt itself, and a
 * workflow changes what CI proves.
 */
const SENSITIVE_NEVER_EXEMPT = ['.review-voice/**', '.github/workflows/**'];

/**
 * Common test and fixture layouts. Counting them made the cap shape how tests
 * were written: an author split one spec into five files to get a hunk under
 * the limit, and the change stayed high anyway.
 *
 * Narrow on purpose: a production file matched here goes uncounted. Name
 * patterns are used only where the language makes them mean a test (`.test.`
 * and `.spec.`, Go's `_test.go`, Ruby's `_spec.rb`); elsewhere a test
 * directory is required, so `ab_test.py`, `LoadTest.java` and a Go `spec/`
 * package still count.
 */
export const DEFAULT_TEST_PATHS = [
  '**/test/**', '**/tests/**', '**/__tests__/**',
  '**/fixtures/**', '**/__fixtures__/**', '**/testdata/**',
  '**/*.test.*', '**/*.spec.*', '**/*_test.go',
  '**/spec/**/*.rb', '**/*_spec.rb',
  '**/*.Tests/**', '**/*.UnitTests/**', '**/*.IntegrationTests/**',
];

export const DEFAULT_HUMAN_REVIEW: HumanReviewConfig = {
  maxDecisionPoints: 40,
  maxHunkDecisionPoints: 15,
  sensitivePaths: DEFAULT_SENSITIVE_PATHS,
  sensitiveExemptPaths: [],
  testPaths: DEFAULT_TEST_PATHS,
  generatedPaths: [],
};

export interface ComplexityAssessment {
  level: 'normal' | 'high';
  /** One short clause per signal that fired, e.g. "62 decision points added (limit 40)". */
  reasons: string[];
  decisionPoints: number;
  densestHunk: { path: string; line: number; decisionPoints: number } | null;
  /**
   * Reviewed files whose decision points are not counted, because they are
   * not production source. Sensitive paths still apply to every one of them.
   */
  excluded: Excluded;
  /** Matched changed paths, at most 20, sorted. */
  sensitivePaths: string[];
  /** The same paths with the first sensitive glob each matched, in config order; same cap. */
  sensitiveMatches: SensitiveMatch[];
  /** Changed paths a sensitive glob matched but `sensitive_exempt_paths` exempted, sorted, same cap. */
  sensitiveExempted: string[];
  limits: {
    maxDecisionPoints: number;
    maxHunkDecisionPoints: number;
    sensitivePaths: string[];
    sensitiveExemptPaths: string[];
    testPaths: string[];
    generatedPaths: string[];
  };
}

export interface SensitiveMatch {
  path: string;
  glob: string;
}

export interface Excluded {
  documentationFiles: number;
  testFiles: number;
  /** What the test files would have added, so the note can say the logic change is smaller. */
  testDecisionPoints: number;
  /** Generated, vendored or lock files the review read, by classification, attribute or glob. */
  generatedFiles: number;
  generatedDecisionPoints: number;
}

const NOTHING_EXCLUDED: Excluded = {
  documentationFiles: 0,
  testFiles: 0,
  testDecisionPoints: 0,
  generatedFiles: 0,
  generatedDecisionPoints: 0,
};

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
 * Decision points per hunk, for the files asked about. The header's line
 * counts say where a hunk ends, so an added line whose text starts with `++ `
 * is still a line of the hunk rather than a file header.
 */
function countHunks(diff: string, wanted: ReadonlySet<string>): HunkCount[] {
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
      if (wanted.has(path)) hunks.push(current);
    }
  }
  return hunks;
}

function config(partial: Partial<HumanReviewConfig> | undefined): HumanReviewConfig {
  return {
    maxDecisionPoints: partial?.maxDecisionPoints ?? DEFAULT_HUMAN_REVIEW.maxDecisionPoints,
    maxHunkDecisionPoints: partial?.maxHunkDecisionPoints ?? DEFAULT_HUMAN_REVIEW.maxHunkDecisionPoints,
    sensitivePaths: partial?.sensitivePaths ?? DEFAULT_HUMAN_REVIEW.sensitivePaths,
    sensitiveExemptPaths: partial?.sensitiveExemptPaths ?? DEFAULT_HUMAN_REVIEW.sensitiveExemptPaths,
    testPaths: partial?.testPaths ?? DEFAULT_HUMAN_REVIEW.testPaths,
    generatedPaths: partial?.generatedPaths ?? DEFAULT_HUMAN_REVIEW.generatedPaths,
  };
}

type Kind = 'production' | 'generated' | 'test' | 'documentation';

const matchesAny = (matchers: readonly RegExp[], path: string): boolean => matchers.some((matcher) => matcher.test(path));

/**
 * Ordinary production paths. An exclusion glob that matches one of them is a
 * catch-all (`**`, `src/**`, `**\/*.go`), not a test or generated layout.
 */
const PRODUCTION_PROBES = [
  'index.js', 'main.go', 'src/index.ts', 'src/App.tsx', 'src/app/service.py', 'src/lib.rs', 'src/main.c',
  'lib/core.rb', 'app/models/user.rb', 'cmd/server/main.go', 'pkg/api/handler.go', 'src/Program.cs',
  'src/main/java/com/example/App.java', 'src/main/kotlin/com/example/App.kt', 'app.php',
];

/**
 * The exclusion globs that may apply. A catch-all that would leave out a file
 * of this change is ignored, with a reason: exclusion globs come from the
 * checked-out tree, and `["**"]` would otherwise zero the count.
 */
function exclusionMatchers(key: string, globs: readonly string[], candidates: readonly string[], reasons: string[]): RegExp[] {
  const kept: RegExp[] = [];
  for (const glob of globs) {
    const matcher = globToRegExp(glob);
    const catchAll = PRODUCTION_PROBES.some((probe) => matcher.test(probe));
    if (catchAll && candidates.some((path) => matcher.test(path))) {
      reasons.push(`ignored ${key} glob "${glob}", which matches ordinary source files`);
      continue;
    }
    kept.push(matcher);
  }
  return kept;
}

/**
 * `markedGenerated` holds the paths the repository's `.gitattributes` marks
 * `linguist-generated`; the caller reads them, so this stays a function of
 * its arguments.
 */
export function assessComplexity(
  diff: string,
  files: readonly ChangedFile[],
  partial?: Partial<HumanReviewConfig>,
  markedGenerated: ReadonlySet<string> = new Set(),
): ComplexityAssessment {
  const limits = config(partial);

  // Decision points count only in production source (amended 2026-10-06).
  // Everything else the review reads is left out of the count, and counted
  // as left out, so the assessment can say what it did not measure.
  const reasons: string[] = [];
  const candidates = files
    .filter((file) => file.reviewed && file.class === 'source' && !isDocumentation(file.path))
    .map((file) => file.path);
  const tests = exclusionMatchers('test_paths', limits.testPaths, candidates, reasons);
  const generated = exclusionMatchers('generated_paths', limits.generatedPaths, candidates, reasons);
  const kindOf = (file: ChangedFile): Kind => {
    // A file the review reads although it is not source - a hand-edited
    // generated file, or anything under --include-generated - is generated.
    if (file.class !== 'source' || markedGenerated.has(file.path) || matchesAny(generated, file.path)) return 'generated';
    if (matchesAny(tests, file.path)) return 'test';
    return isDocumentation(file.path) ? 'documentation' : 'production';
  };
  const kinds = new Map<string, Kind>();
  for (const file of files) {
    if (file.reviewed) kinds.set(file.path, kindOf(file));
  }
  const allHunks = countHunks(diff, new Set(kinds.keys()));
  const hunks = allHunks.filter((hunk) => kinds.get(hunk.path) === 'production');
  const ofKind = (kind: Kind): number => [...kinds.values()].filter((value) => value === kind).length;
  const pointsOf = (kind: Kind): number =>
    allHunks.filter((hunk) => kinds.get(hunk.path) === kind).reduce((sum, hunk) => sum + hunk.decisionPoints, 0);
  const decisionPoints = hunks.reduce((sum, hunk) => sum + hunk.decisionPoints, 0);
  // The first of equally dense hunks wins, so the report is stable.
  const densest = hunks.reduce<HunkCount | null>(
    (best, hunk) => (hunk.decisionPoints > 0 && (best === null || hunk.decisionPoints > best.decisionPoints) ? hunk : best),
    null,
  );

  // Every changed path, reviewed or not: a path left out of the review is no
  // less sensitive for it, and a rename touches both of its names.
  const sensitiveMatchers = limits.sensitivePaths.map((glob) => globToRegExp(glob));
  const neverExempt = SENSITIVE_NEVER_EXEMPT.map((glob) => globToRegExp(glob));
  const changed = new Set<string>();
  for (const file of files) {
    changed.add(file.path);
    if (file.previousPath !== undefined) changed.add(file.previousPath);
  }
  const matched = [...changed].filter((path) => matchesAny(sensitiveMatchers, path)).sort();
  // A catch-all exemption is ignored when it would exempt a path of this change.
  const exemptible = matched.filter((path) => !matchesAny(neverExempt, path));
  const exemptions = exclusionMatchers('sensitive_exempt_paths', limits.sensitiveExemptPaths, exemptible, reasons);
  const exempted = exemptible.filter((path) => matchesAny(exemptions, path));
  const sensitive = matched.filter((path) => !exempted.includes(path));
  const listed = sensitive.slice(0, MAX_SENSITIVE_LISTED);
  const globOf = (path: string): string => limits.sensitivePaths[sensitiveMatchers.findIndex((matcher) => matcher.test(path))]!;
  const matches = listed.map((path) => ({ path, glob: globOf(path) }));
  for (const path of matched.filter((path) => matchesAny(neverExempt, path) && matchesAny(exemptions, path))) {
    reasons.push(`sensitive_exempt_paths does not apply to ${path}, which is review configuration or a workflow`);
  }

  if (decisionPoints > limits.maxDecisionPoints) {
    reasons.push(`${decisionPoints} decision points added (limit ${limits.maxDecisionPoints})`);
  }
  if (densest !== null && densest.decisionPoints > limits.maxHunkDecisionPoints) {
    reasons.push(
      `${densest.decisionPoints} decision points in one hunk at ${densest.path}:${densest.line} (limit ${limits.maxHunkDecisionPoints})`,
    );
  }
  if (sensitive.length > 0) {
    const shown = matches.slice(0, 3).map((match) => `${match.path} matched ${match.glob}`).join(', ');
    const more = sensitive.length - Math.min(3, listed.length);
    reasons.push(`touches sensitive paths (${shown}${more > 0 ? `, +${more} more` : ''})`);
  }

  return {
    level: reasons.length > 0 ? 'high' : 'normal',
    reasons,
    decisionPoints,
    densestHunk: densest === null ? null : { path: densest.path, line: densest.line, decisionPoints: densest.decisionPoints },
    excluded: {
      documentationFiles: ofKind('documentation'),
      testFiles: ofKind('test'),
      testDecisionPoints: pointsOf('test'),
      generatedFiles: ofKind('generated'),
      generatedDecisionPoints: pointsOf('generated'),
    },
    sensitivePaths: listed,
    sensitiveMatches: matches,
    sensitiveExempted: exempted.slice(0, MAX_SENSITIVE_LISTED),
    limits: { ...limits },
  };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** What the count left out, as a sentence, or an empty string when nothing was. */
function notCounted(excluded: Excluded): string {
  const parts: string[] = [];
  if (excluded.generatedFiles > 0) {
    parts.push(
      `${plural(excluded.generatedFiles, 'generated file')} (${plural(excluded.generatedDecisionPoints, 'decision point')})`,
    );
  }
  if (excluded.testFiles > 0) {
    parts.push(`${plural(excluded.testFiles, 'test file')} (${plural(excluded.testDecisionPoints, 'decision point')})`);
  }
  if (excluded.documentationFiles > 0) parts.push(plural(excluded.documentationFiles, 'documentation file'));
  return parts.length === 0 ? '' : ` Left out of the decision-point count: ${parts.join(', ')}.`;
}

/** Which paths an exemption let through, so a reader sees the high level is not about them. */
function exemptedClause(exempted: readonly string[]): string {
  if (exempted.length === 0) return '';
  const more = exempted.length - Math.min(3, exempted.length);
  return ` Exempted by sensitive_exempt_paths: ${exempted.slice(0, 3).join(', ')}${more > 0 ? `, +${more} more` : ''}.`;
}

/** The one line for the agent and the user; never posted to the pull request. Null unless the change is high-complexity. */
export function humanReviewNote(assessment: ComplexityAssessment | null): string | null {
  if (assessment === null || assessment.level !== 'high') return null;
  return `Needs a human reviewer: ${assessment.reasons.join('; ')}.${exemptedClause(assessment.sensitiveExempted)}${notCounted(assessment.excluded)} Review Voice will not approve this change; this is not posted to the pull request.`;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * An assessment recorded before exclusions were reported excluded nothing,
 * so a missing block reads as zeros; a present but malformed one is rejected.
 */
function parseExcluded(value: unknown): Excluded | null {
  if (value === undefined) return { ...NOTHING_EXCLUDED };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  const read = (key: string): number | null => {
    const count = e[key];
    if (count === undefined) return 0;
    return isCount(count) ? count : null;
  };
  const parsed = { ...NOTHING_EXCLUDED };
  for (const key of Object.keys(NOTHING_EXCLUDED) as (keyof Excluded)[]) {
    const count = read(key);
    if (count === null) return null;
    parsed[key] = count;
  }
  return parsed;
}

/** An assessment recorded before matches were reported has none; a present but malformed list is rejected. */
function parseMatches(value: unknown): SensitiveMatch[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const parsed: SensitiveMatch[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const m = item as Record<string, unknown>;
    if (typeof m['path'] !== 'string' || typeof m['glob'] !== 'string') return null;
    parsed.push({ path: m['path'], glob: m['glob'] });
  }
  return parsed;
}

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

  // Fields added after the first release of this record: absent means none.
  const sensitiveExempted = v['sensitiveExempted'] === undefined ? [] : v['sensitiveExempted'];
  if (!isStrings(sensitiveExempted)) return null;
  const sensitiveMatches = parseMatches(v['sensitiveMatches']);
  if (sensitiveMatches === null) return null;

  const excluded = parseExcluded(v['excluded']);
  if (excluded === null) return null;

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
  // Globs added after the first release of this record: absent means none applied.
  const optionalGlobs = (key: string): string[] | null => {
    const globs = l[key];
    if (globs === undefined) return [];
    return isStrings(globs) ? globs : null;
  };
  const sensitiveExemptPaths = optionalGlobs('sensitiveExemptPaths');
  const testPaths = optionalGlobs('testPaths');
  const generatedPaths = optionalGlobs('generatedPaths');
  if (sensitiveExemptPaths === null || testPaths === null || generatedPaths === null) return null;

  return {
    level: v['level'],
    reasons: v['reasons'],
    decisionPoints: v['decisionPoints'],
    densestHunk,
    excluded,
    sensitivePaths: v['sensitivePaths'],
    sensitiveMatches,
    sensitiveExempted,
    limits: {
      maxDecisionPoints: l['maxDecisionPoints'],
      maxHunkDecisionPoints: l['maxHunkDecisionPoints'],
      sensitivePaths: l['sensitivePaths'],
      sensitiveExemptPaths,
      testPaths,
      generatedPaths,
    },
  };
}
