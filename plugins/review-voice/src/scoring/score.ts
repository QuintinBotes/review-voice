import type { Precedent } from '../retrieval/retrieve.ts';

/**
 * A candidate as the schema publishes it. `schemas/candidate.schema.json` is
 * the contract agents are told to emit against, and it is snake_case — so that
 * is what arrives, whatever the internal type is called.
 */
export interface RawCandidate {
  candidate_id?: string;
  candidateId?: string;
  path?: string;
  line?: number;
  category?: string;
  severity?: string;
  claim?: string;
  failure_mode?: string;
  failureMode?: string;
  evidence?: string[];
  technical_confidence?: number;
  technicalConfidence?: number;
}

export interface Candidate {
  candidateId: string;
  path: string;
  line: number;
  category: string;
  severity: 'blocking' | 'important' | 'minor';
  claim: string;
  failureMode: string;
  evidence: string[];
  technicalConfidence: number;
}

export interface ScoreBreakdown {
  candidateId: string;
  /**
   * Location, carried so a breakdown can be matched back to the finding it
   * produced. A candidate id is meaningless to anything downstream: the
   * editor may drop candidates it cannot state within the word limit, so
   * position is not a reliable link either.
   */
  path: string;
  line: number;
  technicalConfidence: number;
  ownerAlignment: number;
  repositoryAlignment: number;
  evidenceQuality: number;
  novelty: number;
  finalScore: number;
  eligible: boolean;
  /** Why it was rejected, when it was. */
  rejectedBecause: string | null;
  precedentIds: string[];
}

export interface Thresholds {
  technicalConfidence: number;
  finalScore: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  technicalConfidence: 0.8,
  finalScore: 0.78,
};

export class MalformedCandidate extends Error {}

/**
 * Normalises a candidate from either casing.
 *
 * The schema and the internal type disagreed on naming, so every field read as
 * undefined. That did not produce an obvious failure: `undefined` arithmetic
 * yields NaN, and every comparison against NaN is false — so both thresholds
 * passed and every candidate was declared eligible with a null score. The gate
 * was not wrong, it was inert.
 *
 * Hence the explicit finiteness check below rather than trusting a comparison
 * to catch it.
 */
export function normaliseCandidate(raw: RawCandidate, index: number): Candidate {
  const candidateId = raw.candidate_id ?? raw.candidateId ?? `cand_${String(index + 1).padStart(3, '0')}`;
  const confidence = raw.technical_confidence ?? raw.technicalConfidence;

  if (typeof raw.path !== 'string' || raw.path.length === 0) {
    throw new MalformedCandidate(`${candidateId}: missing path`);
  }
  if (!Number.isFinite(raw.line)) {
    throw new MalformedCandidate(`${candidateId}: missing or non-numeric line`);
  }
  if (!Number.isFinite(confidence)) {
    throw new MalformedCandidate(
      `${candidateId}: missing or non-numeric technical_confidence — a score cannot be computed, ` +
        'and a candidate that cannot be scored must not be treated as eligible',
    );
  }

  return {
    candidateId,
    path: raw.path,
    line: raw.line as number,
    category: raw.category ?? 'correctness',
    severity: (raw.severity ?? 'minor') as Candidate['severity'],
    claim: raw.claim ?? '',
    failureMode: raw.failure_mode ?? raw.failureMode ?? '',
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    technicalConfidence: confidence as number,
  };
}

/**
 * Maps signed precedent weights onto a 0..1 alignment score.
 *
 * Each weight is scaled by how well that precedent actually matched. Summing
 * raw weights let a marginal hit count as much as a strong one, which is how
 * seven unrelated candidates all landed inside a 0.77–0.85 band — a range too
 * narrow to discriminate between anything.
 */
function alignmentFrom(precedents: Precedent[]): number {
  if (precedents.length === 0) return 0.5; // No evidence either way.
  const total = precedents.reduce((sum, p) => sum + p.weight * (p.matchStrength ?? 1), 0);
  // A bounded squash keeps one loud precedent from saturating the score.
  return 1 / (1 + Math.exp(-total));
}

/**
 * Evidence quality rewards specificity, not volume. Three vague observations
 * are not better evidence than one that names a line.
 */
function evidenceQuality(candidate: Candidate): number {
  const items = candidate.evidence.filter((item) => item.trim().length > 0);
  if (items.length === 0) return 0;

  const specific = items.filter((item) => /\b(line|:\d+|\bat \d+)/i.test(item) || item.length > 40).length;
  const breadth = Math.min(1, items.length / 3);
  const depth = specific / items.length;
  return 0.4 * breadth + 0.6 * depth;
}

/**
 * Penalises a candidate that repeats one already kept. Two findings about the
 * same root cause spend two-fifths of the budget saying one thing.
 */
function novelty(candidate: Candidate, kept: Candidate[]): number {
  if (kept.length === 0) return 1;

  const words = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  const mine = words(`${candidate.claim} ${candidate.failureMode}`);

  let worst = 1;
  for (const other of kept) {
    if (other.path === candidate.path && other.line === candidate.line) return 0;
    const theirs = words(`${other.claim} ${other.failureMode}`);
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    const overlap = mine.size === 0 ? 0 : shared / mine.size;
    worst = Math.min(worst, 1 - overlap);
  }
  return worst;
}

/**
 * The eligibility score from the specification.
 *
 * Deliberately arithmetic and deliberately in the CLI: asking a model to
 * compute this would make the thresholds unfalsifiable, and the whole point of
 * a threshold is that it can be checked.
 */
export function scoreCandidate(
  candidate: Candidate,
  precedents: Precedent[],
  kept: Candidate[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): ScoreBreakdown {
  const ownerPrecedents = precedents.filter((p) => p.role === 'owner');
  const repositoryPrecedents = precedents.filter((p) => p.role !== 'owner');

  const ownerAlignment = alignmentFrom(ownerPrecedents);
  const repositoryAlignment = alignmentFrom(repositoryPrecedents);
  const quality = evidenceQuality(candidate);
  const novel = novelty(candidate, kept);

  const finalScore =
    0.35 * candidate.technicalConfidence +
    0.25 * ownerAlignment +
    0.15 * repositoryAlignment +
    0.15 * quality +
    0.1 * novel;

  let rejectedBecause: string | null = null;
  // Checked explicitly: every comparison against NaN is false, so a
  // non-finite score would otherwise pass both thresholds below.
  if (!Number.isFinite(finalScore) || !Number.isFinite(candidate.technicalConfidence)) {
    rejectedBecause = 'score could not be computed from this candidate';
  } else if (candidate.technicalConfidence < thresholds.technicalConfidence) {
    rejectedBecause = `technical confidence ${candidate.technicalConfidence.toFixed(2)} is below ${thresholds.technicalConfidence}`;
  } else if (finalScore < thresholds.finalScore) {
    rejectedBecause = `score ${finalScore.toFixed(2)} is below ${thresholds.finalScore}`;
  }

  return {
    candidateId: candidate.candidateId,
    path: candidate.path,
    line: candidate.line,
    technicalConfidence: candidate.technicalConfidence,
    ownerAlignment,
    repositoryAlignment,
    evidenceQuality: quality,
    novelty: novel,
    finalScore,
    eligible: rejectedBecause === null,
    rejectedBecause,
    precedentIds: precedents.map((p) => p.eventId),
  };
}
