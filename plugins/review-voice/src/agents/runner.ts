/**
 * Runs one Review Voice agent as a confined headless Claude Code process and
 * returns its schema-valid output (docs/adr/0021). Callers never build a
 * command line; the backend is chosen from the environment.
 */
import { runClaudeCli } from './claude-cli.ts';
import { runFake } from './fake.ts';
import { schemaForRunner } from './schema.ts';
import { RUNNER_TOOLS, runnerTools, schemasDir } from './tools.ts';
import {
  DEFAULT_AGENT_PARALLELISM,
  type AgentCall,
  type AgentResult,
  type AgentSpec,
} from './types.ts';

export { agentsDir, readAgentTools, runnerTools, schemasDir, AgentSpecError } from './tools.ts';
export { schemaForRunner } from './schema.ts';
export { agentTimeoutMs, MAX_STDOUT_BYTES } from './claude-cli.ts';

/**
 * Put before every prompt, so the agent does not plan around tools it lacks and
 * a caller's text can never be the first thing claude reads (a leading `/`).
 */
export const RUNNER_PREAMBLE =
  `Tools available: ${RUNNER_TOOLS.join(', ')}. Shell and git are not available in this run. ` +
  'The working directory is the pull request head; base versions of changed files, when provided, ' +
  'are under the directories named in the prompt.';
export type { AgentSpec, AgentResult, AgentCall } from './types.ts';

function elapsed(started: number): number {
  return Math.round((performance.now() - started) / 10) / 100;
}

export async function runAgent(
  spec: AgentSpec,
  prompt: string,
  cwd: string,
  addDirs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentResult> {
  const started = performance.now();
  try {
    const granted: AgentSpec = { ...spec, tools: runnerTools(spec.tools) };
    const sent = `${RUNNER_PREAMBLE}\n\n${prompt}`;
    const fakeDir = env['REVIEW_VOICE_FAKE_AGENTS'];
    if (fakeDir) return { ...runFake(granted, sent, fakeDir), seconds: elapsed(started) };
    // Asking for the fake runner without its directory must not fall through
    // to a real, billed model.
    if (env['REVIEW_VOICE_AGENT_RUNNER'] === 'fake') {
      return {
        ok: false,
        output: null,
        costUsd: null,
        seconds: elapsed(started),
        error: 'REVIEW_VOICE_AGENT_RUNNER=fake needs REVIEW_VOICE_FAKE_AGENTS=<dir>',
      };
    }
    const prepared = { ...granted, schema: schemaForRunner(spec.schema, spec.schemaDir ?? schemasDir()) };
    return { ...(await runClaudeCli(prepared, sent, cwd, addDirs, env)), seconds: elapsed(started) };
  } catch (error) {
    return {
      ok: false,
      output: null,
      costUsd: null,
      seconds: elapsed(started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Runs calls at most `limit` at a time; results come back in input order. */
export async function runAgents(calls: AgentCall[], limit = DEFAULT_AGENT_PARALLELISM): Promise<AgentResult[]> {
  const results: AgentResult[] = new Array<AgentResult>(calls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < calls.length) {
      const index = next;
      next += 1;
      const call = calls[index]!;
      results[index] = await runAgent(call.spec, call.prompt, call.cwd, call.addDirs, call.env);
    }
  };
  const workers = Math.max(1, Math.min(limit, calls.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
