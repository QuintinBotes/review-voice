import { spawnSync } from 'node:child_process';
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
  options: { cwd: string; enabled: boolean; spawn?: typeof spawnSync },
): EvidenceReport {
  if (!options.enabled || commands.length === 0) {
    return notRunReport(commands.map((command) => command.name));
  }

  // The seam tests use so no real process is needed to pin the call count.
  const spawn = options.spawn ?? spawnSync;
  const outcomes: CommandOutcome[] = [];
  const didNotRun: string[] = [];

  for (const command of commands) {
    const startedAt = Date.now();
    const timeoutMs = (command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    // Run through a shell because users write shell commands, but with the
    // command string coming only from their own config file - never from the
    // diff, and never interpolated with repository content.
    const result = spawn(command.run, {
      cwd: options.cwd,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });

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

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const version = command.version === undefined ? undefined : readVersion(spawn, command.version, options.cwd, timeoutMs);
    outcomes.push({
      name: command.name,
      command: command.run,
      exitCode: result.status,
      durationMs,
      ...(version === undefined ? {} : { version }),
      signals: parseOutput(command.name, command.run, output),
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
function readVersion(spawn: typeof spawnSync, run: string, cwd: string, timeout: number): string | undefined {
  const result = spawn(run, { cwd, shell: true, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return sanitisedVersion(String(result.stdout ?? ''));
}
