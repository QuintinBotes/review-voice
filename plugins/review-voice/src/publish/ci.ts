import type { GitHubClient } from '../github/client.ts';

/**
 * A check that fails by design until something else happens: a "ready to
 * merge" marker, an approval requirement, a contract check that has not yet
 * run. Configured per repository under `ci.gate_checks`, and none are built in,
 * because a name that is a gate in one repository is a real test in another.
 */
export interface GateCheck {
  /** Glob over the check name; `*` matches anything, `?` one character. */
  name: string;
  /** When set, the check's summary must also contain this, ignoring case. */
  summary?: string | undefined;
}

export type CiResult = 'passed' | 'failed' | 'pending' | 'ignored';

export interface CiEntry {
  name: string;
  source: 'check-run' | 'status';
  result: CiResult;
  /** The raw status or conclusion, so a reader can see why it landed here. */
  detail: string;
  /** The configured gate it matched, when it was moved to `gates`. */
  gate?: string | undefined;
}

export interface CiState {
  state: 'green' | 'pending' | 'red';
  passed: number;
  failed: CiEntry[];
  pending: CiEntry[];
  ignored: CiEntry[];
  gates: CiEntry[];
}


interface RawCheckRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { id?: number; slug?: string } | null;
  output?: { title?: string | null; summary?: string | null } | null;
}

interface RawStatus {
  id?: number;
  context?: string;
  state?: string;
  description?: string | null;
}

/** Enough for a monorepo. A reading that reaches it is incomplete, so it is not green. */
export const MAX_ENTRIES = 1000;

/** Superseded or deliberately not run. None of them says anything about this head. */
const IGNORED_CONCLUSIONS = new Set(['stale', 'skipped', 'neutral']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

export function classifyCheckRun(run: { status?: string | undefined; conclusion?: string | null | undefined }): {
  result: CiResult;
  detail: string;
} {
  const status = (run.status ?? '').toLowerCase();
  if (status !== 'completed') {
    // An unknown status is treated as still running: it cannot be a pass.
    return { result: 'pending', detail: status.length > 0 ? status : 'unknown' };
  }
  const conclusion = (run.conclusion ?? '').toLowerCase();
  if (conclusion === 'success') return { result: 'passed', detail: conclusion };
  if (IGNORED_CONCLUSIONS.has(conclusion)) return { result: 'ignored', detail: conclusion };
  if (FAILED_CONCLUSIONS.has(conclusion)) return { result: 'failed', detail: conclusion };
  // A cancelled run that nothing later replaced never said whether the head
  // passes. Superseded ones are dropped before this point.
  if (conclusion === 'cancelled') return { result: 'pending', detail: 'cancelled, with no later run' };
  if (conclusion.length === 0) return { result: 'pending', detail: 'completed without a conclusion' };
  // A conclusion GitHub adds later is not a pass until someone says it is.
  return { result: 'failed', detail: conclusion };
}

export function classifyStatus(status: { state?: string | undefined }): { result: CiResult; detail: string } {
  const state = (status.state ?? '').toLowerCase();
  if (state === 'success') return { result: 'passed', detail: state };
  if (state === 'pending') return { result: 'pending', detail: state };
  return { result: 'failed', detail: state.length > 0 ? state : 'unknown' };
}

function nameGlob(glob: string): RegExp {
  // Check names are free text with spaces and slashes ("ci / build (linux)"),
  // so `*` crosses everything here, unlike a path glob.
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i');
}

function matchingGate(name: string, text: string, gates: readonly GateCheck[]): GateCheck | null {
  for (const gate of gates) {
    if (!nameGlob(gate.name).test(name)) continue;
    if (gate.summary !== undefined && !text.toLowerCase().includes(gate.summary.toLowerCase())) continue;
    return gate;
  }
  return null;
}

const identity = (run: RawCheckRun): string => `${run.app?.id ?? run.app?.slug ?? ''}\u0000${run.name ?? ''}`;

function later(a: RawCheckRun, b: RawCheckRun): boolean {
  // Check run ids only grow, so they order runs even when a queued run has no
  // start time yet.
  if (typeof a.id === 'number' && typeof b.id === 'number') return a.id > b.id;
  return (a.started_at ?? a.completed_at ?? '') > (b.started_at ?? b.completed_at ?? '');
}

/**
 * Drops the runs a later run has replaced, and nothing else.
 *
 * Only a run that never finished (queued, in progress and the like) or was
 * cancelled can be replaced, and only by a later completed run from the same
 * app with the same name: that is a re-run, and an orphaned queued run beside
 * it must not hold the head forever. A failure is never replaced. Two
 * workflows can carry a job of the same name, and "the newest one passed" is
 * how a red build read as green.
 */
function withoutSuperseded(runs: RawCheckRun[]): RawCheckRun[] {
  return runs.filter((run) => {
    const unfinished = (run.status ?? '').toLowerCase() !== 'completed';
    const cancelled = !unfinished && (run.conclusion ?? '').toLowerCase() === 'cancelled';
    if (!unfinished && !cancelled) return true;
    return !runs.some(
      (other) =>
        other !== run &&
        (other.status ?? '').toLowerCase() === 'completed' &&
        identity(other) === identity(run) &&
        later(other, run),
    );
  });
}

export interface CiReading {
  /** The combined status's own state and count, as GitHub reported them. */
  combined?: { state: string | null; totalCount: number } | undefined;
  /** True when a paginated read stopped at its cap, so some checks were not seen. */
  truncated?: boolean | undefined;
}

/** Classifies already-fetched check runs and statuses. Pure, so it is tested without a network. */
export function summariseCi(
  checkRuns: RawCheckRun[],
  statuses: RawStatus[],
  gates: readonly GateCheck[] = [],
  reading: CiReading = {},
): CiState {
  const entries: { entry: CiEntry; text: string }[] = [];

  for (const run of withoutSuperseded(checkRuns)) {
    const { result, detail } = classifyCheckRun(run);
    const text = `${run.output?.title ?? ''}\n${run.output?.summary ?? ''}`;
    entries.push({ entry: { name: run.name ?? '', source: 'check-run', result, detail }, text });
  }

  // The combined endpoint already returns the latest status per context, and
  // a failure is not something to deduplicate away.
  for (const status of statuses) {
    const { result, detail } = classifyStatus(status);
    entries.push({ entry: { name: status.context ?? '', source: 'status', result, detail }, text: status.description ?? '' });
  }

  const state: CiState = { state: 'green', passed: 0, failed: [], pending: [], ignored: [], gates: [] };
  for (const { entry, text } of entries) {
    if (entry.result === 'passed') {
      state.passed += 1;
      continue;
    }
    if (entry.result === 'ignored') {
      state.ignored.push(entry);
      continue;
    }
    // Only a check that is not passing can be a gate. A gate that passes is
    // just a pass.
    const gate = matchingGate(entry.name, text, gates);
    if (gate !== null) {
      state.gates.push({ ...entry, gate: gate.name });
    } else if (entry.result === 'failed') {
      state.failed.push(entry);
    } else {
      state.pending.push(entry);
    }
  }

  // Not knowing is not green. No checks at all usually means CI has not been
  // scheduled yet; a capped reading did not see every check. GitHub reports a
  // combined state of pending with no statuses behind it for every commit
  // without statuses, so that state only counts when statuses exist.
  if (checkRuns.length === 0 && statuses.length === 0) {
    state.pending.push({ name: 'no checks reported yet', source: 'check-run', result: 'pending', detail: 'none' });
  }
  if (reading.truncated === true) {
    state.pending.push({ name: `more than ${MAX_ENTRIES} checks`, source: 'check-run', result: 'pending', detail: 'not all read' });
  }
  if (reading.combined !== undefined && reading.combined.totalCount > 0 && reading.combined.state?.toLowerCase() === 'pending') {
    state.pending.push({ name: 'combined status', source: 'status', result: 'pending', detail: 'pending' });
  }

  state.state = state.failed.length > 0 ? 'red' : state.pending.length > 0 ? 'pending' : 'green';
  return state;
}

/**
 * Reads CI for one commit: check runs and the combined commit status, both
 * paginated. A monorepo pull request carried more than 100 check runs, so one
 * page is not "the checks". One past the cap is asked for, so a reading that
 * reached it is known to be incomplete.
 */
export async function readCi(
  client: GitHubClient,
  repository: string,
  sha: string,
  gates: readonly GateCheck[] = [],
): Promise<CiState> {
  const checkRuns = await client.paginateWrapped<RawCheckRun>(
    `/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100`,
    'check_runs',
    MAX_ENTRIES + 1,
  );

  const first = await client.get<{ state?: unknown; total_count?: unknown; statuses?: unknown }>(
    `/repos/${repository}/commits/${sha}/status?per_page=100`,
  );
  const statuses = (Array.isArray(first.data?.statuses) ? first.data.statuses : []) as RawStatus[];
  if (first.linkNext !== null) {
    statuses.push(...(await client.paginateWrapped<RawStatus>(first.linkNext, 'statuses', MAX_ENTRIES + 1 - statuses.length)));
  }

  return summariseCi(checkRuns.slice(0, MAX_ENTRIES), statuses.slice(0, MAX_ENTRIES), gates, {
    combined: {
      state: typeof first.data?.state === 'string' ? first.data.state : null,
      totalCount: typeof first.data?.total_count === 'number' ? first.data.total_count : statuses.length,
    },
    truncated: checkRuns.length > MAX_ENTRIES || statuses.length > MAX_ENTRIES,
  });
}
