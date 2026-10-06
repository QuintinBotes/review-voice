import { GitHubError, type GitHubClient } from '../github/client.ts';

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

/**
 * `rerun` is a check that did not fail on the code: CI's own machinery timed
 * out, could not start, was cancelled with nothing after it, failed with an
 * infrastructure signature in its output, or has sat unfinished too long to
 * still be coming (docs/adr/0013).
 */
export type CiResult = 'passed' | 'failed' | 'pending' | 'ignored' | 'rerun';

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
  state: 'green' | 'pending' | 'red' | 'needs-rerun';
  passed: number;
  failed: CiEntry[];
  /** Infrastructure failures and stuck checks: nothing to wait for, someone has to rerun them. */
  rerun: CiEntry[];
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
  output?: {
    title?: string | null;
    summary?: string | null;
    annotations_count?: number | null;
  } | null;
  /** The run's annotations, when `readCi` fetched them; never part of GitHub's list response. */
  annotations?: RawAnnotation[] | undefined;
}

interface RawAnnotation {
  path?: string | null;
  annotation_level?: string | null;
  title?: string | null;
  message?: string | null;
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
/**
 * The run never got to say anything about the code: CI timed out, could not
 * start, or is waiting on someone. Counting these as red blamed the change for
 * the runner; a rerun is what they need.
 */
const RERUN_CONCLUSIONS = new Set(['timed_out', 'action_required', 'startup_failure']);

/** How long a check may sit queued or running before it is taken as stuck rather than coming, by default. */
export const STUCK_AFTER_MINUTES = 60;

/** A longer or shorter stuck threshold for the checks whose names match `name`. */
export interface StuckThreshold {
  /** Glob over the check name, as for gate checks. */
  name: string;
  /** A whole number above zero. */
  minutes: number;
}

/**
 * Text that, in a failed check's output or its failure annotations, says the
 * runner or a service it called gave out rather than the change: an agent or
 * runner lost, the platform's time limit, a full disk, a dropped connection,
 * a throttled or unavailable service. Whole phrases rather than bare status
 * codes, because "503" also appears in "503 tests passed".
 */
export const BUILTIN_RERUN_SIGNATURES: readonly string[] = [
  'We stopped hearing from agent',
  'lost communication with the server',
  'The runner has received a shutdown signal',
  'has exceeded the maximum execution time',
  'No space left on device',
  'ECONNRESET',
  'other side closed',
  '429 Too Many Requests',
  '503 Service Unavailable',
];

/** Per-repository CI settings beyond gate checks, from `ci:` in the config (docs/adr/0013). */
export interface CiRules {
  /** Replaces the 60-minute default. */
  stuckAfterMinutes?: number | undefined;
  /** Per check name; the first match wins over `stuckAfterMinutes`. */
  stuckAfter?: readonly StuckThreshold[] | undefined;
  /**
   * Phrases that turn a `failure` into a rerun, matched ignoring case.
   * Undefined means `BUILTIN_RERUN_SIGNATURES`; an empty list matches nothing.
   */
  rerunSignatures?: readonly string[] | undefined;
}

/** Annotations read per failed run; one page is plenty for a runner's own message. */
const ANNOTATIONS_PER_RUN = 50;
/** Failed runs whose annotations are read. Past it a failure stays red, which is where it started. */
export const MAX_ANNOTATION_READS = 50;

export function classifyCheckRun(
  run: { status?: string | undefined; conclusion?: string | null | undefined; started_at?: string | null | undefined },
  now?: number | undefined,
  stuckAfterMinutes: number = STUCK_AFTER_MINUTES,
): {
  result: CiResult;
  detail: string;
} {
  const status = (run.status ?? '').toLowerCase();
  if (status !== 'completed') {
    // Only with a clock to compare against, and only from a known start: a
    // queued run with no start time cannot be shown to be stuck.
    const started = run.started_at === null || run.started_at === undefined ? NaN : Date.parse(run.started_at);
    if (now !== undefined && Number.isFinite(started)) {
      const minutes = Math.floor((now - started) / 60_000);
      if (minutes > stuckAfterMinutes) {
        return { result: 'rerun', detail: `${status.length > 0 ? status : 'unknown'} for ${minutes} min` };
      }
    }
    // An unknown status is treated as still running: it cannot be a pass.
    return { result: 'pending', detail: status.length > 0 ? status : 'unknown' };
  }
  const conclusion = (run.conclusion ?? '').toLowerCase();
  if (conclusion === 'success') return { result: 'passed', detail: conclusion };
  if (IGNORED_CONCLUSIONS.has(conclusion)) return { result: 'ignored', detail: conclusion };
  if (conclusion === 'failure') return { result: 'failed', detail: conclusion };
  if (RERUN_CONCLUSIONS.has(conclusion)) return { result: 'rerun', detail: conclusion };
  // A cancelled run that nothing later replaced never said whether the head
  // passes, and nothing is coming to say it. Superseded ones are dropped
  // before this point.
  if (conclusion === 'cancelled') return { result: 'rerun', detail: 'cancelled, with no later run' };
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

/** The stuck threshold for one check: its first matching override, else the repository's, else 60 minutes. */
export function stuckAfterFor(name: string, rules: CiRules = {}): number {
  const override = (rules.stuckAfter ?? []).find((entry) => nameGlob(entry.name).test(name));
  return override?.minutes ?? rules.stuckAfterMinutes ?? STUCK_AFTER_MINUTES;
}

/**
 * A runner or platform annotation, rather than one on a file of the change:
 * GitHub puts those on `.github` or on no path. A test name or a compiler
 * diagnostic that quotes "429 Too Many Requests" sits on a source file.
 */
function fromRunner(annotation: RawAnnotation): boolean {
  const path = (annotation.path ?? '').trim();
  return path === '' || path === '.github';
}

/**
 * The runner's own note that a step exited non-zero, on nearly every failed
 * job. It says neither that the change failed nor that the runner did.
 */
const EXIT_CODE_NOTE = /^Process completed with exit code \d+\.?$/;
const neutral = (annotation: RawAnnotation): boolean =>
  fromRunner(annotation) && EXIT_CODE_NOTE.test((annotation.message ?? '').trim());

/**
 * The signature that shows a failed run failed on infrastructure, or null.
 *
 * It must appear in the output's title or summary, or in a failure-level
 * annotation from the runner; the output's free text and annotations' raw
 * details carry test and compiler output, so they are not read. And every
 * failure-level annotation must match one: an unmatched one may be a real
 * failure beside the infrastructure one, and so may an annotation GitHub
 * counted but that was not read. Warnings and notices do not count either way,
 * nor does the runner's "Process completed with exit code N." note.
 */
export function infrastructureSignature(run: RawCheckRun, signatures: readonly string[]): string | null {
  const find = (...texts: (string | null | undefined)[]): string | null => {
    const haystack = texts.filter((text): text is string => typeof text === 'string').join('\n').toLowerCase();
    if (haystack.length === 0) return null;
    return signatures.find((signature) => signature.length > 0 && haystack.includes(signature.toLowerCase())) ?? null;
  };
  let matched = find(run.output?.title, run.output?.summary);
  for (const annotation of run.annotations ?? []) {
    if ((annotation.annotation_level ?? '').toLowerCase() !== 'failure') continue;
    if (neutral(annotation)) continue;
    const hit = fromRunner(annotation) ? find(annotation.title, annotation.message) : null;
    if (hit === null) return null;
    matched ??= hit;
  }
  const counted = run.output?.annotations_count ?? 0;
  if (counted > 0 && (run.annotations?.length ?? 0) < counted) return null;
  return matched;
}

const isFailure = (run: RawCheckRun): boolean =>
  (run.status ?? '').toLowerCase() === 'completed' && (run.conclusion ?? '').toLowerCase() === 'failure';

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
  /**
   * The time to judge a stuck check against, in epoch milliseconds. Without
   * it no check is taken as stuck; the live read always supplies one.
   */
  now?: number | undefined;
}

/** Classifies already-fetched check runs and statuses. Pure, so it is tested without a network. */
export function summariseCi(
  checkRuns: RawCheckRun[],
  statuses: RawStatus[],
  gates: readonly GateCheck[] = [],
  reading: CiReading = {},
  rules: CiRules = {},
): CiState {
  const entries: { entry: CiEntry; text: string }[] = [];
  const signatures = rules.rerunSignatures ?? BUILTIN_RERUN_SIGNATURES;

  for (const run of withoutSuperseded(checkRuns)) {
    let { result, detail } = classifyCheckRun(run, reading.now, stuckAfterFor(run.name ?? '', rules));
    // Only a plain failure, never a conclusion GitHub adds later.
    if (result === 'failed' && isFailure(run)) {
      const matched = infrastructureSignature(run, signatures);
      if (matched !== null) {
        result = 'rerun';
        detail = `failure, matched "${matched}"`;
      }
    }
    const text = `${run.output?.title ?? ''}\n${run.output?.summary ?? ''}`;
    entries.push({ entry: { name: run.name ?? '', source: 'check-run', result, detail }, text });
  }

  // The combined endpoint already returns the latest status per context, and
  // a failure is not something to deduplicate away.
  for (const status of statuses) {
    const { result, detail } = classifyStatus(status);
    entries.push({ entry: { name: status.context ?? '', source: 'status', result, detail }, text: status.description ?? '' });
  }

  const state: CiState = { state: 'green', passed: 0, failed: [], rerun: [], pending: [], ignored: [], gates: [] };
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
    } else if (entry.result === 'rerun') {
      state.rerun.push(entry);
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

  // A real failure is red whatever else is going on. Otherwise a check that
  // needs a rerun outranks pending: waiting for the others will not fix it.
  state.state =
    state.failed.length > 0
      ? 'red'
      : state.rerun.length > 0
        ? 'needs-rerun'
        : state.pending.length > 0
          ? 'pending'
          : 'green';
  return state;
}

/**
 * Reads the annotations of failed runs, since a runner reports a lost
 * connection or a time limit as an annotation, and a real failure beside it
 * must keep the run red. GET only, one page per run. A run whose annotations
 * were not read stays red.
 *
 * These reads are optional, so they never wait out a rate limit: the first
 * 403 or 429 stops them, and the runs not yet read stay red rather than
 * holding the verdict for as long as the limit lasts.
 */
async function attachAnnotations(
  client: GitHubClient,
  repository: string,
  runs: RawCheckRun[],
  signatures: readonly string[],
): Promise<void> {
  if (signatures.length === 0) return;
  const candidates = runs
    .filter(
      (run) =>
        isFailure(run) &&
        typeof run.id === 'number' &&
        (run.output?.annotations_count ?? 0) > 0,
    )
    .slice(0, MAX_ANNOTATION_READS);
  for (const run of candidates) {
    try {
      const page = await client.get<unknown>(
        `/repos/${repository}/check-runs/${run.id}/annotations?per_page=${ANNOTATIONS_PER_RUN}`,
        { retryRateLimits: false },
      );
      if (Array.isArray(page.data)) run.annotations = page.data as RawAnnotation[];
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (error.status === 403 || error.status === 429) return;
    }
  }
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
  now: number = Date.now(),
  rules: CiRules = {},
): Promise<CiState> {
  const checkRuns = await client.paginateWrapped<RawCheckRun>(
    `/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100`,
    'check_runs',
    MAX_ENTRIES + 1,
  );

  await attachAnnotations(client, repository, checkRuns.slice(0, MAX_ENTRIES), rules.rerunSignatures ?? BUILTIN_RERUN_SIGNATURES);

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
    now,
  }, rules);
}
