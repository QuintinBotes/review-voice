import type { StageTiming } from './runs.ts';

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
 */
export const SHALLOW_MIN_DIFF_LINES = 150;
export const SHALLOW_LINES_PER_CALL = 40;

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

/**
 * Keeps the fields a stage is defined by and drops the rest, so a stages file
 * cannot put arbitrary data in the run. The analyst stage also gets the size of
 * the diff it read, which is what its effort is judged against later.
 */
export function cleanStages(stages: StageTiming[], diff: string | null): StageTiming[] {
  const diffLines = diff === null ? undefined : changedLineCount(diff);
  return stages.map((stage) => {
    const toolCalls = count(stage.toolCalls);
    const tokens = count(stage.tokens);
    const filesRead = count(stage.filesRead);
    return {
      name: stage.name,
      seconds: stage.seconds,
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(filesRead === undefined ? {} : { filesRead }),
      ...(stage.name === 'analyst' && diffLines !== undefined ? { diffLines } : {}),
    };
  });
}

/** One line per stage, for `explain`. */
export function describeStage(stage: StageTiming): string {
  const parts = [`${Math.round(stage.seconds)}s`];
  if (stage.toolCalls !== undefined) parts.push(`${stage.toolCalls} tool call${stage.toolCalls === 1 ? '' : 's'}`);
  if (stage.filesRead !== undefined) parts.push(`${stage.filesRead} file${stage.filesRead === 1 ? '' : 's'} read`);
  if (stage.tokens !== undefined) parts.push(`${stage.tokens} tokens`);
  if (stage.diffLines !== undefined) parts.push(`on ${stage.diffLines} changed lines`);
  return `${stage.name}: ${parts.join(', ')}`;
}

/** A warning when a run with no findings came from a very shallow analyst pass. */
export function shallowPassWarning(stages: StageTiming[], findingCount: number): string | null {
  if (findingCount > 0) return null;
  const analyst = stages.find((stage) => stage.name === 'analyst');
  if (analyst?.toolCalls === undefined || analyst.diffLines === undefined) return null;
  if (analyst.diffLines < SHALLOW_MIN_DIFF_LINES) return null;
  if (analyst.toolCalls * SHALLOW_LINES_PER_CALL >= analyst.diffLines) return null;
  return (
    `The analyst made ${analyst.toolCalls} tool call(s) on ${analyst.diffLines} changed lines and found nothing. ` +
    'That is a shallow pass for this size; consider re-running it, on a stronger model if need be, before trusting a clean result.'
  );
}
