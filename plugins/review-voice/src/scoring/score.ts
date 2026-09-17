import type { Precedent } from '../retrieval/retrieve.ts';

/**
 * A candidate as the schema publishes it. `schemas/candidate.schema.json` is
 * the contract agents are told to emit against, and it is snake_case - so that
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
  /**
   * The precedent that already states this finding at this location, when one
   * exists. Reported so `explain` can name what the corpus already said.
   */
  duplicateOfPrecedent: string | null;
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
 * yields NaN, and every comparison against NaN is false - so both thresholds
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
      `${candidateId}: missing or non-numeric technical_confidence - a score cannot be computed, ` +
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

const WORDS = /[^\p{L}\p{N}]+/u;

function significantWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(WORDS).filter((word) => word.length > 3));
}

/** Share of `mine` that also appears in `theirs`, 0..1. */
function overlap(mine: Set<string>, theirs: Set<string>): number {
  if (mine.size === 0) return 0;
  return [...mine].filter((word) => theirs.has(word)).length / mine.size;
}

/**
 * How close a precedent sits to the candidate's own line. Comment anchors
 * drift by a line or two as a file is edited, so an exact match is too strict
 * to catch a repeat of the same point.
 */
const DUPLICATE_LINE_WINDOW = 2;

/**
 * Absolute overlap required before a precedent counts as the same point.
 *
 * `matchStrength` alone cannot carry this. It is normalised to the best hit in
 * the result set, so the top precedent scores 1.0 whether it is a paraphrase
 * of the candidate or the least bad of several poor matches. Relative rank
 * cannot answer an absolute question.
 */
const DUPLICATE_OVERLAP = 0.4;

function sameLocation(candidate: Candidate, precedent: Precedent): boolean {
  if (precedent.filePath === null || precedent.lineStart === null) return false;
  if (precedent.filePath !== candidate.path) return false;
  return Math.abs(precedent.lineStart - candidate.line) <= DUPLICATE_LINE_WINDOW;
}

/**
 * Finds a precedent that already makes this point on this line.
 *
 * Novelty used to be measured only against the other candidates in the current
 * review, which answers "are we saying this twice today" and not "has this
 * already been said". A comment published on the same line, matching the same
 * claim, scored full novelty and its positive polarity then raised alignment
 * as well - so a finding the corpus already contained verbatim was rewarded
 * twice for being a repeat.
 */
export function duplicatePrecedent(candidate: Candidate, precedents: Precedent[]): Precedent | null {
  const mine = significantWords(`${candidate.claim} ${candidate.failureMode}`);
  for (const precedent of precedents) {
    if (!sameLocation(candidate, precedent)) continue;
    if (overlap(mine, significantWords(precedent.excerpt)) >= DUPLICATE_OVERLAP) return precedent;
  }
  return null;
}

/**
 * Maps signed precedent weights onto a 0..1 alignment score.
 *
 * Each weight is scaled by how well that precedent actually matched. Summing
 * raw weights let a marginal hit count as much as a strong one, which is how
 * seven unrelated candidates all landed inside a 0.77-0.85 band - a range too
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
 * Penalises a candidate that repeats something already said, whether by
 * another finding in this review or by a comment already in the corpus.
 *
 * Two findings about the same root cause spend two-fifths of the budget saying
 * one thing. A finding that repeats a published comment spends all of it
 * saying nothing.
 */
function novelty(candidate: Candidate, kept: Candidate[], precedents: Precedent[]): number {
  const mine = significantWords(`${candidate.claim} ${candidate.failureMode}`);

  let worst = 1;

  for (const other of kept) {
    if (other.path === candidate.path && other.line === candidate.line) return 0;
    const theirs = significantWords(`${other.claim} ${other.failureMode}`);
    worst = Math.min(worst, 1 - overlap(mine, theirs));
  }

  // A precedent elsewhere in the same file that makes the same point is a
  // weaker signal than one on the line itself, so it caps novelty rather than
  // zeroing it. The on-line case is handled as a rejection, not a score.
  for (const precedent of precedents) {
    if (precedent.filePath !== candidate.path) continue;
    if (overlap(mine, significantWords(precedent.excerpt)) < 0.7) continue;
    worst = Math.min(worst, 0.5);
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
  const alreadySaid = duplicatePrecedent(candidate, precedents);

  // A precedent that already states this finding on this line is evidence that
  // it has been said, not evidence that it is worth saying. Leaving it in the
  // alignment sum let the repeat argue for itself.
  const forAlignment =
    alreadySaid === null ? precedents : precedents.filter((p) => !sameLocation(candidate, p));

  const ownerPrecedents = forAlignment.filter((p) => p.role === 'owner');
  const repositoryPrecedents = forAlignment.filter((p) => p.role !== 'owner');

  const ownerAlignment = alignmentFrom(ownerPrecedents);
  const repositoryAlignment = alignmentFrom(repositoryPrecedents);
  const quality = evidenceQuality(candidate);
  const novel = alreadySaid === null ? novelty(candidate, kept, precedents) : 0;

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
  } else if (alreadySaid !== null) {
    // Not left to the weights. Novelty carries a tenth of the score, so a
    // confident candidate with strong evidence still clears the threshold
    // while repeating a comment already published on that line.
    rejectedBecause = `already stated at ${candidate.path}:${candidate.line} in precedent ${alreadySaid.eventId}`;
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
    duplicateOfPrecedent: alreadySaid?.eventId ?? null,
    precedentIds: precedents.map((p) => p.eventId),
  };
}
