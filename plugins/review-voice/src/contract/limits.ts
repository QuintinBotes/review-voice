/** The output contract's numeric limits and vocabulary. */
export interface ContractLimits {
  /** null means no cap: volume is bounded by the word budget alone. */
  maxFindings: number | null;
  maxWordsPerFinding: number;
  maxTotalWords: number;
  noFindingsResponse: string;
  forbiddenPhrases: readonly string[];
}

/**
 * Ordered by how much of the reader's attention each tier earns, which is also
 * the order findings are presented in. A reader can stop anywhere down the
 * list and will have seen everything above it.
 *
 * `nit` and `question` exist so low-stakes remarks and open asks have a
 * structural home. Writing "Nit:" into prose says the same thing but cannot be
 * sorted, counted, or suppressed by category.
 */
export const SEVERITIES = ['blocking', 'important', 'minor', 'nit', 'question'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Presentation order, so the reader can stop reading when they choose. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  blocking: 0,
  important: 1,
  minor: 2,
  nit: 3,
  question: 4,
};

const BUDGET_FLOOR = 180;
const BUDGET_PER_FILE = 45;
const BUDGET_CEILING = 2000;

/**
 * The total word budget scales with the size of the change.
 *
 * A flat 180 words was written for an ordinary pull request. On a
 * four-hundred-file change it stops being a discipline and becomes a reason to
 * drop real findings, which is the opposite of what a reviewer is for. The
 * ceiling exists because past a couple of thousand words nobody is reading
 * anyway, and the honest response to a change that large is to say so.
 */
export function totalWordBudget(reviewableFiles: number): number {
  const scaled = BUDGET_FLOOR + BUDGET_PER_FILE * Math.max(0, reviewableFiles - 1);
  return Math.min(BUDGET_CEILING, Math.max(BUDGET_FLOOR, scaled));
}

/**
 * Defaults from the baseline policy. A repository may tighten these through
 * its own policy, but never past the ceilings the product promises.
 */
export const DEFAULT_LIMITS: ContractLimits = {
  // No cap. A count cap and a word budget do the same job, and the count is
  // the worse of the two: on tight findings it discards ones the budget would
  // have allowed. Severity ordering does the triage instead.
  maxFindings: null,
  maxWordsPerFinding: 40,
  maxTotalWords: BUDGET_FLOOR,
  noFindingsResponse: 'No actionable findings.',
  // Only phrases that hide a claim or replace one. A hedge makes a finding
  // unfalsifiable — "you might consider" states nothing to agree or disagree
  // with. "overall" and "summary" left out deliberately: they appear in real
  // prose ("overall latency", "the summary endpoint") and word-boundary
  // matching cannot tell those from a summary section.
  forbiddenPhrases: [
    'consider',
    'maybe',
    'might',
    'could potentially',
    'it may be worth',
    'nice work',
    'great job',
  ],
};
