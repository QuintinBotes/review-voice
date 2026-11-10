import type { ChangedFile } from '../diff/acquire.ts';
import { reviewedFileKinds, type HumanReviewConfigInput, type Kind } from '../diff/complexity.ts';
import { isConfiguration } from '../diff/classify.ts';
import { unquoteGitPath } from '../diff/hunks.ts';
import type { Family } from '../agents/types.ts';
import type { LoadedConfig } from '../policy/load.ts';
import type { Authorship } from './authorship.ts';

/** Cost modes and the stage plan (docs/adr/0025). Pure: nothing here reads a file or calls a model. */
export type Mode = 'fast' | 'standard' | 'thorough';
export type RequestedMode = Mode | 'auto';
export type StageName = 'intent' | 'lanes' | 'verify' | 'reproduce' | 'second-pass' | 'tie-break' | 'challenge' | 'edit';
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
  /** The family the challenger runs on, and the rule that chose it (docs/adr/0034). */
  families: { challenge: Family; reason: string };
  /** The configured external runners, echoed as `overrides` is, so the driver needs no second config read. */
  runners: LoadedConfig['runners']['external'];
}

export interface PlanInput {
  requested: RequestedMode;
  models?: ModelOverrides;
  productionSourceChanged: boolean;
  productionLinesChanged: number;
  complexity: 'normal' | 'high';
  /**
   * Controls the change removes (`structure.removedControls`). Optional so a
   * caller that does not measure it is read as none; `planCommand` always sets it.
   */
  removedControls?: number;
  secondPassConfigured: boolean;
  /**
   * The `reproduction` block is on with at least one runner. Optional so a
   * caller that does not read it is read as off; `planCommand` always sets it.
   */
  reproductionConfigured?: boolean;
  runners?: LoadedConfig['runners'] | undefined;
  /** Who wrote the change, from `--authorship`; absent means not known. */
  authorship?: Authorship | undefined;
}

const SONNET = 'sonnet';
const OPUS = 'opus';
/** Above this many production lines changed, `auto` picks thorough. */
export const THOROUGH_LINE_LIMIT = 150;

function autoMode(input: PlanInput): { mode: Mode; reason: string } {
  // A removed control is where a regression hides; it changes models and
  // stages, never the verdict (docs/adr/0025). It is read before the fast
  // rule: the file it was removed from may be a deleted one, which the
  // production count never sees, since a deleted file is not a reviewed one.
  const removed = input.removedControls ?? 0;
  if (!input.productionSourceChanged && removed === 0) return { mode: 'fast', reason: 'auto: no production source changed' };
  if (input.complexity === 'high') return { mode: 'thorough', reason: 'auto: complexity is high' };
  if (removed > 0) {
    return { mode: 'thorough', reason: `auto: ${removed} control${removed === 1 ? ' was' : 's were'} removed` };
  }
  if (input.productionLinesChanged > THOROUGH_LINE_LIMIT) {
    return {
      mode: 'thorough',
      reason: `auto: ${input.productionLinesChanged} production lines changed (over ${THOROUGH_LINE_LIMIT})`,
    };
  }
  return { mode: 'standard', reason: 'auto: production source changed within the standard limits' };
}

/**
 * The base family is `runners.use.challenge`. A change an agent of that same
 * family wrote is challenged on `runners.use.agent_authored_challenge` instead.
 * A change from an agent of another family already has a cross-family
 * challenge, and "different from" an unknown family (`other`) is undefined,
 * so neither triggers the rule.
 */
function challengeFamily(input: PlanInput): { challenge: Family; reason: string } {
  const base = input.runners?.use.challenge ?? 'claude';
  const other = input.runners?.use.agentAuthoredChallenge ?? null;
  if (other !== null && other !== base && input.authorship?.agent === true && input.authorship.family === base) {
    return { challenge: other, reason: `agent-authored by ${base}; challenged on ${other} (runners.use.agent_authored_challenge)` };
  }
  return { challenge: base, reason: base === 'claude' ? 'default' : 'runners.use.challenge' };
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
      // A reproduction runs pull request code, so only the mode that pays for the most evidence runs it, and only when configured.
      reproduce: { run: thorough && (input.reproductionConfigured ?? false), model: null },
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
    families: challengeFamily(input),
    runners: input.runners?.external ?? {},
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
