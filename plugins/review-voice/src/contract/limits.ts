/** The output contract's numeric limits and vocabulary. */
export interface ContractLimits {
  maxFindings: number;
  maxWordsPerFinding: number;
  maxTotalWords: number;
  noFindingsResponse: string;
  forbiddenPhrases: readonly string[];
}

export const SEVERITIES = ['blocking', 'important', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Defaults from the baseline policy. A repository may tighten these through
 * its own policy, but never past the ceilings the product promises.
 */
export const DEFAULT_LIMITS: ContractLimits = {
  maxFindings: 5,
  maxWordsPerFinding: 40,
  maxTotalWords: 180,
  noFindingsResponse: 'No actionable findings.',
  forbiddenPhrases: [
    'consider',
    'maybe',
    'might',
    'could potentially',
    'it may be worth',
    'nice work',
    'great job',
    'overall',
    'summary',
    'nit',
  ],
};
