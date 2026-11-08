/**
 * Review Voice CLI - the deterministic half of the plugin.
 *
 * Everything that can be decided by arithmetic or plumbing lives here: diff
 * acquisition, config and policy layering, static evidence, retrieval,
 * preference scoring, output validation, storage and audit. Judgement calls
 * (candidate generation, verification, wording) live in the plugin's agents.
 * See docs/ARCHITECTURE.md for why the line is drawn there.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { format } from 'node:util';
import { suppressSqliteExperimentalWarning } from './warnings.ts';
import { pluginVersion } from './version.ts';
import { OPTIONAL_CHECKS, runDoctor } from './doctor.ts';
import { validateOutput } from './contract/validate.ts';
import { splitFindings, parseFinding } from './contract/parse.ts';
import { DEFAULT_LIMITS, SEVERITY_ORDER, type Severity } from './contract/limits.ts';
import { GitError } from './diff/acquire.ts';
import {
  parseComplexity,
  type ComplexityAssessment,
} from './diff/complexity.ts';
import {
  parseVerifiedSimplification,
  type VerifiedSimplification,
} from './simplification.ts';
import { isReviewable } from './diff/classify.ts';
import { parseReviewScope, type ReviewScope } from './diff/incremental.ts';
import {
  classifyAnchor,
  classifyStaleConsumer,
  normalisePath,
  ordinaryFindingHint,
  parseHunks,
  reason,
  suggestedPatchMismatch,
  type AnchorCheck,
  type FileHunks,
} from './diff/hunks.ts';
import type { ThreadComment } from './diff/thread.ts';
import {
  FollowUpRulingError,
  openFollowUps,
  parseFollowUpRulings,
  settleFollowUps,
  type FollowUpRuling,
  type FollowUpState,
} from './store/follow-ups.ts';
import { openDatabase } from './store/db.ts';
import { dataDirectory } from './store/paths.ts';
import {
  recordRun,
  runDetail,
  heldProblem,
  type CarryMarker,
  CarryMismatch,
  type CandidateHint,
  type HeldFinding,
  type StageTiming,
  type RunProvenance,
  type RecordedChecks,
  ORIGINS,
  PROVENANCE_MODES,
  recordedChecks,
} from './store/runs.ts';
import { heldBackFindings, parseThreadFile, postedReviewIds } from './diff/held.ts';
import { carryCandidates, carryFindings, CarryError, commitReadable, followLine, seriousNotCarried, type CarriedFinding } from './diff/carry.ts';
import { MODES } from './review/plan.ts';
import { DIFF_LANE, laneNamed } from './review/lanes.ts';
import { candidateAnchor } from './diff/reanchor.ts';
import { resolveCommit } from './diff/prior.ts';
import { configFile, loadConfig } from './policy/load.ts';
import { repositoryRoot } from './diff/acquire.ts';
import { stopCommandsOnSignal } from './evidence/run.ts';
import type { EvidenceSignal } from './evidence/types.ts';
import { parseTieBreaks, type TieBreak } from './verify/reconcile.ts';
import { GitHubClient, NotAllowlisted, ReadOnlyViolation } from './github/client.ts';
import { AuthError } from './github/auth.ts';
import { checkAbsenceClaim, type ExistenceCheck } from './scoring/existence.ts';
import { computeReach } from './scoring/reach.ts';
import { checkCitation } from './scoring/citation.ts';
import { queueCommand } from './queue/command.ts';
import { CONFIG_COPY, watchCommand } from './watch/command.ts';
import { spawnReview } from './watch/review.ts';
import { gitPrepareClone } from './watch/workspace.ts';
import { retrievePrecedents, type Precedent } from './retrieval/retrieve.ts';
import {
  scoreCandidate,
  applyQuestionCap,
  alreadySaidOnThread,
  citedLocations,
  possiblySaidOnThread,
  possiblyRaisedInFile,
  possiblyRepeatsDescription,
  followUpOf,
  normaliseCandidate,
  isFixVerdict,
  editorFix,
  assertUniqueCandidateIds,
  MalformedCandidate,
  DEFAULT_THRESHOLDS,
  DUPLICATE_OVERLAP,
  SAME_FILE_REPEAT_OVERLAP,
  isImpactClass,
  UNVERIFIABLE_REJECTION,
  DOCUMENT_NIT_HINT,
  blockingContext,
  overlap,
  significantWords,
  type Candidate,
  type RawCandidate,
  type ScoreBreakdown,
  type MissingContext,
  type Verification,
  ownerRaiseCeiling,
  QUESTION_GAP_FLOOR,
  isSuppressionExempt,
  matchingSuppression,
  POLICY_SUPPRESSED_PREFIX,
} from './scoring/score.ts';
import { storedPolicyVersions, type PolicyVersionRef } from './store/runs.ts';
import { ReviewWriter, WriteViolation } from './github/writer.ts';
import { cleanStages, shallowPassWarning } from './store/effort.ts';
import { recordAudit } from './store/audit.ts';
import { commandHelp, topLevelHelp } from './help.ts';
import { runReview, reportText } from './review/driver.ts';
import {
  noFindingsHint,
  inProcessState,
  setInProcess,
  githubClient,
  readStdin,
  numericFlag,
  inferRepository,
  remoteRepositories,
  flag,
  repositoryConfig,
  boundLists,
  refExists,
  VERDICT_KEYS,
  verificationProblem,
  verdictList,
  realExistingPath,
} from './cli/shared.ts';
import { redactCommand } from './cli/redact.ts';
import { draftCommand } from './cli/draft.ts';
import { postCheckCommand } from './cli/post-check.ts';
import { discoverCommand } from './cli/discover.ts';
import { evidenceCommand } from './cli/evidence.ts';
import { calibrateCommand } from './cli/calibrate.ts';
import { retrieveCommand } from './cli/retrieve.ts';
import { feedbackCommand } from './cli/feedback.ts';
import { declineCommand } from './cli/decline.ts';
import { anchorsCommand } from './cli/anchors.ts';
import { contextCommand } from './cli/context.ts';
import { validateOutputCommand } from './cli/validate-output.ts';
import { followUpsCommand } from './cli/follow-ups.ts';
import { purgeCommand } from './cli/purge.ts';
import { policyCommand } from './cli/policy.ts';
import { evaluateCommand } from './cli/evaluate.ts';
import { conventionsCommand } from './cli/conventions.ts';
import { checkIntentCommand } from './cli/check-intent.ts';
import { recallCommand } from './cli/recall.ts';
import { worktreeCommand } from './cli/worktree.ts';
import { pullRequestDiffCommand, diffCommand } from './cli/diff.ts';
import { threadCommand } from './cli/thread.ts';
import { symbolsCommand } from './cli/symbols.ts';
import { planCommand, lanesCommand } from './cli/plan.ts';
import { verdictCommand, postCommand } from './cli/verdict.ts';
import { consentPlanCommand, syncCommand } from './cli/sync.ts';
import { outcomesCommand } from './cli/outcomes.ts';
import { checkVerificationCommand } from './cli/check-verification.ts';
import { checkSimplificationCommand } from './cli/check-simplification.ts';
import { verifyCommand } from './cli/verify.ts';
import { reconcileCommand } from './cli/reconcile.ts';
import { challengeCommand } from './cli/challenge.ts';
import { reanchorCommand } from './cli/reanchor.ts';
import { agentCommand } from './cli/agent.ts';
import { statusCommand } from './cli/status.ts';
import { reviewScopeFromManifest, explainCommand } from './cli/explain.ts';
export { diffSummary, emitDiff } from './cli/diff.ts';
export { resolveOutPath, verificationProblem } from './cli/shared.ts';

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
function anchorFor(hunks: Map<string, FileHunks>, candidate: Candidate): AnchorCheck {
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
function deletedFileCheck(argv: string[]): (candidate: { path: string; line: number }, anchor: AnchorCheck) => boolean {
  const base = flag(argv, '--base');
  const head = flag(argv, '--head');
  const cwd = process.cwd();
  // refExists asks for a commit, which is what both refs must name.
  if (base === null || head === null || !refExists(base, cwd) || !refExists(head, cwd)) return () => false;
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
    if (path === '' || path.startsWith('/') || path.split(/[\\/]/).includes('..') || !isReviewable(path, false)) return false;
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
 * approved suppression held back.
 */
function ownerPromotions(argv: string[], candidates: readonly Candidate[]): Set<string> | string {
  const promotions = new Set<string>();
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--promote') continue;
    const candidateId = argv[index + 1];
    if (candidateId === undefined || candidateId.startsWith('--')) {
      return '--promote needs a candidate_id, for example cand_001.';
    }
    if (!known.has(candidateId)) return `--promote names unknown candidate ${JSON.stringify(candidateId)}.`;
    if (promotions.has(candidateId)) return `--promote names ${JSON.stringify(candidateId)} more than once.`;
    promotions.add(candidateId);
  }
  return promotions;
}

/**
 * Applies one promotion. Only what `belowGate` or `suppressed` would list
 * qualifies: the verifier confirmed it and one gate, which is preference,
 * stopped it. Anything else was stopped by a check of the claim itself.
 */
function applyOwnerPromotion(breakdown: ScoreBreakdown, ownerNote: string | null): string | null {
  const gate = gateOf(breakdown.rejectedBecause);
  if (breakdown.eligible) return `--promote ${breakdown.candidateId}: it is already eligible.`;
  // The unverifiable cap is a check of the claim, not a preference gate, so it
  // only lifts on an explicit owner decision that is recorded with its reason (#163).
  if (breakdown.confidenceSource === 'unverifiable-cap' && breakdown.rejectedBecause === UNVERIFIABLE_REJECTION) {
    if (ownerNote === null) {
      return (
        `--promote ${breakdown.candidateId}: it is capped as unverifiable (${breakdown.unverifiableBecause}). ` +
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
      `--promote ${breakdown.candidateId}: only a verified finding held by the score or confidence gate alone ` +
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

function scoreCommand(argv: string[]): number {
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

      if (promotions.has(candidate.candidateId)) {
        const problem = applyOwnerPromotion(breakdown, unverifiableNote);
        if (problem !== null) {
          console.error(problem);
          return 2;
        }
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

/**
 * The approved policy versions a `score` output says it loaded, or null when
 * the file carries none (one written before docs/adr/0032, or by hand). An
 * entry that is not a version reference makes the whole list null, so a
 * malformed file falls back to the rows active at record time rather than
 * recording a reference nothing can resolve.
 */
function policyVersionRefs(value: unknown): PolicyVersionRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: PolicyVersionRef[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { scopeType, scopeKey, policyId, version } = entry as Record<string, unknown>;
    if (typeof scopeType !== 'string' || typeof scopeKey !== 'string' || typeof policyId !== 'string' || typeof version !== 'number') return null;
    refs.push({ scopeType, scopeKey, policyId, version });
  }
  return refs;
}

function recordCommand(argv: string[]): number {
  // An empty ref is a shell slip, not a choice: a run with no head can never be
  // compared with a later run on the same head, so it is refused, not stored (#236).
  for (const name of ['--base', '--head']) {
    if (argv.includes(name) && (flag(argv, name) ?? '') === '') {
      console.error(`${name} needs a git ref or sha; it was empty. Leave the flag out to record none.`);
      return 2;
    }
  }
  // Checked before anything is read or written: an origin outside the enum would
  // otherwise store a label for a source that does not exist.
  const originFlag = flag(argv, '--origin');
  const origin = argv.includes('--origin') ? ORIGINS.find((known) => known === originFlag) : 'interactive';
  if (origin === undefined) {
    console.error(`--origin takes one of ${ORIGINS.join(', ')}.`);
    return 2;
  }
  const modeFlag = flag(argv, '--mode');
  const provenanceMode = PROVENANCE_MODES.find((known) => known === modeFlag) ?? null;
  if (argv.includes('--mode') && provenanceMode === null) {
    console.error(`--mode takes one of ${PROVENANCE_MODES.join(', ')}.`);
    return 2;
  }
  // The same policy cleanStages applies to model names: free text from a flag is
  // kept only when it looks like a version string, and dropped otherwise.
  const claudeFlag = flag(argv, '--claude-version');
  const claudeVersion = claudeFlag !== null && /^[\w.\- ()]{1,100}$/.test(claudeFlag) ? claudeFlag : null;

  const output = readStdin();
  if (output.trim().length === 0) {
    console.error('Nothing on stdin. Pipe the validated review in.');
    console.error(noFindingsHint());
    return 2;
  }

  // The same contract `validate-output` enforces, so a JSON blob or a draft
  // cannot land in the store and be read back by `explain` and `status` as a
  // review. Size limits are left to `validate-output`, which is given the
  // policy's figures; this checks only that the text is review output.
  const contract = validateOutput(output, {
    ...DEFAULT_LIMITS,
    maxFindings: null,
    maxWordsPerFinding: Number.MAX_SAFE_INTEGER,
    maxTotalWords: Number.MAX_SAFE_INTEGER,
  });
  if (!contract.valid) {
    for (const violation of contract.violations) {
      const where = violation.line === undefined ? '' : `line ${violation.line}: `;
      console.error(`[${violation.code}] ${where}${violation.message}`);
    }
    console.error('stdin is not a validated review, so nothing was recorded. Pipe what `validate-output` passed.');
    if (contract.findingCount === 0) console.error(noFindingsHint());
    return 2;
  }

  const diffFile = flag(argv, '--diff-file');
  let diff = '';
  if (diffFile !== null) {
    try {
      diff = readFileSync(diffFile, 'utf8');
    } catch {
      console.error(`Cannot read ${diffFile}.`);
      return 2;
    }
  } else {
    // Loudly, because the run is still recorded and still useful. Without a
    // diff every run stores the hash of the empty string, so every run looks
    // like a repeat of every other one: `candidate_set_agreement` then compares
    // unrelated pull requests and falls further the more work is recorded. No
    // shipped command passed this flag, so that was every run there was.
    console.error(
      'No --diff-file, so this run cannot be compared with another run of the same diff. ' +
        'Pass the patch that `diff --out` wrote. Recording anyway.',
    );
  }

  // This is deliberately separate from normal candidates and scores. A
  // simplification is advice in the review body, never an inline finding or a
  // reason to alter the review event. Parse it here, before opening the store,
  // so a hand-edited body-only suggestion cannot bypass its diff and verifier
  // checks.
  const bodyFindingsFile = flag(argv, '--body-findings');
  let bodyFindings: VerifiedSimplification[] = [];
  if (argv.includes('--body-findings')) {
    if (bodyFindingsFile === null) {
      console.error('--body-findings needs a JSON path from check-simplification.');
      return 2;
    }
    if (diffFile === null) {
      console.error('--body-findings needs --diff-file, so every listed removal can be checked against the diff.');
      return 2;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(bodyFindingsFile, 'utf8'));
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { bodyFindings?: unknown }).bodyFindings)
          ? (parsed as { bodyFindings: unknown[] }).bodyFindings
          : null;
      if (list === null) throw new Error('expected an array or {"bodyFindings": [...]}');
      if (list.length > 1) throw new Error('at most one body-only simplification is allowed per review');
      const hunks = parseHunks(diff);
      bodyFindings = list.map((entry, index) => {
        const checked = parseVerifiedSimplification(entry, hunks);
        if (checked.problem !== null || checked.value === null) {
          throw new Error(`entry ${index}: ${checked.problem ?? 'not a verified simplification'}`);
        }
        return checked.value;
      });
    } catch (error) {
      console.error(
        `Cannot read body-only simplification from ${bodyFindingsFile}: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
      return 2;
    }
  }

  // Scope comes from the manifest written beside the patch, so the record is
  // tied to the exact boundary the analyst saw rather than to a later lookup.
  const filesFile = flag(argv, '--files');
  let pullNumber: number | undefined;
  let manifestRepository: string | null = null;
  let scope: ReviewScope | undefined;
  let complexity: ComplexityAssessment | null = null;
  const knownPaths = new Set<string>();
  if (filesFile !== null) {
    try {
      const manifest = JSON.parse(readFileSync(filesFile, 'utf8')) as Record<string, unknown>;
      if (Array.isArray(manifest.files)) {
        for (const file of manifest.files) if (typeof file?.path === 'string') knownPaths.add(file.path);
      }
      if (Number.isInteger(manifest.pullNumber) && (manifest.pullNumber as number) > 0) {
        pullNumber = manifest.pullNumber as number;
      }
      if (typeof manifest.repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(manifest.repository)) {
        manifestRepository = manifest.repository;
      }
      scope = reviewScopeFromManifest(manifest.scope);
      if (manifest.complexity !== undefined && manifest.complexity !== null) {
        complexity = parseComplexity(manifest.complexity);
        if (complexity === null) console.error(`The complexity assessment in ${filesFile} is malformed; recording without it.`);
      }
    } catch {
      // The review text and patch remain enough to record a useful run. Losing
      // metadata must not turn that record into a failed command.
      console.error(`Cannot read ${filesFile}; recording without pull-request scope.`);
    }
  }

  // Categories cannot be recovered from the rendered output - the contract
  // permits no text beyond the finding - so they arrive alongside it.
  const candidatesFile = flag(argv, '--candidates');
  let candidates: CandidateHint[] = [];
  if (candidatesFile !== null) {
    try {
      const parsed = JSON.parse(readFileSync(candidatesFile, 'utf8')) as
        | { candidates?: CandidateHint[] }
        | CandidateHint[];
      candidates = Array.isArray(parsed) ? parsed : (parsed.candidates ?? []);
    } catch {
      console.error(`Cannot read candidates from ${candidatesFile}.`);
      return 2;
    }
  }

  const scoresFile = flag(argv, '--scores');
  let scores: unknown = [];
  // The policy versions `score` loaded, when its output names them: the run
  // then records what it was held to, not whatever is active now.
  let scoredPolicyVersions: PolicyVersionRef[] | null = null;
  if (scoresFile !== null) {
    try {
      const parsed = JSON.parse(readFileSync(scoresFile, 'utf8')) as { scores?: unknown; policyVersions?: unknown };
      // Bounded again here: a scores file from before the cap, or one a caller
      // assembled, must not put every matching path into the stored run.
      scores = boundLists(Array.isArray(parsed) ? parsed : (parsed.scores ?? []));
      scoredPolicyVersions = Array.isArray(parsed) ? null : policyVersionRefs(parsed.policyVersions);
    } catch {
      console.error(`Cannot read scores from ${scoresFile}.`);
      return 2;
    }
  }

  const verdictsFile = flag(argv, '--verdicts');
  let verdicts: unknown = [];
  if (verdictsFile !== null) {
    try {
      const parsed = JSON.parse(readFileSync(verdictsFile, 'utf8')) as { verdicts?: unknown };
      verdicts = Array.isArray(parsed) ? parsed : (parsed.verdicts ?? []);
    } catch {
      console.error(`Cannot read verdicts from ${verdictsFile}.`);
      return 2;
    }
  }

  // Tie-break rulings from step 3c. Checked as strictly as reconcile checks
  // them, so explain never shows a ruling reconcile would have refused.
  const tieBreaksFile = flag(argv, '--tie-breaks');
  let tieBreaks: TieBreak[] = [];
  if (tieBreaksFile !== null) {
    try {
      tieBreaks = parseTieBreaks(JSON.parse(readFileSync(tieBreaksFile, 'utf8')) as unknown);
    } catch (error) {
      console.error(`Cannot read tie-breaks from ${tieBreaksFile}: ${(error as Error).message}`);
      return 2;
    }
  }

  // Held-back candidates: a malformed entry is refused outright, because a
  // reason that was silently dropped would make the held list look complete.
  const heldFile = flag(argv, '--held');
  let held: HeldFinding[] = [];
  if (heldFile !== null) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(heldFile, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : (parsed as { held?: unknown } | null)?.held;
      if (!Array.isArray(list)) throw new Error('expected an array or {"held": [...]}');
      list.forEach((entry, index) => {
        const problem = heldProblem(entry);
        if (problem !== null) throw new Error(`entry ${index}: ${problem}`);
      });
      held = list as HeldFinding[];
      // A path no candidate or diff file carries can never match the real anchor
      // on a later --held-from run. Warn, but record it: the reason still counts.
      for (const candidate of candidates) knownPaths.add(candidate.path);
      if (knownPaths.size > 0) {
        for (const entry of held) {
          if (!knownPaths.has(entry.path)) {
            console.error(`Held entry ${entry.path}:${entry.line} matches no changed file or candidate; later --held-from runs will not match it.`);
            continue;
          }
          // shortcut: the line count is read only when the file is in the working tree.
          try {
            const content = readFileSync(entry.path, 'utf8');
            const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
            if (entry.line > lines) console.error(`Held entry ${entry.path}:${entry.line} is past the end of the file (${lines} lines).`);
          } catch {
            // Not in the working tree: the line cannot be checked, so say nothing.
          }
        }
      }
    } catch (error) {
      console.error(`Cannot read held findings from ${heldFile}: ${(error as Error).message}`);
      return 2;
    }
  }

  const stagesFile = flag(argv, '--stages');
  let stages: StageTiming[] = [];
  if (stagesFile !== null) {
    try {
      const parsed = JSON.parse(readFileSync(stagesFile, 'utf8')) as { stages?: unknown };
      const list = Array.isArray(parsed) ? parsed : (parsed.stages ?? []);
      stages = (Array.isArray(list) ? list : []).filter(
        (stage): stage is StageTiming =>
          typeof stage === 'object' &&
          stage !== null &&
          typeof (stage as StageTiming).name === 'string' &&
          Number.isFinite((stage as StageTiming).seconds),
      );
      stages = cleanStages(stages, diff === '' ? null : diff);
    } catch {
      console.error(`Cannot read stages from ${stagesFile}.`);
      return 2;
    }
  }

  // The two reports are summarised together or not at all: a summary built from
  // one of them would say "no static checks" or "every symbol file finished" for
  // a report nobody supplied, and the review scope block would then claim it.
  const evidenceFile = flag(argv, '--evidence');
  const symbolsFile = flag(argv, '--symbols');
  let checks: RecordedChecks | undefined;
  if (argv.includes('--evidence') || argv.includes('--symbols')) {
    if (evidenceFile === null || symbolsFile === null) {
      console.error('--evidence and --symbols go together: pass the evidence.json and the symbols.json of this review.');
      return 2;
    }
    try {
      checks = recordedChecks(
        JSON.parse(readFileSync(evidenceFile, 'utf8')) as unknown,
        JSON.parse(readFileSync(symbolsFile, 'utf8')) as unknown,
      );
    } catch (error) {
      console.error(
        `Cannot read the checks from ${evidenceFile} and ${symbolsFile}: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return 2;
    }
  }

  // What settles an earlier run's partly-addressed follow-up: its comment
  // thread resolved on the thread this run read, or the verifier's ruling.
  const followUpThreadFile = flag(argv, '--thread');
  let followUpThread: ThreadComment[] | null = null;
  let followUpThreadFor: { repository: unknown; pullNumber: unknown } | null = null;
  if (argv.includes('--thread')) {
    if (followUpThreadFile === null) {
      console.error('--thread needs a thread JSON path.');
      return 2;
    }
    try {
      const parsed = JSON.parse(readFileSync(followUpThreadFile, 'utf8')) as
        | { comments?: ThreadComment[]; repository?: unknown; pullNumber?: unknown }
        | ThreadComment[];
      const list = Array.isArray(parsed) ? parsed : parsed.comments;
      if (!Array.isArray(list)) throw new Error('comments is not a list');
      followUpThread = list;
      followUpThreadFor = Array.isArray(parsed)
        ? { repository: undefined, pullNumber: undefined }
        : { repository: parsed.repository, pullNumber: parsed.pullNumber };
    } catch (error) {
      console.error(`Cannot read ${followUpThreadFile}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  const rulingsFile = flag(argv, '--follow-ups');
  let rulings: FollowUpRuling[] = [];
  if (argv.includes('--follow-ups')) {
    if (rulingsFile === null) {
      console.error('--follow-ups needs the verifier output with follow_ups.');
      return 2;
    }
    try {
      rulings = parseFollowUpRulings(JSON.parse(readFileSync(rulingsFile, 'utf8')) as unknown);
    } catch (error) {
      const why = error instanceof FollowUpRulingError ? error.message : `cannot read it (${(error as Error).message})`;
      console.error(`Cannot read follow-up rulings from ${rulingsFile}: ${why}.`);
      return 2;
    }
  }

  const db = openDatabase();
  try {
    let carried: { runId: string; findings: CarriedFinding[] } | undefined;
    let carry: CarryMarker | undefined;
    let carriedProvenance: RunProvenance | null = null;
    let carriedVersions: PolicyVersionRef[] | null = null;
    const carriedFrom = flag(argv, '--carried-from');
    if (carriedFrom !== null) {
      const head = flag(argv, '--head');
      if (head === null) {
        console.error('--carried-from needs --head, the commit the findings were carried to.');
        return 2;
      }
      try {
        // The same hold-back `carry --thread` made, and the same settling of
        // files the pull request no longer changes, so the text it printed is
        // the text recorded here.
        const result = carryForRun(db, carriedFrom, head, flag(argv, '--repository'), followUpThreadFile, filesFile);
        // A serious finding left behind may be what stopped an approval;
        // recording the rest would let the review approve without it.
        const serious = seriousNotCarried(result.notCarried);
        if (serious.length > 0) {
          console.error(
            `Not recorded: ${serious.map((f) => `${f.findingId} (${f.severity}, ${f.path}:${f.line})`).join(', ')} ` +
              'did not carry. Review those files again rather than recording the carry.',
          );
          return 2;
        }
        carried = { runId: carriedFrom, findings: result.carried };
        const source = runDetail(db, carriedFrom);
        const prior = source?.carry ?? null;
        if (prior !== null && !prior.covered) carry = { ...prior, inheritedFrom: prior.inheritedFrom ?? carriedFrom };
        // Nothing re-reviewed the carried findings, so the record keeps the
        // provenance of the run that produced them: a carry by the driver must
        // not turn an interactive review into an independent one. A source from
        // before the column has none to keep, and the flags stand. The policy
        // versions are read from the run's own column, which a run from before
        // provenance existed still has, so a policy approved since is never
        // attributed to findings it did not score.
        carriedProvenance = source?.provenance ?? null;
        carriedVersions = storedPolicyVersions(db, carriedFrom);
      } catch (error) {
        console.error((error as Error).message);
        return 2;
      }
    }

    const carryFile = flag(argv, '--carry');
    if (carryFile !== null) {
      const head = flag(argv, '--head');
      let marker: CarryMarker | null = null;
      try {
        const parsed = JSON.parse(readFileSync(carryFile, 'utf8')) as Record<string, unknown>;
        const refused = Array.isArray(parsed['refused'])
          ? (parsed['refused'] as { candidateId?: unknown }[]).map((r) => String(r?.candidateId))
          : null;
        const interdiff = parsed['interdiff'] as { reviewed?: unknown } | undefined;
        if (refused !== null && typeof parsed['since'] === 'string' && typeof parsed['head'] === 'string') {
          const reviewed = interdiff?.reviewed === true;
          marker = {
            since: parsed['since'],
            head: parsed['head'],
            interdiffReviewed: reviewed,
            refused,
            covered: reviewed && refused.length === 0,
          };
        }
      } catch {
        marker = null;
      }
      if (marker === null) {
        console.error(`${carryFile} is not the carry.json that carry-candidates wrote.`);
        return 2;
      }
      if (head === null || !sameCommit(marker.head, head)) {
        console.error(`--carry is for ${marker.head}; pass --head with that commit.`);
        return 2;
      }
      // An inherited gap stays a gap whatever this carry covered.
      if (carry === undefined || marker.covered === false) carry = marker;
    }

    // An omitted --repository used to store null, and a run with no repository
    // is never found by `diff --pr`, so `carry --from` had no run id to use.
    // The manifest's repository, then this clone's origin, stand in for it.
    const repository = flag(argv, '--repository') ?? manifestRepository ?? inferRepository(process.cwd());
    // A short --head would never equal the full sha `diff --since` compares.
    // Only a hex id is looked up, so nothing else is handed to git.
    const headFlag = flag(argv, '--head');
    const headRef =
      headFlag === null || !/^[0-9a-f]{4,64}$/i.test(headFlag)
        ? headFlag
        : (resolveCommit(headFlag, process.cwd()) ?? headFlag);
    // A thread of another pull request would settle this one's follow-ups on
    // someone else's resolutions, so it must name this run's pull request.
    if (followUpThreadFor !== null) {
      const sameRepository =
        typeof followUpThreadFor.repository === 'string' &&
        repository !== null &&
        followUpThreadFor.repository.toLowerCase() === repository.toLowerCase();
      if (!sameRepository || pullNumber === undefined || followUpThreadFor.pullNumber !== pullNumber) {
        console.error(
          `${followUpThreadFile} is not the thread of this run's pull request ` +
            `(${repository ?? 'no --repository'}#${pullNumber ?? '? (no pull request in --files)'}). ` +
            'Pass the thread.json that `RV thread` wrote for it.',
        );
        return 2;
      }
    }
    let followUps: FollowUpState[] = [];
    if (repository !== null && pullNumber !== undefined) {
      const open = openFollowUps(db, repository, pullNumber);
      const scopeFiles = scope !== undefined && 'files' in scope ? scope.files : null;
      const settled = settleFollowUps(open, { thread: followUpThread, rulings, scopeFiles });
      followUps = settled.states;
      for (const id of settled.unmatched) {
        console.error(`Warning: the follow-up ruling for ${id} names no open follow-up of this pull request; ignored.`);
      }
    } else if (rulings.length > 0 || followUpThread !== null) {
      console.error('Warning: --thread and --follow-ups need --repository and a pull request in --files; ignored.');
    }

    const { reviewRunId, findings, provenance } = recordRun(db, {
      repository,
      baseRef: flag(argv, '--base'),
      headRef,
      pullNumber,
      scope,
      complexity,
      diff,
      output,
      candidates,
      scores,
      verdicts,
      tieBreaks,
      held,
      ...(bodyFindings.length === 0 ? {} : { bodyFindings }),
      carried,
      ...(carry === undefined ? {} : { carry }),
      followUps,
      stages,
      ...(checks === undefined ? {} : { checks }),
      provenance: {
        ...(carriedProvenance === null
          ? { origin, pluginVersion: pluginVersion(), claudeVersion, mode: provenanceMode }
          : { origin: carriedProvenance.origin, pluginVersion: carriedProvenance.pluginVersion, claudeVersion: carriedProvenance.claudeVersion, mode: carriedProvenance.mode }),
        // The versions this run was held to: the ones `score` loaded when there
        // is a scores file; else the carried run's, since an unchanged scope is
        // not rescored and a policy change since must not be attributed to it;
        // else the rows active now.
        ...(scoredPolicyVersions !== null
          ? { policyVersions: scoredPolicyVersions }
          : carriedVersions === null
            ? {}
            : { policyVersions: carriedVersions }),
      },
    });
    // Local only: printed here and by `explain`, never part of what is posted.
    const warning = shallowPassWarning(stages, findings.length);
    console.log(
      JSON.stringify(
        {
          reviewRunId,
          findings,
          // So the review driver can print the line without a second command.
          provenance,
          ...(followUps.length === 0 ? {} : { followUps }),
          ...(warning === null ? {} : { warnings: [warning] }),
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    if (error instanceof CarryMismatch) {
      console.error(`A carried finding was recorded on a different line than carry gave it:\n${error.message}`);
      return 2;
    }
    throw error;
  } finally {
    db.close();
  }
}

/**
 * Runs the carry for one stored run against the repository in the working
 * directory, which has to be a clone of the run's repository: the commits are
 * read from it, and another repository's clone cannot read them.
 */
function carryForRun(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  head: string,
  repository: string | null,
  threadFile: string | null = null,
  filesFile: string | null = null,
): ReturnType<typeof carryFindings> {
  const detail = runDetail(db, runId);
  if (detail === null) throw new CarryError(`No recorded run ${runId}.`);
  if (detail.headRef === null) throw new CarryError(`Run ${runId} did not record a head, so nothing can be carried from it.`);

  const recorded = detail.repository;
  if (recorded !== null && repository !== null && recorded.toLowerCase() !== repository.toLowerCase()) {
    throw new CarryError(`Run ${runId} is a review of ${recorded}, not ${repository}.`);
  }
  const expected = recorded ?? repository;

  let root: string;
  try {
    root = repositoryRoot(process.cwd());
  } catch {
    throw new CarryError(`Run carry inside a clone of ${expected ?? "the run's repository"}.`);
  }
  // Any remote counts: a fork's clone reads the pull request through
  // `upstream` while `origin` names the fork.
  const remotes = remoteRepositories(root);
  const actual = inferRepository(root) ?? remotes[0] ?? null;
  if (expected !== null && remotes.length > 0 && !remotes.some((slug) => slug.toLowerCase() === expected.toLowerCase())) {
    throw new CarryError(
      `Run ${runId} is a review of ${expected}, but ${root} is a clone of ${actual}. Run carry from a clone of ${expected}.`,
    );
  }

  for (const ref of [detail.headRef, head]) {
    if (!commitReadable(ref, root)) {
      throw new CarryError(
        `Commit ${ref} is not readable in ${root}${actual === null ? '' : ` (a clone of ${actual})`}. ` +
          `Fetch it there, or run carry from a clone of ${expected ?? "the run's repository"}.`,
      );
    }
  }

  let hold: Map<string, string> | undefined;
  if (threadFile !== null) {
    let text: string;
    try {
      text = readFileSync(threadFile, 'utf8');
    } catch (error) {
      throw new CarryError(`Cannot read ${threadFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const thread = parseThreadFile(text, threadFile, detail);
    hold = heldBackFindings(detail.findings, thread, detail, postedReviewIds(db, runId));
  }
  let noLongerChanged = new Set<string>();
  if (filesFile !== null) {
    try {
      const files = JSON.parse(readFileSync(filesFile, 'utf8')) as { scope?: { noLongerChanged?: unknown } };
      const listed = files.scope?.noLongerChanged;
      noLongerChanged = new Set(Array.isArray(listed) ? listed.filter((path): path is string => typeof path === 'string') : []);
    } catch (error) {
      throw new CarryError(`Cannot read ${filesFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return carryFindings(detail.findings, detail.headRef, head, root, hold, noLongerChanged);
}

/**
 * Lists which findings of an earlier run still hold at a new head.
 *
 * Used when a pull request moved but its own diff did not, so those findings
 * can be repeated at their new lines instead of being re-derived.
 */
function carryCommand(argv: string[]): number {
  const from = flag(argv, '--from');
  const head = flag(argv, '--head');
  if (from === null || head === null) {
    console.error('Usage: carry --from <run-id> --head <sha> [--repository <owner/repo>] [--text] [--thread <thread.json>] [--files <files.json>]');
    return 2;
  }
  // What the author answered on the pull request: threads resolved, reviews dismissed.
  const threadFile = flag(argv, '--thread');
  if (argv.includes('--thread') && threadFile === null) {
    console.error('--thread needs a thread JSON path.');
    return 2;
  }
  // `RV diff --pr` output: its `scope.noLongerChanged` names files the base took over.
  const filesFile = flag(argv, '--files');
  if (argv.includes('--files') && filesFile === null) {
    console.error('--files needs the files.json path from `RV diff --pr`.');
    return 2;
  }
  const db = openDatabase();
  try {
    const result = carryForRun(db, from, head, flag(argv, '--repository'), threadFile, filesFile);
    if (threadFile === null && runDetail(db, from)?.pullNumber !== null) {
      console.error(
        'Findings the author resolved or dismissed on the pull request were not checked. ' +
          'Pass --thread <thread.json> from `RV thread` to hold them back.',
      );
    }
    if (!argv.includes('--text')) {
      console.log(JSON.stringify({ from, head, ...result }, null, 2));
      return 0;
    }
    // The review text alone, so it pipes straight into `validate-output` and
    // `record`. What did not carry is named where a pipe does not take it.
    for (const skipped of result.notCarried) {
      console.error(`Not carried: ${skipped.findingId} ${skipped.path}:${skipped.line} - ${skipped.reason}`);
    }
    for (const held of result.heldBack) {
      const severity = held.severity === undefined ? '' : ` (${held.severity})`;
      console.error(`Held back: ${held.findingId} ${held.path}:${held.line}${severity} - ${held.reason}`);
    }
    for (const settled of result.settled) {
      console.error(`Settled: ${settled.findingId} ${settled.path}:${settled.line} - ${settled.reason}`);
    }
    const serious = seriousNotCarried(result.notCarried);
    if (serious.length > 0) {
      // A blocking or important finding on code that changed may be what kept
      // the earlier review from approving. Carrying the rest would drop it.
      console.error(
        `Not carried: ${serious.map((f) => `${f.findingId} (${f.severity})`).join(', ')}, on code that changed. ` +
          'Review those files again; nothing was printed.',
      );
      return 1;
    }
    if (result.output.length === 0) {
      // Findings existed and none carried. Printing the clean-review sentence
      // here would record a review that says the opposite of the earlier one.
      console.error(
        result.heldBack.length > 0
          ? `Nothing left to print from ${from}: ${result.heldBack.length} finding${result.heldBack.length === 1 ? ' was' : 's were'} ` +
              'held back (resolved or dismissed on the pull request)' +
              `${result.notCarried.length > 0 ? ', and the rest sit on code that changed' : ''}.`
          : `Nothing carried from ${from}; its findings sit on code that changed.`,
      );
      return 1;
    }
    process.stdout.write(`${result.output}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CarryError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  } finally {
    db.close();
  }
}

/** The list inside a JSON input, and how to put a filtered one back in its place. */
function listIn(parsed: unknown, keys: readonly string[]): { list: Record<string, unknown>[]; rebuild: (list: unknown[]) => unknown } | null {
  if (Array.isArray(parsed)) return { list: parsed as Record<string, unknown>[], rebuild: (list) => list };
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const key = keys.find((k) => Array.isArray(record[k]));
  if (key === undefined) return null;
  return { list: record[key] as Record<string, unknown>[], rebuild: (list) => ({ ...record, [key]: list }) };
}

/** Every string inside a JSON value, so a file named anywhere in it is seen. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

const idOfEntry = (entry: Record<string, unknown>): string => String(entry['candidate_id'] ?? entry['candidateId']);

/** The same entry under another candidate id, in the key spelling it already used. */
function withId(entry: Record<string, unknown>, id: string): Record<string, unknown> {
  return 'candidate_id' in entry ? { ...entry, candidate_id: id } : { ...entry, candidateId: id };
}

/** True when two commit names are the same commit, allowing an abbreviation of at least 7. */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || (Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x)));
}

/**
 * The review of the commits between the two heads, read from `--interdiff`.
 *
 * Carried candidates say nothing about those commits, so a carry stands only
 * beside a review of them. The manifest must be a pull-request diff of the new
 * head that covers everything since the old one, and every candidate from it
 * must sit on a changed line of that diff, so the review cannot be stood in
 * for by an unrelated one.
 */
function readInterdiffReview(
  dir: string,
  candidatesFile: string,
  verificationFile: string,
  since: string,
  head: string,
): { candidates: Record<string, unknown>[]; verification: Record<string, unknown>[]; scope: string } | string {
  let manifest: Record<string, unknown>;
  let hunks: Map<string, FileHunks>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'files.json'), 'utf8')) as Record<string, unknown>;
    hunks = parseHunks(readFileSync(join(dir, 'diff.patch'), 'utf8'));
  } catch (error) {
    return `Cannot read the interdiff in ${dir}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const scope = parseReviewScope(manifest['scope']);
  if (scope === null || typeof manifest['head'] !== 'string') {
    return `${dir} is not a pull-request diff; run diff --pr <number> --since <old sha> --out ${dir}`;
  }
  if (!sameCommit(manifest['head'], head)) return `${dir} reads ${manifest['head']}, not the new head ${head}`;
  if (scope.kind !== 'full' && !sameCommit(scope.since, since)) {
    return `${dir} covers the commits since ${scope.since}, not since ${since}`;
  }

  let candidates: Record<string, unknown>[];
  let verification: Record<string, unknown>[];
  try {
    const parsed = listIn(JSON.parse(readFileSync(candidatesFile, 'utf8')), ['candidates']);
    if (parsed === null) throw new Error(`${candidatesFile} is not {"candidates": [...]}`);
    candidates = parsed.list;
    const normalised = candidates.map((raw, index) => normaliseCandidate(raw as RawCandidate, index));
    assertUniqueCandidateIds(normalised);
    const misplaced = normalised.filter((c) => !candidateAnchor(hunks, c).ok);
    if (misplaced.length > 0) {
      throw new Error(
        `interdiff candidate(s) not on a changed line of ${join(dir, 'diff.patch')}: ${misplaced.map((c) => c.candidateId).join(', ')}`,
      );
    }
    candidates = candidates.map((raw, index) => withId(raw, normalised[index]!.candidateId));
    const parsedVerification = listIn(JSON.parse(readFileSync(verificationFile, 'utf8')), VERDICT_KEYS);
    verification = parsedVerification?.list ?? [];
    if (parsedVerification === null && candidates.length > 0) throw new Error(`${verificationFile} contains no verifications`);
    const problem = verificationProblem(verification);
    if (problem !== null) throw new Error(`malformed verification - ${problem}`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return { candidates, verification, scope: scope.kind };
}

/**
 * Why `--diff-file` is not the whole pull request's diff, read from the
 * files.json `diff --out` wrote beside it; null when it is, or nothing says.
 *
 * `diff --pr` writes an interdiff by default after an earlier review, and an
 * anchor can only be checked against the whole pull request: a file the
 * interdiff leaves out is unchanged since the review, not outside the pull
 * request, so every candidate in it would be refused (#67).
 */
function partialDiffReason(diffFile: string): string | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(dirname(diffFile), 'files.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const scope = parseReviewScope(manifest['scope']);
  if (scope === null || scope.kind === 'full') return null;
  return (
    `${diffFile} is the ${scope.kind} patch \`diff --pr\` wrote, not the whole pull request's diff. ` +
    'carry-candidates checks each anchor against the whole pull request: ' +
    'run `diff --pr <number> --full --out <dir>` and pass its diff.patch.'
  );
}

/**
 * Carries verified candidates to a head the author pushed mid-review.
 *
 * Posting is refused once the head moves, and the alternative was copying
 * candidates and verifications across by hand. Only candidates whose files
 * are unchanged carry; the rest are named so they are verified again. The
 * review of the commits between the heads, from `--interdiff`, is merged in;
 * without it `carry.json` says so and a run recorded from it cannot approve.
 * Exit 1 means at least one candidate was refused.
 */
function carryCandidatesCommand(argv: string[]): number {
  const candidatesFile = flag(argv, '--candidates');
  const verificationFile = flag(argv, '--verification');
  const since = flag(argv, '--since');
  const head = flag(argv, '--head');
  const diffFile = flag(argv, '--diff-file');
  const outDir = flag(argv, '--out');
  if ([candidatesFile, verificationFile, since, head, diffFile, outDir].includes(null)) {
    console.error(
      'Usage: carry-candidates --candidates <file> --verification <file> --since <sha> --head <sha> --diff-file <patch> --out <dir> ' +
        '[--interdiff <dir> --interdiff-candidates <file> --interdiff-verification <file>] [--held <file>]',
    );
    return 2;
  }
  const interdiffFlags = ['--interdiff', '--interdiff-candidates', '--interdiff-verification'].map((name) => flag(argv, name));
  if (interdiffFlags.some((value) => value !== null) && interdiffFlags.some((value) => value === null)) {
    console.error('--interdiff, --interdiff-candidates and --interdiff-verification go together.');
    return 2;
  }

  let candidatesIn: NonNullable<ReturnType<typeof listIn>>;
  let verificationIn: NonNullable<ReturnType<typeof listIn>>;
  let candidates: Candidate[];
  let hunks: Map<string, FileHunks>;
  let heldIn: NonNullable<ReturnType<typeof listIn>> | null = null;
  try {
    const parsedCandidates = listIn(JSON.parse(readFileSync(candidatesFile!, 'utf8')), ['candidates']);
    if (parsedCandidates === null) throw new Error(`${candidatesFile} is not {"candidates": [...]}`);
    candidatesIn = parsedCandidates;
    candidates = candidatesIn.list.map((raw, index) => normaliseCandidate(raw as RawCandidate, index));
    assertUniqueCandidateIds(candidates);
    const parsedVerification = listIn(JSON.parse(readFileSync(verificationFile!, 'utf8')), VERDICT_KEYS);
    if (parsedVerification === null || parsedVerification.list.length === 0) {
      throw new Error(`${verificationFile} contains no verifications`);
    }
    verificationIn = parsedVerification;
    const problem = verificationProblem(verificationIn.list);
    if (problem !== null) throw new Error(`malformed verification - ${problem}`);
    hunks = parseHunks(readFileSync(diffFile!, 'utf8'));
    const partial = partialDiffReason(diffFile!);
    if (partial !== null) throw new Error(partial);
    const heldFile = flag(argv, '--held');
    if (heldFile !== null) {
      heldIn = listIn(JSON.parse(readFileSync(heldFile, 'utf8')), ['held']);
      if (heldIn === null) throw new Error(`${heldFile} is not an array or {"held": [...]}`);
      heldIn.list.forEach((entry, index) => {
        const heldError = heldProblem(entry);
        if (heldError !== null) throw new Error(`${heldFile} entry ${index}: ${heldError}`);
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const interdiff =
    interdiffFlags[0] === null
      ? null
      : readInterdiffReview(interdiffFlags[0]!, interdiffFlags[1]!, interdiffFlags[2]!, since!, head!);
  if (typeof interdiff === 'string') {
    console.error(interdiff);
    return 2;
  }

  // A candidate the verifier never saw has nothing to carry.
  const verificationById = new Map(verificationIn.list.map((v) => [idOfEntry(v), v]));
  const unverified = candidates.filter((c) => !verificationById.has(c.candidateId));
  let result: ReturnType<typeof carryCandidates>;
  const heldKept: Record<string, unknown>[] = [];
  const heldDropped: { path: string; line: number; reason: string }[] = [];
  try {
    result = carryCandidates(
      candidates
        .filter((c) => verificationById.has(c.candidateId))
        .map((c) => ({
          ...c,
          texts: [...stringsIn(candidatesIn.list[candidates.indexOf(c)]), ...stringsIn(verificationById.get(c.candidateId))],
        })),
      since!,
      head!,
      hunks,
      process.cwd(),
    );
    // Held findings name old-head lines. Each is moved to its line at the new
    // head, or dropped when that line or its neighbours changed.
    for (const entry of heldIn?.list ?? []) {
      const path = entry['path'] as string;
      const line = entry['line'] as number;
      const moved = followLine(since!, head!, path, line, process.cwd());
      if ('reason' in moved) heldDropped.push({ path, line, reason: moved.reason });
      else heldKept.push({ ...entry, line: moved.line });
    }
  } catch (error) {
    if (error instanceof CarryError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const refused = [
    ...unverified.map((c) => ({ candidateId: c.candidateId, path: c.path, line: c.line, reason: 'no verification for it' })),
    // A file the diff does not touch is most often a diff that is not the
    // whole pull request's, so the refusal says which one it has to be.
    ...result.refused.map((r) =>
      r.reason.includes('in a file the diff does not touch')
        ? { ...r, reason: `${r.reason.replace(/\.$/, '')}; --diff-file must be the whole pull request's diff (\`diff --pr <number> --full\`), not an interdiff` }
        : r,
    ),
  ];

  // The analyst's own entries, moved, in the spelling the file already used.
  const carriedById = new Map(result.carried.map((c) => [c.candidateId, c]));
  const carriedCandidates = candidatesIn.list.flatMap((raw, index) => {
    const moved = carriedById.get(candidates[index]!.candidateId);
    if (moved === undefined) return [];
    const causeKey = 'caused_by' in raw ? 'caused_by' : 'causedBy';
    return [{
      ...raw,
      path: moved.path,
      line: moved.line,
      ...(moved.causedBy === undefined ? {} : { [causeKey]: { path: moved.causedBy.path, line: moved.causedBy.line } }),
    }];
  });
  const carriedVerification = verificationIn.list.filter((v) => carriedById.has(idOfEntry(v)));

  // The interdiff review's candidates join the carried ones. Its analyst
  // numbers from the start too, so a clashing id is renamed in both files.
  const taken = new Set(candidates.map((c) => c.candidateId));
  const renamed: Record<string, string> = {};
  const rename = (id: string): string => {
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
    let n = 1;
    while (taken.has(`${id}_interdiff${n === 1 ? '' : `_${n}`}`)) n += 1;
    const next = `${id}_interdiff${n === 1 ? '' : `_${n}`}`;
    taken.add(next);
    renamed[id] = next;
    return next;
  };
  const interdiffCandidates = (interdiff?.candidates ?? []).map((raw) => withId(raw, rename(idOfEntry(raw))));
  const interdiffVerification = (interdiff?.verification ?? []).map((v) => withId(v, renamed[idOfEntry(v)] ?? idOfEntry(v)));

  const record = {
    since,
    head,
    carried: result.carried,
    refused,
    interdiff:
      interdiff === null
        ? { reviewed: false }
        : { reviewed: true, scope: interdiff.scope, candidates: interdiffCandidates.length, renamed },
    ...(heldIn === null ? {} : { held: { kept: heldKept.length, dropped: heldDropped } }),
  };

  try {
    mkdirSync(outDir!, { recursive: true });
    writeFileSync(
      join(outDir!, 'candidates.json'),
      `${JSON.stringify(candidatesIn.rebuild([...carriedCandidates, ...interdiffCandidates]), null, 2)}\n`,
    );
    writeFileSync(
      join(outDir!, 'verification.json'),
      `${JSON.stringify(verificationIn.rebuild([...carriedVerification, ...interdiffVerification]), null, 2)}\n`,
    );
    if (heldIn !== null) writeFileSync(join(outDir!, 'held.json'), `${JSON.stringify(heldIn.rebuild(heldKept), null, 2)}\n`);
    writeFileSync(join(outDir!, 'carry.json'), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    console.error(`Cannot write to ${outDir}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const db = openDatabase();
  try {
    recordAudit(db, 'candidates_carried', null, {
      since,
      head,
      carried: result.carried.map((c) => c.candidateId),
      refused: refused.map((r) => r.candidateId),
      interdiffReviewed: interdiff !== null,
    });
  } finally {
    db.close();
  }

  for (const r of refused) console.error(`Refused ${r.candidateId}: ${r.reason}`);
  for (const h of heldDropped) console.error(`Held finding dropped: ${h.path}:${h.line} - ${h.reason}`);
  if (interdiff === null) {
    console.error('The commits between the two heads were not reviewed (--interdiff), so a run recorded from this carry will not approve.');
  }
  console.log(
    JSON.stringify(
      {
        carried: result.carried.length,
        refused,
        interdiffReviewed: interdiff !== null,
        candidates: join(outDir!, 'candidates.json'),
        verification: join(outDir!, 'verification.json'),
        ...(heldIn === null ? {} : { held: join(outDir!, 'held.json') }),
        carry: join(outDir!, 'carry.json'),
      },
      null,
      2,
    ),
  );
  return refused.length === 0 ? 0 : 1;
}

/** A held finding of an earlier run, at its line in the head now being reviewed. */
interface CarriedHeld {
  path: string;
  line: number;
  verdict: string;
  reason: string;
  text?: string | undefined;
  /** The run the entry was held in; one of several when `--held-from` lists related pull requests. */
  runId: string;
}

/**
 * The earlier run's held findings that are still on unchanged code.
 *
 * `unverified` entries are left out because nothing was concluded about them.
 * One that does not carry sits on code that changed, so its candidate deserves
 * a fresh look. An unusable run never fails the review: it only means the held
 * findings were not consulted, which the caller is told on stderr.
 */
function carriedHeldFindings(runId: string, head: string): CarriedHeld[] {
  const db = openDatabase();
  try {
    const detail = runDetail(db, runId);
    if (detail === null) throw new CarryError(`No recorded run ${runId}.`);
    if (detail.headRef === null) throw new CarryError(`Run ${runId} did not record a head.`);
    // Only a conclusion holds a candidate back. `unverified` reached none, and
    // any later kind of held entry has to opt in here rather than suppress by default.
    // `below-gate` is carried too, but only to flag: the verifier confirmed it,
    // so it argues for the candidate and never removes one (`matchHeld`). The
    // mark tells the verifier the same concern was already held below the gate.
    const entries = detail.held.filter(
      (h) =>
        h.verdict === 'refuted' ||
        h.verdict === 'partly' ||
        h.verdict === 'repeat' ||
        h.verdict === 'below-gate' ||
        h.verdict === 'owner-declined' ||
        h.verdict === 'challenge-refuted' ||
        h.verdict === 'challenge-partly',
    );
    const inputs = entries.map((h, i) => ({ findingId: String(i), path: h.path, line: h.line, text: '' }));
    const result = carryFindings(inputs, detail.headRef, head, process.cwd());
    return result.carried.map((c) => {
      const entry = entries[Number(c.findingId)] as HeldFinding;
      return { path: c.path, line: c.line, verdict: entry.verdict, reason: entry.reason, text: entry.text, runId };
    });
  } catch (error) {
    if (error instanceof CarryError) {
      console.error(`Held findings were not consulted: ${error.message}`);
      return [];
    }
    throw error;
  } finally {
    db.close();
  }
}

/** Whether the candidate's own text or path points at the held entry's file. */
function namesHeldPath(candidate: Candidate, entry: CarriedHeld): boolean {
  if (candidate.path === entry.path) return true;
  const base = entry.path.slice(entry.path.lastIndexOf('/') + 1);
  // A bare basename such as `index.ts` or `a.ts` would match anything, so only
  // a distinctive one stands in for the full path.
  const names = base.includes('.') && base.length >= 6 ? [entry.path, base] : [entry.path];
  return [candidate.claim, candidate.failureMode, ...candidate.evidence].some(
    (text) => typeof text === 'string' && names.some((name) => text.includes(name)),
  );
}

/**
 * The held finding a candidate may repeat, and whether its wording settles it.
 *
 * A held entry on the same line says something was concluded about code that
 * has not changed since. When the wording matches, the candidate is the same
 * point again. When it does not, the line may carry a new defect, so the
 * candidate stays and the verifier decides.
 *
 * A `below-gate` entry never settles anything: the verifier confirmed it, so
 * a candidate that restates it is marked, not dropped.
 *
 * With no entry at the same anchor, a held concern can still come back
 * anchored elsewhere: one change often touches several files and the analyst
 * picks a different one to hang it on. An entry whose file the candidate names
 * and whose wording it largely shares is returned to flag, never to drop.
 */
function matchHeld(candidate: Candidate, held: CarriedHeld[]): { entry: CarriedHeld; drop: boolean } | null {
  const mine = significantWords(`${candidate.claim} ${candidate.failureMode}`);
  let found: { entry: CarriedHeld; drop: boolean } | null = null;
  for (const entry of held) {
    if (entry.path !== candidate.path || Math.abs(entry.line - candidate.line) > 2) continue;
    const drop =
      entry.verdict !== 'below-gate' &&
      entry.text !== undefined &&
      overlap(mine, significantWords(entry.text)) >= DUPLICATE_OVERLAP;
    if (drop) return { entry, drop };
    found ??= { entry, drop };
  }
  if (found !== null) return found;

  let best: { entry: CarriedHeld; share: number } | null = null;
  for (const entry of held) {
    if (entry.text === undefined || !namesHeldPath(candidate, entry)) continue;
    const share = overlap(mine, significantWords(entry.text));
    if (share < SAME_FILE_REPEAT_OVERLAP) continue;
    if (best === null || share > best.share) best = { entry, share };
  }
  return best === null ? null : { entry: best.entry, drop: false };
}

/**
 * The signals in an `evidence.json`. Individual entries that cannot be matched
 * on (no path, no line, no wording) are left out rather than guessed at; a file
 * that cannot be read as an object at all throws, so the caller can say so.
 */
function readSignals(file: string, root: string): EvidenceSignal[] {
  const document = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (typeof document !== 'object' || document === null || Array.isArray(document)) throw new Error('not a JSON object');
  const signals = (document as { signals?: unknown }).signals;
  if (signals === undefined) return [];
  if (!Array.isArray(signals)) throw new Error('signals is not a list');
  // The commands may have run in another tree than this one, the pull
  // request's head worktree under the driver, so an absolute path a tool
  // printed is relative to where it ran, which the report records as cwd.
  const ranIn = (document as { cwd?: unknown }).cwd;
  const signalRoot = typeof ranIn === 'string' && ranIn !== '' ? ranIn : root;
  return signals.flatMap((entry): EvidenceSignal[] => {
    const s = entry as Partial<EvidenceSignal> | null;
    if (typeof s !== 'object' || s === null || typeof s.path !== 'string' || typeof s.line !== 'number' || typeof s.claim !== 'string') return [];
    // Some tools print absolute paths; a candidate names a repository-relative
    // one. The two must compare as the same file, through whatever links sit
    // above them, and a path outside the tree the tool ran in names nothing a
    // candidate could be about.
    const spelled = s.path.split('\\').join('/');
    const path = isAbsolute(spelled) ? relative(realExistingPath(signalRoot), realExistingPath(spelled)) : posix.normalize(spelled).replace(/^\.\//, '');
    if (path === '' || path === '.' || path.startsWith('..') || isAbsolute(path)) return [];
    return [
      {
        kind: typeof s.kind === 'string' ? s.kind : '',
        path,
        line: s.line,
        claim: s.claim,
        evidence: Array.isArray(s.evidence) ? s.evidence.filter((line): line is string => typeof line === 'string') : [],
        confidence: typeof s.confidence === 'number' ? s.confidence : 0,
        tool: typeof s.tool === 'string' ? s.tool : '',
      },
    ];
  });
}

/**
 * The static signal a candidate restates, if any: the rule `matchHeld` applies
 * to a prior finding. The tool already reports the defect with its own
 * evidence, so a model comment repeating it adds noise. A signal with no path
 * says nothing about where, so it matches nothing.
 */
/**
 * The wording overlap at which a candidate is read as restating a tool's
 * signal. Higher than the bar for a repeat of a prior finding: a tool's message
 * is short and names the symbol and its type, so an unrelated claim about the
 * same symbol at the same line ("Order total uses wrong units" against
 * "Property 'total' does not exist on type 'Order'") shares two words in five
 * with it. An analyst echoing the tool shares most of them.
 */
const TOOL_RESTATEMENT_OVERLAP = 0.6;

function matchSignal(candidate: Candidate, signals: EvidenceSignal[]): EvidenceSignal | null {
  // Wording overlap is a heuristic, and a type error can share its words with
  // a claim about a breach at the same line ("password", "User"). The
  // categories that name a breach or a trust boundary are never held on a
  // heuristic (docs/adr/0032); the verifier decides them.
  if (isSuppressionExempt(candidate.category)) return null;
  const text = `${candidate.claim} ${candidate.failureMode}`;
  const mine = significantWords(text);
  // The anchor checks accept `./src/a.ts`, so the comparison must too.
  const path = posix.normalize(candidate.path.split('\\').join('/')).replace(/^\.\//, '');
  for (const signal of signals) {
    if (signal.path !== path || signal.line === null || Math.abs(signal.line - candidate.line) > 2) continue;
    const message = `${signal.claim} ${signal.evidence.join(' ')}`;
    // The words that carry a tool message's identity are the names it quotes
    // (`'qty'`, `'Item'`, `'en-GB'`), which are often too short for
    // `significantWords` to keep, so two messages about different members of
    // one type would otherwise read as the same. Every name the diagnostic
    // quotes must appear in the candidate's own words, as spelled, before the
    // wording overlap is consulted. A suggested fix ("Did you mean 'x'?") names
    // a replacement, not the defect, so its names are not required.
    const diagnostic = message.replace(/\bDid you mean\b[\s\S]*$/i, '');
    const named = [...diagnostic.matchAll(/['"`]([^'"`\s]+)['"`]/g)].map((match) => match[1] as string);
    if (named.some((name) => !mentions(text, name))) continue;
    if (overlap(mine, significantWords(message)) >= TOOL_RESTATEMENT_OVERLAP) return signal;
  }
  return null;
}

/** Whether `text` names `name` as a whole word, in the same case. */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w$-])${escaped}(?![\\w$-])`).test(text);
}

/** The configured owner reviewer, or null outside a configured repository. */
function configuredOwner(): string | null {
  try {
    return loadConfig(repositoryRoot(process.cwd())).ownerReviewer;
  } catch {
    return null;
  }
}

/**
 * Marks candidates that overlap within the set (#162), without dropping any.
 * Two sources (analyst, a second model, another lane) often raise one concern,
 * and one anchor can carry two different concerns, so an anchor alone is not
 * a duplicate. `sharesAnchorWith` lists the others on the same path:line;
 * `possibleDuplicateOf` names an earlier candidate in the same file whose claim
 * says the same thing, for the verifier and the renderer to settle.
 */
function markSiblings(kept: Record<string, unknown>[]): void {
  const facts = kept.map((entry) => ({
    id: String(entry['candidate_id'] ?? entry['candidateId'] ?? ''),
    path: String(entry['path'] ?? ''),
    line: Number(entry['line']),
    words: significantWords(String(entry['claim'] ?? '')),
  }));
  facts.forEach((fact, index) => {
    const anchorSiblings = facts.filter((other, j) => j !== index && other.path === fact.path && other.line === fact.line).map((other) => other.id);
    if (anchorSiblings.length > 0) kept[index]!['sharesAnchorWith'] = anchorSiblings;
    const earlier = facts
      .slice(0, index)
      .find((other) => other.path === fact.path && fact.words.size > 0 && overlap(fact.words, other.words) >= SAME_FILE_REPEAT_OVERLAP);
    if (earlier !== undefined) {
      kept[index]!['possibleDuplicateOf'] = { candidate_id: earlier.id, kind: earlier.line === fact.line ? 'same-anchor' : 'same-claim' };
    }
  });
}

/**
 * Checks analyst output against the candidate schema, before anything expensive
 * reads it.
 *
 * The same validation runs inside `score`, but `score` is the fourth stage. A
 * wrong-shaped output was not caught until after a full verification pass, and
 * on a real run that cost the only pass which found the best defect of the day.
 * Failing here costs one re-run of one agent.
 */
function checkCandidatesCommand(argv: string[]): number {
  let raw: unknown[];
  try {
    const parsed = JSON.parse(readStdin()) as { candidates?: unknown[] } | unknown[];
    raw = Array.isArray(parsed) ? parsed : (parsed.candidates ?? []);
  } catch {
    console.error('Expected {"candidates": [...]} on stdin.');
    return 2;
  }

  try {
    const candidates = raw.map((candidate, index) => normaliseCandidate(candidate as RawCandidate, index));
    assertUniqueCandidateIds(candidates);

    // A lane's prefix keeps ids from two lanes apart and ties each candidate to
    // its severity rule, so a wrong one goes back like an anchor (docs/adr/0023).
    // A candidate naming no lane keeps any id, as before lanes existed, unless
    // the id carries another lane's prefix: that lane's analyst dropped `lane`.
    const lanes = repositoryConfig()?.lanes ?? [DIFF_LANE];
    const laneFailures = candidates.flatMap(({ candidateId, lane: name }) => {
      if (name === undefined) {
        const owner = lanes.find((lane) => lane.name !== DIFF_LANE.name && candidateId.startsWith(lane.prefix));
        return owner === undefined
          ? []
          : [{ candidateId, lane: DIFF_LANE.name, reason: `${candidateId} carries lane ${owner.name}'s prefix ${owner.prefix} but names no lane; set lane: "${owner.name}"` }];
      }
      const lane = laneNamed(lanes, name);
      if (lane === undefined) {
        return [{ candidateId, lane: name, reason: `lane ${name} is not configured (${lanes.map((known) => known.name).join(', ')})` }];
      }
      return candidateId.startsWith(lane.prefix)
        ? []
        : [{ candidateId, lane: lane.name, reason: `${candidateId} is from lane ${lane.name}, so its candidate_id must start with ${lane.prefix}` }];
    });
    const laneExtra = laneFailures.length > 0 ? { laneFailures } : {};
    const reportLaneFailures = (): void => {
      if (laneFailures.length > 0) {
        console.error(`${laneFailures.length} candidate lane failure${laneFailures.length === 1 ? '' : 's'}.`);
      }
    };

    // An intent_ref naming no statement would send the verifier to re-read
    // intent nobody extracted; it fails like an anchor, so only it goes back.
    let intentFailures: { candidateId: string; intentRef: string; reason: string }[] = [];
    if (argv.includes('--intent')) {
      const intentFile = flag(argv, '--intent');
      if (intentFile === null) {
        console.error('--intent needs the intent.json check-intent wrote.');
        return 2;
      }
      let ids: Set<string>;
      try {
        const statements = (JSON.parse(readFileSync(intentFile, 'utf8')) as { statements?: unknown }).statements;
        if (!Array.isArray(statements)) throw new Error('statements is not a list');
        ids = new Set(statements.map((statement) => (statement as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string'));
      } catch (error) {
        console.error(`Cannot read ${intentFile}: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
      intentFailures = candidates.flatMap(({ candidateId, intentRef }) =>
        intentRef === undefined || ids.has(intentRef)
          ? []
          : [{ candidateId, intentRef, reason: `intent_ref ${intentRef} names no statement in ${intentFile} (check-intent drops a statement that breaks a rule); cite an existing one or drop intent_ref` }],
      );
    }
    const intentExtra = intentFailures.length > 0 ? { intentFailures } : {};
    if ((intentFailures.length > 0 || laneFailures.length > 0) && !argv.includes('--diff-file')) {
      console.log(JSON.stringify({ valid: false, ...laneExtra, ...intentExtra }, null, 2));
      reportLaneFailures();
      if (intentFailures.length > 0) {
        console.error(`${intentFailures.length} candidate intent_ref failure${intentFailures.length === 1 ? '' : 's'}.`);
      }
      return 1;
    }

    // Keep the no-flag answer byte-for-byte compatible for callers that use
    // this command only as the cheap schema boundary before a diff exists.
    if (!argv.includes('--diff-file')) {
      console.log(JSON.stringify({ valid: true, candidates: candidates.length }, null, 2));
      return 0;
    }

    const diffFile = flag(argv, '--diff-file');
    if (diffFile === null) {
      console.error('--diff-file needs a unified diff path.');
      return 2;
    }

    let hunks: Map<string, FileHunks>;
    try {
      hunks = parseHunks(readFileSync(diffFile, 'utf8'));
    } catch (error) {
      console.error(`Cannot read ${diffFile}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }

    const onDeletedFile = deletedFileCheck(argv);

    // --apply-patch-lines: a line that is really a diff.patch line number moves
    // to the new-file line it names, when that is an added line of the same file.
    const applyPatchLines = argv.includes('--apply-patch-lines');
    const anchors = candidates.map((candidate, index) => {
      let anchor = anchorFor(hunks, candidate);
      if (applyPatchLines && !anchor.ok && anchor.kind !== 'stale-consumer' && anchor.patchLine?.path === anchor.path) {
        const from = candidate.line;
        const to = anchor.patchLine.line;
        (candidate as { line: number }).line = to;
        (raw[index] as Record<string, unknown>)['line'] = to;
        console.error(`Re-anchored ${candidate.candidateId} from ${anchor.path}:${from} (a diff.patch line) to ${anchor.path}:${to}`);
        anchor = anchorFor(hunks, candidate);
      }
      return { candidate, anchor };
    });
    // A stale consumer that passes but sits on a line this diff changed. Not a
    // failure: the finding is sound, it is only posted in the body when it
    // could be inline.
    const suggestions = anchors
      .filter(({ anchor }) => anchor.ok && ordinaryFindingHint(anchor) !== null)
      .map(({ candidate, anchor }) => ({
        candidateId: candidate.candidateId,
        path: candidate.path,
        line: candidate.line,
        suggestion: ordinaryFindingHint(anchor),
      }));
    const extra = suggestions.length > 0 ? { suggestions } : {};
    const deletedFileCandidates = anchors
      .filter(({ candidate, anchor }) => onDeletedFile(candidate, anchor))
      .map(({ candidate }) => candidate.candidateId);
    if (deletedFileCandidates.length > 0) {
      console.error(`${deletedFileCandidates.length} candidate${deletedFileCandidates.length === 1 ? '' : 's'} on a deleted file, posted in the review body: ${deletedFileCandidates.join(', ')}`);
    }
    // A suggested patch on a sound anchor fails like an anchor, so the driver
    // sends it back to the lane that wrote it with the reason.
    const anchorFailures = anchors.flatMap(({ candidate, anchor }) => {
      const at = { candidateId: candidate.candidateId, path: candidate.path, line: candidate.line };
      if (!anchor.ok && !onDeletedFile(candidate, anchor)) {
        return [{ ...at, kind: anchor.kind, reason: reason(anchor), nearest: anchor.nearest, ...(anchor.causedBy === undefined ? {} : { causedBy: anchor.causedBy }) }];
      }
      const problem = candidate.suggestedPatch === undefined ? null : suggestedPatchMismatch(hunks, candidate.path, candidate.suggestedPatch);
      return problem === null ? [] : [{ ...at, kind: 'suggested-patch', reason: problem, nearest: [] as number[] }];
    });

    if (anchorFailures.length > 0 || intentFailures.length > 0 || laneFailures.length > 0) {
      console.log(
        JSON.stringify({ valid: false, ...(anchorFailures.length > 0 ? { anchorFailures } : {}), ...laneExtra, ...intentExtra }, null, 2),
      );
      reportLaneFailures();
      if (anchorFailures.length > 0) {
        console.error(`${anchorFailures.length} candidate anchor failure${anchorFailures.length === 1 ? '' : 's'}.`);
      }
      if (intentFailures.length > 0) {
        console.error(`${intentFailures.length} candidate intent_ref failure${intentFailures.length === 1 ? '' : 's'}.`);
      }
      return 1;
    }

    const heldFrom = flag(argv, '--held-from');
    if (argv.includes('--held-from') && heldFrom === null) {
      console.error('--held-from needs a run id, or several separated by commas.');
      return 2;
    }
    const headSha = flag(argv, '--head');
    if (heldFrom !== null && headSha === null) {
      console.error('--held-from needs --head <sha>, the head being reviewed.');
      return 2;
    }

    if (!argv.includes('--thread') && !argv.includes('--evidence') && heldFrom === null && !applyPatchLines) {
      console.log(
        JSON.stringify({ valid: true, candidates: candidates.length, anchors: { checked: candidates.length }, ...extra }, null, 2),
      );
      return 0;
    }

    // A repeat is removed here, before the verifier spends a pass on it. The
    // same check still runs inside `score` as the second line of defence. The
    // description is the exception: a match against it is passed on with
    // `possibleRepeatOf` rather than removed.
    let thread: ThreadComment[] = [];
    if (argv.includes('--thread')) {
      const threadFile = flag(argv, '--thread');
      if (threadFile === null) {
        console.error('--thread needs a thread JSON path.');
        return 2;
      }
      try {
        const parsed = JSON.parse(readFileSync(threadFile, 'utf8')) as { comments?: ThreadComment[] } | ThreadComment[];
        thread = Array.isArray(parsed) ? parsed : (parsed.comments ?? []);
        if (!Array.isArray(thread)) throw new Error('comments is not a list');
      } catch (error) {
        console.error(`Cannot read ${threadFile}: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    }

    // Static signals a candidate may restate. An unreadable file fails like an
    // unreadable thread: silently reviewing without it would hide the miss.
    let signals: EvidenceSignal[] = [];
    if (argv.includes('--evidence')) {
      const evidenceFile = flag(argv, '--evidence');
      if (evidenceFile === null) {
        console.error('--evidence needs the evidence.json the evidence command wrote.');
        return 2;
      }
      // Absolute signal paths are made relative to the repository the command
      // runs in, or to the working directory when it is not one.
      let signalRoot = process.cwd();
      try {
        signalRoot = repositoryRoot(process.cwd());
      } catch {
        // Not a repository; the working directory stands.
      }
      try {
        signals = readSignals(evidenceFile, signalRoot);
      } catch (error) {
        console.error(`Cannot read ${evidenceFile}: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    }

    // Several runs when related pull requests (a stack) carry the same code, so
    // an owner's decision on one holds on the others (#173).
    const heldRuns = heldFrom === null ? [] : [...new Set(heldFrom.split(',').map((id) => id.trim()).filter((id) => id !== ''))];
    const held = headSha === null ? [] : heldRuns.flatMap((runId) => carriedHeldFindings(runId, headSha));

    // The owner's own comments are told apart so the verifier knows whose point
    // it would be repeating. Logins compare without case, as GitHub's do.
    const owner = argv.includes('--thread') ? (flag(argv, '--owner') ?? configuredOwner())?.toLowerCase() ?? null : null;
    const isOwn = (comment: { author: string }): boolean => owner !== null && comment.author.toLowerCase() === owner;

    // The owner's own inline comments are never a reason to drop here. A
    // candidate that restates one may be what the author left open of it, and
    // only the verifier, reading the code, can tell that from a plain repeat;
    // dropping it lost the open part. It is flagged below instead, and `score`
    // still drops it unless the verifier found part of the comment open.
    // A `path:line` cited in a review body counts as a comment at that line
    // (#76), the owner's own included in the rule above.
    const located = citedLocations(thread);
    const droppable = located.filter((comment) => !(isOwn(comment) && comment.path !== null && comment.line !== null));

    const kept: unknown[] = [];
    const droppedAsRepeat: unknown[] = [];
    const droppedAsHeld: unknown[] = [];
    const droppedAsTool: unknown[] = [];
    candidates.forEach((candidate, index) => {
      const repeat = alreadySaidOnThread(candidate, droppable);
      if (repeat !== null) {
        droppedAsRepeat.push({
          candidateId: candidate.candidateId,
          path: candidate.path,
          line: candidate.line,
          author: repeat.author,
          commentPath: repeat.path,
          commentLine: repeat.line,
          reason: `Already stated by ${repeat.author} on this pull request.`,
        });
        return;
      }
      // A tool already reported this, with its own evidence; the model's
      // restatement is held, visibly, rather than posted twice.
      const restated = matchSignal(candidate, signals);
      if (restated !== null) {
        droppedAsTool.push({
          candidateId: candidate.candidateId,
          path: candidate.path,
          line: candidate.line,
          tool: restated.tool,
          signalLine: restated.line,
          message: restated.claim,
        });
        return;
      }
      // Only this command sets `possibleRepeatOf`; one arriving from the
      // analyst is not evidence of anything, and `score` trusts the own-comment kind.
      const { possibleRepeatOf: _ignored, ...original } = raw[index] as Record<string, unknown>;
      const heldMatch = matchHeld(candidate, held);
      if (heldMatch !== null && heldMatch.drop) {
        droppedAsHeld.push({
          candidateId: candidate.candidateId,
          path: candidate.path,
          line: candidate.line,
          heldVerdict: heldMatch.entry.verdict,
          heldReason: heldMatch.entry.reason,
          priorRunId: heldMatch.entry.runId,
        });
        return;
      }
      // The thread is the stronger lead, so a held match only fills the gap
      // when neither thread check found anything.
      const heldMark =
        heldMatch === null
          ? null
          : {
              kind: 'held',
              verdict: heldMatch.entry.verdict,
              reason: heldMatch.entry.reason,
              excerpt: (heldMatch.entry.text ?? '').slice(0, 200),
              path: heldMatch.entry.path,
              line: heldMatch.entry.line,
              priorRunId: heldMatch.entry.runId,
            };
      // A nearby anchored comment is the stronger lead, so it wins when both
      // match. A description match is never dropped here: wording cannot tell
      // a restatement from a contradiction, so the verifier decides.
      // After it, the same claim anywhere in the file, the owner's own comment
      // first: a line moves as the author edits above it, and one concern can
      // cover several places, so distance says little about a repeat. A
      // comment in another file that names this one counts too (#143).
      const possible =
        possiblySaidOnThread(candidate, located, isOwn) ??
        possiblyRaisedInFile(candidate, located, isOwn) ??
        possiblyRaisedInFile(candidate, located);
      if (possible !== null) {
        kept.push({
          ...original,
          possibleRepeatOf: {
            kind: isOwn(possible) ? 'own-comment' : 'thread',
            author: possible.author,
            path: possible.path,
            line: possible.line,
            ...(possible.outdated === true ? { outdated: true } : {}),
            ...(possible.resolved === true ? { resolved: true } : {}),
            ...(possible.resolved === true && typeof possible.resolvedBy === 'string' ? { resolvedBy: possible.resolvedBy } : {}),
            ...(typeof possible.id === 'number' ? { commentId: possible.id } : {}),
            excerpt: possible.body.slice(0, 200),
          },
        });
        return;
      }
      const described = possiblyRepeatsDescription(candidate, thread);
      kept.push(
        described === null
          ? heldMark === null
            ? original
            : { ...original, possibleRepeatOf: heldMark }
          : {
              ...original,
              possibleRepeatOf: {
                kind: 'description',
                author: described.comment.author,
                path: null,
                line: null,
                excerpt: described.excerpt,
              },
            },
      );
    });
    markSiblings(kept as Record<string, unknown>[]);

    console.log(
      JSON.stringify({ valid: true, candidates: kept.length, kept, droppedAsRepeat, droppedAsHeld, droppedAsTool, ...extra }, null, 2),
    );
    return 0;
  } catch (error) {
    if (error instanceof MalformedCandidate) {
      console.error(`Malformed candidate - ${error.message}`);
      console.error('Re-run the analyst with the schema restated. Do not hand-translate its output.');
      return 2;
    }
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  const exit = await dispatch(argv);
  const command = argv[0];
  // Said once here, not at every call site that rejects its flags.
  if (exit === 2 && command !== undefined && commandHelp(command) !== null) {
    console.error(`Run "review-voice ${command} --help" for its flags.`);
  }
  return exit;
}

/**
 * A command that runs configured commands, run on its own: a stop signal
 * kills them too (#277). Under the review driver, its own handler does that
 * and removes the worktree, so none is added here.
 */
async function whileStoppable(run: () => Promise<number>): Promise<number> {
  if (inProcessState() !== null) return run();
  const release = stopCommandsOnSignal();
  try {
    return await run();
  } finally {
    release();
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const command = argv[0];

  // Before dispatch, so it cannot be swallowed by a command that reads stdin.
  // `score --help` printed the stdin error and then blocked on a terminal,
  // which also hid `--exclude-pull`: the flag is in this text, and nobody
  // could get the text to appear.
  if (command !== undefined && (argv.includes('--help') || argv.includes('-h'))) {
    const section = commandHelp(command);
    if (section !== null) {
      console.log(section);
      return 0;
    }
    // `--help` and `-h` themselves, and `help --help`, show the whole list.
    if (command === '--help' || command === '-h' || command === 'help') {
      console.log(topLevelHelp());
      return 0;
    }
    console.error(`Unknown command: ${command}\n\n${topLevelHelp()}`);
    return 2;
  }

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      console.log(topLevelHelp());
      return 0;

    case 'help': {
      const topic = argv[1];
      if (topic === undefined) {
        console.log(topLevelHelp());
        return 0;
      }
      const section = commandHelp(topic);
      if (section === null) {
        console.error(`Unknown command: ${topic}\n\n${topLevelHelp()}`);
        return 2;
      }
      console.log(section);
      return 0;
    }

    case '--version':
    case '-v':
      console.log(pluginVersion());
      return 0;

    case 'diff':
      return argv.includes('--pr')
        ? await pullRequestDiffCommand(argv.slice(1))
        : diffCommand(argv.slice(1));

    case 'symbols':
      return symbolsCommand(argv.slice(1));

    case 'anchors':
      return anchorsCommand(argv.slice(1));

    case 'thread':
      return await threadCommand(argv.slice(1));

    case 'follow-ups':
      return followUpsCommand(argv.slice(1));

    case 'context':
      return contextCommand();

    case 'redact':
      return redactCommand(argv.slice(1));

    case 'sync':
      return await syncCommand(argv.slice(1));

    case 'discover':
      return await discoverCommand();

    case 'consent-plan':
      return consentPlanCommand(argv.slice(1));

    case 'purge':
      return purgeCommand(argv.slice(1));

    case 'retrieve':
      return retrieveCommand(argv.slice(1));

    case 'score':
      return scoreCommand(argv.slice(1));

    case 'evaluate':
      return evaluateCommand(argv.slice(1));

    case 'recall':
      return await recallCommand(argv.slice(1), runInProcess);

    case 'outcomes':
      return outcomesCommand(argv.slice(1));

    case 'draft':
      return draftCommand(argv.slice(1));

    case 'verdict':
      return await verdictCommand(argv.slice(1));

    case 'post':
      return await postCommand(argv.slice(1));

    case 'post-check':
      return postCheckCommand();

    case 'queue':
      return await queueCommand(argv.slice(1), {
        config: repositoryConfig(),
        client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true }),
        openDb: () => openDatabase(),
        now: new Date(),
        out: (text) => console.log(text),
        err: (text) => console.error(text),
      });

    case 'watch': {
      let root: string | null = null;
      try {
        root = repositoryRoot(process.cwd());
      } catch {
        // Not in a repository: there is no config, and watch refuses to start.
      }
      const dataDir = dataDirectory();
      const review = spawnReview(fileURLToPath(import.meta.url), { configPath: join(dataDir, CONFIG_COPY) });
      return await watchCommand(argv.slice(1), {
        configSource: root === null ? null : configFile(root),
        loadSettings: (path) => loadConfig(root ?? process.cwd(), undefined, path),
        client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true }),
        // Built from the recorded run's repository by post, as for the post command.
        writerFor: (allowlist) => new ReviewWriter({ allowlist }),
        openDb: () => openDatabase(),
        dataDir,
        review,
        stopReview: review.stop,
        prepareClone: gitPrepareClone(),
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        out: (text) => console.log(text),
        err: (text) => console.error(text),
      });
    }

    case 'calibrate':
      return calibrateCommand();

    case 'policy':
      return policyCommand(argv.slice(1));

    case 'check-candidates':
      return checkCandidatesCommand(argv.slice(1));

    case 'check-verification':
      return checkVerificationCommand(argv.slice(1));

    case 'check-simplification':
      return checkSimplificationCommand(argv.slice(1));

    case 'check-intent':
      return checkIntentCommand(argv.slice(1));

    case 'conventions':
      return conventionsCommand(argv.slice(1));

    case 'evidence':
      return await whileStoppable(() => evidenceCommand(argv.slice(1)));

    case 'worktree':
      return worktreeCommand(argv.slice(1));

    case 'reconcile':
      return reconcileCommand(argv.slice(1));
    case 'verify':
      return await whileStoppable(() => verifyCommand(argv));

    case 'record':
      return recordCommand(argv.slice(1));

    case 'carry':
      return carryCommand(argv.slice(1));

    case 'plan':
      return planCommand(argv.slice(1));

    case 'lanes':
      return lanesCommand(argv.slice(1));

    case 'reanchor':
      return reanchorCommand(argv.slice(1));

    case 'challenge':
      return challengeCommand(argv.slice(1));

    case 'carry-candidates':
      return carryCandidatesCommand(argv.slice(1));

    case 'feedback':
      return feedbackCommand(argv.slice(1));

    case 'decline':
      return declineCommand(argv.slice(1));

    case 'status':
      return statusCommand();

    case 'explain':
      return explainCommand(argv.slice(1));

    case 'validate-output':
      return validateOutputCommand(argv.slice(1));

    case 'agent':
      return await agentCommand(argv.slice(1));

    case 'review':
      return await reviewCommand(argv.slice(1));

    case 'doctor': {
      const checks = runDoctor();
      for (const check of checks) {
        console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(12)} ${check.detail}`);
      }
      // git and node:sqlite are required; gh is only needed once GitHub history
      // ingestion is enabled, so its absence is reported but not fatal.
      const required = checks.filter((c) => !OPTIONAL_CHECKS.has(c.name));
      return required.every((c) => c.ok) ? 0 : 1;
    }

    default:
      console.error(`Unknown command: ${command}\n\n${topLevelHelp()}`);
      return 2;
  }
}

/**
 * The exit code and message for an error a command threw. Network and
 * credential problems are ordinary operating conditions, not crashes, and a
 * stack trace tells the user nothing they can act on.
 */
function failureOf(error: unknown): { code: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const expected =
    error instanceof AuthError ||
    error instanceof NotAllowlisted ||
    error instanceof ReadOnlyViolation ||
    error instanceof WriteViolation ||
    error instanceof GitError;
  return { code: expected ? 2 : 1, message };
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Set inside the in-process command's own calls. A command that awaits (a
 * configured check now does, issue 277) leaves the event loop to other code,
 * and what that code prints is not the command's output, so it goes where it
 * was going. Under node:test that is the runner's own event stream.
 */
const inCommand = new AsyncLocalStorage<true>();

/**
 * Runs one command in this process with its output captured, for the review
 * driver: every stage calls the command itself, so the driver adds no review
 * logic of its own (docs/adr/0022). One command at a time.
 */
export async function runInProcess(
  argv: string[],
  options: { stdin?: string; fetchImpl?: typeof fetch } = {},
): Promise<CommandResult> {
  if (inProcessState() !== null) throw new Error('A command is already running in this process.');
  const out: string[] = [];
  const err: string[] = [];
  const saved = { log: console.log, error: console.error, write: process.stdout.write };
  setInProcess({ stdin: options.stdin ?? '', fetchImpl: options.fetchImpl });
  const mine = (): boolean => inCommand.getStore() === true;
  console.log = (...args: unknown[]) => (mine() ? void out.push(`${format(...args)}\n`) : saved.log(...args));
  console.error = (...args: unknown[]) => (mine() ? void err.push(`${format(...args)}\n`) : saved.error(...args));
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!mine()) return (saved.write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await inCommand.run(true, () => dispatch(argv));
  } catch (error) {
    const failure = failureOf(error);
    err.push(`${failure.message}\n`);
    code = failure.code;
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.stdout.write = saved.write;
    setInProcess(null);
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** Runs the whole review of one pull request (docs/adr/0022). */
async function reviewCommand(argv: string[]): Promise<number> {
  const pullNumber = Number(flag(argv, '--pr'));
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    console.error('--pr needs a pull request number.');
    return 2;
  }
  const modeFlag = flag(argv, '--mode');
  const mode = MODES.find((known) => known === modeFlag);
  if (argv.includes('--mode') && mode === undefined) {
    console.error(`--mode takes one of ${MODES.join(', ')}.`);
    return 2;
  }
  for (const name of ['--out', '--since', '--repository', '--expect-head', '--config']) {
    if (argv.includes(name) && flag(argv, name) === null) {
      console.error(`${name} needs a value.`);
      return 2;
    }
  }
  // Only the callers that start a review for someone else name themselves; a
  // person at a terminal is the driver, and `interactive` is the slash command's.
  const originFlag = flag(argv, '--origin');
  const reviewOrigin = argv.includes('--origin') ? (['watch', 'action'] as const).find((known) => known === originFlag) : 'driver';
  if (reviewOrigin === undefined) {
    console.error('--origin takes one of watch, action.');
    return 2;
  }
  const repository = flag(argv, '--repository') ?? inferRepository(process.cwd());
  if (repository === null) {
    console.error('Cannot tell which repository. Pass --repository <owner/repo>.');
    return 2;
  }
  const report = await runReview(
    {
      repository,
      pullNumber,
      mode,
      post: argv.includes('--post'),
      out: flag(argv, '--out'),
      since: flag(argv, '--since'),
      full: argv.includes('--full'),
      recheckThread: !argv.includes('--no-recheck-thread'),
      expectHead: flag(argv, '--expect-head'),
      config: flag(argv, '--config'),
      origin: reviewOrigin,
    },
    { command: (args, stdin) => runInProcess(args, { stdin }), client: githubClient([repository]) },
  );
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(reportText(report));
  return report.exitCode;
}

suppressSqliteExperimentalWarning();

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const failure = failureOf(error);
  console.error(failure.message);
  process.exitCode = failure.code;
}
