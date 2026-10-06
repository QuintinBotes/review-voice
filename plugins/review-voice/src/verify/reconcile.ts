import { ESCALATION_CONFIDENCE, verifierConfidence } from '../scoring/confidence.ts';
import type { FindingVerdict } from './types.ts';

/**
 * Settles a disagreement between the evidence-verifier and the second pass.
 *
 * The two passes are independent on purpose, and they do disagree about
 * impact. Applying the second pass by hand meant the lower claim always won,
 * so a defect the evidence-verifier had traced to a real consumer was posted
 * weakened or not at all, even when the trace was right. Letting the stronger
 * claim always win would undo the point of a second model. A tie-break, run
 * only on the disputed point and only when the passes disagree, decides it on
 * the code. See docs/adr/0014-verifier-tie-break.md.
 */

/**
 * The evidence-verifier confidence a traced impact needs to be worth defending:
 * the bar at which scoring would escalate on it.
 */
export const DISPUTE_CONFIDENCE = ESCALATION_CONFIDENCE;

export type RawCandidate = Record<string, unknown>;

export interface TieBreak {
  candidateId: string;
  upheld: boolean;
  reason: string;
}

export interface Dispute {
  candidateId: string;
  path: unknown;
  line: unknown;
  severity: unknown;
  claim: unknown;
  failureMode: unknown;
  evidence: unknown;
  /** The evidence-verifier's entry as it wrote it, impact claim included. */
  verification: Record<string, unknown>;
  secondPass: {
    verdict: string;
    confidence: number;
    reason: string;
    outcome: FindingVerdict['outcome'];
    originalSeverity: string;
    finalSeverity: string;
    verifier: string;
  };
}

export interface Applied {
  candidateId: string;
  result: 'upheld' | 'not upheld' | 'no tie-break supplied';
  /** The severity the candidate goes to scoring with, or null when it was dropped. */
  severity: string | null;
  reason: string | null;
}

export interface ReconcileResult {
  candidates: RawCandidate[];
  disputes: Dispute[];
  applied: Applied[];
  /** Things the caller should see on stderr; none of them changes the output. */
  notes: string[];
}

export class ReconcileInputError extends Error {}

export function candidateIdOf(raw: Record<string, unknown>): string | null {
  const id = raw['candidate_id'] ?? raw['candidateId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

const OUTCOMES: readonly FindingVerdict['outcome'][] = ['kept', 'downgraded', 'dropped', 'unverified'];

/**
 * The second pass's verdicts, checked before any is applied.
 *
 * A verdict that cannot be read is refused rather than skipped: a skipped drop
 * would quietly post a finding the second pass removed, and a skipped
 * downgrade would post it a tier too high.
 */
export function parseSecondPass(parsed: unknown): FindingVerdict[] {
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as { verdicts?: unknown }).verdicts
      : undefined;
  if (!Array.isArray(list)) throw new ReconcileInputError('expected the verify report, {"verdicts": [...]}, or an array');
  list.forEach((entry: unknown, index) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const who = `verdict ${index}`;
    if (!OUTCOMES.includes(e['outcome'] as FindingVerdict['outcome'])) {
      throw new ReconcileInputError(`${who}: outcome must be one of ${OUTCOMES.join(', ')}`);
    }
    if (e['outcome'] === 'downgraded' && (typeof e['finalSeverity'] !== 'string' || e['finalSeverity'] === '')) {
      throw new ReconcileInputError(`${who}: a downgraded verdict needs finalSeverity`);
    }
    const hasId = typeof e['candidateId'] === 'string' && e['candidateId'] !== '';
    if (!hasId && !(typeof e['path'] === 'string' && Number.isInteger(e['line']))) {
      throw new ReconcileInputError(`${who}: needs candidateId, or path and line`);
    }
  });
  return list as FindingVerdict[];
}

/**
 * The tie-breaker's results, checked strictly.
 *
 * An `upheld` that is not a real boolean is refused: `"false"` is truthy, and
 * reading it as a ruling would post the stronger claim on no ruling at all.
 */
export function parseTieBreaks(parsed: unknown): TieBreak[] {
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? ((parsed as { tie_breaks?: unknown; tieBreaks?: unknown }).tie_breaks ??
        (parsed as { tieBreaks?: unknown }).tieBreaks)
      : undefined;
  if (!Array.isArray(list)) throw new ReconcileInputError('expected an array or {"tie_breaks": [...]}');
  const seen = new Set<string>();
  return list.map((entry: unknown, index) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const id = candidateIdOf(e);
    const who = `entry ${index} (${id ?? 'no candidate id'})`;
    if (id === null) throw new ReconcileInputError(`${who}: candidate_id must be a non-empty string`);
    if (typeof e['upheld'] !== 'boolean') throw new ReconcileInputError(`${who}: upheld must be true or false`);
    if (typeof e['reason'] !== 'string' || e['reason'].trim() === '') {
      throw new ReconcileInputError(`${who}: reason must be a non-empty string`);
    }
    // Two rulings on one point leave the decision to whichever is read last.
    if (seen.has(id)) throw new ReconcileInputError(`${who}: a second tie-break for the same candidate`);
    seen.add(id);
    return { candidateId: id, upheld: e['upheld'], reason: e['reason'] };
  });
}

/** True when the evidence-verifier traced the impact and was sure enough to defend it. */
function tracedConfidently(verification: Record<string, unknown> | undefined): boolean {
  if (verification === undefined) return false;
  const traced = verification['impact_traced'] ?? verification['impactTraced'];
  // Read exactly as scoring reads it, quality-tier fallback included, so a
  // trace scoring would escalate on is always one a second pass can dispute.
  const confidence = verifierConfidence(
    verification['technical_confidence'] ?? verification['technicalConfidence'],
    verification['evidence_quality'] ?? verification['evidenceQuality'],
  );
  return traced === true && confidence !== null && confidence >= DISPUTE_CONFIDENCE;
}

export function reconcile(
  candidates: RawCandidate[],
  verifications: Record<string, unknown>[],
  secondPass: FindingVerdict[],
  tieBreaks: TieBreak[] | null,
): ReconcileResult {
  const notes: string[] = [];

  const ids = candidates.map((candidate, index) => {
    const id = candidateIdOf(candidate);
    if (id === null) throw new ReconcileInputError(`candidate ${index}: candidate_id must be a non-empty string`);
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new ReconcileInputError('candidate ids must be unique');

  const verificationById = new Map<string, Record<string, unknown>>();
  for (const entry of verifications) {
    const id = candidateIdOf(entry);
    if (id !== null) verificationById.set(id, entry);
  }

  // A verify report written from analyst output carries no candidateId, only
  // the location. Matched by location then, but only when it is unambiguous: a
  // drop applied to the wrong candidate is worse than refusing.
  const verdictById = new Map<string, FindingVerdict>();
  for (const [index, verdict] of secondPass.entries()) {
    let id: string | null = typeof verdict.candidateId === 'string' && verdict.candidateId !== '' ? verdict.candidateId : null;
    if (id === null) {
      const matches = candidates.filter((c) => c['path'] === verdict.path && c['line'] === verdict.line);
      if (matches.length > 1) {
        throw new ReconcileInputError(
          `verdict ${index}: ${verdict.path}:${verdict.line} matches ${matches.length} candidates and carries no candidateId`,
        );
      }
      id = matches.length === 1 ? candidateIdOf(matches[0] as RawCandidate) : null;
      if (id === null) {
        notes.push(`Warning: second-pass verdict for ${verdict.path}:${verdict.line} matches no candidate. Ignored.`);
        continue;
      }
    } else if (!ids.includes(id)) {
      notes.push(`Warning: second-pass verdict for unknown candidate id ${id}. Ignored.`);
      continue;
    }
    if (verdictById.has(id)) throw new ReconcileInputError(`verdict ${index}: a second verdict for ${id}`);
    verdictById.set(id, verdict);
  }

  const disputes: Dispute[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const id = ids[index] as string;
    const verdict = verdictById.get(id);
    if (verdict === undefined) continue;
    if (verdict.outcome !== 'downgraded' && verdict.outcome !== 'dropped') continue;
    const verification = verificationById.get(id);
    if (!tracedConfidently(verification)) continue;
    disputes.push({
      candidateId: id,
      path: candidate['path'],
      line: candidate['line'],
      severity: candidate['severity'],
      claim: candidate['claim'],
      failureMode: candidate['failure_mode'] ?? candidate['failureMode'],
      evidence: candidate['evidence'],
      verification: verification as Record<string, unknown>,
      secondPass: {
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        reason: verdict.reason,
        outcome: verdict.outcome,
        originalSeverity: verdict.originalSeverity,
        finalSeverity: verdict.finalSeverity,
        verifier: verdict.verifier,
      },
    });
  }

  const disputed = new Set(disputes.map((d) => d.candidateId));
  const rulings = new Map<string, TieBreak>();
  for (const tieBreak of tieBreaks ?? []) {
    if (!ids.includes(tieBreak.candidateId)) {
      notes.push(`Warning: tie-break for unknown candidate id ${tieBreak.candidateId}. Ignored.`);
    } else if (!disputed.has(tieBreak.candidateId)) {
      // Only a dispute can be settled this way. Anything else would let a
      // tie-break overrule a second pass nobody disagreed with.
      notes.push(`Note: ${tieBreak.candidateId} is not disputed, so its tie-break is ignored.`);
    } else {
      rulings.set(tieBreak.candidateId, tieBreak);
    }
  }

  const out: RawCandidate[] = [];
  const applied: Applied[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const id = ids[index] as string;
    const verdict = verdictById.get(id);
    const ruling = rulings.get(id);

    // An upheld dispute keeps the candidate exactly as the evidence-verifier
    // passed it, which is what lets scoring report its traced severity.
    const secondPassStands = ruling === undefined || !ruling.upheld;
    let result: RawCandidate | null = candidate;
    if (secondPassStands && verdict !== undefined) {
      if (verdict.outcome === 'dropped') result = null;
      else if (verdict.outcome === 'downgraded') {
        result = { ...candidate, severity: verdict.finalSeverity };
        // Lowering the requested tier alone is not enough: scoring escalates
        // above it on the very trace the second pass disputed.
        if (disputed.has(id)) result['impact_disputed'] = true;
      }
    }
    if (result !== null) out.push(result);

    if (disputed.has(id)) {
      applied.push({
        candidateId: id,
        result: ruling === undefined ? 'no tie-break supplied' : ruling.upheld ? 'upheld' : 'not upheld',
        severity: result === null ? null : typeof result['severity'] === 'string' ? result['severity'] : null,
        reason: ruling?.reason ?? null,
      });
    }
  }

  return { candidates: out, disputes, applied, notes };
}
