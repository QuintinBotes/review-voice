export interface AgentSpec {
  /** The agent file's name, agents/<name>.md. */
  name: string;
  model: string;
  /** The declared tools, as readAgentTools returns them; the runner narrows them. */
  tools: string[];
  /** The JSON Schema the final answer must satisfy. */
  schema: object;
  /** Where the schema's relative file `$ref`s resolve; default the plugin's schemas/. */
  schemaDir?: string;
  timeoutMs?: number;
}

export interface AgentResult {
  ok: boolean;
  output: unknown;
  costUsd: number | null;
  seconds: number;
  error?: string;
}

export interface AgentCall {
  spec: AgentSpec;
  prompt: string;
  cwd: string;
  /** Extra directories the file tools may read, such as base copies of changed files. */
  addDirs?: string[];
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
export const MAX_AGENT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_AGENT_PARALLELISM = 4;
