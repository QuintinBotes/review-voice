import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { parseOutput } from './parsers.ts';
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
/** The shell's own answer when the command is missing (127) or not executable (126). */
const SHELL_UNAVAILABLE_EXIT_CODES: readonly number[] = [126, 127];

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
 * left alone; a value shorter than MIN_MASKED_LENGTH is too.
 */
export function maskPassthrough(text: string, source: NodeJS.ProcessEnv, passthrough: readonly string[]): string {
  let masked = text;
  // Longest first, so a value containing another listed value is masked whole.
  const values = passthrough
    .map((name) => [name, source[name]] as const)
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string' && entry[1].length >= MIN_MASKED_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of values) masked = masked.split(value).join(`[redacted:${name}]`);
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
 * a surrogate pair is never split.
 */
function sanitisedVersion(stdout: string): string | undefined {
  const firstLine = stdout.split('\n')[0] ?? '';
  const clean = firstLine
    // Control (Cc) and format (Cf) characters: the format class holds the bidi
    // controls and the zero-width characters, and line and paragraph separators
    // would break the one-line record.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .trim();
  const capped = [...clean].slice(0, MAX_VERSION_POINTS).join('').trim();
  return capped === '' ? undefined : capped;
}

/**
 * Runs the commands the user declared in their own configuration - and only
 * those (docs/adr/0003). Review Voice is pointed at repositories whose contents
 * it treats as untrusted, so auto-detecting and running a project script would
 * be arbitrary code execution on hostile input. Detection suggests;
 * configuration enables.
 */
export function collectEvidence(
  commands: ConfiguredCommand[],
  options: { cwd: string; enabled: boolean; envPassthrough?: readonly string[]; spawn?: typeof spawnSync },
): EvidenceReport {
  if (!options.enabled || commands.length === 0) {
    return notRunReport(commands.map((command) => command.name));
  }

  // The seam tests use so no real process is needed to pin the call count.
  const spawn = options.spawn ?? spawnSync;
  const env = commandEnvironment(process.env, options.envPassthrough ?? []);
  const outcomes: CommandOutcome[] = [];
  const didNotRun: string[] = [];

  for (const command of commands) {
    const startedAt = Date.now();
    const timeoutMs = (command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    // Run through a shell because users write shell commands, but with the
    // command string coming only from their own config file - never from the
    // diff, and never interpolated with repository content.
    const result = spawnInGroup(spawn, command.run, options.cwd, timeoutMs, env);

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
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const version = command.version === undefined ? undefined : readVersion(spawn, command.version, options.cwd, timeoutMs, env, mask);
    // Parsed from the true output, so a passed-through directory in a path does
    // not break the location; then the text a reader sees is masked. The path
    // and line stay as printed, because matching a finding to a signal reads them.
    const signals = parseOutput(command.name, command.run, output).map((signal) => ({
      ...signal,
      claim: mask(signal.claim),
      evidence: signal.evidence.map(mask),
    }));
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
function readVersion(
  spawn: typeof spawnSync,
  run: string,
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv,
  mask: (text: string) => string,
): string | undefined {
  const result = spawnInGroup(spawn, run, cwd, timeout, env);
  if (result.error !== undefined || result.status !== 0) return undefined;
  // Masked whole, before the first line is taken and capped: a cut value no
  // longer matches, and a multiline one would leave its first line behind.
  return sanitisedVersion(mask(String(result.stdout ?? '')));
}

/**
 * Runs a configured command in a process group of its own and, once it has
 * returned, kills whatever is left of the group. The shell itself has exited
 * by then (or was killed at the timeout or the output cap), so what the kill
 * reaches is anything the command started in the background, which would
 * otherwise outlive the review whether the check passed, failed or timed out.
 * The kill signal is one the command cannot trap, so a check that ignored a
 * polite one cannot hold the review either.
 */
function spawnInGroup(
  spawn: typeof spawnSync,
  run: string,
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  const options: SpawnSyncOptions & { detached: boolean } = {
    cwd,
    env,
    shell: true,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    detached: true,
  };
  const result = spawn(run, options);
  if (typeof result.pid === 'number' && result.pid > 0) {
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch {
      // Nothing was left in the group, which is the usual case.
    }
  }
  return result;
}
