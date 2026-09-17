import { SEVERITIES } from '../contract/limits.ts';

export type Severity = (typeof SEVERITIES)[number];

/**
 * The consequence a category carries when the claim holds.
 *
 * Severity is derived here rather than asked for, because asking produced a
 * different answer each time. On two runs of a byte-identical diff the same
 * finding was `minor` at confidence 0.90 and `important` at 0.85: the evidence
 * barely moved and the tier jumped. Ordering is severity-first, so an unstable
 * tier moves a finding up and down the page between identical reviews.
 *
 * This is a claim about blast radius, which is a property of the kind of defect
 * rather than of how the reviewer felt about it on the day.
 */
const BY_CATEGORY: Record<string, Severity> = {
  security: 'blocking',
  trust_boundary: 'blocking',
  authorization: 'blocking',
  authentication: 'blocking',
  data_integrity: 'blocking',

  correctness: 'important',
  persistence: 'important',
  concurrency: 'important',
  error_handling: 'important',
  reliability: 'important',
  migration: 'important',
  api_contract: 'important',
  user_visible_behavior: 'important',
  release: 'important',

  ci: 'minor',
  packaging: 'minor',
  dependency: 'minor',
  performance: 'minor',
  observability: 'minor',
  test_coverage: 'minor',

  maintainability: 'nit',
  style: 'nit',
};

/** Anything below this is real but not firm enough to carry its full tier. */
const FIRM_CONFIDENCE = 0.85;

function weaken(severity: Severity): Severity {
  const index = SEVERITIES.indexOf(severity);
  // `question` is a kind, not a tier, so there is nothing below `nit`.
  if (index === -1) return 'nit';
  return (SEVERITIES[Math.min(index + 1, SEVERITIES.indexOf('nit'))] ?? 'nit') as Severity;
}

export interface DerivedSeverity {
  severity: Severity;
  /** What the analyst asked for, kept so a divergence can be audited. */
  requested: string;
  reason: string;
}

/**
 * Derives the severity a finding is reported at.
 *
 * `question` is preserved: it says the reviewer could not establish the answer
 * and the author can, which is a kind of finding rather than a level of
 * consequence, and no category implies it.
 */
export function deriveSeverity(category: string, requested: string, confidence: number): DerivedSeverity {
  if (requested === 'question') {
    return { severity: 'question', requested, reason: 'a question is a kind of finding, not a tier' };
  }

  const base = BY_CATEGORY[category];
  if (base === undefined) {
    return {
      severity: 'minor',
      requested,
      reason: `category ${category} has no mapping, so the middle tier is used rather than a guess`,
    };
  }

  if (!Number.isFinite(confidence) || confidence >= FIRM_CONFIDENCE) {
    return { severity: base, requested, reason: `${category} carries ${base}` };
  }

  const weakened = weaken(base);
  return {
    severity: weakened,
    requested,
    reason: `${category} carries ${base}, weakened to ${weakened} below ${FIRM_CONFIDENCE} confidence`,
  };
}
