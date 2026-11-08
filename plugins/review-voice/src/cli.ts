/**
 * Review Voice CLI - the deterministic half of the plugin.
 *
 * Everything that can be decided by arithmetic or plumbing lives here: diff
 * acquisition, config and policy layering, static evidence, retrieval,
 * preference scoring, output validation, storage and audit. Judgement calls
 * (candidate generation, verification, wording) live in the plugin's agents.
 * See docs/ARCHITECTURE.md for why the line is drawn there.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { suppressSqliteExperimentalWarning } from './warnings.ts';
import { pluginVersion } from './version.ts';
import { OPTIONAL_CHECKS, runDoctor } from './doctor.ts';
import { splitFindings, parseFinding } from './contract/parse.ts';
import { GitError } from './diff/acquire.ts';
import {
  classifyAnchor,
  classifyStaleConsumer,
  normalisePath,
  ordinaryFindingHint,
  parseHunks,
  reason,
  suggestedPatchMismatch,
  type FileHunks,
} from './diff/hunks.ts';
import type { ThreadComment } from './diff/thread.ts';
import { openDatabase } from './store/db.ts';
import { dataDirectory } from './store/paths.ts';
import {
  runDetail,
  type HeldFinding,
} from './store/runs.ts';
import { carryFindings, CarryError } from './diff/carry.ts';
import { MODES } from './review/plan.ts';
import { DIFF_LANE, laneNamed } from './review/lanes.ts';
import { configFile, loadConfig } from './policy/load.ts';
import { repositoryRoot } from './diff/acquire.ts';
import { stopCommandsOnSignal } from './evidence/run.ts';
import type { EvidenceSignal } from './evidence/types.ts';
import { GitHubClient, NotAllowlisted, ReadOnlyViolation } from './github/client.ts';
import { AuthError } from './github/auth.ts';
import { queueCommand } from './queue/command.ts';
import { CONFIG_COPY, watchCommand } from './watch/command.ts';
import { spawnReview } from './watch/review.ts';
import { gitPrepareClone } from './watch/workspace.ts';
import {
  alreadySaidOnThread,
  citedLocations,
  possiblySaidOnThread,
  possiblyRaisedInFile,
  possiblyRepeatsDescription,
  normaliseCandidate,
  assertUniqueCandidateIds,
  MalformedCandidate,
  DUPLICATE_OVERLAP,
  SAME_FILE_REPEAT_OVERLAP,
  overlap,
  significantWords,
  type Candidate,
  type RawCandidate,
  isSuppressionExempt,
} from './scoring/score.ts';
import { ReviewWriter, WriteViolation } from './github/writer.ts';
import { commandHelp, topLevelHelp } from './help.ts';
import { runReview, reportText } from './review/driver.ts';
import {
  inProcessState,
  setInProcess,
  githubClient,
  readStdin,
  inferRepository,
  flag,
  repositoryConfig,
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
import { explainCommand } from './cli/explain.ts';
import { carryCommand, carryCandidatesCommand } from './cli/carry.ts';
import { recordCommand } from './cli/record.ts';
import { anchorFor, deletedFileCheck, scoreCommand, configuredOwner } from './cli/score.ts';
export { diffSummary, emitDiff } from './cli/diff.ts';
export { resolveOutPath, verificationProblem } from './cli/shared.ts';

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
