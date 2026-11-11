import { spawn, type ChildProcess } from 'node:child_process';
import { stopCommands } from '../evidence/run.ts';
import { agentFile } from './tools.ts';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  type AgentResult,
  type AgentSpec,
} from './types.ts';

const ERROR_CHARS = 500;
/** A schema-valid answer is far smaller; past this the process is runaway. */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
/** Only the first ERROR_CHARS are ever reported. */
const MAX_STDERR_BYTES = 64 * 1024;

/** Credentials and runner settings the agent process has no use for. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== 'GITHUB_TOKEN' && key !== 'GH_TOKEN' && !key.startsWith('REVIEW_VOICE_'),
    ),
  );
}

/** setTimeout fires at once past 2^31-1 ms, so a cap is also a correctness bound. */
export function agentTimeoutMs(spec: AgentSpec): number {
  return Math.min(spec.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS);
}

/**
 * Children run in their own process groups, so a Ctrl-C at the terminal never
 * reaches them. While any is live, SIGINT and SIGTERM kill every group first.
 */
const live = new Set<ChildProcess>();
let signalsOwned = false;

/** Kills every live agent's process group. */
export function stopAll(): void {
  for (const child of live) killTree(child);
}

/**
 * The review driver handles SIGINT and SIGTERM itself while it runs, so it can
 * remove its worktree after stopAll and before it exits.
 */
export function ownSignals(owned: boolean): void {
  signalsOwned = owned;
}

function onSignal(signal: NodeJS.Signals): void {
  stopAll();
  // The exit skips every finally, so the undo steps left with onStop (a command runner's temporary directory) run here.
  stopCommands();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

function track(child: ChildProcess): void {
  if (live.size === 0 && !signalsOwned) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  live.add(child);
}

function untrack(child: ChildProcess): void {
  if (!live.delete(child) || live.size > 0) return;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}

/**
 * A SIGKILL to the CLI cannot be caught, so claude runs under this wrapper. It
 * leads the process group the runner kills, and kills that group itself once
 * the CLI's pid is gone: no portable parent-death signal exists, so it polls.
 * The argv after `--` is the claude command line; stdio passes straight through.
 */
export const WATCHDOG = `
const { spawn } = require('node:child_process');
const parent = process.ppid;
const [bin, ...args] = process.argv.slice(1);
const child = spawn(bin, args, { stdio: 'inherit' });
const poll = setInterval(() => {
  if (process.ppid === parent) return;
  try { process.kill(-process.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); process.exit(1); }
}, 2000);
child.on('error', (error) => {
  process.stderr.write('could not start ' + bin + ': ' + error.message);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  clearInterval(poll);
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
`;

export function claudeBin(env: NodeJS.ProcessEnv): string {
  return env['REVIEW_VOICE_CLAUDE_BIN'] || 'claude';
}

interface Envelope {
  is_error?: unknown;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Input plus output tokens, or undefined when either is missing or not a count.
 * Cache creation and cache read tokens are left out on purpose: they are not
 * what the stage was asked to read or write.
 */
function tokensOf(usage: unknown): number | undefined {
  if (usage === null || typeof usage !== 'object') return undefined;
  const { input_tokens: input, output_tokens: output } = usage as Record<string, unknown>;
  return isCount(input) && isCount(output) ? input + output : undefined;
}

/** `spec.tools` is already narrowed by runnerTools. */
function claudeArguments(spec: AgentSpec, addDirs: string[], env: NodeJS.ProcessEnv): string[] {
  const tools = spec.tools.join(',');
  return [
    '-p',
    '--restricted',
    // Ignores CLAUDE.md, skills, commands and agents planted in the checkout.
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
    // Bare mode skips OAuth and keychain reads, which only an API key replaces.
    ...(env['ANTHROPIC_API_KEY'] ? ['--bare'] : []),
    '--system-prompt-file',
    agentFile(spec.name),
    '--model',
    spec.model,
    // An empty value is how claude disables every built-in tool; leaving the
    // flag out would grant the default set.
    '--tools',
    tools,
    ...(tools === '' ? [] : ['--allowedTools', tools]),
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    '--json-schema',
    JSON.stringify(spec.schema),
    '--output-format',
    'json',
  ];
}

export function firstChars(text: string): string {
  return text.trim().slice(0, ERROR_CHARS);
}

export function interpretEnvelope(stdout: string, stderr: string, code: number | null): Omit<AgentResult, 'seconds'> {
  let envelope: Envelope | null = null;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) envelope = parsed as Envelope;
  } catch {
    envelope = null;
  }
  const costUsd = typeof envelope?.total_cost_usd === 'number' ? envelope.total_cost_usd : null;
  const tokens = tokensOf(envelope?.usage);
  const counted = tokens === undefined ? {} : { tokens };
  if (code === 0 && envelope !== null && envelope.is_error === false && envelope.structured_output !== undefined) {
    return { ok: true, output: envelope.structured_output, costUsd, ...counted };
  }
  const result = typeof envelope?.result === 'string' ? envelope.result : '';
  const detail =
    firstChars(result) ||
    firstChars(stderr) ||
    firstChars(stdout) ||
    (code === 0 ? 'claude returned no structured output' : `claude exited with code ${code}`);
  return { ok: false, output: null, costUsd, ...counted, error: detail };
}

/** What a watched process produced; `failed` is set when it never ran, timed out or overflowed. */
export interface WatchedResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failed?: string;
}

/**
 * Spawns `bin` under the watchdog in its own process group, with the timeout,
 * output cap, signal ownership and stdin discipline every agent backend shares
 * (the command backend runs through here too, so `stopAll` kills either).
 */
export function spawnWatched(
  bin: string,
  args: readonly string[],
  input: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<WatchedResult> {
  return new Promise((resolve) => {
    // Its own process group, so a timeout can kill everything it started.
    const child = spawn(process.execPath, ['-e', WATCHDOG, '--', bin, ...args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    track(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopped: 'timeout' | 'output too large' | null = null;
    let settled = false;
    const finish = (result: WatchedResult): void => {
      untrack(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (reason: 'timeout' | 'output too large'): void => {
      stopped ??= reason;
      killTree(child);
      // A descendant that left the group (setsid) still holds the pipes and close
      // waits for them, so close follows the watchdog's exit only once they go (issue 277).
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) stop('output too large');
      else stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on('error', (error) => {
      finish({ code: null, stdout: '', stderr: '', failed: `could not start ${bin}: ${error.message}` });
    });
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(stopped === null ? {} : { failed: stopped }),
      });
    });
    if (child.stdin) {
      // A process that exits before reading all of stdin is reported by its
      // exit status; the broken pipe itself carries no information.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

export async function runClaudeCli(
  spec: AgentSpec,
  prompt: string,
  cwd: string,
  addDirs: string[],
  env: NodeJS.ProcessEnv,
): Promise<Omit<AgentResult, 'seconds'>> {
  // Always on stdin: argv cannot carry a NUL or a large diff, and a positional
  // prompt is parsed for flags.
  const args = claudeArguments(spec, addDirs, env);
  const result = await spawnWatched(claudeBin(env), args, prompt, { cwd, env: childEnv(env), timeoutMs: agentTimeoutMs(spec) });
  if (result.failed !== undefined) return { ok: false, output: null, costUsd: null, error: result.failed };
  return interpretEnvelope(result.stdout, result.stderr, result.code);
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
