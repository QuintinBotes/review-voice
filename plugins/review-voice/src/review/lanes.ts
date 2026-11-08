import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangedFile } from '../diff/acquire.ts';
import type { HumanReviewConfigInput } from '../diff/complexity.ts';
import { governsAny } from '../conventions/globs.ts';
import { productionChange, type ChangeKind, type Tier } from './plan.ts';

/** Configured analyst lanes (docs/adr/0023). Pure apart from finding the plugin's agents directory. */

/** Weakest to strongest. */
export const LANE_TIERS: readonly Tier[] = ['nit', 'minor', 'important', 'blocking'];

/**
 * The structural signals a lane may wake on, each the name of a list in
 * `structure` (the `diff --out` manifest). A closed list: a new signal is a
 * new reading of the diff, and docs/ARCHITECTURE.md names each one.
 */
export const LANE_SIGNAL_KEYS = {
  'removed-controls': 'removedControls',
  'risk-markers': 'riskMarkers',
  'type-escapes': 'typeEscapes',
  'branch-growth': 'branchGrowth',
  'size-crossing': 'sizeCrossings',
} as const;
export type LaneSignal = keyof typeof LANE_SIGNAL_KEYS;
export const LANE_SIGNALS = Object.keys(LANE_SIGNAL_KEYS) as readonly LaneSignal[];

export interface Lane {
  name: string;
  /** Agent file stem under the plugin's agents/ directory. */
  agent: string;
  /** Every candidate_id from this lane starts with it. */
  prefix: string;
  when: { minChangedSourceLines?: number; paths?: string[]; excludeKinds?: ChangeKind[]; signals?: LaneSignal[] };
  severity: { cap?: Tier; escalate?: { to: Tier; requires: 'blocker_confirmed' } };
}

/** Always present; it cannot be redefined or given a severity rule. */
export const DIFF_LANE: Lane = { name: 'diff', agent: 'diff-analyst', prefix: 'cand_', when: {}, severity: {} };

/** The lane a candidate came from: its `lane`, or `diff` when it names none. */
export function laneNamed(lanes: readonly Lane[], name: string | undefined): Lane | undefined {
  return lanes.find((lane) => lane.name === (name ?? DIFF_LANE.name));
}

/**
 * The plugin's agents directory. Searched upward because the code runs both
 * from the bundle (dist/) and from source (src/review/) in tests.
 */
function agentsDirectory(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, 'agents');
    if (existsSync(join(candidate, `${DIFF_LANE.agent}.md`))) return candidate;
    dir = dirname(dir);
  }
  return null;
}

export function agentExists(name: string): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return false;
  const dir = agentsDirectory();
  return dir !== null && existsSync(join(dir, `${name}.md`));
}

export interface LaneEligibility {
  lane: Lane;
  eligible: boolean;
  reason: string;
}

/**
 * How many entries of one signal the manifest's `structure` block holds, in
 * the lane's paths when it sets any. The block is untrusted JSON: a missing
 * block, a missing key, a non-list or an entry without a path counts as none.
 */
function signalCount(structure: unknown, signal: LaneSignal, paths: readonly string[] | undefined): number {
  if (typeof structure !== 'object' || structure === null) return 0;
  const entries = (structure as Record<string, unknown>)[LANE_SIGNAL_KEYS[signal]];
  if (!Array.isArray(entries)) return 0;
  return entries.filter((entry) => {
    const path = typeof entry === 'object' && entry !== null ? (entry as { path?: unknown }).path : undefined;
    return typeof path === 'string' && (paths === undefined || governsAny(paths, [path]));
  }).length;
}

/**
 * Which lanes run on this change, counting changed lines the way `plan` does
 * except that a lane's `exclude_kinds` replaces the kinds left out. A lane with
 * `signals` also wakes when one of them is non-empty in `structure`; with
 * `signals` an absent minimum is no minimum rather than zero (docs/adr/0023).
 */
export function eligibleLanes(
  lanes: readonly Lane[],
  files: readonly ChangedFile[],
  diffText: string,
  options: {
    humanReview?: HumanReviewConfigInput | undefined;
    markedGenerated?: ReadonlySet<string>;
    /** The manifest's `structure` block, as read from files.json. */
    structure?: unknown;
  } = {},
): LaneEligibility[] {
  return lanes.map((lane) => {
    if (lane.name === DIFF_LANE.name) return { lane, eligible: true, reason: 'the diff lane always runs' };
    const paths = lane.when.paths;
    const counts = paths === undefined ? undefined : (path: string) => governsAny(paths, [path]);
    const { productionLinesChanged: lines } = productionChange(files, diffText, options.humanReview, options.markedGenerated, {
      exclude: lane.when.excludeKinds,
      counts,
    });
    const measured = `${lines} changed source line${lines === 1 ? '' : 's'}${paths === undefined ? '' : ` in ${paths.join(', ')}`}`;
    const signals = lane.when.signals;
    if (signals !== undefined) {
      const where = paths === undefined ? '' : ` in ${paths.join(', ')}`;
      const fired = signals
        .map((signal) => ({ signal, count: signalCount(options.structure, signal, paths) }))
        .filter(({ count }) => count > 0);
      const set = lane.when.minChangedSourceLines;
      const met = set !== undefined && lines >= set;
      const held = [
        ...fired.map(({ signal, count }) => `${signal}: ${count} entr${count === 1 ? 'y' : 'ies'}${where}`),
        ...(met ? [`${measured}, at least ${set}`] : []),
      ];
      if (held.length > 0) return { lane, eligible: true, reason: held.join('; ') };
      const asked = `none of ${signals.length === 0 ? 'no signals' : signals.join(', ')} fired${where}`;
      return {
        lane,
        eligible: false,
        reason: set === undefined ? `${asked}, and no line minimum is set` : `${asked}, and ${measured} is under the minimum of ${set}`,
      };
    }
    const minimum = lane.when.minChangedSourceLines ?? 0;
    return lines >= minimum
      ? { lane, eligible: true, reason: `${measured}, at least ${minimum}` }
      : { lane, eligible: false, reason: `${measured}, under the minimum of ${minimum}` };
  });
}
