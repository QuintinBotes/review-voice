import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireDiff,
  attributeSource,
  GitError,
  linguistGeneratedPaths,
  type ChangedFile,
  repositoryRoot,
} from '../diff/acquire.ts';
import {
  applyStructureHumanReviewCap,
  assessComplexity,
  deletedProductionPaths,
  humanReviewNote,
  productionPaths,
  type ComplexityAssessment,
} from '../diff/complexity.ts';
import { collectStructure, type StructureSignals } from '../diff/structure.ts';
import {
  acquirePullRequestDiff,
  applyReviewScope,
  type SquashedParentSuspected,
  type SuspectedWrongBase,
} from '../diff/pull-request.ts';
import { firstPartyMatcher, isReviewable } from '../diff/classify.ts';
import type { ExclusionSummary } from '../diff/exclusions.ts';
import { planScope, type PlannedScope, type ReviewScope } from '../diff/incremental.ts';
import { openDatabase } from '../store/db.ts';
import { recordedRunsForPull, runDetail } from '../store/runs.ts';
import {
  fetchPriorHead,
  latestOwnReview,
  resolvePrior,
  resolveSince,
  type PriorResolution,
  type RecordedRun,
} from '../diff/prior.ts';
import { githubClient, inferRepository, flag, repositoryConfig } from './shared.ts';

export async function pullRequestDiffCommand(argv: string[]): Promise<number> {
  const pullNumber = Number(flag(argv, '--pr'));
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    console.error('--pr needs a pull request number.');
    return 2;
  }

  const repository = flag(argv, '--repository') ?? inferRepository(process.cwd());
  if (repository === null) {
    console.error('Cannot tell which repository. Pass --repository <owner/repo>.');
    return 2;
  }

  // An explicit previous head overrides whatever was recorded, and must be a
  // commit this clone can read: comparing against a guess would narrow the
  // review on a boundary nobody checked.
  let since: string | null = null;
  if (argv.includes('--since')) {
    const wanted = flag(argv, '--since');
    since = wanted === null ? null : resolveSince(wanted, repository, process.cwd());
    if (since === null) {
      console.error(
        wanted === null ? '--since needs a commit.' : `--since ${wanted} is not a commit in this clone.`,
      );
      return 2;
    }
  }

  // One list for every place that asks whether a path is reviewed, so a path
  // cannot be read by the diff and vendored to the scope planner (issue 351).
  const firstPartyPaths = repositoryConfig()?.firstPartyPaths ?? [];
  const firstParty = firstPartyMatcher(firstPartyPaths);

  const result = await acquirePullRequestDiff({
    repository,
    pullNumber,
    includeGenerated: argv.includes('--include-generated'),
    firstPartyPaths,
    cwd: process.cwd(),
    client: githubClient([repository]),
  });

  let recorded: RecordedRun[] = [];
  let uncoveredPrior: string | null = null;
  try {
    const db = openDatabase();
    try {
      recorded = recordedRunsForPull(db, repository, pullNumber);
      // A run whose carry left commits unreviewed is no boundary: reading
      // only what came after it would never read those commits. With no
      // prior, the whole pull request is read (docs/adr/0017).
      if (recorded.length > 0 && runDetail(db, recorded[0]!.runId)?.carry?.covered === false) {
        uncoveredPrior = recorded[0]!.runId;
        recorded = [];
      }
    } finally {
      db.close();
    }
  } catch {
    // A store that cannot be read only removes one source of the previous head.
  }

  const { prior, resolution } = await resolvePrior({
    since,
    recorded,
    pull: `${repository}#${pullNumber}`,
    ownReview: () =>
      uncoveredPrior !== null
        ? Promise.resolve(null)
        : latestOwnReview(githubClient([repository]), repository, pullNumber),
  });
  if (uncoveredPrior !== null && since === null) {
    console.error(`Run ${uncoveredPrior} carried candidates without reviewing the commits before it, so the whole pull request is read.`);
  }

  // What the review at the previous head left out by its own rules, so that
  // a file no review read is not called unchanged since it. A run recorded
  // before that list was kept, or a previous head with no recorded run, says
  // nothing of the key or the flag it was read with, so it is taken to have
  // read only what the default rules read. A lock file left out then and
  // read now under --include-generated was never covered.
  const priorLeftOut =
    prior === null
      ? []
      : ((prior.reviewRunId === null ? null : leftOutBy(prior.reviewRunId)) ??
        result.files.filter((file) => !isReviewable(file.path, false)).map((file) => file.path));

  let planned: PlannedScope;
  try {
    planned = planScope({
      priorRun: prior,
      head: result.head,
      headAvailable: result.refs.head.available,
      reviewedFiles: result.files.filter((file) => file.reviewed),
      // Deletions are never reviewed, but a follow-up must still show one. A
      // deleted lock file or generated output stays out, as it would anyway.
      deletedFiles: result.files
        .filter((file) => file.status === 'deleted' && isReviewable(file.path, argv.includes('--include-generated'), firstParty))
        .map((file) => file.path),
      cwd: process.cwd(),
      truncated: result.truncated,
      forceFull: argv.includes('--full'),
      base: result.refs.base.available && result.base !== null ? result.base : undefined,
      fetchPriorHead: (sha) => fetchPriorHead(sha, repository, process.cwd()),
      includeGenerated: argv.includes('--include-generated'),
      firstPartyPaths,
      leftOutFiles: result.files.filter((file) => !file.reviewed),
      priorLeftOut,
    });
  } catch (error) {
    planned = {
      scope: {
        kind: 'full',
        cause: 'compare-unavailable',
        since: prior?.headRef ?? null,
        priorRunId: prior?.reviewRunId ?? null,
        detail: `planning the scope failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`,
      },
      interdiffPatch: null,
    };
  }

  const scoped = applyReviewScope(result, pullNumber, planned.scope, process.cwd(), undefined, planned.interdiffPatch, planned.leftOutChanged);
  return emitDiff({ ...scoped, repository, prior: resolution }, flag(argv, '--out'));
}

/** The paths a recorded run left out by its own rules, or null when it kept no such list or cannot be read. */
function leftOutBy(runId: string): string[] | null {
  try {
    const db = openDatabase();
    try {
      return runDetail(db, runId)?.leftOut ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * A whole unified diff inline in a JSON blob is awkward to hand to an agent -
 * the patch for a mid-sized pull request runs past a hundred kilobytes, and
 * the caller ends up splitting it back out. `--out` does that here instead.
 */
interface EmittedDiff {
  diff: string;
  mode: 'worktree' | 'staged' | 'base' | 'pull-request';
  base: string | null;
  head: string;
  reviewedFileCount: number;
  hunkFileCount: number;
  excludedFileCount: number;
  exclusions?: ExclusionSummary | null;
  files?: ChangedFile[];
  pullNumber?: number;
  scope?: ReviewScope;
  scopeNote?: string | null;
  truncated?: boolean;
  truncationNote?: string | null;
  suspectedWrongBase?: SuspectedWrongBase | null;
  squashedParentSuspected?: SquashedParentSuspected | null;
  /** Added by `emitDiff`; see docs/adr/0012. */
  complexity?: ComplexityAssessment;
  humanReviewNote?: string | null;
  /** Structural evidence for the analyst; enabled human-review settings may also cap an approval. */
  structure?: StructureSignals;
  refs?: {
    base: { sha: string; available: boolean };
    head: { sha: string; available: boolean };
    mergeBase: string | null;
  };
  prior?: PriorResolution;
  /** On `--pr`: the repository the diff was read for, so `record --files` can store it. */
  repository?: string;
}

/** The compact metadata a command runner needs after `diff --out`. */
export function diffSummary(result: EmittedDiff): {
  mode: EmittedDiff['mode'];
  base: string | null;
  /** On `--pr`, where the branch left the base; see `refs.mergeBase`. */
  mergeBase: string | null;
  head: string;
  pullNumber: number | null;
  scope: {
    kind: ReviewScope['kind'];
    cause: string | null;
    /**
     * Which condition sent a full read, and which git command failed, when one
     * did; on an interdiff, which conflicted files were narrowed or read whole.
     */
    detail: string | null;
    since: string | null;
    mergeBase: string | null;
  } | null;
  scopeNote: string | null;
  /**
   * Files the pull request no longer changes because the new base already
   * makes the same change; review.md prints them after the findings.
   */
  absorbedByBase: string[];
  /**
   * Files whose replay conflicted that the pull request no longer changes;
   * review.md prints them after the findings.
   */
  noLongerChanged: string[];
  complexity: ComplexityAssessment | null;
  humanReviewNote: string | null;
  structure: StructureSignals | null;
  truncated: boolean;
  truncationNote: string | null;
  /** A pull request whose commits mostly sit on the default branch; see `acquirePullRequestDiff`. */
  suspectedWrongBase: SuspectedWrongBase | null;
  /** Listed files already identical on the base tip, excluded from the review; see `acquirePullRequestDiff`. */
  squashedParentSuspected: SquashedParentSuspected | null;
  reviewedFileCount: number;
  hunkFileCount: number;
  excludedFileCount: number;
  /** How many changed files of the scope the review leaves out, by reason; null when it reads them all. */
  exclusions: ExclusionSummary | null;
  handEditSuspected: string[];
  refs: {
    base: { sha: string; available: boolean };
    head: { sha: string; available: boolean };
    mergeBase: string | null;
  } | null;
  prior: {
    source: PriorResolution['source'];
    head: string | null;
    runId: string | null;
    runIdNote: string | null;
  } | null;
} {
  const scope = result.scope === undefined
    ? null
    : {
        kind: result.scope.kind,
        cause:
          result.scope.kind === 'full'
            ? result.scope.cause
            : result.scope.kind === 'unchanged'
              ? result.scope.reason
              : null,
        detail:
          result.scope.kind === 'full' || result.scope.kind === 'interdiff' ? (result.scope.detail ?? null) : null,
        since: result.scope.since,
        mergeBase:
          result.scope.kind === 'unchanged' || result.scope.kind === 'interdiff' ? result.scope.mergeBase : null,
      };
  return {
    mode: result.mode,
    base: result.base,
    mergeBase: result.refs?.mergeBase ?? null,
    head: result.head,
    pullNumber: result.pullNumber ?? null,
    scope,
    scopeNote: result.scopeNote ?? null,
    absorbedByBase:
      result.scope !== undefined && (result.scope.kind === 'unchanged' || result.scope.kind === 'interdiff')
        ? (result.scope.absorbedByBase ?? [])
        : [],
    noLongerChanged:
      result.scope !== undefined && (result.scope.kind === 'unchanged' || result.scope.kind === 'interdiff')
        ? (result.scope.noLongerChanged ?? [])
        : [],
    complexity: result.complexity ?? null,
    humanReviewNote: result.humanReviewNote ?? null,
    structure: result.structure ?? null,
    truncated: result.truncated ?? false,
    truncationNote: result.truncationNote ?? null,
    suspectedWrongBase: result.suspectedWrongBase ?? null,
    squashedParentSuspected: result.squashedParentSuspected ?? null,
    reviewedFileCount: result.reviewedFileCount,
    hunkFileCount: result.hunkFileCount,
    excludedFileCount: result.excludedFileCount,
    exclusions: result.exclusions ?? null,
    handEditSuspected: (result.files ?? []).filter((file) => file.handEditSuspected === true).map((file) => file.path),
    refs:
      result.refs === undefined
        ? null
        : { base: result.refs.base, head: result.refs.head, mergeBase: result.refs.mergeBase },
    prior:
      result.prior === undefined
        ? null
        : {
            source: result.prior.source,
            head: result.prior.head,
            runId: result.prior.runId,
            runIdNote: result.prior.runIdNote ?? null,
          },
  };
}

/**
 * Reviewed and deleted paths the repository's `.gitattributes` marks generated,
 * as of the commit the change starts from (see attributeSource). Outside a
 * repository, or without that commit, nothing is marked.
 */
function markedGenerated(acquired: EmittedDiff): Set<string> {
  // A deleted file is asked about too, so a deleted generated file is not read
  // for removed controls; no reviewed-only path is affected by the extra names.
  const asked = (acquired.files ?? []).filter((file) => file.reviewed || file.status === 'deleted').map((file) => file.path);
  try {
    const root = repositoryRoot(process.cwd());
    return linguistGeneratedPaths(root, asked, attributeSource(root, acquired));
  } catch {
    return new Set();
  }
}

export function emitDiff(acquired: EmittedDiff, outDir: string | null): number {
  // Assessed here, from the diff the analyst will read, so the manifest and
  // the summary say the same thing and `record --files` carries it forward.
  const config = repositoryConfig();
  for (const warning of config?.warnings ?? []) console.error(`Warning: ${warning}`);
  // Said on every diff that leaves a file out, since a manifest entry is not a
  // signal, and ten of twelve files once went unread with no word (issue 351).
  if (acquired.exclusions != null) console.error(acquired.exclusions.note);
  const generated = markedGenerated(acquired);
  // A narrowed review is flagged for what it reads: files earlier commits
  // changed are not this run's. The pull request stays flagged through the
  // prior runs (ADR 0012, sticky).
  const scope = acquired.scope;
  const narrowed = scope !== undefined && (scope.kind === 'interdiff' || scope.kind === 'incremental') ? scope.files : null;
  const scopedFiles = (acquired.files ?? []).filter((file) => narrowed === null || narrowed.includes(file.path));
  const assessed = assessComplexity(acquired.diff, scopedFiles, config?.humanReview, generated);
  const production = productionPaths(scopedFiles, config?.humanReview, generated);
  // A wholly deleted file is not in the patch, so removed controls read it from
  // the base; it is classified by the same rules as the files the review reads.
  const deletedProduction = deletedProductionPaths(scopedFiles, config?.humanReview, generated);
  const structure = collectStructure(process.cwd(), acquired, production, config?.structure, deletedProduction);
  const complexity = applyStructureHumanReviewCap(assessed, structure, config?.humanReview);
  const result: EmittedDiff = {
    ...acquired,
    complexity,
    humanReviewNote: humanReviewNote(complexity),
    structure,
  };

  if (outDir === null) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  try {
    mkdirSync(outDir, { recursive: true });
    const patchPath = join(outDir, 'diff.patch');
    const metaPath = join(outDir, 'files.json');
    writeFileSync(patchPath, result.diff);
    writeFileSync(metaPath, JSON.stringify({ ...result, diff: undefined }, null, 2));
    console.log(
      JSON.stringify(
        { patch: patchPath, files: metaPath, diffBytes: result.diff.length, summary: diffSummary(result) },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(`Cannot write to ${outDir}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export function diffCommand(argv: string[]): number {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex === -1 ? null : (argv[baseIndex + 1] ?? null);
  if (baseIndex !== -1 && (base === null || base.startsWith('--'))) {
    console.error('--base needs a git ref, for example: --base origin/main');
    return 2;
  }

  try {
    const result = acquireDiff({
      cwd: process.cwd(),
      staged: argv.includes('--staged'),
      base,
      includeGenerated: argv.includes('--include-generated'),
      firstPartyPaths: repositoryConfig()?.firstPartyPaths ?? [],
    });
    // An empty diff is a valid answer, not an error: the caller should say so
    // rather than invent something to review.
    return emitDiff(result, flag(argv, '--out'));
  } catch (error) {
    if (error instanceof GitError) {
      console.error(error.message);
      console.error('Run this inside a git repository.');
      return 2;
    }
    throw error;
  }
}

/** files.json and diff.patch from `diff --out`, or null after saying what was wrong. */
export function readFilesAndDiff(
  filesPath: string,
  diffPath: string,
): { manifest: Record<string, unknown>; changed: ChangedFile[]; diffText: string; generated: Set<string> } | null {
  let manifest: Record<string, unknown>;
  let diffText: string;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filesPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
    manifest = parsed as Record<string, unknown>;
    diffText = readFileSync(diffPath, 'utf8');
  } catch (error) {
    console.error(`Cannot read the diff: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const files = manifest['files'];
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'object' && file !== null && typeof file.path === 'string')) {
    console.error(`${filesPath} is not a files.json from \`diff --out\`: it has no files list.`);
    return null;
  }
  const generated = markedGenerated({ ...manifest, diff: diffText } as unknown as EmittedDiff);
  return { manifest, changed: files as ChangedFile[], diffText, generated };
}
