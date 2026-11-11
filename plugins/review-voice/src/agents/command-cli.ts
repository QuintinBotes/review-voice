import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandEnvironment, maskPassthrough, maskPassthroughDeep, onStop } from '../evidence/run.ts';
import { jsonCandidates } from '../verify/external.ts';
import { agentTimeoutMs, firstChars, spawnWatched } from './claude-cli.ts';
import { agentFile } from './tools.ts';
import type { AgentResult, AgentSpec, RunnerSpec } from './types.ts';

/**
 * The configured argv with `{schema}`, `{output}` and `{cwd}` replaced where
 * one is a whole argument. Every other argument is passed as written, so a
 * brace inside an operator's own flag is never rewritten.
 */
export function expandCommand(command: readonly string[], values: { schema: string; output: string; cwd: string }): string[] {
  const tokens: Record<string, string> = { '{schema}': values.schema, '{output}': values.output, '{cwd}': values.cwd };
  // Own keys only: an argument such as `toString` must not resolve to Object.prototype.
  return command.map((argument) => (Object.hasOwn(tokens, argument) ? tokens[argument]! : argument));
}

/** The last top-level JSON object in the text, or undefined when there is none. */
export function lastJsonObject(text: string): unknown {
  for (const candidate of jsonCandidates(text).reverse()) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Runs an agent on another model family through the command its configuration
 * names (docs/adr/0021, amended). An external CLI has no system-prompt flag
 * the runner can rely on, so the agent file's body travels on stdin ahead of
 * the prompt, which already starts with COMMAND_RUNNER_PREAMBLE.
 */
export async function runCommandCli(
  spec: AgentSpec & { runner: RunnerSpec },
  prompt: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Omit<AgentResult, 'seconds'>> {
  const { runner } = spec;
  const [bin, ...rest] = runner.command;
  const passthrough = runner.envPassthrough ?? [];
  const dir = mkdtempSync(join(tmpdir(), 'rv-runner-'));
  const withdraw = onStop(() => rmSync(dir, { recursive: true, force: true }));
  try {
    const schema = join(dir, 'schema.json');
    const output = join(dir, 'output.json');
    writeFileSync(schema, JSON.stringify(spec.schema));
    const body = readFileSync(agentFile(spec.name), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    const result = await spawnWatched(bin ?? '', expandCommand(rest, { schema, output, cwd }), `${body}\n\n${prompt}`, {
      cwd,
      // The same minimal environment as every configured command (issue 279):
      // the CLI reads the pull request's tree, which has no claim on the
      // reviewer's tokens.
      env: commandEnvironment(env, passthrough),
      timeoutMs: agentTimeoutMs(spec),
    });
    if (result.failed !== undefined) return { ok: false, output: null, costUsd: null, error: result.failed };
    // A codex --json stream is many objects and the last one is not the answer,
    // which is why {output} exists. Once named, stdout is no substitute for it.
    const fromFile = runner.command.includes('{output}');
    const written = fromFile && existsSync(output);
    const answer = written ? readFileSync(output, 'utf8') : fromFile ? '' : result.stdout;
    const parsed = result.code === 0 ? lastJsonObject(answer) : undefined;
    // No tokens key, ever: no count was reported, and zero would be a count nobody made.
    if (parsed !== undefined) return { ok: true, output: maskPassthroughDeep(parsed, env, passthrough), costUsd: null };
    // Masked whole, before the cut: a value cut in two no longer matches.
    const detail =
      firstChars(maskPassthrough(result.stderr, env, passthrough)) ||
      firstChars(maskPassthrough(result.stdout, env, passthrough)) ||
      (result.code !== 0 ? `${bin} exited with code ${result.code}` : fromFile && !written ? `${bin} wrote no {output} file` : `${bin} returned no JSON object`);
    return { ok: false, output: null, costUsd: null, error: detail };
  } finally {
    withdraw();
    rmSync(dir, { recursive: true, force: true });
  }
}
