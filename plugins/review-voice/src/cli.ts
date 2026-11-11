
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { suppressSqliteExperimentalWarning } from './warnings.ts';
import { pluginVersion } from './version.ts';
import { OPTIONAL_CHECKS, runDoctor } from './doctor.ts';
import { splitFindings, parseFinding } from './contract/parse.ts';
import { GitError } from './diff/acquire.ts';
import {
  classifyAnchor,
  classifyStaleConsumer,
  normalisePath,
} from './diff/hunks.ts';
import { openDatabase } from './store/db.ts';
import { dataDirectory } from './store/paths.ts';
import { MODES } from './review/plan.ts';
import { loadConfig } from './policy/load.ts';
import { repositoryRoot } from './diff/acquire.ts';
import { stopCommandsOnSignal } from './evidence/run.ts';
import { GitHubClient, NotAllowlisted, ReadOnlyViolation } from './github/client.ts';
import { AuthError } from './github/auth.ts';
import { queueCommand } from './queue/command.ts';
import { reviewSpawnOptions, watchCommand, watchConfigSource } from './watch/command.ts';
import { spawnReview } from './watch/review.ts';
import { gitPrepareClone } from './watch/workspace.ts';
import { ReviewWriter, WriteViolation } from './github/writer.ts';
import { commandHelp, topLevelHelp } from './help.ts';
import { runReview, reportText } from './review/driver.ts';
import {
  inProcessState,
  setInProcess,
  githubClient,
  inferRepository,
  flag,
  repositoryConfig,
} from './cli/shared.ts';
import { redactCommand } from './cli/redact.ts';
import { draftCommand } from './cli/draft.ts';
import { postCheckCommand } from './cli/post-check.ts';
import { discoverCommand } from './cli/discover.ts';
import { evidenceCommand } from './cli/evidence.ts';
import { reproduceCommand } from './cli/reproduce.ts';
import { calibrateCommand } from './cli/calibrate.ts';
import { retrieveCommand } from './cli/retrieve.ts';
import { feedbackCommand } from './cli/feedback.ts';
import { declineCommand } from './cli/decline.ts';
import { anchorsCommand } from './cli/anchors.ts';
import { contextCommand } from './cli/context.ts';
import { validateOutputCommand } from './cli/validate-output.ts';
import { followUpsCommand } from './cli/follow-ups.ts';
import { purgeCommand } from './cli/purge.ts';
import { policyCommand } from './cli/policy.ts';
import { evaluateCommand } from './cli/evaluate.ts';
import { conventionsCommand } from './cli/conventions.ts';
import { checkIntentCommand } from './cli/check-intent.ts';
import { recallCommand } from './cli/recall.ts';
import { importBenchmarkCommand } from './cli/import-benchmark.ts';
import { worktreeCommand } from './cli/worktree.ts';
import { pullRequestDiffCommand, diffCommand } from './cli/diff.ts';
import { threadCommand } from './cli/thread.ts';
import { symbolsCommand } from './cli/symbols.ts';
import { planCommand, lanesCommand } from './cli/plan.ts';
import { verdictCommand, postCommand } from './cli/verdict.ts';
import { consentPlanCommand, syncCommand } from './cli/sync.ts';
import { outcomesCommand } from './cli/outcomes.ts';
import { checkVerificationCommand } from './cli/check-verification.ts';
import { checkSimplificationCommand } from './cli/check-simplification.ts';
import { verifyCommand } from './cli/verify.ts';
import { reconcileCommand } from './cli/reconcile.ts';
import { challengeCommand } from './cli/challenge.ts';
import { reanchorCommand } from './cli/reanchor.ts';
import { agentCommand } from './cli/agent.ts';
import { statusCommand } from './cli/status.ts';
import { explainCommand } from './cli/explain.ts';
import { carryCommand, carryCandidatesCommand } from './cli/carry.ts';
import { recordCommand } from './cli/record.ts';
import { scoreCommand } from './cli/score.ts';
import { checkCandidatesCommand } from './cli/check-candidates.ts';
export { diffSummary, emitDiff } from './cli/diff.ts';
export { resolveOutPath, verificationProblem } from './cli/shared.ts';

async function main(argv: string[]): Promise<number> {
  const exit = await dispatch(argv);
  const command = argv[0];
  // Said once here, not at every call site that rejects its flags.
  if (exit === 2 && command !== undefined && commandHelp(command) !== null) {
    console.error(`Run "review-voice ${command} --help" for its flags.`);
  }
  return exit;
}

/**
 * A command that runs configured commands, run on its own: a stop signal
 * kills them too (#277). Under the review driver, its own handler does that
 * and removes the worktree, so none is added here.
 */
async function whileStoppable(run: () => Promise<number>): Promise<number> {
  if (inProcessState() !== null) return run();
  const release = stopCommandsOnSignal();
  try {
    return await run();
  } finally {
    release();
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const command = argv[0];

  // Before dispatch, so it cannot be swallowed by a command that reads stdin.
  // `score --help` printed the stdin error and then blocked on a terminal,
  // which also hid `--exclude-pull`: the flag is in this text, and nobody
  // could get the text to appear.
  if (command !== undefined && (argv.includes('--help') || argv.includes('-h'))) {
    const section = commandHelp(command);
    if (section !== null) {
      console.log(section);
      return 0;
    }
    // `--help` and `-h` themselves, and `help --help`, show the whole list.
    if (command === '--help' || command === '-h' || command === 'help') {
      console.log(topLevelHelp());
      return 0;
    }
    console.error(`Unknown command: ${command}\n\n${topLevelHelp()}`);
    return 2;
  }

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      console.log(topLevelHelp());
      return 0;

    case 'help': {
      const topic = argv[1];
      if (topic === undefined) {
        console.log(topLevelHelp());
        return 0;
      }
      const section = commandHelp(topic);
      if (section === null) {
        console.error(`Unknown command: ${topic}\n\n${topLevelHelp()}`);
        return 2;
      }
      console.log(section);
      return 0;
    }

    case '--version':
    case '-v':
      console.log(pluginVersion());
      return 0;

    case 'diff':
      return argv.includes('--pr')
        ? await pullRequestDiffCommand(argv.slice(1))
        : diffCommand(argv.slice(1));

    case 'symbols':
      return symbolsCommand(argv.slice(1));

    case 'anchors':
      return anchorsCommand(argv.slice(1));

    case 'thread':
      return await threadCommand(argv.slice(1));

    case 'follow-ups':
      return followUpsCommand(argv.slice(1));

    case 'context':
      return contextCommand();

    case 'redact':
      return redactCommand(argv.slice(1));

    case 'sync':
      return await syncCommand(argv.slice(1));

    case 'discover':
      return await discoverCommand();

    case 'consent-plan':
      return consentPlanCommand(argv.slice(1));

    case 'purge':
      return purgeCommand(argv.slice(1));

    case 'retrieve':
      return retrieveCommand(argv.slice(1));

    case 'score':
      return scoreCommand(argv.slice(1));

    case 'evaluate':
      return evaluateCommand(argv.slice(1));

    case 'recall':
      return await recallCommand(argv.slice(1), runInProcess);

    case 'import-benchmark':
      return importBenchmarkCommand(argv.slice(1));

    case 'outcomes':
      return outcomesCommand(argv.slice(1));

    case 'draft':
      return draftCommand(argv.slice(1));

    case 'verdict':
      return await verdictCommand(argv.slice(1));

    case 'post':
      return await postCommand(argv.slice(1));

    case 'post-check':
      return postCheckCommand();

    case 'queue':
      return await queueCommand(argv.slice(1), {
        config: repositoryConfig(),
        client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true }),
        openDb: () => openDatabase(),
        now: new Date(),
        out: (text) => console.log(text),
        err: (text) => console.error(text),
      });

    case 'watch': {
      let root: string | null = null;
      try {
        root = repositoryRoot(process.cwd());
      } catch {
        // Not in a repository: only --config names a config, and without it watch refuses to start.
      }
      const config = watchConfigSource(argv.slice(1), root);
      if (typeof config === 'string') {
        console.error(config);
        return 2;
      }
      const dataDir = dataDirectory();
      const review = spawnReview(fileURLToPath(import.meta.url), reviewSpawnOptions(dataDir, config));
      return await watchCommand(argv.slice(1), {
        configSource: config?.path ?? null,
        // The copy keeps the source of the file it was taken from.
        loadSettings: (path) => loadConfig(root ?? process.cwd(), undefined, path, undefined, config?.source),
        client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true }),
        // Built from the recorded run's repository by post, as for the post command.
        writerFor: (allowlist) => new ReviewWriter({ allowlist }),
        openDb: () => openDatabase(),
        dataDir,
        review,
        stopReview: review.stop,
        prepareClone: gitPrepareClone(),
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        out: (text) => console.log(text),
        err: (text) => console.error(text),
      });
    }

    case 'calibrate':
      return calibrateCommand();

    case 'policy':
      return policyCommand(argv.slice(1));

    case 'check-candidates':
      return checkCandidatesCommand(argv.slice(1));

    case 'check-verification':
      return checkVerificationCommand(argv.slice(1));

    case 'check-simplification':
      return checkSimplificationCommand(argv.slice(1));

    case 'check-intent':
      return checkIntentCommand(argv.slice(1));

    case 'conventions':
      return conventionsCommand(argv.slice(1));

    case 'evidence':
      return await whileStoppable(() => evidenceCommand(argv.slice(1)));

    case 'reproduce':
      return await whileStoppable(() => reproduceCommand(argv.slice(1)));

    case 'worktree':
      return worktreeCommand(argv.slice(1));

    case 'reconcile':
      return reconcileCommand(argv.slice(1));
    case 'verify':
      return await whileStoppable(() => verifyCommand(argv));

    case 'record':
      return recordCommand(argv.slice(1));

    case 'carry':
      return carryCommand(argv.slice(1));

    case 'plan':
      return planCommand(argv.slice(1));

    case 'lanes':
      return lanesCommand(argv.slice(1));

    case 'reanchor':
      return reanchorCommand(argv.slice(1));

    case 'challenge':
      return challengeCommand(argv.slice(1));

    case 'carry-candidates':
      return carryCandidatesCommand(argv.slice(1));

    case 'feedback':
      return feedbackCommand(argv.slice(1));

    case 'decline':
      return declineCommand(argv.slice(1));

    case 'status':
      return statusCommand();

    case 'explain':
      return explainCommand(argv.slice(1));

    case 'validate-output':
      return validateOutputCommand(argv.slice(1));

    case 'agent':
      return await agentCommand(argv.slice(1));

    case 'review':
      return await reviewCommand(argv.slice(1));

    case 'doctor': {
      const checks = runDoctor();
      for (const check of checks) {
        console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(12)} ${check.detail}`);
      }
      // git and node:sqlite are required; gh is only needed once GitHub history
      // ingestion is enabled, so its absence is reported but not fatal.
      const required = checks.filter((c) => !OPTIONAL_CHECKS.has(c.name));
      return required.every((c) => c.ok) ? 0 : 1;
    }

    default:
      console.error(`Unknown command: ${command}\n\n${topLevelHelp()}`);
      return 2;
  }
}

/**
 * The exit code and message for an error a command threw. Network and
 * credential problems are ordinary operating conditions, not crashes, and a
 * stack trace tells the user nothing they can act on.
 */
function failureOf(error: unknown): { code: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const expected =
    error instanceof AuthError ||
    error instanceof NotAllowlisted ||
    error instanceof ReadOnlyViolation ||
    error instanceof WriteViolation ||
    error instanceof GitError;
  return { code: expected ? 2 : 1, message };
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Set inside the in-process command's own calls. A command that awaits (a
 * configured check now does, issue 277) leaves the event loop to other code,
 * and what that code prints is not the command's output, so it goes where it
 * was going. Under node:test that is the runner's own event stream.
 */
const inCommand = new AsyncLocalStorage<true>();

/**
 * Runs one command in this process with its output captured, for the review
 * driver: every stage calls the command itself, so the driver adds no review
 * logic of its own (docs/adr/0022). One command at a time.
 */
export async function runInProcess(
  argv: string[],
  options: { stdin?: string; fetchImpl?: typeof fetch } = {},
): Promise<CommandResult> {
  if (inProcessState() !== null) throw new Error('A command is already running in this process.');
  const out: string[] = [];
  const err: string[] = [];
  const saved = { log: console.log, error: console.error, write: process.stdout.write };
  setInProcess({ stdin: options.stdin ?? '', fetchImpl: options.fetchImpl });
  const mine = (): boolean => inCommand.getStore() === true;
  console.log = (...args: unknown[]) => (mine() ? void out.push(`${format(...args)}\n`) : saved.log(...args));
  console.error = (...args: unknown[]) => (mine() ? void err.push(`${format(...args)}\n`) : saved.error(...args));
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!mine()) return (saved.write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await inCommand.run(true, () => dispatch(argv));
  } catch (error) {
    const failure = failureOf(error);
    err.push(`${failure.message}\n`);
    code = failure.code;
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.stdout.write = saved.write;
    setInProcess(null);
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** Runs the whole review of one pull request (docs/adr/0022). */
async function reviewCommand(argv: string[]): Promise<number> {
  const pullNumber = Number(flag(argv, '--pr'));
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    console.error('--pr needs a pull request number.');
    return 2;
  }
  const modeFlag = flag(argv, '--mode');
  const mode = MODES.find((known) => known === modeFlag);
  if (argv.includes('--mode') && mode === undefined) {
    console.error(`--mode takes one of ${MODES.join(', ')}.`);
    return 2;
  }
  for (const name of ['--out', '--since', '--repository', '--expect-head', '--config']) {
    if (argv.includes(name) && flag(argv, name) === null) {
      console.error(`${name} needs a value.`);
      return 2;
    }
  }
  // Only the callers that start a review for someone else name themselves; a
  // person at a terminal is the driver, and `interactive` is the slash command's.
  const originFlag = flag(argv, '--origin');
  const reviewOrigin = argv.includes('--origin') ? (['watch', 'action'] as const).find((known) => known === originFlag) : 'driver';
  if (reviewOrigin === undefined) {
    console.error('--origin takes one of watch, action.');
    return 2;
  }
  const repository = flag(argv, '--repository') ?? inferRepository(process.cwd());
  if (repository === null) {
    console.error('Cannot tell which repository. Pass --repository <owner/repo>.');
    return 2;
  }
  const report = await runReview(
    {
      repository,
      pullNumber,
      mode,
      post: argv.includes('--post'),
      out: flag(argv, '--out'),
      since: flag(argv, '--since'),
      full: argv.includes('--full'),
      recheckThread: !argv.includes('--no-recheck-thread'),
      expectHead: flag(argv, '--expect-head'),
      config: flag(argv, '--config'),
      origin: reviewOrigin,
    },
    { command: (args, stdin) => runInProcess(args, { stdin }), client: githubClient([repository]) },
  );
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(reportText(report));
  return report.exitCode;
}

suppressSqliteExperimentalWarning();

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const failure = failureOf(error);
  console.error(failure.message);
  process.exitCode = failure.code;
}
