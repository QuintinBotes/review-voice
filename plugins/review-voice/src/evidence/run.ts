import { spawnSync } from 'node:child_process';
import { parseOutput } from './parsers.ts';
import type { CommandOutcome, EvidenceReport } from './types.ts';

export interface ConfiguredCommand {
  name: string;
  run: string;
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * Runs the commands the user declared in their own configuration — and only
 * those (docs/adr/0003). Review Voice is pointed at repositories whose contents
 * it treats as untrusted, so auto-detecting and running a project script would
 * be arbitrary code execution on hostile input. Detection suggests;
 * configuration enables.
 */
export function collectEvidence(
  commands: ConfiguredCommand[],
  options: { cwd: string; enabled: boolean },
): EvidenceReport {
  if (!options.enabled || commands.length === 0) {
    return { enabled: false, signals: [], commands: [], didNotRun: commands.map((command) => command.name) };
  }

  const outcomes: CommandOutcome[] = [];
  const didNotRun: string[] = [];

  for (const command of commands) {
    const startedAt = Date.now();
    // Run through a shell because users write shell commands, but with the
    // command string coming only from their own config file — never from the
    // diff, and never interpolated with repository content.
    const result = spawnSync(command.run, {
      cwd: options.cwd,
      shell: true,
      encoding: 'utf8',
      timeout: (command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
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

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    outcomes.push({
      name: command.name,
      command: command.run,
      exitCode: result.status,
      durationMs,
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
