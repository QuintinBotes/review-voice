/**
 * Verifier stability (#484): re-verify a fixed set of stored candidates k
 * times, never from a cache, and report how far the verifier's confidence
 * moves between runs and how often the gate decision moves with it.
 *
 * The gate decision is `reGateBreakdown`, the scorer's own logic, so the
 * thresholds are never restated here. The stored final score is held fixed:
 * it is not recomputed from the new confidence, so the flip rate isolates the
 * confidence floor and the stored score gate.
 */
import { inParallel } from '../agents/runner.ts';
import { DEFAULT_AGENT_PARALLELISM } from '../agents/types.ts';
import { holdReasonOf, reGateBreakdown, type Thresholds } from '../scoring/score.ts';
import type { StoredCandidate } from './calibration.ts';

export interface StabilityVerdict {
  technicalConfidence: number;
  verified: boolean;
}

/**
 * `useCache` is always false from here: a stability sample that read a cached
 * verdict would repeat the first run and report a spread of zero.
 */
export type StabilityVerifier = (
  candidate: StoredCandidate,
  attempt: number,
  options: { useCache: false },
) => Promise<StabilityVerdict | null>;

export interface StabilityRow {
  run: string;
  candidate_id: string;
  /** One per successful verification, in attempt order. */
  confidences: number[];
  min: number;
  max: number;
  /** Population standard deviation of `confidences`. */
  stddev: number;
  /** Whether the decision differed between runs, per threshold set; null when it cannot be re-gated. */
  flips: { current: boolean | null; proposed?: boolean | null };
}

export interface FlipRate {
  flipped: number;
  of: number;
  rate: number | null;
}

export interface StabilityReport {
  k: number;
  candidates: number;
  expectedCalls: number;
  calls: number;
  failedCalls: number;
  rows: StabilityRow[];
  flipRate: { current: FlipRate; proposed?: FlipRate };
  /** Candidates with no successful verification, or whose breakdown lacks a field the gate needs. */
  excluded: { run: string; candidate_id: string; reason: string }[];
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

function tierOf(candidate: StoredCandidate): unknown {
  const severity = candidate.breakdown['severity'];
  return typeof severity === 'string' ? severity : (severity as { severity?: unknown } | null | undefined)?.severity;
}

/** `post`, `hold`, or the reason the breakdown cannot be re-gated. */
function decide(candidate: StoredCandidate, verdict: StabilityVerdict, thresholds: Thresholds): 'post' | 'hold' | string {
  if (!verdict.verified) return 'hold';
  // Only the verifier-dependent part varies: no recorded hold, a confidence or score gate held
  // alone, or the verifier's own rejection. Any other stored hold (policy, materiality, owner
  // precedent, unverifiable, an anchor failure, a compound reason) stands, as in reGateBreakdown.
  const rejected = candidate.breakdown['rejectedBecause'];
  const reason = typeof rejected === 'string' && rejected.length > 0 ? rejected : null;
  const hold = holdReasonOf(reason, candidate.breakdown['gate']);
  const alone = reason === null || !reason.includes(' Also: ');
  const varies =
    hold === null || (alone && (hold === 'confidenceFloor' || hold === 'score' || (hold === 'other' && candidate.verified === false)));
  const result = reGateBreakdown(
    {
      eligible: varies ? true : candidate.breakdown['eligible'],
      rejectedBecause: varies ? null : candidate.breakdown['rejectedBecause'],
      gate: varies ? undefined : candidate.breakdown['gate'],
      technicalConfidence: verdict.technicalConfidence,
      confidenceSource: 'verifier',
      finalScore: candidate.breakdown['finalScore'],
      severityTier: tierOf(candidate),
      category: candidate.breakdown['category'] ?? candidate.candidate?.['category'],
      ownerPromotion: candidate.breakdown['ownerPromotion'],
    },
    thresholds,
  );
  return !result.reapplicable ? result.reason : result.eligible ? 'post' : 'hold';
}

const flipRate = (flips: readonly (boolean | null)[]): FlipRate => {
  const gated = flips.filter((flip): flip is boolean => flip !== null);
  const flipped = gated.filter(Boolean).length;
  return { flipped, of: gated.length, rate: gated.length === 0 ? null : round6(flipped / gated.length) };
};

export async function runStability(
  candidates: readonly StoredCandidate[],
  options: { k: number; verify: StabilityVerifier; current: Thresholds; proposed?: Thresholds | null; concurrency?: number },
): Promise<StabilityReport> {
  const { k, verify, current, proposed, concurrency = DEFAULT_AGENT_PARALLELISM } = options;
  const rows: StabilityRow[] = [];
  const excluded: StabilityReport['excluded'] = [];
  let calls = 0;
  let failedCalls = 0;
  // All k x n calls go through the driver's bounded pool; results stay in input order, so a
  // candidate's verdicts are in attempt order whatever order the calls finish in.
  const jobs = candidates.flatMap((candidate) => Array.from({ length: k }, (_, attempt) => ({ candidate, attempt })));
  const results = await inParallel(jobs, ({ candidate, attempt }) => verify(candidate, attempt, { useCache: false }), concurrency);
  for (const [index, candidate] of candidates.entries()) {
    const verdicts: StabilityVerdict[] = [];
    for (const verdict of results.slice(index * k, (index + 1) * k)) {
      calls += 1;
      if (verdict === null) failedCalls += 1;
      else verdicts.push(verdict);
    }
    const id = { run: candidate.run, candidate_id: candidate.candidateId };
    if (verdicts.length === 0) {
      excluded.push({ ...id, reason: 'no verification succeeded' });
      continue;
    }
    const confidences = verdicts.map((verdict) => verdict.technicalConfidence);
    const mean = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
    const variance = confidences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / confidences.length;
    // A set whose decisions cannot all be re-gated has no flip to report; the first reason is named.
    const flipsUnder = (thresholds: Thresholds): boolean | null => {
      const decisions = verdicts.map((verdict) => decide(candidate, verdict, thresholds));
      const problem = decisions.find((decision) => decision !== 'post' && decision !== 'hold');
      if (problem !== undefined) {
        if (thresholds === current) excluded.push({ ...id, reason: problem });
        return null;
      }
      return new Set(decisions).size > 1;
    };
    rows.push({
      ...id,
      confidences,
      min: Math.min(...confidences),
      max: Math.max(...confidences),
      stddev: round6(Math.sqrt(variance)),
      flips: { current: flipsUnder(current), ...(proposed == null ? {} : { proposed: flipsUnder(proposed) }) },
    });
  }
  return {
    k,
    candidates: candidates.length,
    expectedCalls: k * candidates.length,
    calls,
    failedCalls,
    rows,
    flipRate: {
      current: flipRate(rows.map((row) => row.flips.current)),
      ...(proposed == null ? {} : { proposed: flipRate(rows.map((row) => row.flips.proposed ?? null)) }),
    },
    excluded,
  };
}

export function formatStabilityText(report: StabilityReport): string {
  const pct = (rate: FlipRate): string => (rate.rate === null ? 'n/a' : `${(rate.rate * 100).toFixed(1)}% (${rate.flipped} of ${rate.of})`);
  const out = [
    `Stability over ${report.k} runs of ${report.candidates} candidates (${report.calls} model calls, ${report.failedCalls} failed)`,
    `Decision flips, current thresholds:  ${pct(report.flipRate.current)}`,
    ...(report.flipRate.proposed === undefined ? [] : [`Decision flips, proposed thresholds: ${pct(report.flipRate.proposed)}`]),
    '',
    'run / candidate                          min     max     stddev',
    ...report.rows.map((row) => `${`${row.run} ${row.candidate_id}`.padEnd(40)} ${row.min.toFixed(2)}    ${row.max.toFixed(2)}    ${row.stddev.toFixed(4)}`),
    ...report.excluded.map((entry) => `excluded ${entry.run} ${entry.candidate_id}: ${entry.reason}`),
  ];
  return `${out.join('\n')}\n`;
}
