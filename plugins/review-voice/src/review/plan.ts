import type { ChangedFile } from '../diff/acquire.ts';
import { reviewedFileKinds, type HumanReviewConfigInput, type Kind } from '../diff/complexity.ts';
import { isConfiguration } from '../diff/classify.ts';
import { unquoteGitPath } from '../diff/hunks.ts';

/** Cost modes and the stage plan (docs/adr/0025). Pure: nothing here reads a file or calls a model. */
export type Mode = 'fast' | 'standard' | 'thorough';
export type RequestedMode = Mode | 'auto';
export type StageName = 'intent' | 'lanes' | 'verify' | 'second-pass' | 'tie-break' | 'challenge' | 'edit';
export type Tier = 'blocking' | 'important' | 'minor' | 'nit';

export const MODES: readonly RequestedMode[] = ['fast', 'standard', 'thorough', 'auto'];
/** The keys `review.models` may set. `analyst` is the diff lane's model. */
export const MODEL_KEYS = ['intent', 'analyst', 'lanes', 'verify', 'tie-break', 'challenge', 'edit'] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];
export type ModelOverrides = Partial<Record<ModelKey, string>>;

export interface StagePlan {
  mode: Mode;
  requested: RequestedMode;
  /** Which rule chose the mode. */
  reason: string;
  stages: Record<StageName, { run: boolean; model: string | null }>;
  /** `others: null` means the other lanes are off. */
  laneModels: { diff: string; others: string | null };
  /** The configured overrides, kept so a per-finding model honours them. */
  overrides: ModelOverrides;
}

export interface PlanInput {
  requested: RequestedMode;
  models?: ModelOverrides;
  productionSourceChanged: boolean;
  productionLinesChanged: number;
  complexity: 'normal' | 'high';
  secondPassConfigured: boolean;
}

const SONNET = 'sonnet';
const OPUS = 'opus';
/** Above this many production lines changed, `auto` picks thorough. */
export const THOROUGH_LINE_LIMIT = 150;

function autoMode(input: PlanInput): { mode: Mode; reason: string } {
  if (!input.productionSourceChanged) return { mode: 'fast', reason: 'auto: no production source changed' };
  if (input.complexity === 'high') return { mode: 'thorough', reason: 'auto: complexity is high' };
  if (input.productionLinesChanged > THOROUGH_LINE_LIMIT) {
    return {
      mode: 'thorough',
      reason: `auto: ${input.productionLinesChanged} production lines changed (over ${THOROUGH_LINE_LIMIT})`,
    };
  }
  return { mode: 'standard', reason: 'auto: production source changed within the standard limits' };
}

export function resolvePlan(input: PlanInput): StagePlan {
  const overrides = input.models ?? {};
  const chosen =
    input.requested === 'auto'
      ? autoMode(input)
      : { mode: input.requested, reason: `mode set to ${input.requested}` };
  const { mode } = chosen;
  const fast = mode === 'fast';
  const thorough = mode === 'thorough';

  const diffLane = overrides.analyst ?? overrides.lanes ?? (thorough ? OPUS : SONNET);
  const otherLanes = fast ? null : (overrides.lanes ?? (thorough ? OPUS : SONNET));
  const secondPass = input.secondPassConfigured && !fast;

  return {
    mode,
    requested: input.requested,
    reason: chosen.reason,
    stages: {
      intent: { run: true, model: overrides.intent ?? SONNET },
      lanes: { run: true, model: diffLane },
      // The verifier is a floor: no mode turns it off.
      verify: { run: true, model: overrides.verify ?? (thorough ? OPUS : SONNET) },
      // The second pass is a configured command, so it has no model of its own.
      'second-pass': { run: secondPass, model: null },
      'tie-break': { run: true, model: overrides['tie-break'] ?? (fast ? SONNET : OPUS) },
      // In fast the stage is off by default; modelForFinding applies the floor for findings above a nit.
      challenge: fast
        ? { run: false, model: null }
        : { run: true, model: overrides.challenge ?? (thorough ? OPUS : SONNET) },
      edit: { run: true, model: overrides.edit ?? SONNET },
    },
    laneModels: { diff: diffLane, others: otherLanes },
    overrides,
  };
}

const STRONG: ReadonlySet<Tier | 'question'> = new Set(['important', 'blocking']);

/**
 * The model for one finding at a stage whose model depends on its severity.
 * Verification always runs. Challenge always runs above a nit, in every mode
 * (docs/adr/0025); in fast mode it does not run for a nit or a question.
 */
export function modelForFinding(
  plan: StagePlan,
  stage: 'verify' | 'challenge',
  severity: Tier | 'question',
): { run: boolean; model: string | null } {
  const override = plan.overrides[stage];
  const strong = plan.mode === 'thorough' || (plan.mode === 'standard' && STRONG.has(severity));
  const model = override ?? (strong ? OPUS : SONNET);
  if (stage === 'verify') return { run: true, model };
  if (plan.mode === 'fast' && (severity === 'nit' || severity === 'question')) return { run: false, model: null };
  return { run: true, model };
}

/** Kinds of changed file the production line count can leave out; all of them by default. */
export const CHANGE_KINDS = ['test', 'docs', 'config', 'generated'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

const CHANGE_KIND: Record<Kind, ChangeKind | 'production'> = {
  production: 'production',
  test: 'test',
  documentation: 'docs',
  generated: 'generated',
};

export interface ProductionChange {
  productionSourceChanged: boolean;
  productionLinesChanged: number;
}

/** Added and removed lines per file, read from the diff text. */
function linesByPath(diffText: string): Map<string, number> {
  const counts = new Map<string, number>();
  let current: string | null = null;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (?:"a\/.*?"|a\/\S+) ("b\/.*"|b\/.*)$/.exec(line);
      current = match === null ? null : unquoteGitPath(match[1]!).slice(2);
      inHunk = false;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (inHunk && (line.startsWith('+') || line.startsWith('-'))) {
      counts.set(current, (counts.get(current) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Production source changed and how many lines of it, by the classification
 * the complexity assessment uses, plus a configuration kind of its own that
 * the decision-point count does not have. `exclude` names the kinds left out
 * (all of them by default, as `plan` uses it); `counts` narrows which files
 * count, as a lane's `paths` does. A file's own additions and deletions win;
 * the diff text is counted only for a file that records neither.
 */
export function productionChange(
  files: readonly ChangedFile[],
  diffText: string,
  partial?: HumanReviewConfigInput,
  markedGenerated: ReadonlySet<string> = new Set(),
  options: { exclude?: readonly ChangeKind[] | undefined; counts?: ((path: string) => boolean) | undefined } = {},
): ProductionChange {
  const exclude = new Set<string>(options.exclude ?? CHANGE_KINDS);
  const lockfiles = new Set(files.filter((file) => file.class === 'lockfile').map((file) => file.path));
  const kindOf = (path: string, kind: Kind): ChangeKind | 'production' =>
    (kind === 'production' || lockfiles.has(path)) && isConfiguration(path) ? 'config' : CHANGE_KIND[kind];
  const production = new Set(
    [...reviewedFileKinds(files, partial, markedGenerated)]
      .filter(([path, kind]) => !exclude.has(kindOf(path, kind)) && (options.counts?.(path) ?? true))
      .map(([path]) => path),
  );
  let fromDiff: Map<string, number> | null = null;
  let lines = 0;
  for (const file of files) {
    if (!production.has(file.path)) continue;
    if (Number.isFinite(file.additions) && Number.isFinite(file.deletions)) {
      lines += file.additions + file.deletions;
    } else {
      fromDiff ??= linesByPath(diffText);
      lines += fromDiff.get(file.path) ?? 0;
    }
  }
  return { productionSourceChanged: production.size > 0, productionLinesChanged: lines };
}
