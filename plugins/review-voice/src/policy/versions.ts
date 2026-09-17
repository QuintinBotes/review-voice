import { randomUUID } from 'node:crypto';
import type { Database } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import type { ProposedRule } from './compile.ts';

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
  return `${lines.join('\n')}\n`;
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
  const row = db.prepare('SELECT policy_id, scope_key, version, provenance_json FROM policies WHERE policy_id = ?').get(policyId) as
    | { policy_id: string; scope_key: string; version: number; provenance_json: string }
    | undefined;
  if (row === undefined) return { ok: false, error: `No policy ${policyId}.` };

  const rules = JSON.parse(row.provenance_json) as ProposedRule[];
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
