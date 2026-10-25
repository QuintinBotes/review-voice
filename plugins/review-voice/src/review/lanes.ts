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

export interface Lane {
  name: string;
  /** Agent file stem under the plugin's agents/ directory. */
  agent: string;
  /** Every candidate_id from this lane starts with it. */
  prefix: string;
  when: { minChangedSourceLines?: number; paths?: string[]; excludeKinds?: ChangeKind[] };
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
 * Which lanes run on this change, counting changed lines the way `plan` does
 * except that a lane's `exclude_kinds` replaces the kinds left out.
 */
export function eligibleLanes(
  lanes: readonly Lane[],
  files: readonly ChangedFile[],
  diffText: string,
  options: { humanReview?: HumanReviewConfigInput | undefined; markedGenerated?: ReadonlySet<string> } = {},
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
    const minimum = lane.when.minChangedSourceLines ?? 0;
    return lines >= minimum
      ? { lane, eligible: true, reason: `${measured}, at least ${minimum}` }
      : { lane, eligible: false, reason: `${measured}, under the minimum of ${minimum}` };
  });
}
