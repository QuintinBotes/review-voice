import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pluginVersion } from '../version.ts';
import { validateOutput } from '../contract/validate.ts';
import { DEFAULT_LIMITS } from '../contract/limits.ts';
import { parseComplexity, type ComplexityAssessment } from '../diff/complexity.ts';
import { parseVerifiedSimplification, type VerifiedSimplification } from '../simplification.ts';
import type { ReviewScope } from '../diff/incremental.ts';
import { parseHunks, patchRenames } from '../diff/hunks.ts';
import type { ThreadComment } from '../diff/thread.ts';
import {
  FollowUpRulingError,
  openFollowUps,
  parseFollowUpRulings,
  settleFollowUps,
  type FollowUpRuling,
  type FollowUpState,
} from '../store/follow-ups.ts';
import { openDatabase } from '../store/db.ts';
import {
  recordRun,
  runDetail,
  heldProblem,
  challengeNotRun,
  type CarryMarker,
  CarryMismatch,
  type CandidateHint,
  type HeldFinding,
  type StageTiming,
  type RunProvenance,
  type RecordedChecks,
  type RecordedReproduction,
  ORIGINS,
  PROVENANCE_MODES,
  recordedChecks,
  recordedReproductions,
  storedPolicyVersions,
  type PolicyVersionRef,
} from '../store/runs.ts';
import { seriousNotCarried, type CarriedFinding } from '../diff/carry.ts';
import { resolveCommit } from '../diff/prior.ts';
import { parseTieBreaks, type TieBreak } from '../verify/reconcile.ts';
import { cleanStages, parseStagesFile, shallowPassWarning } from '../store/effort.ts';
import { noFindingsHint, readStdin, inferRepository, flag, boundLists } from './shared.ts';
import { reviewScopeFromManifest } from './explain.ts';
import { carryForRun, sameCommit } from './carry.ts';
import { readSignals } from './check-candidates.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { SAFE_GIT } from '../review/worktree.ts';
import type { EvidenceSignal } from '../evidence/types.ts';

/** A path as the diff spells it. A held entry keeps the analyst's spelling, `./src/app.ts` included, so both sides of a comparison go through here. */
const plainPath = (path: string): string => posix.normalize(path.split('\\').join('/')).replace(/^\.\//, '');

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

export function recordCommand(argv: string[]): number {
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
  let manifestMode: unknown = null;
  let scope: ReviewScope | undefined;
  let complexity: ComplexityAssessment | null = null;
  const knownPaths = new Set<string>();
  // The pull request's own file list, a rename under both names; empty when the manifest carries none.
  const pullFiles = new Set<string>();
  if (filesFile !== null) {
    try {
      const manifest = JSON.parse(readFileSync(filesFile, 'utf8')) as Record<string, unknown>;
      if (Array.isArray(manifest.files)) {
        for (const file of manifest.files) {
          if (typeof file?.path !== 'string') continue;
          knownPaths.add(file.path);
          pullFiles.add(plainPath(file.path));
          if (typeof file.previousPath === 'string') pullFiles.add(plainPath(file.previousPath));
        }
      }
      if (Number.isInteger(manifest.pullNumber) && (manifest.pullNumber as number) > 0) {
        pullNumber = manifest.pullNumber as number;
      }
      manifestMode = manifest.mode;
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
      // The content under review (#322): the index for a staged review, the working tree for a worktree review or
      // when no --head names a side, else the file at --head, since the checkout may be elsewhere.
      const heldHead = flag(argv, '--head');
      const atHead = manifestMode !== 'worktree' && manifestMode !== 'staged' && heldHead !== null;
      // A ref starting with '-' would reach git as an option, so it is never resolved.
      const heldRevision =
        manifestMode === 'staged' ? '' : atHead && !heldHead.startsWith('-') ? resolveCommit(heldHead, process.cwd()) : null;
      if (knownPaths.size > 0 && held.length > 0 && atHead && heldRevision === null) {
        console.error(`--head ${heldHead} is not a commit in this clone, so held lines were not checked against the file at it.`);
      }
      if (knownPaths.size > 0) {
        for (const entry of held) {
          if (!knownPaths.has(entry.path)) {
            console.error(`Held entry ${entry.path}:${entry.line} matches no changed file or candidate; later --held-from runs will not match it.`);
            continue;
          }
          if (atHead && heldRevision === null) continue;
          try {
            const content =
              heldRevision === null
                ? readFileSync(join(repositoryRoot(process.cwd()), entry.path), 'utf8')
                : execFileSync('git', [...SAFE_GIT, 'show', `${heldRevision}:${entry.path}`], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    maxBuffer: 64 * 1024 * 1024,
                  });
            const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
            if (entry.line > lines) console.error(`Held entry ${entry.path}:${entry.line} is past the end of the file (${lines} lines).`);
          } catch {
            // Not a file there, or not a repository: the line cannot be checked, so say nothing.
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
      stages = cleanStages(
        parseStagesFile(JSON.parse(readFileSync(stagesFile, 'utf8')), (message) => console.error(`Stages in ${stagesFile}: ${message}.`)),
        diff === '' ? null : diff,
      );
    } catch (error) {
      console.error(`Cannot read stages from ${stagesFile}: ${(error as Error).message}`);
      return 2;
    }
  }

  // The two reports are summarised together or not at all: a summary built from
  // one of them would say "no static checks" or "every symbol file finished" for
  // a report nobody supplied, and the review scope block would then claim it.
  const evidenceFile = flag(argv, '--evidence');
  const symbolsFile = flag(argv, '--symbols');
  let checks: RecordedChecks | undefined;
  let toolSignals: EvidenceSignal[] = [];
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
      // Read as `check-candidates` reads them, so a signal's path compares the
      // same way there and here, and one outside the repository matches nothing.
      let root = process.cwd();
      try {
        root = repositoryRoot(root);
      } catch {
        // Not a repository; the working directory stands.
      }
      toolSignals = readSignals(evidenceFile, root);
    } catch (error) {
      console.error(
        `Cannot read the checks from ${evidenceFile} and ${symbolsFile}: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return 2;
    }
  }

  // The documents `conventions` returned, so a quote the analyst cited is
  // stored only when the document holds it. Refused when unreadable, like the
  // other inputs, since recording without it would look like a run that cited none.
  const conventionsFile = flag(argv, '--conventions');
  let conventions: { path: string; content: string }[] = [];
  if (argv.includes('--conventions')) {
    if (conventionsFile === null) {
      console.error('--conventions needs the conventions.json that `conventions` wrote.');
      return 2;
    }
    try {
      const report = JSON.parse(readFileSync(conventionsFile, 'utf8')) as { documents?: unknown } | null;
      const documents = report?.documents;
      if (!Array.isArray(documents)) throw new Error('it has no documents list');
      conventions = documents.flatMap((doc: unknown) => {
        const d = doc as { path?: unknown; content?: unknown } | null;
        return typeof d?.path === 'string' && typeof d.content === 'string' ? [{ path: d.path, content: d.content }] : [];
      });
    } catch (error) {
      console.error(`Cannot read conventions from ${conventionsFile}: ${error instanceof Error ? error.message : String(error)}.`);
      return 2;
    }
  }

  // What the reproduce stage did, kept without output, since the output can hold
  // anything the copy could read and so stays in the run directory under retention.
  const reproductionsFile = flag(argv, '--reproductions');
  let reproductions: RecordedReproduction[] | undefined;
  if (argv.includes('--reproductions')) {
    if (reproductionsFile === null) {
      console.error('--reproductions needs the reproductions.json that `reproduce` wrote.');
      return 2;
    }
    try {
      reproductions = recordedReproductions(JSON.parse(readFileSync(reproductionsFile, 'utf8')) as unknown);
    } catch (error) {
      console.error(`Cannot read reproductions from ${reproductionsFile}: ${error instanceof Error ? error.message : String(error)}.`);
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
    // A hold for a challenger that did not run outlives a carry and a narrowed
    // review: nothing judged that finding, and dropping its hold would let this
    // run approve (docs/adr/0024). One on a file the pull request no longer
    // changes is settled like its findings. The manifest's file list says so
    // for every scope; the two scope lists say so for a manifest without one.
    const left = new Set(
      (scope?.kind === 'unchanged' || scope?.kind === 'interdiff' ? [...(scope.noLongerChanged ?? []), ...(scope.absorbedByBase ?? [])] : []).map(plainPath),
    );
    const stillChanged = (path: string): boolean => !left.has(path) && (pullFiles.size === 0 || pullFiles.has(path));
    // A file this review's patch renames takes its hold to the new name. Under
    // the old one, which the pull request's file list never held when the file
    // was renamed before, the hold would read as one on a file that left.
    const renamed = patchRenames(diff);
    const unjudged = (prior: HeldFinding[] | undefined): HeldFinding[] =>
      (prior ?? [])
        .filter(challengeNotRun)
        .map((entry) => {
          const to = renamed.get(plainPath(entry.path));
          return to === undefined ? entry : { ...entry, path: to };
        })
        .filter((entry) => stillChanged(plainPath(entry.path)));
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
        // Like the marker above: a carry reviews no file, so every such hold travels with it.
        held = [...held, ...unjudged(source?.held)];
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

    // A review narrower than the pull request never releases such a hold, on a
    // file it read or not: it saw its own hunks only, the held line may be far
    // from them, and nothing challenges a finding that is not raised again. A
    // full review inherits nothing, since it reads the whole pull request.
    if (carriedFrom === null && (scope?.kind === 'incremental' || scope?.kind === 'interdiff') && scope.priorRunId !== null) {
      const place = (entry: HeldFinding): string => `${plainPath(entry.path)}:${entry.line}`;
      // The same finding held again by this run is recorded once.
      const own = new Set(held.filter(challengeNotRun).map(place));
      held = [...held, ...unjudged(runDetail(db, scope.priorRunId)?.held).filter((entry) => !own.has(place(entry)))];
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

    const { reviewRunId, findings, provenance, families } = recordRun(db, {
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
      ...(reproductions === undefined ? {} : { reproductions }),
      toolSignals,
      conventions,
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
          // So the review driver can print the lines without a second command.
          provenance,
          families,
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
