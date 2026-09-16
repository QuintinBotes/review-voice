import type { Database } from '../store/db.ts';

export interface RuleEvidence {
  keeps: number;
  dismissals: number;
  rewrites: number;
  ownerSignals: number;
  contradictingSignals: number;
  mostRecentAt: string | null;
  eventIds: string[];
}

export interface ProposedRule {
  scope: { type: 'global' | 'repository'; key: string };
  kind: 'suppress' | 'prioritise';
  rule: string;
  evidence: RuleEvidence;
  confidence: number;
  /** False when the rule needs more corroboration before it can activate. */
  activatable: boolean;
  blockedBecause: string | null;
}

/**
 * The activation bar from the specification: three corroborating positive
 * signals, at least one from the owner, and nothing from the owner
 * contradicting it.
 *
 * Weak signals cannot clear this on their own. A merge with no visible fix, a
 * thread resolved in silence, or no reply at all are all consistent with the
 * comment having been right, wrong, or unread — and a rule built on them would
 * be a guess wearing a confidence score.
 */
const MIN_CORROBORATING = 3;

export function canActivate(evidence: RuleEvidence): { ok: boolean; reason: string | null } {
  const supporting = evidence.dismissals + evidence.keeps + evidence.rewrites;
  if (supporting < MIN_CORROBORATING) {
    return { ok: false, reason: `only ${supporting} corroborating signals; ${MIN_CORROBORATING} are needed` };
  }
  if (evidence.ownerSignals < 1) {
    return { ok: false, reason: 'no owner signal' };
  }
  if (evidence.contradictingSignals > 0) {
    return { ok: false, reason: `${evidence.contradictingSignals} contradicting owner signal(s)` };
  }
  return { ok: true, reason: null };
}

function confidenceFrom(evidence: RuleEvidence): number {
  const supporting = evidence.dismissals + evidence.keeps + evidence.rewrites;
  if (supporting === 0) return 0;
  const corroboration = Math.min(1, supporting / 6);
  const ownerShare = Math.min(1, evidence.ownerSignals / Math.max(1, supporting));
  const contradiction = evidence.contradictingSignals / (supporting + evidence.contradictingSignals);
  return Math.max(0, corroboration * 0.5 + ownerShare * 0.5 - contradiction);
}

interface FeedbackRow {
  action: string;
  finding_id: string;
  review_run_id: string;
  reason: string | null;
  created_at: string;
  output_json: string;
}

/**
 * Compiles explicit feedback into proposed policy rules.
 *
 * Only explicit feedback is used. Inferred outcomes are evidence for
 * retrieval, but a rule that changes what the reviewer says in every future
 * review should rest on something the owner actually said.
 */
export function compileProposals(db: Database): ProposedRule[] {
  const rows = db
    .prepare(
      `SELECT f.action, f.finding_id, f.review_run_id, f.reason, f.created_at, r.output_json
       FROM feedback f
       JOIN review_runs r ON r.review_run_id = f.review_run_id
       ORDER BY f.created_at DESC`,
    )
    .all() as unknown as FeedbackRow[];

  // Group by the file the finding was about, which is the coarsest grouping
  // that still says something actionable.
  const byCategory = new Map<string, { rows: FeedbackRow[]; paths: Set<string> }>();

  for (const row of rows) {
    let path = 'unknown';
    try {
      const parsed = JSON.parse(row.output_json) as { findings: { findingId: string; path: string }[] };
      path = parsed.findings.find((finding) => finding.findingId === row.finding_id)?.path ?? 'unknown';
    } catch {
      continue;
    }

    const key = row.action === 'never_flag' || row.action === 'dismiss' ? 'suppress' : 'prioritise';
    const bucket = byCategory.get(key) ?? { rows: [], paths: new Set<string>() };
    bucket.rows.push(row);
    bucket.paths.add(path);
    byCategory.set(key, bucket);
  }

  const proposals: ProposedRule[] = [];

  for (const [kind, bucket] of byCategory) {
    const keeps = bucket.rows.filter((r) => r.action === 'keep').length;
    const dismissals = bucket.rows.filter((r) => r.action === 'dismiss' || r.action === 'never_flag').length;
    const rewrites = bucket.rows.filter((r) => r.action === 'rewrite').length;

    const evidence: RuleEvidence = {
      keeps,
      dismissals,
      rewrites,
      // Every recorded feedback action is the owner's; that is who gives it.
      ownerSignals: bucket.rows.length,
      contradictingSignals: kind === 'suppress' ? keeps : dismissals,
      mostRecentAt: bucket.rows[0]?.created_at ?? null,
      eventIds: bucket.rows.map((r) => `${r.review_run_id}:${r.finding_id}`),
    };

    const gate = canActivate(evidence);
    const reasons = bucket.rows.map((r) => r.reason).filter((r): r is string => r !== null && r.length > 0);

    proposals.push({
      scope: { type: 'global', key: 'owner' },
      kind: kind as 'suppress' | 'prioritise',
      rule:
        kind === 'suppress'
          ? `Suppress findings like those dismissed in ${[...bucket.paths].slice(0, 3).join(', ')}${reasons.length > 0 ? ` (stated reason: ${reasons[0]})` : ''}.`
          : `Prioritise findings like those kept in ${[...bucket.paths].slice(0, 3).join(', ')}.`,
      evidence,
      confidence: confidenceFrom(evidence),
      activatable: gate.ok,
      blockedBecause: gate.reason,
    });
  }

  return proposals;
}
