import type { Database } from '../store/db.ts';
import { categoryOfRuleId, ruleIdFor } from './rules.ts';

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
  scope: { type: 'global' | 'repository' | 'path'; key: string };
  /**
   * The path glob a suppress rule is narrowed to, or null for everywhere. It is
   * the scope key of a path rule, and absent on a rule stored before S07, which
   * reads as everywhere.
   */
  glob?: string | null;
  kind: 'suppress' | 'prioritise';
  /** The finding category the rule is about, taken from `ruleId`. */
  category: string;
  /** What the rule is about: `category:lane[:blocker_class]` (docs/adr/0032). */
  ruleId: string;
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
  actor: string;
  finding_id: string;
  review_run_id: string;
  reason: string | null;
  created_at: string;
  output_json: string;
}

interface Labelled {
  row: FeedbackRow;
  category: string | null;
  /** The finding's stored rule id, or the one derived from its category and lane. */
  ruleId: string | null;
  severity: string | null;
  path: string;
}

/**
 * Feedback on findings whose category was never recorded cannot be grouped.
 * A finding recorded before rule ids existed has none stored, so its rule is
 * derived from its category and lane; that is what the id would have been.
 */
function label(row: FeedbackRow): Labelled | null {
  try {
    const parsed = JSON.parse(row.output_json) as {
      findings: { findingId: string; path: string; category?: string; severity?: string; lane?: string; ruleId?: string }[];
    };
    const finding = parsed.findings.find((f) => f.findingId === row.finding_id);
    if (finding === undefined) return null;
    const category = typeof finding.category === 'string' && finding.category.length > 0 ? finding.category : null;
    return {
      row,
      category,
      ruleId:
        category === null
          ? null
          : typeof finding.ruleId === 'string' && finding.ruleId.length > 0
            ? finding.ruleId
            : ruleIdFor(category, finding.lane),
      severity: finding.severity ?? null,
      path: finding.path,
    };
  } catch {
    return null;
  }
}

/** A rule id contains colons and a kind never does, so a tab keeps the two apart. */
const KEY_SEPARATOR = '\t';

export const GLOBAL_SCOPE = { type: 'global', key: 'owner' } as const;

/**
 * The longest directory every path sits under, as segments; empty when they
 * share only the repository root. Whole segments, so `src/bill` and
 * `src/billing` meet at `src`, not at a half-named directory. A segment holding
 * a glob character ends the prefix: it would widen the glob it is written into.
 */
function commonDirectory(paths: string[]): string[] {
  let common: string[] | null = null;
  for (const path of paths) {
    const segments = path.split('\\').join('/').split('/').filter((part) => part.length > 0 && part !== '.');
    const directories: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      if (/[*?]/.test(segment) || segment === '..') break;
      directories.push(segment);
    }
    if (common === null) {
      common = directories;
    } else {
      let shared = 0;
      while (shared < common.length && shared < directories.length && common[shared] === directories[shared]) shared += 1;
      common = common.slice(0, shared);
    }
  }
  return common ?? [];
}

/**
 * Compiles feedback into proposed policy rules.
 *
 * Two sources count. The owner's explicit feedback, and strong thread
 * dismissals (docs/adr/0029): an author or the owner turned a posted finding
 * down on the pull request. Weak outcomes and silence never count, because a
 * rule that changes what the reviewer says in every future review should rest
 * on someone having said so. A thread dismissal is an owner signal only when
 * the owner's own login decided it; a teammate's dismissal is evidence but can
 * never activate a rule alone (docs/adr/0006).
 *
 * Rules stay keyed by rule id. A suppress rule's path scope, the longest
 * common directory of its dismissals, only narrows where an approved rule
 * applies; it is never part of what the rule is about.
 */
export function compileProposals(db: Database, options: { ownerReviewer?: string | null | undefined } = {}): ProposedRule[] {
  const feedbackRows = db
    .prepare(
      `SELECT f.action, f.actor, f.finding_id, f.review_run_id, f.reason, f.created_at, r.output_json
       FROM feedback f
       JOIN review_runs r ON r.review_run_id = f.review_run_id
       ORDER BY f.created_at DESC`,
    )
    .all() as unknown as FeedbackRow[];

  // An outcome a dismiss or never_flag feedback row covers is dropped, so one
  // dismissal counts once however it was recorded.
  const owner = options.ownerReviewer?.toLowerCase() ?? null;
  const threadRows = (
    db
      .prepare(
        `SELECT o.review_run_id, o.finding_id, o.decided_by, o.checked_at, r.output_json
         FROM finding_outcomes o
         JOIN review_runs r ON r.review_run_id = o.review_run_id
         WHERE o.outcome = 'dismissed' AND o.strength = 'strong'
           AND NOT EXISTS (
             SELECT 1 FROM feedback f
             WHERE f.review_run_id = o.review_run_id AND f.finding_id = o.finding_id
               AND f.action IN ('dismiss', 'never_flag')
           )`,
      )
      .all() as unknown as { review_run_id: string; finding_id: string; decided_by: string | null; checked_at: string; output_json: string }[]
  ).map(
    (row): FeedbackRow => ({
      action: 'dismiss',
      actor: owner !== null && row.decided_by?.toLowerCase() === owner ? 'owner' : 'team',
      finding_id: row.finding_id,
      review_run_id: row.review_run_id,
      reason: null,
      created_at: row.checked_at,
      output_json: row.output_json,
    }),
  );
  const rows = [...feedbackRows, ...threadRows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  // Grouped by rule id (category, lane, blocker class), not by file path.
  // "Suppress naming comments" is a rule; "suppress things like the ones in
  // src/a.ts" is an observation about one directory that happens to be where
  // you were working that week. Two lanes' findings of one category are two
  // rules, because a dismissal of one says nothing about the other. Rules stay
  // keyed by rule id; an approved rule's path scope only narrows where it
  // applies (docs/adr/0029), it never makes the directory the thing being ruled on.
  const buckets = new Map<string, Labelled[]>();

  for (const row of rows) {
    const labelled = label(row);
    if (labelled === null) continue;

    // Feedback recorded before categories were captured has nothing to group
    // on. It still counts toward precision; it just cannot become a rule.
    if (labelled.category === null || labelled.ruleId === null) continue;

    const kind = row.action === 'never_flag' || row.action === 'dismiss' ? 'suppress' : 'prioritise';
    const key = `${kind}${KEY_SEPARATOR}${labelled.ruleId}`;
    buckets.set(key, [...(buckets.get(key) ?? []), labelled]);
  }

  const proposals: ProposedRule[] = [];

  for (const [key, group] of buckets) {
    const [kind, ruleId] = key.split(KEY_SEPARATOR) as ['suppress' | 'prioritise', string];
    const category = categoryOfRuleId(ruleId);

    const keeps = group.filter((g) => g.row.action === 'keep').length;
    const dismissals = group.filter((g) => g.row.action === 'dismiss' || g.row.action === 'never_flag').length;
    const rewrites = group.filter((g) => g.row.action === 'rewrite').length;

    // A contradicting signal is the owner having gone the other way on the
    // same rule - the one case where a rule should not form quietly.
    const opposite = `${kind === 'suppress' ? 'prioritise' : 'suppress'}${KEY_SEPARATOR}${ruleId}`;
    const contradictingSignals = (buckets.get(opposite) ?? []).length;

    const evidence: RuleEvidence = {
      keeps,
      dismissals,
      rewrites,
      // Only the owner's own feedback is an activation signal; a pooled
      // reviewer's comment informs voice and precedent, never a rule (docs/adr/0030).
      ownerSignals: group.filter((g) => g.row.actor === 'owner').length,
      contradictingSignals,
      mostRecentAt: group[0]?.row.created_at ?? null,
      eventIds: group.map((g) => `${g.row.review_run_id}:${g.row.finding_id}`),
    };

    const gate = canActivate(evidence);
    const reasons = group.map((g) => g.row.reason).filter((r): r is string => r !== null && r.length > 0);
    const severities = [...new Set(group.map((g) => g.severity).filter((s): s is string => s !== null))];

    // Only a suppression can be narrowed: a prioritise rule has no dismissals
    // and its `priorities` entry carries no glob, so it stays global. A bucket
    // whose dismissals share only the root is global too.
    const directory = kind === 'suppress' ? commonDirectory(group.map((g) => g.path)) : [];
    const glob = directory.length === 0 ? null : `${directory.join('/')}/**`;

    proposals.push({
      scope: glob === null ? { ...GLOBAL_SCOPE } : { type: 'path', key: glob },
      glob,
      kind,
      category,
      ruleId,
      rule:
        kind === 'suppress'
          ? `Suppress ${category} findings${glob === null ? '' : ` under ${glob}`}${severities.length === 1 ? ` at ${severities[0]} severity` : ''} unless they name a concrete failure mode${reasons.length > 0 ? ` (stated reason: ${reasons[0]})` : ''}.`
          : `Treat ${category} as high priority; findings in this category are consistently kept.`,
      evidence,
      confidence: confidenceFrom(evidence),
      activatable: gate.ok,
      blockedBecause: gate.reason,
    });
  }

  return proposals;
}
