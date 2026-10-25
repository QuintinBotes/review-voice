import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { GitHubClient } from '../github/client.ts';
import type { ReviewWriter } from '../github/writer.ts';
import type { LoadedConfig } from '../policy/load.ts';
import { computeVerdict, postReview, type VerdictOptions } from '../publish/post.ts';
import { buildQueue, type QueueEntry } from '../queue/queue.ts';
import type { QueueConfig, QueueSource } from '../queue/config.ts';
import { MODES } from '../review/plan.ts';
import type { Database } from '../store/db.ts';
import { checkOutcomes } from '../store/outcomes.ts';
import { recordedRunsForPull, runDetail } from '../store/runs.ts';
import { recentlySentPulls, saveWatchHead, type HeadStatus, type WatchHead } from '../store/watch.ts';
import { parseDuration } from './config.ts';
import { acquireLock, lockPort } from './lock.ts';
import type { ReviewPullRequest } from './review.ts';
import { cloneDir, type PrepareClone } from './workspace.ts';

type WatchSettings = Pick<
  LoadedConfig,
  'allowlist' | 'queue' | 'watch' | 'warnings' | 'postingEnabled' | 'ciGateChecks' | 'ciRules' | 'ownerReviewer' | 'verdictPolicy'
>;

export interface WatchCommandDeps {
  /** The config file watch was started with; null outside a repository. */
  configSource: string | null;
  /** Reads one config file. */
  loadSettings: (path: string) => WatchSettings;
  client: (allowlist: string[]) => GitHubClient;
  writerFor: (allowlist: string[]) => ReviewWriter;
  openDb: () => Database;
  dataDir: string;
  review: ReviewPullRequest;
  /** Ends a review still running when the watcher is interrupted. */
  stopReview: () => Promise<void> | void;
  prepareClone: PrepareClone;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** The copy of the config each pass and its reviews read, so an edit or branch switch mid-pass changes nothing. */
export const CONFIG_COPY = 'watch-config.yaml';

/** A row to write, or null when the head moved and the next pass retries it. */
type Outcome = { row: Omit<WatchHead, 'attempts' | 'updatedAt'> } | { row: null; detail: string };

interface PassOptions {
  deps: WatchCommandDeps;
  config: WatchSettings;
  queue: QueueConfig;
  post: boolean;
  mode: string | undefined;
  workspace: string;
}

/**
 * Replaces the copy in one rename, from a file created fresh with mode 0600
 * that refuses to follow a symlink, so a reader never sees half a config and
 * nothing planted at either path is written through.
 */
function writeCopy(source: string, copy: string): void {
  const text = readFileSync(source);
  const temp = `${copy}.tmp-${process.pid}`;
  try {
    // Left by a crashed pass with this pid; unlinking a symlink removes the link, not its target.
    unlinkSync(temp);
  } catch {
    // None.
  }
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  renameSync(temp, copy);
}

const OUTCOME_DAYS = 7;
const OUTCOME_PULLS = 20;

/**
 * `review-voice watch [--once] [--interval <dur>] [--post] [--mode M] [--max N] [--json]`.
 * One watcher per data directory. Exit 0, 1 when an entry of a `--once` pass
 * failed, 2 on a bad invocation or when another watcher holds the lock.
 */
export async function watchCommand(argv: string[], deps: WatchCommandDeps): Promise<number> {
  let interval: number | undefined;
  if (argv.includes('--interval')) {
    const parsed = parseDuration(argv[argv.indexOf('--interval') + 1] ?? '');
    if (parsed === null) {
      deps.err('--interval takes a duration such as 30m or 2h.');
      return 2;
    }
    interval = parsed;
  }
  let mode: string | undefined;
  if (argv.includes('--mode')) {
    mode = argv[argv.indexOf('--mode') + 1];
    if (!MODES.some((known) => known === mode)) {
      deps.err(`--mode takes one of ${MODES.join(', ')}.`);
      return 2;
    }
  }
  let max: number | undefined;
  if (argv.includes('--max')) {
    max = Number(argv[argv.indexOf('--max') + 1]);
    if (!Number.isInteger(max) || max <= 0) {
      deps.err('--max takes a whole number above zero.');
      return 2;
    }
  }
  const source = deps.configSource;
  const initial = source === null ? null : deps.loadSettings(source);
  if (source === null || initial === null || initial.allowlist.length === 0) {
    for (const warning of initial?.warnings ?? []) deps.err(`Warning: ${warning}`);
    deps.err('No repositories are allowlisted. Run /review-voice:init first.');
    return 2;
  }
  const wantPost = argv.includes('--post');
  if ((wantPost || initial.watch.post) && !initial.postingEnabled) {
    deps.err('Posting is off: set writes.github_posting_enabled in .review-voice/config.yaml, or watch without --post.');
    return 2;
  }

  mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(deps.dataDir, initial.watch.lockPort ?? lockPort(deps.dataDir));
  if ('holder' in lock) {
    deps.err(`Another watcher is running on ${deps.dataDir} (pid ${lock.holder}).`);
    return 2;
  }
  if ('foreign' in lock) {
    deps.err(
      `Port ${lock.foreign} on 127.0.0.1, which holds the watcher lock for ${deps.dataDir}, is taken by another program. ` +
        'Set watch.lock_port in .review-voice/config.yaml to a free port.',
    );
    return 2;
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    void (async () => {
      await deps.stopReview();
      lock.release();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // After the lock, so a refused second watcher cannot overwrite the holder's copy.
  const copy = join(deps.dataDir, CONFIG_COPY);
  const refresh = (): WatchSettings => {
    writeCopy(source, copy);
    const settings = deps.loadSettings(copy);
    for (const warning of settings.warnings) deps.err(`Warning: ${warning}`);
    if (settings.allowlist.length === 0) throw new Error('no repositories are allowlisted in the config any more');
    return settings;
  };

  try {
    let settings = initial;
    for (;;) {
      const started = deps.now().getTime();
      let failed: boolean;
      try {
        // Read again every pass: the posting switch, the allowlist and the policies are the config's as it is now.
        settings = refresh();
        let post = wantPost || settings.watch.post;
        if (post && !settings.postingEnabled) {
          deps.err('Posting is off in the config now; this pass posts nothing.');
          post = false;
        }
        failed = await runPass(
          {
            deps,
            config: settings,
            queue: {
              ...settings.queue,
              sources: [...new Set<QueueSource>([...settings.queue.sources, ...(settings.queue.teams.length > 0 ? ['team' as const] : [])])],
              maxPerPass: max ?? settings.queue.maxPerPass,
            },
            post,
            mode,
            workspace: settings.watch.workspace ?? join(deps.dataDir, 'clones'),
          },
          argv.includes('--json'),
        );
      } catch (error) {
        deps.err(`The pass stopped: ${error instanceof Error ? error.message : String(error)}`);
        failed = true;
      }
      if (argv.includes('--once')) return failed ? 1 : 0;
      // The next pass starts when this one is due or, if this one ran long, straight after it; never beside it.
      await deps.sleep(Math.max(0, started + (interval ?? settings.watch.intervalMs) - deps.now().getTime()));
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    lock.release();
  }
}

/** One pass: the queue, each entry in turn, then outcomes. True when an entry failed. */
async function runPass(options: PassOptions, json: boolean): Promise<boolean> {
  const { deps, config } = options;
  const client = deps.client(config.allowlist);
  const { data: viewer } = await client.get<{ login?: string }>('/user');
  if (typeof viewer?.login !== 'string' || viewer.login.length === 0) throw new Error('could not read the authenticated GitHub user');

  const db = deps.openDb();
  try {
    const queue = await buildQueue({
      client,
      db,
      config: options.queue,
      me: viewer.login,
      now: deps.now(),
      maxAttemptsPerHead: config.watch.maxAttemptsPerHead,
    });
    const rows: WatchHead[] = [];
    const lines: string[] = [];
    const counts = new Map<string, number>();
    for (const entry of queue.entries) {
      const outcome = await handle(options, client, db, entry);
      const summary = `${entry.repository}#${entry.pull}: ${entry.action.kind}`;
      if (outcome.row === null) {
        lines.push(`${summary} (no row: ${outcome.detail})`);
        counts.set('retried', (counts.get('retried') ?? 0) + 1);
        continue;
      }
      // Written only once the action returned, so a crash leaves no row and the next pass redoes the head.
      const row = saveWatchHead(db, outcome.row, deps.now());
      rows.push(row);
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      const event = row.event === null ? '' : ` ${row.event}`;
      lines.push(`${summary}${event} (${row.status} ${row.reviewUrl ?? row.detail ?? ''})`.replace(/ \)$/, ')'));
    }

    const followed = await followOutcomes(client, db, deps);
    if (json) {
      deps.out(JSON.stringify(rows, null, 2));
    } else {
      const totals = [...counts].map(([status, count]) => `${count} ${status}`).join(', ');
      lines.push(
        `${queue.entries.length} entr${queue.entries.length === 1 ? 'y' : 'ies'}${totals === '' ? '' : `: ${totals}`}; ` +
          `${queue.notReached.length} not reached; outcomes followed on ${followed} pull request(s)`,
      );
      deps.out(lines.join('\n'));
    }
    return rows.some((row) => row.status === 'failed');
  } finally {
    db.close();
  }
}

const NOT_ALLOWED = 'not in the allowlist any more';

async function handle(options: PassOptions, client: GitHubClient, db: Database, entry: QueueEntry): Promise<Outcome> {
  const base = { repository: entry.repository, pull: entry.pull, head: entry.head, runId: null, event: null, reviewUrl: null };
  const failed = (detail: string): Outcome => ({ row: { ...base, status: 'failed', detail } });
  if (entry.action.kind !== 'skip' && !client.allows(entry.repository)) return { row: { ...base, status: 'skipped', detail: NOT_ALLOWED } };
  try {
    switch (entry.action.kind) {
      case 'skip':
        return { row: { ...base, status: 'skipped', detail: entry.action.rule } };
      case 'review':
        return await review(options, entry);
      case 'verdict-only':
      case 'recheck-ci':
        return await verdict(options, client, db, entry, entry.action.kind === 'recheck-ci');
    }
  } catch (error) {
    return failed((error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300));
  }
}

async function review(options: PassOptions, entry: QueueEntry): Promise<Outcome> {
  const clone = cloneDir(options.workspace, entry.repository);
  await options.deps.prepareClone(entry.repository, entry.pull, clone);
  const result = await options.deps.review({
    repository: entry.repository,
    pull: entry.pull,
    clone,
    post: options.post,
    mode: options.mode,
    expectHead: entry.head,
    timeoutMs: options.config.watch.reviewTimeoutMs,
    runRepositoryCommands: options.config.watch.runRepositoryCommands,
  });
  if (result.exitCode === 3) return { row: null, detail: result.detail ?? 'head moved' };
  const status: HeadStatus =
    result.exitCode === 0
      ? options.post && result.carried === true
        ? 'carried'
        : result.reviewUrl === null
          ? 'reviewed'
          : 'posted'
      : result.exitCode === 4
        ? 'waiting-ci'
        : result.exitCode === 6
          ? 'held'
          : 'failed';
  return {
    row: {
      repository: entry.repository,
      pull: entry.pull,
      head: entry.head,
      runId: result.runId,
      event: result.event,
      reviewUrl: result.reviewUrl,
      status,
      detail: status === 'failed' ? (result.detail ?? `review exited ${result.exitCode}`) : result.detail,
    },
  };
}

/** `verdict`, then `post` when posting, on the run recorded at this head. */
async function verdict(options: PassOptions, client: GitHubClient, db: Database, entry: QueueEntry, recheck: boolean): Promise<Outcome> {
  const { deps, config } = options;
  const recorded = recordedRunsForPull(db, entry.repository, entry.pull, 50).find((run) => run.head.toLowerCase() === entry.head.toLowerCase());
  const run = recorded === undefined ? null : runDetail(db, recorded.runId);
  const base = { repository: entry.repository, pull: entry.pull, head: entry.head, runId: run?.reviewRunId ?? null, reviewUrl: null };
  if (run === null) return { row: { ...base, event: null, status: 'failed', detail: 'no run is recorded at this head' } };

  const target: VerdictOptions = {
    db,
    client,
    repository: entry.repository,
    pullNumber: entry.pull,
    head: entry.head,
    review: run.output,
    runId: run.reviewRunId,
    gateChecks: config.ciGateChecks,
    ciRules: config.ciRules,
    owner: config.ownerReviewer,
    policy: config.verdictPolicy,
  };
  const computed = await computeVerdict({ ...target, recheck });
  const { exitCode, output } = computed;
  const waiting = (code: number): HeadStatus | null => (code === 4 || code === 5 ? 'waiting-ci' : code === 6 ? 'held' : null);
  if (exitCode === 3) return { row: null, detail: 'head moved' };
  const paused = waiting(exitCode);
  if (paused !== null) return { row: { ...base, event: output.event, status: paused, detail: output.reasons.join('; ') || null } };
  if (exitCode !== 0) return { row: { ...base, event: output.event, status: 'failed', detail: output.reasons.join('; ') || `verdict exited ${exitCode}` } };
  if (!options.post) return { row: { ...base, event: output.event, status: 'reviewed', detail: null } };
  // postReview's writer is built from the run's repository; the allowlist as it is now must still cover it.
  if (run.repository === null || !client.allows(run.repository)) return { row: { ...base, event: output.event, status: 'skipped', detail: NOT_ALLOWED } };

  const sent = await postReview({
    ...target,
    writerFor: deps.writerFor,
    confirm: true,
    event: output.event ?? undefined,
    postingEnabled: config.postingEnabled,
    // On under watch (docs/adr/0028): an unattended post must not talk over a person.
    recheckThread: true,
  });
  const result = sent.output;
  if (sent.exitCode === 0 && result.status === 'carried') {
    return { row: { ...base, event: null, reviewUrl: result.reviewUrl ?? null, status: 'carried', detail: null } };
  }
  if (sent.exitCode === 0 && result.status === 'sent') {
    return { row: { ...base, event: result.verdict?.event ?? output.event, reviewUrl: result.review?.url ?? null, status: 'posted', detail: null } };
  }
  if (sent.exitCode === 3) return { row: null, detail: result.reasons.join('; ') || 'head moved' };
  const status = waiting(sent.exitCode) ?? 'failed';
  return { row: { ...base, event: output.event, status, detail: result.reasons.join('; ') || `post exited ${sent.exitCode}` } };
}

/**
 * Outcomes for the pull requests with a review sent in the last week, this
 * pass's included, at most twenty. `since` is the twentieth one's newest send,
 * so no older pull request is read. Returns how many were followed.
 */
async function followOutcomes(client: GitHubClient, db: Database, deps: WatchCommandDeps): Promise<number> {
  const weekAgo = new Date(deps.now().getTime() - OUTCOME_DAYS * 86_400_000).toISOString();
  const pulls = recentlySentPulls(db, weekAgo, OUTCOME_PULLS);
  if (pulls.length === 0) return 0;
  const since = pulls.length === OUTCOME_PULLS ? pulls.at(-1)!.sentAt : weekAgo;
  const allowlist = [...new Set(pulls.map((pull) => pull.repository).filter((repository) => client.allows(repository)))];
  try {
    const result = await checkOutcomes({ db, client, allowlist, since, now: deps.now });
    for (const warning of result.warnings) deps.err(warning);
  } catch (error) {
    deps.err(`Outcomes were not followed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return pulls.filter((pull) => allowlist.includes(pull.repository)).length;
}
