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

const BUDGET_FLOOR = 600;
const BUDGET_PER_FILE = 60;
const BUDGET_CEILING = 3000;

/**
 * The total word budget, scaled to the size of the change.
 *
 * Once the count cap went and severity ordering took over the triage, this
 * stopped being a discipline. A nit at position nine costs a reader nothing,
 * because they stop where they choose. What remains is a runaway guard: it
 * should never bind on a real review, and when it does the output is
 * pathological rather than merely long.
 *
 * So the floor is deliberately generous. At forty words a finding, the old 180
 * allowed four and a half — which was the count cap returning through the back
 * door on small changes, without even the honest message explaining itself. A
 * single dense file can hold more real findings than that.
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
  // Kept as the floor rather than a separate constant: a caller that does not
  // know the file count still gets a budget that will not silently trim.
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
