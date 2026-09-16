import type { Precedent } from '../retrieval/retrieve.ts';

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

/** Maps a signed precedent weight onto a 0..1 alignment score. */
function alignmentFrom(precedents: Precedent[]): number {
  if (precedents.length === 0) return 0.5; // No evidence either way.
  const total = precedents.reduce((sum, p) => sum + p.weight, 0);
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
  if (candidate.technicalConfidence < thresholds.technicalConfidence) {
    rejectedBecause = `technical confidence ${candidate.technicalConfidence.toFixed(2)} is below ${thresholds.technicalConfidence}`;
  } else if (finalScore < thresholds.finalScore) {
    rejectedBecause = `score ${finalScore.toFixed(2)} is below ${thresholds.finalScore}`;
  }

  return {
    candidateId: candidate.candidateId,
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
