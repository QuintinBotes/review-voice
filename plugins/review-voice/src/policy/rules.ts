import type { Suppression } from './schema.ts';

/**
 * The stable identity of a kind of finding (docs/adr/0032).
 *
 * `${category}:${lane}`, or `${category}:${lane}:${blocker_class}` when the
 * candidate claimed a blocker class. The lane defaults to `diff` because that
 * is what a candidate with no lane is. A category and a lane never contain a
 * colon, so the first two segments are always recoverable; the blocker class is
 * whatever follows.
 */
export type RuleId = string;

const DEFAULT_LANE = 'diff';

/** Null when there is no category: a finding nothing classified has no rule. */
export function ruleIdFor(
  category: string | null | undefined,
  lane: string | null | undefined,
  blockerClass?: string | null,
): RuleId | null {
  if (typeof category !== 'string' || category.trim().length === 0) return null;
  const laneName = typeof lane === 'string' && lane.length > 0 ? lane : DEFAULT_LANE;
  const base = `${category}:${laneName}`;
  return typeof blockerClass === 'string' && blockerClass.length > 0 ? `${base}:${blockerClass}` : base;
}

/**
 * Reads a policy's `suppressions:` list. An entry that is not a rule id with an
 * optional glob and reason is skipped with a warning, not guessed at: a
 * malformed entry silently becoming "suppress everything" is the failure to
 * avoid. A policy written before S06 has no list, which is no suppressions.
 */
export function readSuppressions(
  value: unknown,
  policyVersion: number | null,
): { suppressions: Suppression[]; warnings: string[] } {
  const suppressions: Suppression[] = [];
  const warnings: string[] = [];
  if (value === undefined || value === null) return { suppressions, warnings };
  if (!Array.isArray(value)) {
    warnings.push('suppressions must be a list; ignoring it.');
    return { suppressions, warnings };
  }
  for (const entry of value) {
    const record = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const ruleId = record?.['rule_id'];
    const glob = record?.['glob'];
    const reason = record?.['reason'];
    if (typeof ruleId !== 'string' || ruleId.trim().length === 0) {
      warnings.push('suppressions: skipped an entry with no rule_id.');
      continue;
    }
    if (glob !== undefined && glob !== null && (typeof glob !== 'string' || glob.length === 0)) {
      warnings.push(`suppressions: skipped ${ruleId}, whose glob is not text or null.`);
      continue;
    }
    suppressions.push({
      ruleId: ruleId.trim(),
      glob: typeof glob === 'string' ? glob : null,
      reason: typeof reason === 'string' ? reason : null,
      policyVersion,
    });
  }
  return { suppressions, warnings };
}

/** The category a rule id is about: everything before the first colon. */
export function categoryOfRuleId(ruleId: RuleId): string {
  const at = ruleId.indexOf(':');
  return at === -1 ? ruleId : ruleId.slice(0, at);
}

/**
 * The rule id a stored proposal rule is about. A proposal written before rule
 * ids existed (or built by hand) has a category and no id, so its id is the
 * category on the `diff` lane; one with neither has no id, and so suppresses
 * nothing rather than something it cannot name.
 */
export function ruleIdOfRule(rule: { ruleId?: string | undefined; category?: string | undefined }): RuleId | null {
  if (typeof rule.ruleId === 'string' && rule.ruleId.trim().length > 0) return rule.ruleId.trim();
  return ruleIdFor(rule.category, DEFAULT_LANE);
}
