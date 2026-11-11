import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { safeCheckName } from '../publish/verdict.ts';
import type { HeldFinding } from '../store/runs.ts';
import type { ReviewReport } from './driver.ts';

/**
 * The held queue (`verdict.held_queue`, docs/adr/0031 amendment) lists every
 * finding a run held, with its verdict and reason, and for the ones
 * `score --promote` can post, the command that re-scores the run from its own
 * directory. The commands are printed for a person and never run; nothing here
 * is posted to the pull request.
 */

/** The `score` call the driver made, kept so the run can be scored again by hand. */
export interface PromoteCall {
  /** `process.execPath`, then the bundle. */
  program: readonly string[];
  cwd: string;
  /** REVIEW_VOICE_CONFIG and REVIEW_VOICE_DATA_DIR when set, the two variables `score` reads. */
  env: Readonly<Record<string, string>>;
  /** The arguments passed, `score` first. */
  args: readonly string[];
  /** `score-input.json` in the run directory. */
  stdin: string;
  /** `scores.promoted.json`, so the run's own `scores.json` is never overwritten. */
  stdout: string;
}

export interface HeldQueueEntry {
  path: string;
  line: number;
  severity: string | null;
  verdict: string;
  reason: string;
  candidateId: string | null;
  /** The command that re-scores the run with this finding promoted; null when `score --promote` cannot post it. */
  promote: string | null;
}

/**
 * The verdicts `applyOwnerPromotion` accepts with a bare `--promote`. An
 * unverified one needs an owner note, so the queue never offers a route to
 * post a claim the verifier could not check.
 */
const PROMOTABLE: ReadonlySet<string> = new Set(['below-gate', 'policy-suppressed']);

/** A word that could end the code span, break the line, or hide or reorder what a person reads. */
const UNSAFE = /[`\u0000-\u001f\u007f-\u009f​-‍‪-‮⁦-⁩﻿]/;
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One word for a POSIX shell. */
const quote = (word: string): string => (BARE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

function promoteCommand(call: PromoteCall, candidateId: string): string | null {
  const env = Object.entries(call.env);
  const words = [call.cwd, ...env.flat(), ...call.program, ...call.args, candidateId, call.stdin, call.stdout];
  if (words.some((word) => UNSAFE.test(word))) return null;
  return [
    'cd',
    quote(call.cwd),
    '&&',
    ...env.map(([name, value]) => `${name}=${quote(value)}`),
    ...[...call.program, ...call.args, '--promote', candidateId].map(quote),
    '<',
    quote(call.stdin),
    '>',
    quote(call.stdout),
  ].join(' ');
}

/** One entry per held finding, in order; `call` is null when the run kept none or its paths must not be shown. */
export function heldQueue(held: readonly HeldFinding[], call: PromoteCall | null): HeldQueueEntry[] {
  return held.map((entry) => {
    const candidateId = entry.candidateId || null;
    return {
      path: entry.path,
      line: entry.line,
      severity: entry.severity ?? null,
      verdict: entry.verdict,
      reason: entry.reason,
      candidateId,
      promote: call !== null && candidateId !== null && PROMOTABLE.has(entry.verdict) ? promoteCommand(call, candidateId) : null,
    };
  });
}

/** True for an entry of the shape `heldQueue` returns; the watcher reads the queue from a child's JSON. */
export function isHeldQueueEntry(value: unknown): value is HeldQueueEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const optional = (key: string): boolean => entry[key] === null || typeof entry[key] === 'string';
  return (
    typeof entry['path'] === 'string' &&
    Number.isInteger(entry['line']) &&
    typeof entry['verdict'] === 'string' &&
    typeof entry['reason'] === 'string' &&
    optional('severity') &&
    optional('candidateId') &&
    optional('promote')
  );
}

export const PROMOTE_NOTE =
  'A promoted finding still has to pass the challenge. Continue from step 4b of commands/review.md, with scores.promoted.json in place of scores.json.';

/** Inline code on one line, so no markdown, HTML or mention in the text can render. */
const code = (text: string, max?: number): string => `\`${safeCheckName(text, max) || 'none'}\``;

/**
 * The list as lines of markdown, nothing for an empty queue. Every string the
 * run recorded is flattened through `safeCheckName` into a code span.
 */
export function heldQueueLines(entries: readonly HeldQueueEntry[], runId: string | null): string[] {
  if (entries.length === 0) return [];
  return [
    `Held by Review Voice (${entries.length})${runId === null ? '' : `, run ${code(runId)}`}`,
    PROMOTE_NOTE,
    ...entries.map((entry) => {
      const location = `\`${safeCheckName(entry.path, 200) || 'none'}:${entry.line}\``;
      const what = [location, code(entry.severity ?? 'no severity'), code(entry.verdict), code(entry.reason, 120)].join(', ');
      // Checked again here, since a watcher renders entries another process wrote.
      const next =
        entry.promote !== null && !UNSAFE.test(entry.promote)
          ? `Promote with \`${entry.promote}\`.`
          : entry.candidateId !== null && PROMOTABLE.has(entry.verdict)
            ? `Promotable as ${code(entry.candidateId)}.`
            : 'Not promotable.';
      return `- ${what}. ${next}`;
    }),
  ];
}

/**
 * Appends the list to the job summary inside GitHub Actions, above the
 * Action's own section, which the same step writes after `review` exits.
 * Returns a warning when the append fails; the run's exit code never changes.
 */
export function writeJobSummary(report: Pick<ReviewReport, 'heldQueue' | 'runId'>, env: NodeJS.ProcessEnv): string | null {
  const path = env['GITHUB_STEP_SUMMARY'];
  const [heading, note, ...items] = heldQueueLines(report.heldQueue ?? [], report.runId);
  if (env['GITHUB_ACTIONS'] !== 'true' || path === undefined || !isAbsolute(path) || heading === undefined) return null;
  try {
    appendFileSync(path, `## ${heading}\n\n${note}\n\n${items.join('\n')}\n\n`);
    return null;
  } catch (error) {
    return `The held findings were not added to the job summary: ${error instanceof Error ? error.message : String(error)}`;
  }
}
