import { ESCALATION_CONFIDENCE, verifierConfidence } from '../scoring/confidence.ts';
import type { DecisiveEvidence, FindingVerdict } from './types.ts';

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
 *
 * The other direction goes through the same tie-break. A second pass that
 * traced a worse impact proposes a stronger tier; it rises only when the
 * tie-breaker upholds that impact, traced, at the escalation confidence. See
 * docs/adr/0019-cross-check-may-raise-through-tie-break.md.
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
  /**
   * Set by `reconcile`: whether this ruling settled a dispute. A ruling on a
   * candidate nobody disputed is ignored there, and `explain` must not treat
   * it as having restored anything. Absent on a ruling read straight from the
   * tie-breaker and on runs recorded before the mark existed; `explain` reads
   * those as it always did.
   */
  applied?: boolean | undefined;
  /**
   * On a ruling about a worse impact the second pass proposed: whether the
   * tie-breaker traced it, and how sure it was - a number, or a quality tier
   * read as scoring reads one. The tier rises only on both.
   */
  impactTraced?: boolean | undefined;
  confidence?: number | undefined;
  evidenceQuality?: string | undefined;
  /** Set by `reconcile`: the tier an applied upgrade raised the candidate to. */
  raised?: string | undefined;
}

/**
 * Which way the passes disagree. `downgrade`: the evidence-verifier traced an
 * impact the second pass lowered or dropped. `upgrade`: the second pass traced
 * a worse impact than the tier the candidate holds.
 */
export type DisputeKind = 'downgrade' | 'upgrade';

export interface Dispute {
  candidateId: string;
  kind: DisputeKind;
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
    /** The stronger tier an `upgrade` dispute is about; null on a downgrade. */
    proposedSeverity: string | null;
    /** Places the tie-breaker should look, not conclusions to accept. */
    decisiveEvidence: DecisiveEvidence[];
  };
}

export interface Applied {
  candidateId: string;
  kind: DisputeKind;
  /**
   * `upheld without traced impact`: an upgrade ruling that upheld the worse
   * impact without tracing it at the escalation confidence, so the tier stays.
   */
  result: 'upheld' | 'not upheld' | 'upheld without traced impact' | 'no tie-break supplied';
  /** The severity the candidate goes to scoring with, or null when it was dropped. */
  severity: string | null;
  reason: string | null;
}

export interface ReconcileResult {
  candidates: RawCandidate[];
  disputes: Dispute[];
  applied: Applied[];
  /** Every ruling supplied, marked with whether it settled a dispute. */
  tieBreaks: TieBreak[];
  /** Things the caller should see on stderr; none of them changes the output. */
  notes: string[];
}

export class ReconcileInputError extends Error {}

export function candidateIdOf(raw: Record<string, unknown>): string | null {
  const id = raw['candidate_id'] ?? raw['candidateId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

const OUTCOMES: readonly FindingVerdict['outcome'][] = ['kept', 'downgraded', 'dropped', 'unverified'];
const VERDICTS: readonly FindingVerdict['verdict'][] = ['confirmed', 'rejected', 'uncertain'];

/** The verdict label each outcome may carry; a `downgraded` one may follow any. */
const OUTCOME_VERDICT: Partial<Record<FindingVerdict['outcome'], FindingVerdict['verdict']>> = {
  kept: 'confirmed',
  dropped: 'rejected',
  unverified: 'uncertain',
};

/** Strongest first. A question asks rather than asserts, so it is weakest. */
const SEVERITY_RANK: Record<string, number> = { blocking: 4, important: 3, minor: 2, nit: 1, question: 0 };

function rank(severity: unknown): number | null {
  return typeof severity === 'string' && Object.hasOwn(SEVERITY_RANK, severity) ? (SEVERITY_RANK[severity] ?? null) : null;
}

/** Why a decisive-evidence list is malformed, or null when it is well formed. */
function decisiveEvidenceProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'decisiveEvidence must be an array';
  for (const [index, entry] of value.entries()) {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof e['path'] !== 'string' || e['path'] === '') return `decisiveEvidence ${index} needs a path`;
    if (!Number.isInteger(e['line']) || (e['line'] as number) < 1) return `decisiveEvidence ${index} needs a positive line`;
    if (typeof e['why'] !== 'string' || e['why'].trim() === '') return `decisiveEvidence ${index} needs a why`;
  }
  return null;
}

/**
 * Why a verdict's fields contradict its label, or null when they agree.
 *
 * A verdict counts only when what it says agrees with what it is labelled. A
 * cross-check once answered "rejected" while its own reason confirmed the
 * claim; the reason is prose, but the fields that state the same thing are
 * not, and a verdict whose fields disagree with each other is refused rather
 * than applied by whichever field is read.
 */
function contradiction(e: Record<string, unknown>): string | null {
  const outcome = e['outcome'] as FindingVerdict['outcome'];
  const expected = OUTCOME_VERDICT[outcome];
  if (expected !== undefined && e['verdict'] !== expected) {
    return `a ${outcome} verdict must be ${expected}, not ${String(e['verdict'])}`;
  }
  const original = rank(e['originalSeverity']);
  const final = rank(e['finalSeverity']);
  if (outcome === 'downgraded') {
    if (final === null) return 'a downgraded verdict needs finalSeverity, a known tier';
    // Only a nit or a question, with no weaker tier to go to, may stay put.
    const floor = e['originalSeverity'] === 'nit' || e['originalSeverity'] === 'question';
    if (original !== null && !(final < original || (floor && final === original))) {
      return `a downgraded verdict needs a finalSeverity below ${String(e['originalSeverity'])}, not ${String(e['finalSeverity'])}`;
    }
  }
  if (outcome === 'kept' && original !== null && final !== null && final !== original) {
    return `a kept verdict leaves the severity at ${String(e['originalSeverity'])}, not ${String(e['finalSeverity'])}`;
  }
  if (e['decisiveEvidence'] !== undefined) {
    const problem = decisiveEvidenceProblem(e['decisiveEvidence']);
    if (problem !== null) return problem;
  }
  if (e['proposedSeverity'] !== undefined) {
    const proposed = rank(e['proposedSeverity']);
    if (outcome !== 'kept') return 'only a kept verdict may propose a stronger severity';
    if (proposed === null || e['proposedSeverity'] === 'question') return 'proposedSeverity must be a tier';
    if (original === null || proposed <= original) {
      return `proposedSeverity ${String(e['proposedSeverity'])} is not above ${String(e['originalSeverity'])}`;
    }
    if (!Array.isArray(e['decisiveEvidence']) || e['decisiveEvidence'].length === 0) {
      return 'a proposed stronger severity needs decisiveEvidence to trace';
    }
    if (typeof e['reason'] !== 'string' || e['reason'].trim() === '') return 'a proposed stronger severity needs a reason';
  }
  return null;
}

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
    if (!VERDICTS.includes(e['verdict'] as FindingVerdict['verdict'])) {
      throw new ReconcileInputError(`${who}: verdict must be one of ${VERDICTS.join(', ')}`);
    }
    const problem = contradiction(e);
    if (problem !== null) throw new ReconcileInputError(`${who}: ${problem}`);
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
    if (e['applied'] !== undefined && typeof e['applied'] !== 'boolean') {
      throw new ReconcileInputError(`${who}: applied must be true or false when supplied`);
    }
    const impactTraced = e['impact_traced'] ?? e['impactTraced'];
    if (impactTraced !== undefined && typeof impactTraced !== 'boolean') {
      throw new ReconcileInputError(`${who}: impact_traced must be true or false when supplied`);
    }
    const confidence = e['confidence'];
    if (confidence !== undefined && (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))) {
      throw new ReconcileInputError(`${who}: confidence must be a number from 0 to 1 when supplied`);
    }
    const quality = e['evidence_quality'] ?? e['evidenceQuality'];
    if (quality !== undefined && typeof quality !== 'string') {
      throw new ReconcileInputError(`${who}: evidence_quality must be a string when supplied`);
    }
    if (e['raised'] !== undefined && rank(e['raised']) === null) {
      throw new ReconcileInputError(`${who}: raised must be a severity when supplied`);
    }
    return {
      candidateId: id,
      upheld: e['upheld'],
      reason: e['reason'],
      ...(typeof e['applied'] === 'boolean' ? { applied: e['applied'] } : {}),
      ...(typeof impactTraced === 'boolean' ? { impactTraced } : {}),
      ...(typeof confidence === 'number' ? { confidence } : {}),
      ...(typeof quality === 'string' ? { evidenceQuality: quality } : {}),
      ...(typeof e['raised'] === 'string' ? { raised: e['raised'] } : {}),
    };
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
    const verification = verificationById.get(id);
    let kind: DisputeKind;
    if (verdict.outcome === 'downgraded' || verdict.outcome === 'dropped') {
      if (!tracedConfidently(verification)) continue;
      kind = 'downgrade';
    } else if (verdict.outcome === 'kept' && verdict.proposedSeverity !== undefined) {
      // Proposed against the tier the candidate holds now, whatever the
      // verdict recorded as its original.
      const held = rank(candidate['severity']);
      const proposed = rank(verdict.proposedSeverity);
      if (held === null || proposed === null || proposed <= held || candidate['severity'] === 'question') {
        notes.push(`Note: ${id}'s proposed ${verdict.proposedSeverity} is not above its ${String(candidate['severity'])}, so it is not disputed.`);
        continue;
      }
      kind = 'upgrade';
    } else {
      continue;
    }
    disputes.push({
      candidateId: id,
      kind,
      path: candidate['path'],
      line: candidate['line'],
      severity: candidate['severity'],
      claim: candidate['claim'],
      failureMode: candidate['failure_mode'] ?? candidate['failureMode'],
      evidence: candidate['evidence'],
      verification: verification ?? {},
      secondPass: {
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        reason: verdict.reason,
        outcome: verdict.outcome,
        originalSeverity: verdict.originalSeverity,
        finalSeverity: verdict.finalSeverity,
        verifier: verdict.verifier,
        proposedSeverity: kind === 'upgrade' ? (verdict.proposedSeverity as string) : null,
        decisiveEvidence: verdict.decisiveEvidence ?? [],
      },
    });
  }

  const kinds = new Map(disputes.map((d) => [d.candidateId, d.kind]));
  const disputed = new Set(kinds.keys());
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
  const raisedTo = new Map<string, string>();
  for (const [index, candidate] of candidates.entries()) {
    const id = ids[index] as string;
    const verdict = verdictById.get(id);
    const ruling = rulings.get(id);
    const kind = kinds.get(id);

    if (kind === 'upgrade') {
      // The worse impact counts only as the evidence-verifier's does for an
      // escalation: traced, and at least that sure, read by the same function.
      const sure = verifierConfidence(ruling?.confidence, ruling?.evidenceQuality);
      const raise =
        ruling?.upheld === true && ruling.impactTraced === true && sure !== null && sure >= ESCALATION_CONFIDENCE;
      const proposed = verdict?.proposedSeverity as string;
      const result = raise ? { ...candidate, severity: proposed } : candidate;
      if (raise) raisedTo.set(id, proposed);
      else if (ruling?.upheld === true) {
        notes.push(`Note: ${id}'s upheld ruling did not trace the worse impact at ${ESCALATION_CONFIDENCE} or more, so its tier stays.`);
      }
      out.push(result);
      applied.push({
        candidateId: id,
        kind,
        result:
          ruling === undefined
            ? 'no tie-break supplied'
            : raise
              ? 'upheld'
              : ruling.upheld
                ? 'upheld without traced impact'
                : 'not upheld',
        severity: typeof result['severity'] === 'string' ? result['severity'] : null,
        reason: ruling?.reason ?? null,
      });
      continue;
    }

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
        kind: 'downgrade',
        result: ruling === undefined ? 'no tie-break supplied' : ruling.upheld ? 'upheld' : 'not upheld',
        severity: result === null ? null : typeof result['severity'] === 'string' ? result['severity'] : null,
        reason: ruling?.reason ?? null,
      });
    }
  }

  // Recomputed here, whatever the input said: only reconcile knows which
  // rulings settled a dispute.
  const marked = (tieBreaks ?? []).map((tieBreak) => {
    const { raised: _input, ...rest } = tieBreak;
    const raised = raisedTo.get(tieBreak.candidateId);
    return { ...rest, applied: rulings.has(tieBreak.candidateId), ...(raised === undefined ? {} : { raised }) };
  });

  return { candidates: out, disputes, applied, tieBreaks: marked, notes };
}
