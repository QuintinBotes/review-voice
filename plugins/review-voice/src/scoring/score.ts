import type { Precedent } from '../retrieval/retrieve.ts';
import type { ReachCheck } from './reach.ts';
import { deriveSeverity, type DerivedSeverity } from './severity.ts';

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
  severity: 'blocking' | 'important' | 'minor' | 'nit' | 'question';
  claim: string;
  failureMode: string;
  evidence: string[];
  technicalConfidence: number;
}

/**
 * What the `evidence-verifier` concluded, when it ran.
 *
 * The verifier is the only stage that actually checks a claim against the
 * repository, and until now its conclusion reached scoring only by deciding
 * which candidates arrived. Its confidence supersedes the analyst's.
 */
export interface Verification {
  candidateId: string;
  evidenceQuality?: 'high' | 'medium' | 'low' | undefined;
  technicalConfidence?: number | undefined;
  /** Context the verifier needed and could not obtain. */
  requiredContextMissing?: string[] | undefined;
  /** Deterministic CLI evidence; it is never read from verifier output. */
  reach?: ReachCheck | undefined;
}

/** Used when the verifier reports a tier rather than a number. */
const QUALITY_CONFIDENCE: Record<string, number> = { high: 0.9, medium: 0.75, low: 0.5 };

/**
 * The ceiling for a claim nobody could check.
 *
 * Below every default gate, so such a candidate is rejected rather than merely
 * discounted. A reviewer that states it cannot verify something and ships the
 * claim anyway is the failure that produces a retracted comment.
 */
export const UNVERIFIABLE_CONFIDENCE = 0.6;

/**
 * An admission, in the candidate's own evidence, that the claim could not be
 * checked. Observed verbatim as "No local key catalogue exists in the repo, so
 * the keys' existence cannot be verified here", filed at confidence 0.8.
 */
const ADMITS_UNVERIFIABLE = [
  /\b(?:cannot|can not|could not|couldn't|unable to)\s+(?:be\s+)?(?:verif|confirm|check|establish|determin)/i,
  /\bnot\s+verifiable\b/i,
  /\bwithout\s+access\s+to\b/i,
  /\bno\s+way\s+to\s+(?:verify|confirm|check)\b/i,
];

function admitsUnverifiable(candidate: Candidate): boolean {
  return candidate.evidence.some((item) => ADMITS_UNVERIFIABLE.some((pattern) => pattern.test(item)));
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
  /** The confidence actually gated on, after supersession and any cap. */
  technicalConfidence: number;
  /** What the analyst claimed about its own output. */
  analystConfidence: number;
  /** What the verifier concluded, when it ran. */
  verifiedConfidence: number | null;
  /** Why the effective confidence differs from the analyst's, when it does. */
  confidenceSource: 'analyst' | 'verifier' | 'unverifiable-cap';
  /** The tier this is reported at, derived rather than requested. */
  severity: DerivedSeverity;
  ownerAlignment: number;
  repositoryAlignment: number;
  evidenceQuality: number;
  novelty: number;
  finalScore: number;
  /**
   * What the score would be with anchor-less precedents excluded from
   * alignment. Reported so the switch can be made on measurement rather than
   * arithmetic - see `anchoredAlignmentFrom`.
   */
  anchored: {
    ownerAlignment: number;
    repositoryAlignment: number;
    finalScore: number;
    /** True when the change would flip this candidate's eligibility. */
    wouldChangeEligibility: boolean;
  };
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
  /** Applied to a confidence the verifier established. */
  technicalConfidence: number;
  /**
   * Applied when only the analyst's self-report exists.
   *
   * A separate number because it is a different measurement. The verifier
   * checked the claim against the repository; the analyst is reporting how it
   * feels about its own output, and that has now been measured against ground
   * truth. Over eleven candidates verified or refuted by hand against the code:
   *
   *   0.85 true · 0.80 FALSE · 0.80 plausible · 0.75 true
   *   0.75 plausible · 0.70 true · 0.70 true
   *
   * The self-report does not separate true from false anywhere in that band:
   * the two most thoroughly verified findings sat at 0.70 and the only false
   * one at 0.80. Held at 0.8 it discarded a real behavioural defect, a test
   * that does not test what it claims, and the finding that drove an actual
   * changes-requested review, while shipping the false one. It is also unstable
   * at the boundary: the same finding on an identical diff scored 0.75 and then
   * 0.80, which decided whether it reached the author at all.
   *
   * 0.7 is where the labelled data puts it. Below that the signal does carry:
   * candidates at 0.50 and 0.65 were weak or wrong in earlier rounds. Above it
   * the number is noise, and a gate on noise is a coin toss with a threshold.
   */
  analystOnlyConfidence: number;
  finalScore: number;
}

/**
 * The final-score gate, and why it moved.
 *
 * 0.78 was calibrated when `evidenceQuality` scored 1.000 for every candidate,
 * because its specificity test accepted "longer than 40 characters". That term
 * carries 0.15 of the score, so every candidate was handed 0.15 unconditionally
 * and the threshold was really 0.63 plus a constant.
 *
 * Once the term began to discriminate, spanning 0.40 to 1.00 on a real run, the
 * whole distribution moved down beneath a gate that had not moved with it: two
 * of twelve verified findings cleared it where eight of ten had before, and the
 * threshold sat above the distribution rather than through it.
 *
 * 0.74 was arithmetic about that change. 0.68 is measured. Across five pull
 * request runs every candidate the verifier judged false was already rejected
 * on confidence, so nothing reaching the score gate is still in question:
 *
 *   verifier said false   0.4685  0.5886  0.6313
 *   verifier said true    0.6884  0.6911  0.7389  0.7587  0.7723
 *
 * The classes separate cleanly between 0.6313 and 0.6884 with nothing in
 * between, and 0.74 sat inside the confirmed-true group, deleting three of
 * five true findings. 0.68 sits just under the lowest confirmed score.
 *
 * The gate is kept because its job is preference, not truth: alignment,
 * novelty and evidence quality say whether the owner would want this said,
 * which the confidence gate does not measure. It should not be re-litigating
 * whether the finding is real, which the verifier decided on better evidence.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  technicalConfidence: 0.8,
  analystOnlyConfidence: 0.7,
  finalScore: 0.68,
};

/**
 * How many questions one review may ask.
 *
 * A question costs the reader an answer rather than a fix, and several at once
 * turn a review into an interrogation. Two is a guess, recorded as one.
 */
export const MAX_QUESTIONS: number = 2;

/**
 * Keeps the best questions and rejects the rest, after all of them are scored.
 *
 * The cap used to be applied while scoring, against the questions already kept,
 * which made it first-come rather than merit-ranked: four questions at 0.30,
 * 0.45, 0.60 and 0.35 kept the first two and dropped the 0.60, and reversing
 * the input kept a different pair. A byte-identical diff could then produce a
 * different review depending only on the order the analyst emitted them, which
 * is the nondeterminism severity derivation exists to remove.
 *
 * Ties break on candidate id so the order is total, not merely sorted.
 */
export function applyQuestionCap(breakdowns: ScoreBreakdown[], limit: number = MAX_QUESTIONS): void {
  const questions = breakdowns.filter((b) => b.eligible && b.severity.severity === 'question');
  if (questions.length <= limit) return;

  const ranked = [...questions].sort(
    (a, b) => b.finalScore - a.finalScore || a.candidateId.localeCompare(b.candidateId),
  );

  for (const dropped of ranked.slice(limit)) {
    dropped.eligible = false;
    dropped.rejectedBecause =
      `this review already asks ${limit} better-evidenced question${limit === 1 ? '' : 's'}, ` +
      'and a review that ends in a list of questions has stopped being a review';
  }
}

/** A comment already on the pull request, from `diff/thread.ts`. */
export interface ThreadComment {
  path: string | null;
  line: number | null;
  author: string;
  body: string;
}

/**
 * Whether this point has already been made on this pull request.
 *
 * Distinct from `duplicatePrecedent`, which asks whether the *owner* has said
 * something like this before, across their history, and feeds taste. This asks
 * only whether the point is already on the page, by anyone - the author, a
 * human reviewer, or another bot.
 *
 * `--exclude-pull` keeps the pull request's own thread out of precedent, and
 * should: a review this tool posted coming back as evidence of the owner's
 * taste is circular. Deduplication is the opposite problem, and on the first
 * batch posted to real pull requests it removed 16 of 30 candidates - more than
 * every other stage combined - because those repositories already run an
 * automated reviewer.
 *
 * An unanchored comment is compared on wording alone, since a review body or a
 * conversation comment can make a point about a line without citing it.
 */
export function alreadySaidOnThread(
  candidate: Candidate,
  thread: ThreadComment[],
): ThreadComment | null {
  const mine = significantWords(`${candidate.claim} ${candidate.failureMode}`);
  if (mine.size === 0) return null;

  for (const comment of thread) {
    const anchored = comment.path !== null && comment.line !== null;
    if (anchored) {
      if (comment.path !== candidate.path) continue;
      if (Math.abs((comment.line as number) - candidate.line) > DUPLICATE_LINE_WINDOW) continue;
      if (overlap(mine, significantWords(comment.body)) >= DUPLICATE_OVERLAP) return comment;
      continue;
    }

    // Unanchored: the same point stated in a review body still counts, but the
    // bar is higher because there is no location agreeing with it.
    if (overlap(mine, significantWords(comment.body)) >= UNANCHORED_DUPLICATE_OVERLAP) return comment;
  }

  return null;
}

export class MalformedCandidate extends Error {}

/** Field names from shapes agents have returned instead of the schema. */
const FOREIGN_KEYS = ['title', 'location', 'suggested_direction', 'suggestion', 'description', 'summary'];

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
    // Named explicitly, because an agent that returns a different shape
    // altogether fails here first and "missing path" is a misleading summary
    // of "this is not a candidate". One run emitted title, location and
    // suggested_direction, and the whole pull request produced nothing.
    const foreign = FOREIGN_KEYS.filter((key) => key in raw);
    throw new MalformedCandidate(
      foreign.length > 0
        ? `${candidateId}: has ${foreign.join(', ')} but no path. This is not the candidate schema. ` +
          'Expected candidate_id, path, line, category, severity, claim, failure_mode, evidence, ' +
          'technical_confidence, per schemas/candidate.schema.json.'
        : `${candidateId}: missing path`,
    );
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
    // Deliberately not defaulted. `correctness` used to stand in for a missing
    // category, which gave an unlabelled finding a real tier and recorded
    // nothing about the substitution.
    category: raw.category ?? '',
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

/**
 * The bar for a comment that names no line.
 *
 * Higher than the anchored one because nothing corroborates it: a review body
 * saying "a few naming nits" should not silence a specific finding that happens
 * to share some words with it.
 */
const UNANCHORED_DUPLICATE_OVERLAP = 0.7;

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
/**
 * Whether a precedent is tied to a place in the code.
 *
 * An unanchored summary matches every candidate equally, so with owner
 * weighting applied it surfaces regardless of topic. `corpus/store.ts` already
 * warns about exactly this - on one corpus 40 of 60 owner events had no file
 * anchor - and then scores on them anyway.
 *
 * The consequence is not a weak signal but a constant one. `matchStrength` is
 * normalised to the best hit in each candidate's own result set, so when the
 * same unanchored summaries are retrieved for every candidate, every candidate
 * gets the same alignment. On a live run all eight findings drew the same three
 * precedents and the gate rejected nothing.
 *
 * A constant does not merely fail to discriminate. Owner alignment carries 0.25
 * of the final score and repository alignment 0.15, so 0.40 of it is a fixed
 * addition compressing the range available to the four terms that do. This
 * repository has ruled on that shape once already: `evidenceQuality` scored
 * 1.000 on every candidate and was described as "a fixed 0.15 added to every
 * score, carrying no information".
 */
function isAnchored(precedent: Precedent): boolean {
  return precedent.filePath !== null;
}

/** Maps signed precedent weights onto a 0..1 alignment score. */
/**
 * What alignment reports when precedent says nothing either way.
 *
 * Named because a question is gated on falling below it, so the number has to
 * mean "the owner has actively dismissed this kind of comment" rather than
 * "no precedent was retrieved".
 */
export const NEUTRAL_ALIGNMENT = 0.5;

function alignmentFrom(precedents: Precedent[]): number {
  if (precedents.length === 0) return NEUTRAL_ALIGNMENT; // No evidence either way.
  const total = precedents.reduce((sum, p) => sum + p.weight * (p.matchStrength ?? 1), 0);
  // A bounded squash keeps one loud precedent from saturating the score.
  return 1 / (1 + Math.exp(-total));
}

/**
 * The same alignment with anchor-less precedents excluded.
 *
 * Reported, not gated on. Excluding them moves the final score by 0.05 to 0.11
 * on the shapes seen in live runs, against a threshold of 0.68 - large enough
 * that switching without measuring would silently delete findings that pass
 * today. The gate's own history is the argument: 0.74 was arithmetic about a
 * distribution change and was wrong; 0.68 was measured and replaced it.
 *
 * So this ships as a shadow. Every breakdown carries what the score would be,
 * and whether eligibility would change, so the switch can be made on evidence
 * from real runs rather than on a second round of arithmetic.
 */
function anchoredAlignmentFrom(precedents: Precedent[]): number {
  return alignmentFrom(precedents.filter(isAnchored));
}

/**
 * Something that ties an observation to a specific place in the code: a line
 * reference, a path, an identifier, or quoted source.
 */
const ANCHORED = [
  /\bline\s+\d+/i,
  /:\d+\b/,
  /`[^`]+`/,
  /\b[\w$]+\.(?:ts|tsx|js|jsx|cs|py|go|rb|java|kt|rs|sql|ya?ml|json)\b/i,
  /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/,
  /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/,
];

/**
 * Evidence quality rewards specificity, not volume. Three vague observations
 * are not better evidence than one that names a line.
 *
 * Specificity used to accept "longer than 40 characters", which every analyst
 * bullet satisfies, so the term scored 1.000 on every candidate in a real run:
 * a fixed 0.15 added to every score, carrying no information. An anchor has to
 * be an actual anchor.
 */
function evidenceQuality(candidate: Candidate): number {
  const items = candidate.evidence.filter((item) => item.trim().length > 0);
  if (items.length === 0) return 0;

  const specific = items.filter((item) => ANCHORED.some((pattern) => pattern.test(item))).length;
  const breadth = Math.min(1, items.length / 3);
  const depth = specific / items.length;
  return 0.4 * breadth + 0.6 * depth;
}

/**
 * How much two candidates in different files must share before one counts as
 * a restatement of the other rather than a neighbour in the same subsystem.
 */
const CROSS_FILE_DUPLICATE = 0.8;

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
    const shared = overlap(mine, theirs);

    // Two defects in one file may well be one defect described twice. Two in
    // different files usually are not, however much vocabulary they share,
    // because a subsystem has a vocabulary. A double-submit race and an
    // unhandled failure in neighbouring hooks are not the same finding, and
    // the second one was being discarded for sounding like the first.
    if (other.path === candidate.path) {
      worst = Math.min(worst, 1 - shared);
    } else if (shared >= CROSS_FILE_DUPLICATE) {
      worst = Math.min(worst, 1 - shared);
    }
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
  verification?: Verification | undefined,
): ScoreBreakdown {
  const analystConfidence = candidate.technicalConfidence;

  const verifiedConfidence =
    verification === undefined
      ? null
      : (verification.technicalConfidence ??
        (verification.evidenceQuality === undefined
          ? null
          : (QUALITY_CONFIDENCE[verification.evidenceQuality] ?? null)));

  // The verifier is the only stage that checks the claim against the
  // repository, so where the two disagree it is the one with evidence.
  let confidence = verifiedConfidence ?? analystConfidence;
  let confidenceSource: ScoreBreakdown['confidenceSource'] = verifiedConfidence === null ? 'analyst' : 'verifier';

  // Context the verifier itself could not obtain is binding: that is the
  // verifier reporting on its own reach, not a guess about someone else's.
  const missingContext = (verification?.requiredContextMissing ?? []).length > 0;

  // The analyst's admission is a prior, not a ceiling. It used to outrank the
  // verifier absolutely, which inverted the whole point of letting the
  // verifier supersede: on a real diff the verifier established the claim
  // directly, said in as many words that the caveat bore on severity rather
  // than confidence, and was overruled by a regex reading the analyst's prose.
  // An explicit number from the verifier means it considered the question.
  const admitted = admitsUnverifiable(candidate);
  const verifierEngaged = verification?.technicalConfidence !== undefined;

  if ((missingContext || (admitted && !verifierEngaged)) && confidence > UNVERIFIABLE_CONFIDENCE) {
    confidence = UNVERIFIABLE_CONFIDENCE;
    confidenceSource = 'unverifiable-cap';
  }

  // Which floor applies depends on who established the number. The verifier
  // checked the claim; the analyst did not.
  const confidenceFloor =
    confidenceSource === 'verifier' ? thresholds.technicalConfidence : thresholds.analystOnlyConfidence;

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
  const anchoredOwnerAlignment = anchoredAlignmentFrom(ownerPrecedents);
  const anchoredRepositoryAlignment = anchoredAlignmentFrom(repositoryPrecedents);
  const quality = evidenceQuality(candidate);
  const novel = alreadySaid === null ? novelty(candidate, kept, precedents) : 0;

  const score = (owner: number, repository: number): number =>
    0.35 * confidence + 0.25 * owner + 0.15 * repository + 0.15 * quality + 0.1 * novel;

  const finalScore = score(ownerAlignment, repositoryAlignment);
  const anchoredFinalScore = score(anchoredOwnerAlignment, anchoredRepositoryAlignment);

  // A question asserts nothing, so a confidence gate protects the reader from
  // nothing.
  //
  // Four questions have been filed across the programme and not one has ever
  // reached output: 0.40, 0.30, 0.40, and one the analyst declined to file.
  // Every survivor was cut by the analyst-only floor. That is a category error
  // and it compounds - a question is raised *because* something could not be
  // verified, so low confidence is the content of a question rather than a
  // defect in it, and `admitsUnverifiable` then caps it lower still for saying
  // so. 1.3.1 fixed the derivation half of this; the gating half was untouched.
  //
  // What a question needs is not a confidence bar but a limit on how many can
  // be asked at once, since a review that ends in five questions has stopped
  // being a review.
  const isQuestion =
    deriveSeverity(candidate.category, candidate.severity, verification?.reach).severity === 'question';

  let rejectedBecause: string | null = null;
  // Checked explicitly: every comparison against NaN is false, so a
  // non-finite score would otherwise pass both thresholds below.
  if (!Number.isFinite(finalScore) || !Number.isFinite(confidence)) {
    rejectedBecause = 'score could not be computed from this candidate';
  } else if (alreadySaid !== null) {
    // Not left to the weights. Novelty carries a tenth of the score, so a
    // confident candidate with strong evidence still clears the threshold
    // while repeating a comment already published on that line.
    rejectedBecause = `already stated at ${candidate.path}:${candidate.line} in precedent ${alreadySaid.eventId}`;
  } else if (isQuestion) {
    // A question skips the confidence gates below, which measure belief in an
    // assertion it does not make. It does not skip precedent.
    //
    // The branch used to be empty, and everything below it includes the final
    // score - which is where owner alignment lives. So a question ignored
    // precedent entirely, and `/review-voice:feedback` could never teach this
    // reviewer to stop asking a class of question its owner does not want.
    // With questions now a third of output, that is a third of the review the
    // feedback loop could not reach. Measured: a question at 0.6452 shipped
    // while a nit at the higher 0.6756 was rejected.
    //
    // The whole score is the wrong instrument to restore, because 0.35 of it is
    // confidence and reinstating that would re-block the questions 1.3.3 freed.
    // What is restored is the part that carries the owner's judgement: a
    // question the owner has dismissed the like of before is not asked again.
    if (ownerAlignment < NEUTRAL_ALIGNMENT) {
      rejectedBecause =
        `owner precedent is against asking this (${ownerAlignment.toFixed(2)} alignment), ` +
        'and a question the owner has dismissed the like of before is noise the second time';
    }
  } else if (confidenceSource === 'unverifiable-cap') {
    // Stated as its own rejection rather than left to the numeric comparison.
    // It used to depend on the cap sitting below the floor, which quietly tied
    // it to a number that has since moved.
    rejectedBecause = `the claim states it could not be verified, so it cannot ship whatever it scores`;
  } else if (confidence < confidenceFloor) {
    rejectedBecause =
      `technical confidence ${confidence.toFixed(2)} (${confidenceSource}) is below ${confidenceFloor}` +
      (confidenceSource === 'analyst'
        ? '. No verification was supplied, so this is the analyst\'s opinion of its own output.'
        : '');
  } else if (finalScore < thresholds.finalScore) {
    // Four places, because two produced "score 0.78 is below 0.78" on a
    // finalScore of 0.7788996174443317. True, and unreadable.
    rejectedBecause = `score ${finalScore.toFixed(4)} is below the ${thresholds.finalScore} threshold`;
  }

  return {
    candidateId: candidate.candidateId,
    path: candidate.path,
    line: candidate.line,
    technicalConfidence: confidence,
    severity: deriveSeverity(candidate.category, candidate.severity, verification?.reach),
    analystConfidence,
    verifiedConfidence,
    confidenceSource,
    ownerAlignment,
    repositoryAlignment,
    evidenceQuality: quality,
    novelty: novel,
    finalScore,
    anchored: {
      ownerAlignment: anchoredOwnerAlignment,
      repositoryAlignment: anchoredRepositoryAlignment,
      finalScore: anchoredFinalScore,
      // Only the score gate can flip here: every other rejection reason is
      // independent of alignment.
      wouldChangeEligibility:
        rejectedBecause === null
          ? anchoredFinalScore < thresholds.finalScore
          : rejectedBecause.startsWith('score ') && anchoredFinalScore >= thresholds.finalScore,
    },
    eligible: rejectedBecause === null,
    rejectedBecause,
    duplicateOfPrecedent: alreadySaid?.eventId ?? null,
    precedentIds: precedents.map((p) => p.eventId),
  };
}
