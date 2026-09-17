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

/**
 * How far derivation may move a finding from what the analyst asked for.
 *
 * Derivation exists because asking produced a different tier each time: the
 * same finding was `minor` at 0.90 and `important` at 0.85 on a byte-identical
 * diff. That is still true, and the category is still the stable input.
 *
 * But the category is a string, and the analyst has read the code. When reach
 * was rarely established the table deferred often and the two mostly agreed.
 * Now that reach resolves on 17 of 20 candidates and nearly always to
 * `repository`, the reach-varying categories have collapsed to their repository
 * column and the table overrode the analyst on 9 of 20 - six of them upward. A
 * finding the analyst called `minor`, having read the code, shipped as
 * `blocking` at confidence 0.70 on the strength of its category label alone.
 *
 * One tier is the compromise. Derivation still normalises and still bounds the
 * flapping, because a tier can move by one either way and no further; the
 * analyst's reading still constrains the outcome. `question` is exempt because
 * it is not a tier at all, and an unrecognised request cannot bound anything.
 *
 * It applies only to categories whose tier varies by reach. `security` and its
 * neighbours are `blocking` at every reach because they are severe by nature,
 * not because a search said so, and that was always the design - the complaint
 * is specifically that reach-varying categories have collapsed to their
 * repository column, so that is what is bounded.
 */
const MAX_TIER_MOVEMENT = 1;

function boundToRequest(
  derived: Severity,
  requested: string,
  reach: ReachCheck | null,
  reason: string,
): DerivedSeverity {
  const asked = SEVERITIES.indexOf(requested as Severity);
  const got = SEVERITIES.indexOf(derived);
  if (asked === -1 || got === -1) {
    return { severity: derived, requested, reach, reason };
  }

  const distance = got - asked;
  if (Math.abs(distance) <= MAX_TIER_MOVEMENT) {
    return { severity: derived, requested, reach, reason };
  }

  const bounded = SEVERITIES[asked + Math.sign(distance) * MAX_TIER_MOVEMENT]!;
  return {
    severity: bounded,
    requested,
    reach,
    reason:
      `${reason}, bounded to ${bounded} because the analyst asked for ${requested} ` +
      'and derivation may move a tier by one',
  };
}

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

  const varies = new Set(Object.values(tiers ?? {})).size > 1;
  const describe =
    resolved === normalised
      ? `${resolved} at ${resolvedReach} reach carries ${severity}`
      : `${category} read as ${resolved}; ${resolvedReach} reach carries ${severity}`;

  // A category with one tier at every reach is severe by nature rather than by
  // search, so the analyst's request does not bound it.
  if (!varies) {
    return { severity, requested, reach: reach ?? null, reason: describe };
  }

  // Bounded to the analyst's request. The legacy no-reach path above is left
  // alone: it has been stable for several releases and the evidence for
  // bounding is entirely about reach-derived escalation.
  return boundToRequest(
    severity,
    requested,
    reach ?? null,
    describe,
  );
}
