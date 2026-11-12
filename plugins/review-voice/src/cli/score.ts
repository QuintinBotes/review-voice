import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SEVERITY_ORDER, type Severity } from '../contract/limits.ts';
import { firstPartyMatcher, isReviewable } from '../diff/classify.ts';
import { parseHunks, reason, type AnchorCheck, type FileHunks } from '../diff/hunks.ts';
import type { ThreadComment } from '../diff/thread.ts';
import { openDatabase } from '../store/db.ts';
import { DIFF_LANE, laneNamed } from '../review/lanes.ts';
import { candidateAnchor } from '../diff/reanchor.ts';
import { loadConfig } from '../policy/load.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { checkAbsenceClaim, type ExistenceCheck } from '../scoring/existence.ts';
import { computeReach } from '../scoring/reach.ts';
import { checkCitation } from '../scoring/citation.ts';
import { retrievePrecedents, type Precedent } from '../retrieval/retrieve.ts';
import {
  scoreCandidate,
  applyQuestionCap,
  alreadySaidOnThread,
  citedLocations,
  followUpOf,
  normaliseCandidate,
  isFixVerdict,
  editorFix,
  assertUniqueCandidateIds,
  MalformedCandidate,
  DEFAULT_THRESHOLDS,
  isImpactClass,
  UNVERIFIABLE_REJECTION,
  DOCUMENT_NIT_HINT,
  blockingContext,
  type Candidate,
  type RawCandidate,
  type ScoreBreakdown,
  type MissingContext,
  type Verification,
  ownerRaiseCeiling,
  QUESTION_GAP_FLOOR,
  matchingSuppression,
  POLICY_SUPPRESSED_PREFIX,
} from '../scoring/score.ts';
import {
  readStdin,
  numericFlag,
  flag,
  repositoryConfig,
  boundLists,
  refExists,
  VERDICT_KEYS,
  verificationProblem,
  verdictList,
} from './shared.ts';

/**
 * Caps long string lists and precedent excerpts in score output.
 *
 * Reach lists every path git grep found, and one line of change produced a
 * 137 KB report. Only the serialised copy is cut, so computeReach still
 * returns the full lists. A cut list gets `<name>Total` and `truncated`.
 */
/**
 * The entry with `candidate_id` beside `candidateId`. Candidates, verification
 * and `check-candidates` spell it `candidate_id`, and a pipeline joining score
 * entries back to them on that key got null for every one. Both are written
 * while `candidateId` is deprecated, so neither kind of reader breaks.
 */
function withSnakeCaseId(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    out[key] = value;
    if (key === 'candidateId') out['candidate_id'] = value;
  }
  return out;
}

/**
 * The anchor check for one candidate. A stale consumer is judged by its cause,
 * since its own line is meant to be on unchanged code.
 */
export function anchorFor(hunks: Map<string, FileHunks>, candidate: Candidate): AnchorCheck {
  return candidateAnchor(hunks, candidate);
}

/**
 * Whether a candidate whose anchor failed only because its file is in no patch
 * is about a file this change deleted, with the cited line one that file had.
 * A deleted file has nothing left to review, so it is never in the patch, yet
 * a control it held is a lead and a finding about it is real (#265). Such a
 * finding posts in the review body, since the file has no new side.
 *
 * Asked of git, never of a manifest, so no stale or crafted file can grant it:
 * both commits must be in the clone, a rename-aware comparison from their merge
 * base to --head must list the path as deleted (so neither an upstream addition
 * nor a rename's old path counts), the path must be one a review would read
 * (not generated, vendored or a lock file), and the line must lie within its
 * copy at the merge base.
 * Without both refs, as on a working-tree or staged review, nothing is exempt.
 */
export function deletedFileCheck(argv: string[]): (candidate: { path: string; line: number }, anchor: AnchorCheck) => boolean {
  const base = flag(argv, '--base');
  const head = flag(argv, '--head');
  const cwd = process.cwd();
  // refExists asks for a commit, which is what both refs must name.
  if (base === null || head === null || !refExists(base, cwd) || !refExists(head, cwd)) return () => false;
  // The list the diff was read with, so a deleted file is one a review would read here exactly when it is there.
  const firstParty = firstPartyMatcher(repositoryConfig()?.firstPartyPaths ?? []);
  const git = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  // What this change deleted, measured from where it forked: a file the base
  // branch added later is not one, and neither is a rename's old path, which
  // a rename-aware comparison reports as R rather than D. One git call, made
  // only when a candidate needs it.
  let deleted: { from: string; paths: Set<string> } | null | undefined;
  const deletions = (): { from: string; paths: Set<string> } | null => {
    if (deleted !== undefined) return deleted;
    try {
      const from = git(['merge-base', base, head]).trim();
      const listing = git(['diff', '--no-ext-diff', '--name-status', '-M', '-z', '--diff-filter=D', from, head]);
      const fields = listing.split('\0').filter((field) => field !== '');
      const paths = new Set<string>();
      // Kept as git spells them: a normalised path could match a different,
      // unchanged file (src\\guard.ts against src/guard.ts) and read its blob.
      for (let index = 0; index + 1 < fields.length; index += 2) if (fields[index] === 'D') paths.add(fields[index + 1] as string);
      deleted = { from, paths };
    } catch {
      deleted = null;
    }
    return deleted;
  };
  const lines = new Map<string, number | null>();
  const baseLines = (from: string, path: string): number | null => {
    if (lines.has(path)) return lines.get(path)!;
    let count: number | null = null;
    try {
      const text = git(['show', `${from}:${path}`]);
      count = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    } catch {
      // Not a file at the fork point: nothing to cite.
    }
    lines.set(path, count);
    return count;
  };
  return (candidate, anchor) => {
    if (anchor.ok || anchor.kind !== 'file-not-in-diff') return false;
    const path = candidate.path.replace(/^\.\/+/, '');
    if (path === '' || path.startsWith('/') || path.split(/[\\/]/).includes('..') || !isReviewable(path, false, firstParty)) return false;
    const found = deletions();
    if (found === null || !found.paths.has(path)) return false;
    const count = baseLines(found.from, path);
    return count !== null && Number.isInteger(candidate.line) && candidate.line >= 1 && candidate.line <= count;
  };
}

/** A tier an owner may explicitly lower a scored finding to. Questions are not tiers to override. */
const OWNER_OVERRIDE_SEVERITIES = ['blocking', 'important', 'minor', 'nit'] as const;

type OwnerOverrideSeverity = (typeof OWNER_OVERRIDE_SEVERITIES)[number];

/**
 * Reads repeatable `--severity candidate_id=tier` owner downgrades.
 *
 * The score is still the source of truth for validation. This switch merely
 * makes a narrower owner judgement explicit in that score instead of inviting
 * an edit to the generated JSON after scoring.
 */
function ownerSeverityOverrides(argv: string[], candidates: readonly Candidate[]): Map<string, OwnerOverrideSeverity> | string {
  const overrides = new Map<string, OwnerOverrideSeverity>();
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--severity') continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return '--severity needs candidate_id=tier, for example cand_001=minor.';
    }
    const separator = value.indexOf('=');
    if (separator < 1 || separator !== value.lastIndexOf('=')) {
      return `--severity ${JSON.stringify(value)} must be candidate_id=tier.`;
    }
    const candidateId = value.slice(0, separator);
    const severity = value.slice(separator + 1);
    if (!known.has(candidateId)) return `--severity names unknown candidate ${JSON.stringify(candidateId)}.`;
    if (!(OWNER_OVERRIDE_SEVERITIES as readonly string[]).includes(severity)) {
      return `--severity ${JSON.stringify(value)} must use one of ${OWNER_OVERRIDE_SEVERITIES.join(', ')}.`;
    }
    if (overrides.has(candidateId)) return `--severity names ${JSON.stringify(candidateId)} more than once.`;
    overrides.set(candidateId, severity as OwnerOverrideSeverity);
  }
  return overrides;
}

/**
 * Reads repeatable `--promote candidate_id` owner decisions: post a verified
 * finding that the score or confidence gate alone held back, or one an
 * approved suppression held back. `--as-question` ids are read the same way.
 */
function ownerPromotions(argv: string[], candidates: readonly Candidate[], option: string = '--promote'): Set<string> | string {
  const promotions = new Set<string>();
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== option) continue;
    const candidateId = argv[index + 1];
    if (candidateId === undefined || candidateId.startsWith('--')) {
      return `${option} needs a candidate_id, for example cand_001.`;
    }
    if (!known.has(candidateId)) return `${option} names unknown candidate ${JSON.stringify(candidateId)}.`;
    if (promotions.has(candidateId)) return `${option} names ${JSON.stringify(candidateId)} more than once.`;
    promotions.add(candidateId);
  }
  return promotions;
}

/**
 * Why `--as-question` cannot apply to a candidate, or null. Only a verified
 * minor or nit qualifies: a question still rests on checked facts, and turning
 * a blocking or important finding into one would soften a request for changes
 * into a comment (#361).
 */
function ownerQuestionProblem(breakdown: ScoreBreakdown, verification: Verification | undefined): string | null {
  const id = breakdown.candidateId;
  const tier = breakdown.severity.severity;
  if (tier === 'question') return `--as-question ${id}: it is already a question.`;
  if (tier === 'blocking' || tier === 'important') {
    return (
      `--as-question ${id}: its tier is ${tier}, and posting it as a question would soften a request for changes into a comment. ` +
      `Use --promote ${id} to post it at its tier, or lower it with --severity ${id}=<tier> first.`
    );
  }
  if (verification?.verified !== true) {
    return `--as-question ${id}: the verifier did not verify it (verified is not true), and a question still rests on checked facts.`;
  }
  return null;
}

/**
 * Applies one promotion. Only what `belowGate` or `suppressed` would list
 * qualifies: the verifier confirmed it and one gate, which is preference,
 * stopped it. Anything else was stopped by a check of the claim itself.
 */
function applyOwnerPromotion(breakdown: ScoreBreakdown, ownerNote: string | null, option: string = '--promote'): string | null {
  const gate = gateOf(breakdown.rejectedBecause);
  if (breakdown.eligible) return `${option} ${breakdown.candidateId}: it is already eligible.`;
  // The unverifiable cap is a check of the claim, not a preference gate, so it
  // only lifts on an explicit owner decision that is recorded with its reason (#163).
  if (breakdown.confidenceSource === 'unverifiable-cap' && breakdown.rejectedBecause === UNVERIFIABLE_REJECTION) {
    if (ownerNote === null) {
      return (
        `${option} ${breakdown.candidateId}: it is capped as unverifiable (${breakdown.unverifiableBecause}). ` +
        'Pass --allow-unverifiable with --owner-note "<why>" to post it on the owner\'s decision.'
      );
    }
    breakdown.ownerPromotion = { gate: 'unverifiable', heldBecause: breakdown.rejectedBecause, ownerNote };
    breakdown.eligible = true;
    breakdown.rejectedBecause = null;
    return null;
  }
  // A suppression holds only a candidate that was eligible when it applied, so
  // lifting it restores that eligibility whatever the confidence source was: a
  // question kept eligible under the unverifiable cap is still postable.
  if (gate === 'policy') {
    breakdown.ownerPromotion = { gate, heldBecause: breakdown.rejectedBecause!, ruleId: breakdown.rejectedBecause!.slice(POLICY_SUPPRESSED_PREFIX.length) };
    breakdown.eligible = true;
    breakdown.rejectedBecause = null;
    return null;
  }
  if (breakdown.confidenceSource !== 'verifier' || !Number.isFinite(breakdown.finalScore) || gate === null) {
    return (
      `${option} ${breakdown.candidateId}: only a verified finding held by the score or confidence gate alone ` +
      `can be promoted, and this one was rejected because ${breakdown.rejectedBecause}.`
    );
  }
  breakdown.ownerPromotion = { gate, heldBecause: breakdown.rejectedBecause! };
  breakdown.eligible = true;
  breakdown.rejectedBecause = null;
  return null;
}

/**
 * Applies one explicit owner override after deterministic derivation. It
 * lowers a tier, or raises one only up to `ceiling`, the tier the legacy-tier
 * hint names (#216).
 */
function applyOwnerSeverityOverride(breakdown: ScoreBreakdown, override: OwnerOverrideSeverity, ceiling: Severity | null): string | null {
  const current = breakdown.severity.severity;
  if (current === 'question') return `--severity cannot override question for ${breakdown.candidateId}.`;
  const raises = SEVERITY_ORDER[override] < SEVERITY_ORDER[current as Severity];
  const raiseAllowed = raises && ceiling !== null && SEVERITY_ORDER[override] >= SEVERITY_ORDER[ceiling];
  if (SEVERITY_ORDER[override] === SEVERITY_ORDER[current as Severity] || (raises && !raiseAllowed)) {
    return (
      `--severity ${breakdown.candidateId}=${override} must lower the scored ${current} tier; ` +
      'owner overrides cannot restate a severity, and raise one only as far as its legacy-tier hint names' +
      (ceiling === null ? ' (it names none).' : ` (${ceiling}).`)
    );
  }
  breakdown.severity = {
    ...breakdown.severity,
    severity: override,
    reason: `${breakdown.severity.reason}, ${raises ? 'raised' : 'held'} at ${override} by an explicit owner override`,
  };
  // At nit the documentation exception applies, so the rejection that pointed
  // the owner here lifts, but only when it was the sole reason (#166).
  const hint = DOCUMENT_NIT_HINT.replace('<id>', breakdown.candidateId);
  if (override === 'nit' && breakdown.rejectedBecause?.endsWith(hint) && !breakdown.rejectedBecause.includes(' Also: ')) {
    breakdown.eligible = true;
    breakdown.rejectedBecause = null;
  }
  return null;
}

export function scoreCommand(argv: string[]): number {
  let candidates: Candidate[];
  try {
    const parsed = JSON.parse(readStdin()) as { candidates?: RawCandidate[] } | RawCandidate[];
    const raw = Array.isArray(parsed) ? parsed : (parsed.candidates ?? []);
    candidates = raw.map((candidate, index) => normaliseCandidate(candidate, index));
    assertUniqueCandidateIds(candidates);
  } catch (error) {
    if (error instanceof MalformedCandidate) {
      // Refused rather than scored as zero: a candidate that cannot be scored
      // must not quietly become eligible.
      console.error(`Malformed candidate - ${error.message}`);
      console.error('Re-run the analyst with the schema restated. Do not hand-translate its output.');
      return 2;
    }
    console.error('Expected {"candidates": [...]} on stdin.');
    return 2;
  }

  const severityOverrides = ownerSeverityOverrides(argv, candidates);
  if (typeof severityOverrides === 'string') {
    console.error(severityOverrides);
    return 2;
  }

  const promotions = ownerPromotions(argv, candidates);
  if (typeof promotions === 'string') {
    console.error(promotions);
    return 2;
  }
  const questions = ownerPromotions(argv, candidates, '--as-question');
  if (typeof questions === 'string') {
    console.error(questions);
    return 2;
  }
  const allowUnverifiable = argv.includes('--allow-unverifiable');
  const ownerNote = flag(argv, '--owner-note');
  if (allowUnverifiable && (ownerNote === null || ownerNote.trim() === '')) {
    console.error('--allow-unverifiable needs --owner-note "<why>": the run records why the owner posted it.');
    return 2;
  }
  const unverifiableNote = allowUnverifiable ? ownerNote!.trim() : null;

  const configured = repositoryConfig()?.thresholds ?? {};
  const thresholds = {
    technicalConfidence: Number(
      flag(argv, '--min-confidence') ?? configured.technicalConfidence ?? DEFAULT_THRESHOLDS.technicalConfidence,
    ),
    analystOnlyConfidence: Number(
      flag(argv, '--min-analyst-confidence') ?? DEFAULT_THRESHOLDS.analystOnlyConfidence,
    ),
    finalScore: Number(flag(argv, '--min-score') ?? configured.finalScore ?? DEFAULT_THRESHOLDS.finalScore),
  };

  // The evidence-verifier's conclusions, keyed by candidate. Without them the
  // gate falls back to the analyst's opinion of its own output, which is the
  // one number in the pipeline with no evidence behind it.
  const verifications = new Map<string, Verification>();
  const verificationFlag = flag(argv, '--verification');
  if (verificationFlag !== null) {
    try {
      const parsed = JSON.parse(readFileSync(verificationFlag, 'utf8')) as unknown;
      const list = verdictList(parsed);
      const problem = verificationProblem(list);
      if (problem !== null) {
        console.error(`Malformed verification - ${problem}`);
        console.error('Re-run the evidence-verifier with the schema restated. Do not hand-translate its output.');
        return 2;
      }
      for (const raw of list) {
        const id = (raw['candidate_id'] ?? raw['candidateId']) as string;
        const fixVerdict = raw['fix_verdict'] ?? raw['fixVerdict'];
        const fixConfidence = raw['fix_confidence'] ?? raw['fixConfidence'];
        const fixReason = raw['fix_reason'] ?? raw['fixReason'];
        const fixDirection = raw['fix_direction'] ?? raw['fixDirection'];
        const impactTraced = raw['impact_traced'] ?? raw['impactTraced'];
        const impactClass = raw['impact_class'] ?? raw['impactClass'];
        const premisesVerified = raw['premises_verified'] ?? raw['premisesVerified'];
        const verified = raw['verified'];
        const reason = raw['reason'];
        const blockerConfirmed = raw['blocker_confirmed'] ?? raw['blockerConfirmed'];
        verifications.set(id, {
          candidateId: id,
          evidenceQuality: (raw['evidence_quality'] ?? raw['evidenceQuality']) as Verification['evidenceQuality'],
          technicalConfidence: (raw['technical_confidence'] ?? raw['technicalConfidence']) as number | undefined,
          // Unknown verdicts are missing, not a new state an editor could
          // interpret optimistically. Rendering must fail closed here.
          fixVerdict: isFixVerdict(fixVerdict) ? fixVerdict : undefined,
          fixConfidence:
            typeof fixConfidence === 'number' &&
            Number.isFinite(fixConfidence) &&
            fixConfidence >= 0 &&
            fixConfidence <= 1
              ? fixConfidence
              : undefined,
          fixReason: typeof fixReason === 'string' ? fixReason : undefined,
          fixDirection: typeof fixDirection === 'string' ? fixDirection : undefined,
          // Only a real boolean counts; a string "true" is not evidence.
          impactTraced: typeof impactTraced === 'boolean' ? impactTraced : undefined,
          // Already checked by `verificationProblem`.
          impactClass: isImpactClass(impactClass) ? impactClass : undefined,
          premisesVerified: typeof premisesVerified === 'boolean' ? premisesVerified : undefined,
          verified: typeof verified === 'boolean' ? verified : undefined,
          blockerConfirmed: typeof blockerConfirmed === 'boolean' ? blockerConfirmed : undefined,
          reason: typeof reason === 'string' ? reason : undefined,
          requiredContextMissing: (raw['required_context_missing'] ??
            raw['requiredContextMissing']) as MissingContext[] | undefined,
          // Already checked by `verificationProblem`.
          partlyAddressed: (raw['partly_addressed'] ?? raw['partlyAddressed']) as Verification['partlyAddressed'],
        });
      }
    } catch (error) {
      console.error(`Cannot read ${verificationFlag}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }

    // A file that parses to nothing is the failure mode this flag exists to
    // prevent. Reading zero verifications and scoring anyway is exactly the
    // silent fallback to the analyst's self-report that the gate was changed
    // to stop, and it produced a clean exit 0 while doing it. With no
    // candidates there is nothing to verify, so an empty file is the honest
    // answer and a clean review runs the same pipeline (#232).
    if (verifications.size === 0 && candidates.length > 0) {
      console.error(
        `${verificationFlag} contained no verifications. Expected an array, or an object with ` +
          `one of: ${VERDICT_KEYS.join(', ')}, each entry carrying candidate_id. ` +
          'Refusing to score on the analyst self-report while a verification file was supplied.',
      );
      return 2;
    }

    // Both are warnings: an id the verifier invented scores nothing, and a
    // candidate it skipped falls back to the analyst's confidence, which the
    // gate already reports as confidenceSource 'analyst'.
    const known = new Set(candidates.map((candidate) => candidate.candidateId));
    const unknown = [...verifications.keys()].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      console.error(`Warning: ${verificationFlag} verifies unknown candidate id(s): ${unknown.join(', ')}. Ignored.`);
    }
    const unverified = candidates.filter((candidate) => !verifications.has(candidate.candidateId));
    if (unverified.length > 0) {
      console.error(
        `Warning: no verification for ${unverified.map((candidate) => candidate.candidateId).join(', ')}; ` +
          "they are scored on the analyst's own confidence.",
      );
    }
  }

  // Absence claims are checked against the tree under review, which is not the
  // working tree when reviewing a pull request. A checkout behind the base
  // reports two files as absent that the base contains, and an empty result
  // then reads as the guard corroborating a false claim.
  let searchRoot: string | null = null;
  try {
    searchRoot = repositoryRoot(process.cwd());
  } catch {
    searchRoot = null;
  }

  const baseRef = flag(argv, '--base');
  if (baseRef !== null && searchRoot !== null && !refExists(baseRef, searchRoot)) {
    console.error(
      `--base ${baseRef} does not resolve in this repository. Fetch it, or omit the flag ` +
        'to search the working tree. Absence claims would otherwise be checked against nothing.',
    );
    return 2;
  }

  // Reach is deterministic repository evidence, not a verifier verdict. Keep
  // it alongside verification only because that is the existing metadata
  // channel into scoring. A reach-only record leaves confidence behaviour
  // unchanged when no verifier output was supplied.
  // The diff decides which symbols reach is measured from. Without it reach
  // falls back to the claim's symbols, which measures the words a finding used
  // rather than the code it is about.
  let reachDiff: string | null = null;
  let anchorHunks: Map<string, FileHunks> | null = null;
  if (argv.includes('--diff-file')) {
    const path = flag(argv, '--diff-file');
    if (path === null) {
      console.error('--diff-file needs a unified diff path.');
      return 2;
    }
    try {
      reachDiff = readFileSync(path, 'utf8');
      anchorHunks = parseHunks(reachDiff);
    } catch (error) {
      console.error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  const onDeletedFile = deletedFileCheck(argv);

  let thread: ThreadComment[] = [];
  if (argv.includes('--thread')) {
    const path = flag(argv, '--thread');
    if (path === null) {
      console.error('--thread needs a thread JSON path.');
      return 2;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { comments?: ThreadComment[] };
      thread = Array.isArray(parsed) ? parsed : (parsed.comments ?? []);
    } catch (error) {
      console.error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (searchRoot !== null) {
    const firstParty = firstPartyMatcher(repositoryConfig()?.firstPartyPaths ?? []);
    for (const candidate of candidates) {
      const verification = verifications.get(candidate.candidateId);
      verifications.set(candidate.candidateId, {
        ...(verification ?? { candidateId: candidate.candidateId }),
        candidateId: candidate.candidateId,
        reach: computeReach(
          candidate.claim,
          candidate.path,
          searchRoot,
          baseRef,
          undefined,
          reachDiff,
          firstParty,
        ),
      });
    }
  }

  // Whose comment a partly-addressed follow-up may set aside: the owner's,
  // checked here rather than taken from the candidate's own label.
  const owner = flag(argv, '--owner') ?? configuredOwner();

  const pullFlag = argv.includes('--exclude-pull') ? numericFlag(argv, '--exclude-pull', 0) : null;
  if (argv.includes('--exclude-pull') && pullFlag === null) {
    console.error('--exclude-pull needs a pull request number.');
    return 2;
  }

  const lanes = repositoryConfig()?.lanes ?? [DIFF_LANE];

  const db = openDatabase();
  try {
    // The store is passed so the loaded layers include the owner's approved
    // policies, whose suppressions are applied below (docs/adr/0032). Without
    // a repository there is no configuration and so nothing to suppress. The
    // versions loaded go into the output, so `record` stores what this run was
    // held to even if a policy changes between the two commands.
    const loadedConfig = repositoryConfig(db);
    const suppressions = loadedConfig?.suppressions ?? [];
    const policyVersions = loadedConfig?.activePolicyVersions ?? [];
    const suppressionByCandidate = new Map<string, NonNullable<ReturnType<typeof matchingSuppression>>>();
    const kept: Candidate[] = [];
    const results: (ScoreBreakdown & { precedents: Precedent[]; absenceCheck?: ExistenceCheck })[] = [];
    const followUps = new Map<string, NonNullable<ReturnType<typeof followUpOf>>>();

    // Scored in order so novelty is measured against what has already been
    // kept, not against every candidate including worse duplicates.
    for (const candidate of candidates) {
      const precedents = retrievePrecedents(db, {
        text: `${candidate.claim} ${candidate.failureMode}`,
        repository: flag(argv, '--repository') ?? undefined,
        filePath: candidate.path,
        // A comment on the pull request under review is the conversation, not
        // precedent, and it is the route by which a posted review comes back
        // as evidence of the owner's taste on the very finding that produced
        // it.
        excludePullNumber: pullFlag ?? undefined,
        maxPositive: 3,
        maxNegative: 2,
      });
      const verification = verifications.get(candidate.candidateId);
      const lane = laneNamed(lanes, candidate.lane);
      const breakdown = scoreCandidate(candidate, precedents, kept, thresholds, verification, lane);
      const override = severityOverrides.get(candidate.candidateId);
      if (override !== undefined) {
        const problem = applyOwnerSeverityOverride(breakdown, override, ownerRaiseCeiling(breakdown.severity, candidate, verification, lane));
        if (problem !== null) {
          console.error(problem);
          return 2;
        }
      }

      // An approved suppression holds a candidate the verifier's verdict left
      // eligible, before the checks below run, so a failure in one of them is
      // still appended to its reason and it is then no longer held by policy
      // alone. A suppression is preference, not truth, so it never overwrites
      // a rejection a check of the claim itself already made, and the owner
      // can still post the finding with `--promote` (docs/adr/0032).
      if (breakdown.eligible) {
        const suppression = matchingSuppression(suppressions, candidate);
        if (suppression !== null) {
          breakdown.eligible = false;
          breakdown.rejectedBecause = `${POLICY_SUPPRESSED_PREFIX}${suppression.ruleId}`;
          suppressionByCandidate.set(candidate.candidateId, suppression);
        }
      }

      // A claim that something is absent is checked against the repository
      // before anything else is weighed. It is the cheapest class of claim to
      // verify and the most damaging to get wrong: a reviewer that invents an
      // absence tells the author to break working code.
      let absence = null;
      if (searchRoot !== null) {
        try {
          // The claim only, never the failure mode. Concatenating them handed
          // the sentence explaining the consequence a vote on whether the
          // assertion was scoped, so the same invented claim was checked or
          // ignored depending on how its impact was worded, and a symbol named
          // in the mechanism could be reported as one the claim said was
          // absent.
          absence = checkAbsenceClaim(
            candidate.claim,
            searchRoot,
            baseRef,
            undefined,
            flag(argv, '--repository'),
          );
        } catch {
          absence = null;
        }
      }

      if (absence !== null && absence.found.length > 0) {
        breakdown.eligible = false;
        breakdown.rejectedBecause =
          `claims something is absent, but the repository contains ${absence.found.join(', ')}`;
      }

      // A point already on the page is not worth making again, whoever made
      // it. On the first posted batch this removed more candidates than every
      // other stage combined, because those repositories already run a bot.
      //
      // The exception is a follow-up on the owner's own comment that the author
      // only partly addressed: it restates that comment by design, so the
      // owner's own inline comments are not held against it. Anyone else's are.
      const followUp = followUpOf(candidate, verifications.get(candidate.candidateId), thread, owner);
      if (followUp !== null) followUps.set(candidate.candidateId, followUp);
      else if (verifications.get(candidate.candidateId)?.partlyAddressed !== undefined) {
        console.error(
          `Warning: ${candidate.candidateId} is marked partly_addressed but is not linked to a comment of the ` +
            'owner on this thread. Scored as an ordinary finding.',
        );
      }
      // Only the linked comment is set aside. Any other comment, the owner's
      // own included, still rejects a candidate that repeats it.
      // A citation in the follow-up author's own review body is set aside with
      // it: it is the same owner pointing at the same place.
      const echoThread =
        followUp === null
          ? citedLocations(thread)
          : citedLocations(thread).filter(
              (comment) =>
                !(comment.author === followUp.author && comment.path === followUp.path && comment.line === followUp.line) &&
                !(comment.cited === true && comment.author === followUp.author),
            );

      // A candidate one local gate stopped is still checked against the rules
      // below, so `belowGate` and `unverified` list only what that gate alone
      // stopped. A failure here is appended rather than replacing the reason.
      const listable = !breakdown.eligible && locallyListable(breakdown.rejectedBecause);
      const alsoRejected = (because: string): void => {
        breakdown.rejectedBecause = `${breakdown.rejectedBecause ?? ''}. Also: ${because}`;
      };

      const echoed = breakdown.eligible || listable ? alreadySaidOnThread(candidate, echoThread) : null;
      if (echoed !== null) {
        const because =
          `already said on this pull request by ${echoed.author}` +
          (echoed.path === null ? '' : ` at ${echoed.path}:${echoed.line ?? '?'}`);
        if (breakdown.eligible) {
          breakdown.eligible = false;
          breakdown.rejectedBecause = because;
        } else {
          alsoRejected(because);
        }
      }

      // A candidate can only become a review comment where the reviewed diff
      // changed code. A nearby removed guard is valid at its right-side site;
      // an unchanged context line is not silently moved there for the analyst.
      const anchorCheck = anchorHunks === null ? null : anchorFor(anchorHunks, candidate);
      // The anchor reason leads even when something else rejected the
      // candidate first: it is the one an analyst can act on, and leaving it
      // behind a score threshold hides why re-anchoring was needed.
      if (anchorCheck !== null && !anchorCheck.ok && !onDeletedFile(candidate, anchorCheck)) {
        const earlier = breakdown.rejectedBecause;
        breakdown.eligible = false;
        breakdown.rejectedBecause = reason(anchorCheck) + (earlier === null ? '' : ` Also: ${earlier}`);
      }

      // The path is the one field nothing checked, and a wrong one sends the
      // author to a file that does not exist.
      let citation = null;
      const stillListable = !breakdown.eligible && listable && locallyListable(breakdown.rejectedBecause);
      if ((breakdown.eligible || stillListable) && searchRoot !== null) {
        citation = checkCitation(candidate.path, searchRoot, baseRef, reachDiff);
        if (!citation.resolves && !citation.inconclusive) {
          const because =
            `cites ${candidate.path}, which does not exist at the reviewed ref` +
            (citation.suggestion === null ? '' : `; did it mean ${citation.suggestion}?`);
          if (breakdown.eligible) {
            breakdown.eligible = false;
            breakdown.rejectedBecause = because;
          } else {
            alsoRejected(because);
          }
        }
      }

      // --as-question posts a held finding as --promote would, and only changes
      // the tier of an eligible one, so naming both means --as-question alone.
      const asQuestion = questions.has(candidate.candidateId);
      const promote = asQuestion ? !breakdown.eligible : promotions.has(candidate.candidateId);
      const problem =
        (asQuestion ? ownerQuestionProblem(breakdown, verification) : null) ??
        (promote ? applyOwnerPromotion(breakdown, unverifiableNote, asQuestion ? '--as-question' : '--promote') : null);
      if (problem !== null) {
        console.error(problem);
        return 2;
      }
      if (asQuestion) {
        breakdown.ownerQuestionFrom = breakdown.severity.severity as 'minor' | 'nit';
        breakdown.severity = { ...breakdown.severity, severity: 'question', reason: `${breakdown.severity.reason}, the owner posted this as a question` };
        breakdown.ownerQuestion = true;
      }

      if (breakdown.eligible) kept.push(candidate);
      results.push({
        ...breakdown,
        precedents,
        ...(absence === null ? {} : { absenceCheck: absence }),
        ...(anchorCheck === null ? {} : { anchorCheck }),
        // Read by the posting plan: a finding with no new-side line goes in the body.
        ...(anchorCheck !== null && onDeletedFile(candidate, anchorCheck) ? { deletedFile: true } : {}),
        ...(citation === null ? {} : { citationCheck: citation }),
      });
    }

    // After every question has a score to rank by, not while scoring. Applied
    // before the distribution below so `cleared` counts what actually ships.
    applyQuestionCap(results);

    // Confirmed by the verifier and stopped by one numeric gate alone: the
    // final score, which is preference, or the floor on the verifier's own
    // confidence. Real by the verifier's account, but not shipped. Shown
    // locally so it is not lost, and never posted. A rejection from any other
    // gate leads its reason or is appended after "Also:", so the prefix tells
    // them apart; `gate` says which one stopped it.
    const belowGate = results
      .filter(
        (r) =>
          r.confidenceSource === 'verifier' &&
          !r.eligible &&
          Number.isFinite(r.finalScore) &&
          gateOf(r.rejectedBecause) !== null &&
          gateOf(r.rejectedBecause) !== 'policy',
      )
      .map((r) => {
        const gate = gateOf(r.rejectedBecause);
        return boundLists({
          candidateId: r.candidateId,
          path: r.path,
          line: r.line,
          severity: r.severity.severity,
          claim: candidates.find((c) => c.candidateId === r.candidateId)?.claim ?? '',
          confidenceSource: r.confidenceSource,
          gate,
          ...(gate === 'score'
            ? { finalScore: r.finalScore, threshold: thresholds.finalScore }
            : {
                technicalConfidence: r.technicalConfidence,
                threshold: r.severity.severity === 'question' ? QUESTION_GAP_FLOOR : thresholds.technicalConfidence,
              }),
        });
      });

    // Held by an approved suppression alone, and listed here rather than in
    // `belowGate` so the driver holds each one once, as `policy-suppressed`.
    // Shown locally like `belowGate`, and never posted unless the owner
    // promotes it: a suppression is preference, not truth (docs/adr/0032).
    const suppressed = results
      .filter((r) => !r.eligible && gateOf(r.rejectedBecause) === 'policy')
      .map((r) => {
        const suppression = suppressionByCandidate.get(r.candidateId);
        return boundLists({
          candidateId: r.candidateId,
          ruleId: suppression?.ruleId ?? r.rejectedBecause!.slice(POLICY_SUPPRESSED_PREFIX.length),
          path: r.path,
          line: r.line,
          severity: r.severity.severity,
          claim: candidates.find((c) => c.candidateId === r.candidateId)?.claim ?? '',
          policyVersion: suppression?.policyVersion ?? null,
        });
      });

    // Held back by the verifier's own report of context it could not obtain,
    // and by nothing else. The claim may well be right - one was later
    // confirmed end to end and was the most useful point of its review - so
    // the owner sees it locally, with what was missing. Never posted.
    const unverified = results
      .filter((r) => r.confidenceSource === 'unverifiable-cap' && r.rejectedBecause === UNVERIFIABLE_REJECTION)
      .flatMap((r) => {
        const missing = blockingContext(verifications.get(r.candidateId)?.requiredContextMissing);
        if (missing.length === 0) return [];
        return [
          boundLists({
            candidateId: r.candidateId,
            path: r.path,
            line: r.line,
            severity: r.severity.severity,
            claim: candidates.find((c) => c.candidateId === r.candidateId)?.claim ?? '',
            verifierConfidence: r.verifiedConfidence,
            requiredContextMissing: missing,
          }),
        ];
      });

    // Verified, then contradicted by the repository search. One of the two is
    // wrong, so the owner sees it locally rather than losing it. Never posted.
    const absenceContradicted = results
      .filter((r) => !r.eligible && r.absenceCheck !== undefined && r.absenceCheck.found.length > 0)
      .filter((r) => verifications.get(r.candidateId)?.verified === true)
      .map((r) =>
        boundLists({
          candidateId: r.candidateId,
          path: r.path,
          line: r.line,
          severity: r.severity.severity,
          claim: candidates.find((c) => c.candidateId === r.candidateId)?.claim ?? '',
          found: r.absenceCheck!.found,
          rejectedBecause: r.rejectedBecause,
        }),
      );
    // Render order, the one validate-output enforces: severity, then the higher
    // final score. Handing the editor sorted input means it never has to
    // re-sort, which it did not reliably do (#144).
    const scoreOf = new Map(results.map((r) => [r.candidateId, r]));
    const rank = (c: Candidate): [number, number] => {
      const scored = scoreOf.get(c.candidateId);
      return [SEVERITY_ORDER[(scored?.severity.severity ?? c.severity) as Severity], -(scored?.finalScore ?? 0)];
    };
    kept.sort((a, b) => {
      const [sa, fa] = rank(a);
      const [sb, fb] = rank(b);
      return sa - sb || fa - fb;
    });

    const finals = results
      .map((r) => r.finalScore)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const at = (p: number): number | null =>
      finals.length === 0 ? null : (finals[Math.min(finals.length - 1, Math.floor(p * finals.length))] as number);

    console.log(
      JSON.stringify(
        {
          scores: (boundLists(results) as unknown[]).map(withSnakeCaseId),
          // Reported every run so the threshold stops being a constant nobody
          // can check. A gate sitting above the whole distribution is not
          // selective, it is miscalibrated, and that is only visible here.
          distribution: {
            count: finals.length,
            min: at(0),
            median: at(0.5),
            max: finals.length === 0 ? null : (finals[finals.length - 1] as number),
            threshold: thresholds.finalScore,
            // What actually ships, not what cleared this one gate. Counting
            // scores above the threshold ignored candidates the confidence
            // gate had already rejected, so the block overstated the yield in
            // exactly the place the operator is asked to report it.
            cleared: results.filter((r) => r.eligible).length,
            // Named, because a run scored without verification has no
            // precision defence beyond precedent, and that should not be
            // something the reader has to infer from a missing flag.
            gatedOnAnalystSelfReport: results.filter((r) => r.confidenceSource === 'analyst').length,
            aboveThreshold: finals.filter((v) => v >= thresholds.finalScore).length,
          },
          // Enough to carry a survivor forward without rejoining by hand.
          // Severity is the derived tier, not the requested one. Ordering is
          // severity-first, and asking produced `minor` at confidence 0.90 and
          // `important` at 0.85 for the same finding on an identical diff.
          // The editor states the fix text verbatim, so it is never cut: a
          // repair ending in `...` would be posted as a broken sentence.
          eligible: kept.map((c) => {
            const scored = results.find((r) => r.candidateId === c.candidateId);
            const derived = scored?.severity;
            const bounded = boundLists({
              candidateId: c.candidateId,
              path: c.path,
              line: c.line,
              severity: derived?.severity ?? c.severity,
              requestedSeverity: c.severity,
              severityReason: derived?.reason ?? null,
              // Whether the verifier or a fallback set the confidence, without a join to `scores` (#220).
              confidenceSource: scored?.confidenceSource ?? null,
              category: c.category,
              // The driver records these entries as the run's candidates, and
              // a finding's rule id is derived from them: without the lane and
              // the blocker class every recorded rule would read `:diff`.
              lane: c.lane,
              blockerClass: c.blockerClass,
              // What the editor writes from. It has no tools, so everything it
              // may state has to be here, and nothing it may not.
              claim: c.claim,
              failureMode: c.failureMode,
              evidence: c.evidence,
              // Only the repair text the editor may state. A refuted repair is
              // left out rather than handed over with an instruction not to use
              // it; the full decision stays in `scores` for `explain`.
            }) as Record<string, unknown>;
            return {
              ...(withSnakeCaseId(bounded) as Record<string, unknown>),
              fix: scored === undefined ? { render: 'none' as const, text: null } : editorFix(scored.fix),
              // Outside the bound, as code must arrive whole; `normaliseCandidate`
              // already capped it at that length. `record` stores it with the
              // finding, and posting renders it only behind the verified fix.
              // The path it was checked on travels inside the patch, which nothing
              // that moves a finding (reanchor, the challenge) rewrites, so a move
              // shows at post time as a patch written for another place.
              ...(c.suggestedPatch === undefined ? {} : { suggested_patch: { ...c.suggestedPatch, path: c.path } }),
              // The editor names the cause in the prose, since the consumer's
              // line is what the finding's location shows.
              ...(c.anchor === 'stale-consumer' ? { anchor: c.anchor, causedBy: c.causedBy ?? null } : {}),
              // A follow-up states only what remains of the owner's earlier
              // comment, as an ordinary finding; `record` stores that state.
              ...(followUps.has(c.candidateId)
                ? { possibleRepeatOf: { kind: 'own-comment', status: 'partly-addressed', ...followUps.get(c.candidateId) } }
                : {}),
              // A contested point is marked so the editor leaves it out: the
              // second pass disputed how far the failure reaches and no
              // tie-break upheld the wider claim.
              ...(c.impactDisputed === true ? { impactDisputed: true } : {}),
            };
          }),
          belowGate: belowGate.map(withSnakeCaseId),
          suppressed: suppressed.map(withSnakeCaseId),
          unverified: unverified.map(withSnakeCaseId),
          absenceContradicted: absenceContradicted.map(withSnakeCaseId),
          policyVersions,
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Whether a rejection came from one of the gates whose candidates are listed
 * locally - the unverifiable cap, the confidence floor, the final score or an
 * approved suppression - and from nothing else yet.
 */
function locallyListable(rejectedBecause: string | null): boolean {
  if (rejectedBecause === null) return false;
  return rejectedBecause === UNVERIFIABLE_REJECTION || gateOf(rejectedBecause) !== null;
}

/** The gate that alone stopped a candidate, or null. */
function gateOf(rejectedBecause: string | null): 'score' | 'confidence' | 'policy' | null {
  if (rejectedBecause === null || rejectedBecause.includes(' Also: ')) return null;
  if (rejectedBecause.startsWith(POLICY_SUPPRESSED_PREFIX)) return 'policy';
  if (rejectedBecause.startsWith('score ')) return 'score';
  if (rejectedBecause.startsWith('technical confidence ')) return 'confidence';
  return null;
}

/** The configured owner reviewer, or null outside a configured repository. */
export function configuredOwner(): string | null {
  try {
    return loadConfig(repositoryRoot(process.cwd())).ownerReviewer;
  } catch {
    return null;
  }
}
