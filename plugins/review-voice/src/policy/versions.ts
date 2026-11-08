import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Database } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import type { PolicyVersionRef } from '../store/runs.ts';
import { isSuppressionExempt, SUPPRESSION_EXEMPT_CATEGORIES } from '../scoring/score.ts';
import type { ProposedRule } from './compile.ts';
import { categoryOfRuleId, readSuppressions, ruleIdOfRule } from './rules.ts';

export interface PolicyVersion {
  policyId: string;
  scopeType: string;
  scopeKey: string;
  version: number;
  contentYaml: string;
  active: boolean;
  generatedAt: string;
  approvedAt: string | null;
  provenance: ProposedRule[];
}

function nextVersion(db: Database, scopeType: string, scopeKey: string): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM policies WHERE scope_type = ? AND scope_key = ?')
    .get(scopeType, scopeKey) as { v: number | null };
  return (row.v ?? 0) + 1;
}

/** Why a suppression exists, in the owner's terms, for the artifact and `context`. */
function suppressionReason(rule: ProposedRule): string {
  const { dismissals, keeps, rewrites, mostRecentAt } = rule.evidence;
  const signals = dismissals + keeps + rewrites;
  const when = mostRecentAt === null ? Number.NaN : Date.parse(mostRecentAt);
  const month = Number.isNaN(when)
    ? ''
    : ` in ${new Date(when).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`;
  return `owner dismissed ${dismissals} of ${signals}${month}`;
}

function toYaml(rules: ProposedRule[], version: number, scopeKey: string): string {
  const lines = [
    `policy_version: ${version}`,
    'scope:',
    '  type: global',
    `  key: ${scopeKey}`,
    '',
    'suppressed_patterns:',
  ];
  const suppress = rules.filter((rule) => rule.kind === 'suppress');
  if (suppress.length === 0) lines.push('  []');
  for (const rule of suppress) lines.push(`  - ${JSON.stringify(rule.rule)}`);
  // The structured form of the same rules, keyed by rule id so `score` can
  // apply them. The prose above stays for readers (docs/adr/0032). A rule that
  // names nothing has no id to key on, so it gets prose only.
  const keyed = suppress.flatMap((rule) => {
    const ruleId = ruleIdOfRule(rule);
    return ruleId === null ? [] : [{ rule, ruleId }];
  });
  lines.push('', 'suppressions:');
  if (keyed.length === 0) lines.push('  []');
  for (const { rule, ruleId } of keyed) {
    lines.push(
      `  - rule_id: ${JSON.stringify(ruleId)}`,
      // S07 fills path globs; null means everywhere.
      '    glob: null',
      `    reason: ${JSON.stringify(suppressionReason(rule))}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Every rule id a stored proposal would suppress: the structured list in its
 * content and the suppress rules in its provenance, so a row edited in one
 * place cannot hide what the other says.
 */
function suppressedRuleIds(contentYaml: string, rules: ProposedRule[]): string[] {
  const ids = new Set<string>();
  for (const rule of rules) {
    const ruleId = rule.kind === 'suppress' ? ruleIdOfRule(rule) : null;
    if (ruleId !== null) ids.add(ruleId);
  }
  try {
    const doc = parseYaml(contentYaml) as { suppressions?: unknown } | null;
    for (const suppression of readSuppressions(doc?.suppressions, null).suppressions) ids.add(suppression.ruleId);
  } catch {
    // Content that does not parse suppresses nothing when loaded either.
  }
  return [...ids];
}

/**
 * The raw active rows of the owner's global scope, the only scope `proposePolicy`
 * writes and so the only one `loadConfig` layers (S07 widens it). Loading and
 * recording both read through here, so what a run says it was held to is what
 * `score` loaded.
 */
export function activePolicyRows(db: Database): { policyId: string; scopeType: string; scopeKey: string; version: number; contentYaml: string }[] {
  return (
    db
      .prepare(
        `SELECT policy_id, scope_type, scope_key, version, content_yaml FROM policies
         WHERE scope_type = 'global' AND scope_key = 'owner' AND active = 1 ORDER BY version DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map((row) => ({
    policyId: row['policy_id'] as string,
    scopeType: row['scope_type'] as string,
    scopeKey: row['scope_key'] as string,
    version: row['version'] as number,
    contentYaml: row['content_yaml'] as string,
  }));
}

/** The active approved policy versions, as a run records them (`active_policy_versions_json`). */
export function activePolicyVersions(db: Database): PolicyVersionRef[] {
  return activePolicyRows(db).map(({ scopeType, scopeKey, policyId, version }) => ({ scopeType, scopeKey, policyId, version }));
}

/**
 * Stores a proposal. It is never active on arrival - a global policy change
 * always requires owner approval, so generation and activation are separate
 * operations by construction rather than by discipline.
 */
export function proposePolicy(db: Database, rules: ProposedRule[], scopeKey = 'owner'): PolicyVersion {
  const version = nextVersion(db, 'global', scopeKey);
  const policyId = randomUUID();
  const contentYaml = toYaml(rules, version, scopeKey);
  const generatedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO policies (policy_id, scope_type, scope_key, version, content_yaml,
                           active, generated_at, approved_at, provenance_json, evaluation_json)
     VALUES (?, 'global', ?, ?, ?, 0, ?, NULL, ?, ?)`,
  ).run(policyId, scopeKey, version, contentYaml, generatedAt, JSON.stringify(rules), JSON.stringify({}));

  recordAudit(db, 'policy_proposed', { type: 'policy', id: policyId }, { version, ruleCount: rules.length });

  return {
    policyId,
    scopeType: 'global',
    scopeKey,
    version,
    contentYaml,
    active: false,
    generatedAt,
    approvedAt: null,
    provenance: rules,
  };
}

export type ApprovalOutcome =
  | { ok: true; policyId: string; version: number }
  | { ok: false; error: string };

export function approvePolicy(db: Database, policyId: string): ApprovalOutcome {
  const row = db
    .prepare('SELECT policy_id, scope_key, version, provenance_json, content_yaml FROM policies WHERE policy_id = ?')
    .get(policyId) as
    | { policy_id: string; scope_key: string; version: number; provenance_json: string; content_yaml: string }
    | undefined;
  if (row === undefined) return { ok: false, error: `No policy ${policyId}.` };

  const rules = JSON.parse(row.provenance_json) as ProposedRule[];

  // ADR 0006 warned that a suppression is one line away from "never mention
  // authentication". The categories that name a breach or a trust boundary can
  // never be suppressed, so a proposal that tries is refused here, ahead of the
  // evidence bar so the reason does not depend on how much feedback there is,
  // and `score` ignores one that got in another way (docs/adr/0032).
  const exempt = suppressedRuleIds(row.content_yaml, rules).filter((ruleId) => isSuppressionExempt(categoryOfRuleId(ruleId)));
  if (exempt.length > 0) {
    return {
      ok: false,
      error:
        `a suppression may not reach ${[...SUPPRESSION_EXEMPT_CATEGORIES].join(', ')}, and this proposal suppresses ` +
        `${exempt.join(', ')}. Nothing was approved.`,
    };
  }

  const blocked = rules.filter((rule) => !rule.activatable);
  if (blocked.length > 0) {
    // Approving a rule that has not met the evidence bar would make the bar
    // decorative.
    return {
      ok: false,
      error: `${blocked.length} rule(s) have not met the evidence bar: ${blocked.map((r) => r.blockedBecause).join('; ')}`,
    };
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE policies SET active = 0 WHERE scope_type = ? AND scope_key = ?').run('global', row.scope_key);
    db.prepare('UPDATE policies SET active = 1, approved_at = ? WHERE policy_id = ?').run(
      new Date().toISOString(),
      policyId,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  recordAudit(db, 'policy_approved', { type: 'policy', id: policyId }, { version: row.version });
  return { ok: true, policyId, version: row.version };
}

export function rollbackTo(db: Database, version: number, scopeKey = 'owner'): ApprovalOutcome {
  const row = db
    .prepare('SELECT policy_id FROM policies WHERE scope_type = ? AND scope_key = ? AND version = ? AND approved_at IS NOT NULL')
    .get('global', scopeKey, version) as { policy_id: string } | undefined;

  if (row === undefined) {
    // Rolling back to a version that was never approved would activate
    // something nobody ever agreed to.
    return { ok: false, error: `No approved policy at version ${version}.` };
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE policies SET active = 0 WHERE scope_type = ? AND scope_key = ?').run('global', scopeKey);
    db.prepare('UPDATE policies SET active = 1 WHERE policy_id = ?').run(row.policy_id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  recordAudit(db, 'policy_rolled_back', { type: 'policy', id: row.policy_id }, { version });
  return { ok: true, policyId: row.policy_id, version };
}

export function listPolicies(db: Database, scopeKey = 'owner'): PolicyVersion[] {
  return (
    db
      .prepare('SELECT * FROM policies WHERE scope_type = ? AND scope_key = ? ORDER BY version DESC')
      .all('global', scopeKey) as Record<string, unknown>[]
  ).map((row) => ({
    policyId: row['policy_id'] as string,
    scopeType: row['scope_type'] as string,
    scopeKey: row['scope_key'] as string,
    version: row['version'] as number,
    contentYaml: row['content_yaml'] as string,
    active: (row['active'] as number) === 1,
    generatedAt: row['generated_at'] as string,
    approvedAt: row['approved_at'] as string | null,
    provenance: JSON.parse(row['provenance_json'] as string) as ProposedRule[],
  }));
}
