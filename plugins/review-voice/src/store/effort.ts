import type { StageTiming } from './runs.ts';
import { parseHunks } from '../diff/hunks.ts';
import { FAMILIES } from '../agents/types.ts';

/**
 * How much the analyst actually read, and whether a clean result came from a
 * pass too shallow to trust. Local evidence only: nothing here is posted, and
 * nothing here changes a verdict.
 *
 * A clean `{"candidates": []}` after 3 or 4 tool calls on a 200 to 470 line
 * diff recorded as an ordinary clean run, while the same analyst on comparable
 * diffs used 15 to 60. The pass is shallow when its tool calls fall below one
 * per 40 changed lines, on a diff of at least 150 lines. Both numbers are
 * calibrated by guess from those runs; a measured distribution should revise
 * them.
 *
 * It is also shallow when it read under half of the changed files it could
 * read, on a diff of any size (#320): many small files can each go unread
 * while the tool calls still cover the lines.
 */
export const SHALLOW_MIN_DIFF_LINES = 150;
export const SHALLOW_LINES_PER_CALL = 40;
export const SHALLOW_MIN_FILES_READ_SHARE = 0.5;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Added and removed lines, not headers or context. */
export function changedLineCount(diff: string): number {
  let lines = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) continue;
    if (raw.startsWith('+') || raw.startsWith('-')) lines += 1;
  }
  return lines;
}

/** Every field of a stage; typed so a field added to StageTiming must be added here. */
const STAGE_FIELDS: Record<keyof StageTiming, true> = {
  name: true,
  seconds: true,
  toolCalls: true,
  tokens: true,
  filesRead: true,
  diffLines: true,
  diffFiles: true,
  model: true,
  models: true,
  costUsd: true,
  family: true,
};

/**
 * The figures a stage may leave out (#352). A coordinator that hands a stage to
 * a subagent gets its answer back and none of these, and a required figure it
 * could not see was a figure it made up.
 */
const FIGURES = ['seconds', 'toolCalls', 'filesRead', 'tokens'] as const;

/**
 * The stages of a `--stages` file, or an error naming what it does not know.
 * Refused rather than filtered (#316): a stage dropped in silence left the run
 * with an empty list that looked like a run with no stages.
 */
export function parseStagesFile(parsed: unknown, warn: (message: string) => void = () => undefined): StageTiming[] {
  const keyed = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed).filter((key) => key !== 'stages') : [];
  const list = Array.isArray(parsed) ? parsed : (parsed as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(list) || keyed.length > 0) {
    throw new Error(`expected an array or {"stages": [...]}${keyed.length === 0 ? '' : `, not keys ${keyed.map((key) => JSON.stringify(key)).join(', ')}`}`);
  }
  list.forEach((stage: unknown, index) => {
    const problem = ((): string | null => {
      if (typeof stage !== 'object' || stage === null || Array.isArray(stage)) return 'not an object';
      // An extra field costs only itself: the stage is kept and the drop is named, so a stray note never fails a record.
      const unknown = Object.keys(stage).filter((key) => !Object.hasOwn(STAGE_FIELDS, key));
      if (unknown.length > 0) warn(`entry ${index}: unknown field${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => JSON.stringify(key)).join(', ')} not stored`);
      const given = stage as Record<string, unknown>;
      if (typeof given['name'] !== 'string' || given['name'] === '') return 'name must be a non-empty string';
      // Left out or null is not measured. A value that is there and is no measurement is a mistake, and storing it as not measured would hide it.
      const bad = FIGURES.find((key) => given[key] !== undefined && given[key] !== null && count(given[key]) === undefined);
      return bad === undefined ? null : `${bad} must be a number, zero or more, when it is given`;
    })();
    if (problem !== null) throw new Error(`entry ${index}: ${problem}`);
  });
  return list as StageTiming[];
}

/**
 * Keeps the fields a stage is defined by and drops the rest, so a stages file
 * cannot put arbitrary data in the run. The analyst stage also gets the size of
 * the diff it read, which is what its effort is judged against later.
 */
export function cleanStages(stages: StageTiming[], diff: string | null): StageTiming[] {
  const diffLines = diff === null ? undefined : changedLineCount(diff);
  // Files with a hunk at the head, as acquire counts them: parseHunks keeps a hunkless file only when it ends the patch.
  const diffFiles = diff === null ? undefined : [...parseHunks(diff).values()].filter((file) => file.ranges.length > 0).length;
  return stages.map((stage) => {
    const seconds = count(stage.seconds);
    const toolCalls = count(stage.toolCalls);
    const tokens = count(stage.tokens);
    const filesRead = count(stage.filesRead);
    const costUsd = count(stage.costUsd);
    // A model name is configuration text; bounded so it cannot carry a payload.
    const modelName = (value: unknown): value is string => typeof value === 'string' && /^[\w.:\[\]-]{1,100}$/.test(value);
    const model = modelName(stage.model) ? stage.model : undefined;
    const models = Array.isArray(stage.models) ? stage.models.filter(modelName).slice(0, 200) : [];
    // A family outside the closed enum is dropped, not stored.
    const family = (FAMILIES as readonly unknown[]).includes(stage.family) ? stage.family : undefined;
    return {
      name: stage.name,
      ...(seconds === undefined ? {} : { seconds }),
      ...(model === undefined ? {} : { model }),
      ...(models.length === 0 ? {} : { models }),
      ...(family === undefined ? {} : { family }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(filesRead === undefined ? {} : { filesRead }),
      ...(stage.name === 'analyst' && diffLines !== undefined ? { diffLines } : {}),
      ...(stage.name === 'analyst' && diffFiles !== undefined ? { diffFiles } : {}),
    };
  });
}

/** One line per stage, for `explain`. */
export function describeStage(stage: StageTiming): string {
  // Not `=== undefined`: a row from the store may hold null where a figure is missing.
  const figure = (value: number | undefined, label: string, measured: (value: number) => string): string =>
    typeof value === 'number' ? measured(value) : `${label} not measured`;
  const parts = [
    figure(stage.seconds, 'seconds', (value) => `${Math.round(value)}s`),
    figure(stage.toolCalls, 'tool calls', (value) => `${value} tool call${value === 1 ? '' : 's'}`),
    figure(stage.filesRead, 'files read', (value) => `${value} file${value === 1 ? '' : 's'} read`),
    figure(stage.tokens, 'tokens', (value) => `${value} tokens`),
  ];
  if (stage.diffLines !== undefined) parts.push(`on ${stage.diffLines} changed lines`);
  return `${stage.name}: ${parts.join(', ')}`;
}

/** A warning when a run with no findings came from a very shallow analyst pass. */
export function shallowPassWarning(stages: StageTiming[], findingCount: number): string | null {
  if (findingCount > 0) return null;
  const analyst = stages.find((stage) => stage.name === 'analyst');
  if (analyst === undefined) return null;
  const { toolCalls, diffLines, filesRead, diffFiles } = analyst;
  const reasons: string[] = [];
  // As describeStage reads them: a null from the store is not measured, and judged as a number it would be zero.
  if (typeof toolCalls === 'number' && diffLines !== undefined && diffLines >= SHALLOW_MIN_DIFF_LINES && toolCalls * SHALLOW_LINES_PER_CALL < diffLines) {
    reasons.push(`made ${toolCalls} tool call(s) on ${diffLines} changed lines`);
  }
  if (typeof filesRead === 'number' && diffFiles !== undefined && filesRead < diffFiles * SHALLOW_MIN_FILES_READ_SHARE) {
    reasons.push(`read ${filesRead} of ${diffFiles} changed files`);
  }
  if (reasons.length === 0) return null;
  return (
    `The analyst ${reasons.join(', ')} and found nothing. ` +
    'That is a shallow pass for this size; consider re-running it, on a stronger model if need be, before trusting a clean result.'
  );
}

/**
 * What `record` says when a clean run gave the files check nothing to judge
 * (#352): no warning is not the same as a read that passed.
 */
export function unjudgedRead(stages: StageTiming[], findingCount: number): string | null {
  if (findingCount > 0) return null;
  const analyst = stages.find((stage) => stage.name === 'analyst');
  if (analyst === undefined || typeof analyst.filesRead === 'number' || !analyst.diffFiles) return null;
  return `Whether the analyst read enough of the ${analyst.diffFiles} changed files could not be judged, because the stage recorded no file count.`;
}
