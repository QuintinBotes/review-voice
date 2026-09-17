import { SEVERITIES } from '../contract/limits.ts';
import type { Reach, ReachCheck } from './reach.ts';

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
 * The category says what kind of consequence a claim carries; reach says how
 * far the named implementation spreads. Reach is computed by the CLI from the
 * reviewed tree, never supplied by an agent.
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
const LEGACY_BY_CATEGORY: Record<string, Severity> = {
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

type ReachTiers = Record<Reach, Severity>;

const atEveryReach = (severity: Severity): ReachTiers => ({
  local: severity,
  component: severity,
  repository: severity,
});

/**
 * Category supplies the consequence; deterministic reach supplies its extent.
 *
 * Categories whose consequence already fixes their tier retain it at every
 * reach. The remaining thresholds are initial, calibrated-by-guess values:
 * they are deliberately explicit so a measured run can revise the table
 * without restoring an agent judgement to this path.
 */
const BY_CATEGORY_AND_REACH: Record<string, ReachTiers> = {
  security: atEveryReach('blocking'),
  trust_boundary: atEveryReach('blocking'),
  authorization: atEveryReach('blocking'),
  authentication: atEveryReach('blocking'),
  data_integrity: atEveryReach('blocking'),

  concurrency: atEveryReach('important'),
  persistence: atEveryReach('important'),
  migration: atEveryReach('important'),
  // A contract break that reaches the repository stops the build for every
  // consumer. Measured: a change adding a required prop and missing one of
  // three call sites derived `important` while its head had ten CI failures,
  // each a Code check across a different package.
  api_contract: { local: 'important', component: 'important', repository: 'blocking' },
  release: atEveryReach('important'),

  correctness: { local: 'minor', component: 'important', repository: 'important' },
  error_handling: { local: 'minor', component: 'important', repository: 'important' },
  reliability: { local: 'minor', component: 'important', repository: 'important' },
  user_visible_behavior: { local: 'minor', component: 'important', repository: 'important' },
  ci: { local: 'nit', component: 'important', repository: 'blocking' },
  packaging: { local: 'minor', component: 'important', repository: 'blocking' },
  dependency: { local: 'minor', component: 'important', repository: 'blocking' },
  performance: { local: 'minor', component: 'minor', repository: 'important' },

  observability: atEveryReach('nit'),
  test_coverage: atEveryReach('nit'),
  maintainability: atEveryReach('nit'),
  style: atEveryReach('nit'),
};

/**
 * Names agents reach for that are not in the schema.
 *
 * The prompt now lists the valid categories, which is the actual fix. This is
 * the belt: on one pull request half the findings used `testing` and
 * `documentation`, plausible words that are not in the enum, and both fell back
 * to the middle tier. The fallback behaved exactly as designed and said so, and
 * the finding still lost the distinction it was making, because a test-coverage
 * nit landed on `minor`.
 *
 * Only unambiguous synonyms are listed. An alias into a `blocking` tier is the
 * riskiest kind, so a genuinely ambiguous word like `privacy` is left to the
 * middle-tier fallback rather than guessed into `security` or `data_integrity`.
 */
const ALIASES: Record<string, string> = {
  testing: 'test_coverage',
  tests: 'test_coverage',
  test: 'test_coverage',
  coverage: 'test_coverage',

  documentation: 'maintainability',
  docs: 'maintainability',
  comments: 'maintainability',
  naming: 'maintainability',
  readability: 'maintainability',

  perf: 'performance',
  logging: 'observability',
  formatting: 'style',

  authz: 'authorization',
  authn: 'authentication',
  secrets: 'security',
  vulnerability: 'security',

  race: 'concurrency',
  idempotency: 'concurrency',
  database: 'persistence',
  schema: 'migration',
  api: 'api_contract',
  build: 'ci',
  deployment: 'release',
  dependencies: 'dependency',
  bug: 'correctness',
  logic: 'correctness',
};

export interface DerivedSeverity {
  severity: Severity;
  /** What the analyst asked for, kept so a divergence can be audited. */
  requested: string;
  /** The CLI's deterministic reach evidence, or absent reach. */
  reach: ReachCheck | null;
  reason: string;
}

/**
 * Derives the severity a finding is reported at.
 *
 * Absent reach deliberately reproduces the legacy category tier exactly. A
 * local question remains a question; wider questions use the same
 * category-and-reach table as every other finding.
 */
export function deriveSeverity(
  category: string | null | undefined,
  requested: string,
  reach: ReachCheck | null | undefined = null,
): DerivedSeverity {
  // A question passes through whatever its reach.
  //
  // 1.1.0 derived it from (category, reach) like anything else, on the theory
  // that the interrogative is carried by the wording and `question` as a tier
  // should mean an ask whose reach is local. The theory was wrong twice over.
  // `BY_CATEGORY_AND_REACH` contains no `question` at any category or reach, so
  // the tier was unreachable, and 1.3.0's module fallback made reach available
  // far more often - which turned the bug from rare into routine.
  //
  // Measured consequence: a candidate that said, in its own evidence, that the
  // LaunchDarkly state was outside the repository and could not be read was
  // re-derived as `important` and published as an assertion. An honest "I could
  // not check this" became a claim.
  //
  // The schema accepts `question` and the output contract orders it, so the
  // analyst is invited to request a tier only this line can honour.
  if (requested === 'question') {
    return {
      severity: 'question',
      requested,
      reach: reach ?? null,
      reason: 'a question is a kind of finding, not a tier, whatever its reach',
    };
  }

  const resolvedReach = reach?.reach;
  const hasReach =
    resolvedReach === 'local' || resolvedReach === 'component' || resolvedReach === 'repository';

  // A missing category used to be defaulted to `correctness` before it reached
  // here, which silently promoted an unlabelled finding into a real tier and
  // recorded nothing about the substitution. Absent and unrecognised are the
  // same state as far as this can tell, and both take the middle tier.
  if (category === null || category === undefined || category === '') {
    if (!hasReach && requested === 'question') {
      return {
        severity: 'question',
        requested,
        reach: reach ?? null,
        reason: 'a question is a kind of finding, not a tier',
      };
    }
    return {
      severity: 'minor',
      requested,
      reach: reach ?? null,
      reason: 'no category was supplied, so the middle tier is used rather than a guess',
    };
  }

  const normalised = category.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias = ALIASES[normalised];
  const resolved = LEGACY_BY_CATEGORY[normalised] !== undefined ? normalised : (alias ?? normalised);

  const legacy = LEGACY_BY_CATEGORY[resolved];
  if (legacy === undefined) {
    return {
      severity: 'minor',
      requested,
      reach: reach ?? null,
      reason: `category ${category} has no mapping, so the middle tier is used rather than a guess`,
    };
  }

  // An unanswered search must behave exactly as the previous category-only
  // derivation. This covers no named symbol, no hits, and every git failure.
  if (!hasReach) {
    if (requested === 'question') {
      return {
        severity: 'question',
        requested,
        reach: reach ?? null,
        reason: 'a question is a kind of finding, not a tier',
      };
    }
    return {
      severity: legacy,
      requested,
      reach: reach ?? null,
      reason:
        resolved === normalised
          ? `${resolved} carries ${legacy}`
          : `${category} read as ${resolved}, which carries ${legacy}`,
    };
  }

  const tiers = BY_CATEGORY_AND_REACH[resolved];
  const severity = tiers?.[resolvedReach];
  if (severity === undefined) {
    // Keep the legacy fallback even if a future alias maps to a category whose
    // reach table was accidentally omitted.
    return {
      severity: legacy,
      requested,
      reach: reach ?? null,
      reason: `${resolved} has no reach mapping, so its legacy ${legacy} tier is used`,
    };
  }

  // The table has been consulted before preserving the interrogative. A
  // question is a tier only when deterministic evidence confines it locally;
  // a wider question earns the consequence of its category and reach.
  if (requested === 'question' && resolvedReach === 'local') {
    return {
      severity: 'question',
      requested,
      reach: reach ?? null,
      reason: 'a question at local reach remains question',
    };
  }

  return {
    severity,
    requested,
    reach: reach ?? null,
    reason:
      resolved === normalised
        ? `${resolved} at ${resolvedReach} reach carries ${severity}`
        : `${category} read as ${resolved}; ${resolvedReach} reach carries ${severity}`,
  };
}
