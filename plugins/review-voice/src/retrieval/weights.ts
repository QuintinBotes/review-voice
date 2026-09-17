export type ReviewerRole = 'owner' | 'team' | 'external' | 'bot';
export type OutcomeStatus = 'accepted' | 'dismissed' | 'rewritten' | 'unresolved' | 'unknown';

/**
 * Base evidence weights.
 *
 * Negative weights are stronger than their positive counterparts on purpose:
 * being told not to say something is a clearer instruction than being told a
 * comment was fine, and suppression should be easier to learn than propensity.
 */
export function baseWeight(role: ReviewerRole, outcome: OutcomeStatus): number {
  if (role === 'bot') return 0;

  if (role === 'owner') {
    switch (outcome) {
      case 'accepted':
        return 1.0;
      case 'rewritten':
        return 1.0;
      case 'dismissed':
        return -1.0;
      default:
        // An owner comment whose outcome is unknown is still owner judgement -
        // weaker than a confirmed one, far from worthless.
        return 0.45;
    }
  }

  if (role === 'team') {
    switch (outcome) {
      case 'accepted':
      case 'rewritten':
        return 0.55;
      case 'dismissed':
        return -0.4;
      default:
        return 0.25;
    }
  }

  return 0;
}

export const DEFAULT_HALF_LIFE_DAYS = 180;

/** Halves every `halfLifeDays`: last year's conventions should not outvote this month's. */
export function recencyWeight(
  createdAt: string,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  const ageMs = now.getTime() - new Date(createdAt).getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return 2 ** (-ageDays / halfLifeDays);
}

export interface SpecificityInput {
  hasFilePath: boolean;
  hasLine: boolean;
  hasDiffHunk: boolean;
}

/**
 * A comment pinned to an exact line with its diff hunk is evidence about
 * something specific. A general remark on a pull request might be about
 * anything, so it should not weigh the same.
 */
export function specificityWeight(input: SpecificityInput): number {
  let weight = 0.6;
  if (input.hasFilePath) weight += 0.15;
  if (input.hasLine) weight += 0.15;
  if (input.hasDiffHunk) weight += 0.1;
  return weight;
}

export interface ContextInput {
  sameRepository: boolean;
  samePath: boolean;
  sameLanguage: boolean;
}

/** How much this precedent is about the situation actually under review. */
export function contextWeight(input: ContextInput): number {
  let weight = 0.5;
  if (input.sameRepository) weight += 0.3;
  if (input.samePath) weight += 0.1;
  if (input.sameLanguage) weight += 0.1;
  return weight;
}

export function eventWeight(parts: {
  role: ReviewerRole;
  outcome: OutcomeStatus;
  createdAt: string;
  specificity: SpecificityInput;
  context: ContextInput;
  now?: Date;
  ownerMultiplier?: number;
}): number {
  const base = baseWeight(parts.role, parts.outcome);
  // The owner multiplier is applied to magnitude, so a dismissal is amplified
  // exactly as much as a keep. Amplifying only the positives would make the
  // reviewer progressively louder.
  const multiplied = parts.role === 'owner' ? base * (parts.ownerMultiplier ?? 3.0) : base;

  return (
    multiplied *
    recencyWeight(parts.createdAt, parts.now) *
    specificityWeight(parts.specificity) *
    contextWeight(parts.context)
  );
}
