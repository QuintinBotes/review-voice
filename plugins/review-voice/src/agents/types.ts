export const FAMILIES = ['claude', 'codex', 'gemini'] as const;
export type Family = (typeof FAMILIES)[number];
export type ExternalFamily = Exclude<Family, 'claude'>;

/** A configured command that runs an agent on another model family (docs/adr/0021, amended). */
export interface RunnerSpec {
  family: ExternalFamily;
  /** argv, never a shell string; `{schema}`, `{output}` and `{cwd}` are replaced before spawn. */
  command: readonly string[];
  /** What the run records as the stage's model; the family name by default. */
  label: string;
  /** Variables the command gets beyond the minimal environment; see `commandEnvironment`. */
  envPassthrough?: readonly string[];
}

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
  /** Absent means the built-in Claude backend, so every existing caller is unchanged. */
  runner?: RunnerSpec;
}

export interface AgentResult {
  ok: boolean;
  output: unknown;
  costUsd: number | null;
  seconds: number;
  /**
   * Input plus output tokens of the call, when the model reported both. Absent
   * rather than zero when unknown, so a stage never shows a count nobody made.
   */
  tokens?: number;
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
