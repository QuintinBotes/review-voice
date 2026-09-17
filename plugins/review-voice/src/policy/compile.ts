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
  /** The finding category the rule is about. */
  category: string;
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
 * comment having been right, wrong, or unread - and a rule built on them would
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

interface Labelled {
  row: FeedbackRow;
  category: string | null;
  severity: string | null;
  path: string;
}

/** Feedback on findings whose category was never recorded cannot be grouped. */
function label(row: FeedbackRow): Labelled | null {
  try {
    const parsed = JSON.parse(row.output_json) as {
      findings: { findingId: string; path: string; category?: string; severity?: string }[];
    };
    const finding = parsed.findings.find((f) => f.findingId === row.finding_id);
    if (finding === undefined) return null;
    return {
      row,
      category: finding.category ?? null,
      severity: finding.severity ?? null,
      path: finding.path,
    };
  } catch {
    return null;
  }
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

  // Grouped by finding category, not by file path. "Suppress naming comments"
  // is a rule; "suppress things like the ones in src/a.ts" is an observation
  // about one directory that happens to be where you were working that week.
  const buckets = new Map<string, Labelled[]>();

  for (const row of rows) {
    const labelled = label(row);
    if (labelled === null) continue;

    // Feedback recorded before categories were captured has nothing to group
    // on. It still counts toward precision; it just cannot become a rule.
    if (labelled.category === null) continue;

    const kind = row.action === 'never_flag' || row.action === 'dismiss' ? 'suppress' : 'prioritise';
    const key = `${kind}:${labelled.category}`;
    buckets.set(key, [...(buckets.get(key) ?? []), labelled]);
  }

  const proposals: ProposedRule[] = [];

  for (const [key, group] of buckets) {
    const [kind, category] = key.split(':') as ['suppress' | 'prioritise', string];

    const keeps = group.filter((g) => g.row.action === 'keep').length;
    const dismissals = group.filter((g) => g.row.action === 'dismiss' || g.row.action === 'never_flag').length;
    const rewrites = group.filter((g) => g.row.action === 'rewrite').length;

    // A contradicting signal is the owner having gone the other way on the
    // same category - the one case where a rule should not form quietly.
    const opposite = kind === 'suppress' ? `prioritise:${category}` : `suppress:${category}`;
    const contradictingSignals = (buckets.get(opposite) ?? []).length;

    const evidence: RuleEvidence = {
      keeps,
      dismissals,
      rewrites,
      // Every recorded feedback action is the owner's; that is who gives it.
      ownerSignals: group.length,
      contradictingSignals,
      mostRecentAt: group[0]?.row.created_at ?? null,
      eventIds: group.map((g) => `${g.row.review_run_id}:${g.row.finding_id}`),
    };

    const gate = canActivate(evidence);
    const reasons = group.map((g) => g.row.reason).filter((r): r is string => r !== null && r.length > 0);
    const severities = [...new Set(group.map((g) => g.severity).filter((s): s is string => s !== null))];

    proposals.push({
      scope: { type: 'global', key: 'owner' },
      kind,
      category,
      rule:
        kind === 'suppress'
          ? `Suppress ${category} findings${severities.length === 1 ? ` at ${severities[0]} severity` : ''} unless they name a concrete failure mode${reasons.length > 0 ? ` (stated reason: ${reasons[0]})` : ''}.`
          : `Treat ${category} as high priority; findings in this category are consistently kept.`,
      evidence,
      confidence: confidenceFrom(evidence),
      activatable: gate.ok,
      blockedBecause: gate.reason,
    });
  }

  return proposals;
}
