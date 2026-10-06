/**
 * How the evidence-verifier's confidence is read, shared by `score` and
 * `reconcile` so the two cannot disagree about it.
 */

/** Used when the verifier reports a tier rather than a number. */
const QUALITY_CONFIDENCE: Record<string, number> = { high: 0.9, medium: 0.75, low: 0.5 };

/** The verifier confidence an escalation above the requested tier must clear. */
export const ESCALATION_CONFIDENCE = 0.85;

/**
 * The confidence the verifier established: its number, or the one its quality
 * tier stands for when it gave no number. Null when it gave neither.
 *
 * One function for every reader. `reconcile` read only the number, so a trace
 * reported as `evidence_quality: "high"` alone was never disputed while
 * scoring still escalated on it, and the second pass's downgrade did not hold.
 */
export function verifierConfidence(
  technicalConfidence: unknown,
  evidenceQuality: unknown,
): number | null {
  if (typeof technicalConfidence === 'number' && Number.isFinite(technicalConfidence)) return technicalConfidence;
  if (typeof evidenceQuality !== 'string' || !Object.hasOwn(QUALITY_CONFIDENCE, evidenceQuality)) return null;
  return QUALITY_CONFIDENCE[evidenceQuality] ?? null;
}
