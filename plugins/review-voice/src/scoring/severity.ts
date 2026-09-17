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
 *
 * Confidence deliberately plays no part. A first version weakened one tier
 * below 0.85, which measured as the whole remaining instability: on two runs of
 * an identical diff the category was the same both times and the tier differed
 * anyway, at 0.82 against 0.90 and 0.85 against 0.80. Everything that can ship
 * already sits in [0.8, 1.0] because the confidence gate says so, and run to
 * run variance is around 0.08, so any boundary drawn inside that band gets
 * crossed. One free judgement was removed from this path and a second was left
 * in with a hard edge in the middle of it.
 *
 * The tiers are one step quieter than they were to compensate for dropping the
 * weakening, so removing the cliff does not make reviews louder.
 */
const BY_CATEGORY: Record<string, Severity> = {
  // Reserved for categories that are severe by their nature rather than by
  // circumstance. The confidence gate already keeps anything under 0.8 out.
  security: 'blocking',
  trust_boundary: 'blocking',
  authorization: 'blocking',
  authentication: 'blocking',
  data_integrity: 'blocking',

  // Wide blast radius follows from the kind of defect.
  concurrency: 'important',
  persistence: 'important',
  migration: 'important',
  api_contract: 'important',
  release: 'important',

  // Real defects whose reach depends on circumstances the scorer cannot see.
  // The quieter tier is the right default for a reviewer whose whole purpose
  // is not to overstate; the wording carries the consequence either way.
  correctness: 'minor',
  error_handling: 'minor',
  reliability: 'minor',
  user_visible_behavior: 'minor',
  ci: 'minor',
  packaging: 'minor',
  dependency: 'minor',
  performance: 'minor',

  observability: 'nit',
  test_coverage: 'nit',
  maintainability: 'nit',
  style: 'nit',
};

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
export function deriveSeverity(category: string | null | undefined, requested: string): DerivedSeverity {
  if (requested === 'question') {
    return { severity: 'question', requested, reason: 'a question is a kind of finding, not a tier' };
  }

  // A missing category used to be defaulted to `correctness` before it reached
  // here, which silently promoted an unlabelled finding into a real tier and
  // recorded nothing about the substitution. Absent and unrecognised are the
  // same state as far as this can tell, and both take the middle tier.
  if (category === null || category === undefined || category === '') {
    return {
      severity: 'minor',
      requested,
      reason: 'no category was supplied, so the middle tier is used rather than a guess',
    };
  }

  const base = BY_CATEGORY[category];
  if (base === undefined) {
    return {
      severity: 'minor',
      requested,
      reason: `category ${category} has no mapping, so the middle tier is used rather than a guess`,
    };
  }

  return { severity: base, requested, reason: `${category} carries ${base}` };
}
