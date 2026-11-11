import { spawn as spawnChild } from 'node:child_process';
import { cleaner, cut, memo, parseOutput, replaced } from './parsers.ts';
import type { CommandOutcome, EvidenceReport } from './types.ts';

export interface ConfiguredCommand {
  name: string;
  run: string;
  timeoutSeconds?: number;
  /**
   * A command that prints the tool's version. It is configuration like `run`,
   * so running it keeps "detection suggests, configuration enables".
   */
  version?: string;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_VERSION_POINTS = 80;
/** A signal's claim and each evidence line, so one diagnostic cannot fill the report. */
const MAX_SIGNAL_TEXT_POINTS = 4096;
/** The shell's own answer when the command is missing (127) or not executable (126). */
export const SHELL_UNAVAILABLE_EXIT_CODES: readonly number[] = [126, 127];

/**
 * What a configured command gets without being listed, which is enough for a
 * shell to find its tools, a home, a locale, a scratch directory and a terminal.
 */
const BASE_ENVIRONMENT: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CI', 'TERM'];

/**
 * The environment every configured command runs with (issue 279). A command
 * runs in the pull request's head tree, so one that delegates to the tree runs
 * the author's code; inheriting the review process's environment would hand
 * that code GITHUB_TOKEN, ANTHROPIC_API_KEY and REVIEW_VOICE_* settings. Only
 * the base names and the names the repository listed by name are passed, and a
 * listed name that is not set stays absent rather than becoming empty.
 */
/** Below this length a value is too likely to be an ordinary word or number to mask everywhere it appears. */
const MIN_MASKED_LENGTH = 8;

/**
 * The text with the value of every passed-through variable replaced by its
 * name (issue 279). A repository lists a variable because a command needs it,
 * often a token, and a tool that prints it (a version banner, a debug line, a
 * verifier quoting its request) would otherwise carry it into the stored
 * report and the agents' prompts. The base variables are not secrets and are
 * left alone; a value shorter than MIN_MASKED_LENGTH is too. A value is masked
 * as listed and as each of its lines reads once trimmed, since a text adapter
 * reads a tool's output by line and trims it, where a value saved with a
 * newline or a space at its edge would no longer be found.
 */
export function maskPassthrough(text: string, source: NodeJS.ProcessEnv, passthrough: readonly string[]): string {
  const names = new Map<string, string>();
  for (const name of passthrough) {
    const value = source[name];
    if (typeof value !== 'string') continue;
    for (const form of [value, ...value.split('\n').map((line) => line.trim())]) {
      if (form.length >= MIN_MASKED_LENGTH && !names.has(form)) names.set(form, name);
    }
  }
  let masked = text;
  // Longest first, so a value containing another listed value is masked whole.
  for (const [value, name] of [...names].sort((a, b) => b[0].length - a[0].length)) masked = masked.split(value).join(`[redacted:${name}]`);
  return masked;
}

/**
 * Every string inside a decoded value, masked. Applied after parsing, because
 * a value that was escaped in the raw text (quotes, backslashes, newlines in
 * JSON) only matches once decoded.
 */
export function maskPassthroughDeep<T>(value: T, source: NodeJS.ProcessEnv, passthrough: readonly string[]): T {
  if (typeof value === 'string') return maskPassthrough(value, source, passthrough) as T;
  if (Array.isArray(value)) return value.map((entry) => maskPassthroughDeep(entry, source, passthrough)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskPassthroughDeep(entry, source, passthrough)])) as T;
  }
  return value;
}

export function commandEnvironment(source: NodeJS.ProcessEnv, passthrough: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENVIRONMENT, ...passthrough]) {
    const value = source[name];
    if (typeof value === 'string') env[name] = value;
  }
  return env;
}

/**
 * The report for a run in which nothing was spawned: every configured command
 * is named as not having run, with the reason when an environment switch (not
 * the configuration) is what stopped them.
 */
export function notRunReport(names: readonly string[], skipped?: string): EvidenceReport {
  return {
    enabled: false,
    signals: [],
    commands: [],
    didNotRun: [...names],
    ...(skipped === undefined ? {} : { skipped }),
  };
}

/**
 * A version line comes from a tool run on a repository whose contents are
 * untrusted, and lands in a stored record. Control, bidi and zero-width
 * characters can reorder or hide text, so they go; the cap is by code point so
 * a surrogate pair is never split. It is masked and redacted before its first
 * line is taken, so a multiline value does not leave that line behind, and again once
 * stripped, since removing an invisible character can join a secret the text
 * split. A tool can also wrap a value at the end of the first line, where it
 * matches only once the break is a space, so the line is cleaned once more
 * with the text after it, their white space collapsed, and what that
 * replaces in the line, or from the line into the next, goes whole. All of it
 * comes before the cap, since a cut value no longer matches.
 */
function sanitisedVersion(stdout: string, clean: (text: string) => string): string | undefined {
  const whole = clean(stdout);
  const end = whole.indexOf('\n');
  // Control (Cc) and format (Cf) characters: the format class holds the bidi
  // controls and the zero-width characters, and line and paragraph separators
  // would break the one-line record.
  const stripped = clean((end === -1 ? whole : whole.slice(0, end)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ''));
  const spaced = `${stripped}${end === -1 ? '' : whole.slice(end)}`.replace(/\s+/g, ' ');
  const first = stripped.replace(/\s+/g, ' ').length;
  let line = '';
  let copied = 0;
  for (const part of replaced(spaced, clean(spaced))) {
    if (part.start >= first) break;
    line += spaced.slice(copied, part.start) + part.marker;
    copied = part.end;
  }
  line += spaced.slice(copied, first);
  const capped = cut(line.trim(), MAX_VERSION_POINTS).trim();
  return capped === '' ? undefined : capped;
}

/**
 * Runs the commands the user declared in their own configuration - and only
 * those (docs/adr/0003). Review Voice is pointed at repositories whose contents
 * it treats as untrusted, so auto-detecting and running a project script would
 * be arbitrary code execution on hostile input. Detection suggests;
 * configuration enables.
 */
export async function collectEvidence(
  commands: ConfiguredCommand[],
  options: { cwd: string; enabled: boolean; envPassthrough?: readonly string[]; spawn?: CommandSpawner },
): Promise<EvidenceReport> {
  if (!options.enabled || commands.length === 0) {
    return notRunReport(commands.map((command) => command.name));
  }

  // The seam tests use so no real process is needed to pin the call count.
  const spawn = options.spawn ?? spawnCommand;
  const env = commandEnvironment(process.env, options.envPassthrough ?? []);
  const outcomes: CommandOutcome[] = [];
  const didNotRun: string[] = [];

  for (const command of commands) {
    const startedAt = Date.now();
    const timeoutMs = (command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    // Run through a shell because users write shell commands, but with the
    // command string coming only from their own config file - never from the
    // diff, and never interpolated with repository content.
    const result = await spawnInGroup(spawn, command.run, options.cwd, timeoutMs, env);

    const durationMs = Date.now() - startedAt;

    if (result.error !== undefined) {
      const reason = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? `timed out after ${command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}s`
        : result.error.message;
      outcomes.push({
        name: command.name,
        command: command.run,
        exitCode: null,
        durationMs,
        unavailable: reason,
        signals: [],
      });
      didNotRun.push(command.name);
      continue;
    }

    // A shell that cannot find or execute the tool exits 127 or 126 with no
    // diagnostics to parse. That is a check that never ran, not one that passed
    // or failed, so it is named as such while the real exit code stays visible.
    if (result.status !== null && SHELL_UNAVAILABLE_EXIT_CODES.includes(result.status)) {
      outcomes.push({
        name: command.name,
        command: command.run,
        exitCode: result.status,
        durationMs,
        unavailable: `not found or not executable (exit ${result.status})`,
        signals: [],
      });
      didNotRun.push(command.name);
      continue;
    }

    const mask = (text: string): string => maskPassthrough(text, process.env, options.envPassthrough ?? []);
    // A tool's text can quote a secret it read, and every adapter's signals
    // pass here, so this is where they are cleaned. Text is masked and
    // redacted whole and only then cut, since a secret the cut splits no
    // longer matches its pattern. Both read the text as printed, since
    // either applied to what the other left would miss what it changed.
    const clean = cleaner(mask);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const configuredVersion = command.version === undefined ? undefined : await readVersion(spawn, command.version, options.cwd, timeoutMs, env, clean);
    // Parsed from the true output, so a passed-through value cannot break a
    // diagnostic's shape; then the text a reader sees is masked and redacted.
    // A path is a location, so it is kept as printed or dropped with its line,
    // since a rewritten path would name another file. It is dropped when
    // masking or redaction would change it, because it then carries a secret
    // or a value the repository listed as one. An adapter that reads a line
    // in parts, or rewrites the tool's text, cleans it whole first.
    const parsed = parseOutput(command.name, command.run, output, options.cwd, clean);
    // Checked once per path, since every diagnostic in an eslint file or a SARIF artifact shares it.
    const keeps = memo((path) => clean(path) === path);
    const cleanCut = (text: string): string => cut(clean(text), MAX_SIGNAL_TEXT_POINTS);
    const signals = parsed.signals.map((signal) => ({
      ...signal,
      ...(signal.path !== null && !keeps(signal.path) ? { path: null, line: null } : {}),
      claim: cleanCut(signal.claim),
      evidence: signal.evidence.map(cleanCut),
    }));
    // A version the output itself states (a SARIF document names its producer)
    // is recorded like a version command's line; a command the user wrote wins.
    const version = configuredVersion ?? (parsed.version === undefined ? undefined : sanitisedVersion(parsed.version, clean));
    outcomes.push({
      name: command.name,
      command: command.run,
      exitCode: result.status,
      durationMs,
      ...(version === undefined ? {} : { version }),
      signals,
    });
  }

  return {
    enabled: true,
    signals: outcomes.flatMap((outcome) => outcome.signals),
    commands: outcomes,
    didNotRun,
  };
}

/**
 * The tool's version line, or undefined. A version command that fails in any
 * way records nothing: it is a nicety for the audit record and must never turn
 * a check that ran into one that did not.
 */
async function readVersion(
  spawn: CommandSpawner,
  run: string,
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv,
  clean: (text: string) => string,
): Promise<string | undefined> {
  const result = await spawnInGroup(spawn, run, cwd, timeout, env);
  if (result.error !== undefined || result.status !== 0) return undefined;
  return sanitisedVersion(String(result.stdout ?? ''), clean);
}

/**
 * The options a configured check runs with; see spawnCommand. With `args`,
 * `run` is the program and the list its arguments, run without a shell, so a
 * reproduction's sandbox wrapper gets its argv exactly as built.
 */
export function spawnInGroup(
  spawn: CommandSpawner,
  run: string,
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv,
  args?: string[],
): CommandResult | Promise<CommandResult> {
  return spawn(run, {
    cwd, env, shell: args === undefined, ...(args === undefined ? {} : { args }),
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, detached: true,
  });
}

/** What a configured command produced, in the shape spawnSync gave it before (issue 277). */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not start, timed out (code ETIMEDOUT) or overflowed (code ENOBUFS). */
  error?: Error;
}

/** How a configured command runs. The fixed fields are spelled out so a test can pin all of them. */
export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** False only with `args`. */
  shell: boolean;
  /** The program's arguments when it runs without a shell. */
  args?: readonly string[];
  encoding: 'utf8';
  timeout: number;
  killSignal: 'SIGKILL';
  /** Bytes allowed on stdout or on stderr, each. */
  maxBuffer: number;
  detached: true;
  /** Written to stdin. Without it stdin is empty, never left open, so a command that reads it cannot hang. */
  input?: string;
}

/** The seam tests use so no real process is needed; a result may come back at once. */
export type CommandSpawner = (command: string, options: CommandOptions) => CommandResult | Promise<CommandResult>;

/** The longest delay setTimeout honours, about 24 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The process groups of the configured commands running now, by leader pid. */
const runningGroups = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Nothing was left in the group, which is the usual case.
  }
}

/** The undo steps of work in progress around a command, such as a reproduction's file in the worktree. */
const undoOnStop = new Set<() => void>();

/** Leaves `undo` for a stop signal to run, since the exit that follows skips every finally; returns the function that withdraws it. */
export function onStop(undo: () => void): () => void {
  undoOnStop.add(undo);
  return () => void undoOnStop.delete(undo);
}

/**
 * Kills every configured command still running, with all it started (issue
 * 277), then runs the undo steps left with onStop, latest first. Each command
 * runs in a process group of its own, which a signal to the review never
 * reaches, so the review driver calls this from its signal handler before it
 * removes the worktree the commands run in.
 */
export function stopCommands(): void {
  for (const pid of runningGroups) killGroup(pid, 'SIGKILL');
  for (const undo of [...undoOnStop].reverse()) {
    undoOnStop.delete(undo);
    try {
      undo();
    } catch {
      // The stop goes ahead; one step that failed must not keep the rest from running.
    }
  }
}

/**
 * For `evidence` or `verify` run on their own: a stop signal to the CLI kills
 * its configured commands too, then exits as the review driver does. The
 * commands run in groups of their own, which a Ctrl-C to the terminal's
 * group no longer reaches. Returns the function that removes the handlers.
 */
export function stopCommandsOnSignal(): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    stopCommands();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

/**
 * Runs a configured command in a process group of its own, without blocking
 * the event loop (issue 277). While spawnSync ran one, a stop signal waited
 * for it, up to its whole timeout, and a watcher's SIGKILL after its grace
 * period left the worktree behind. A timeout or output past the cap kills the
 * whole group and is reported with spawnSync's error codes, so callers read
 * it as before. Once the command has returned, whatever is left of the group
 * is killed too. The shell has exited by then, so what the kill reaches is
 * anything the command started in the background, which would otherwise
 * outlive the review whether the check passed, failed or timed out. The kill
 * signal is one the command cannot trap, so a check that ignored a polite one
 * cannot hold the review either.
 */
export function spawnCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawnChild(command, options.args ?? [], { cwd: options.cwd, env: options.env, shell: options.shell, detached: options.detached, stdio: 'pipe' });
    const pid = child.pid;
    if (pid !== undefined) runningGroups.add(pid);
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure: 'ETIMEDOUT' | 'ENOBUFS' | undefined;
    let settled = false;
    const stop = (code: 'ETIMEDOUT' | 'ENOBUFS'): void => {
      failure ??= code;
      if (pid !== undefined) killGroup(pid, options.killSignal);
      // A descendant that left the group (setsid, or a detached spawn) still
      // holds the pipes, and close waits for them, so a timeout or overflow
      // would wait for it. spawnSync stopped reading here; so does this, and
      // close then follows the shell's exit.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    // As under spawnSync, a timeout of zero is none. setTimeout fires at once past
    // MAX_TIMER_MS, where spawnSync waited, so a longer one is capped instead.
    const timer = options.timeout > 0 ? setTimeout(() => stop('ETIMEDOUT'), Math.min(options.timeout, MAX_TIMER_MS)) : undefined;
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        const room = options.maxBuffer - sizes[stream];
        if (room > 0) chunks[stream].push(chunk.subarray(0, room));
        sizes[stream] += chunk.length;
        if (sizes[stream] > options.maxBuffer) stop('ENOBUFS');
      });
    }
    const finish = (status: number | null, error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid !== undefined) {
        killGroup(pid, 'SIGKILL');
        runningGroups.delete(pid);
      }
      resolve({
        status,
        stdout: Buffer.concat(chunks.stdout).toString(options.encoding),
        stderr: Buffer.concat(chunks.stderr).toString(options.encoding),
        ...(error === undefined ? {} : { error }),
      });
    };
    // A shell that could not start (a missing directory, say) is an error, as it was under spawnSync.
    child.on('error', (error) => finish(null, error));
    // On close, not exit, as spawnSync waited, so output still in the pipe is read whole.
    child.on('close', (status) =>
      finish(status, failure === undefined ? undefined : Object.assign(new Error(`spawn ${child.spawnfile} ${failure}`), { code: failure })),
    );
    // A command that answers without reading its input can exit before the
    // write, which then fails with EPIPE. That is no failure, and an error left
    // unhandled here would crash the review. Failure is judged only by a spawn
    // error on the child or an exit with no status.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  });
}
