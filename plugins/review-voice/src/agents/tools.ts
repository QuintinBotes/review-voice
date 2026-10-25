import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The only tools the runner grants (docs/adr/0021). No shell: git options can
 * run arbitrary commands, and an allowedTools prefix cannot narrow them.
 */
export const RUNNER_TOOLS = ['Read', 'Grep', 'Glob'];

/** Declared for the interactive host, which may run git; the runner drops it. */
const HOST_ONLY_TOOLS = ['Bash(git:*)'];

export class AgentSpecError extends Error {}

/**
 * The plugin root, the directory holding .claude-plugin/. The bundle runs from
 * dist/ and the tests run the source from src/agents/, so this walks up rather
 * than assuming a fixed depth.
 */
function pluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    if (dirname(dir) === dir) return join(here, '..');
  }
}

export function agentsDir(): string {
  return join(pluginRoot(), 'agents');
}

export function schemasDir(): string {
  return join(pluginRoot(), 'schemas');
}

/** Agent names become file paths, so every backend checks them first. */
export function checkAgentName(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new AgentSpecError(`Unknown agent: ${name} (not an agent name)`);
}

/** The agent's prompt file. */
export function agentFile(name: string): string {
  checkAgentName(name);
  const path = join(agentsDir(), `${name}.md`);
  if (!existsSync(path)) throw new AgentSpecError(`Unknown agent: ${name} (no ${name}.md in ${agentsDir()})`);
  return path;
}

export function readAgentTools(name: string): string[] {
  return parseAgentTools(readFileSync(agentFile(name), 'utf8'), `${name}.md`);
}

/**
 * The `tools:` frontmatter: `[]`, a comma list (bare or in brackets), or a YAML
 * block list of `- Tool` lines. An empty value with no block list is no tools.
 */
export function parseAgentTools(text: string, label: string): string[] {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (frontmatter === undefined) throw new AgentSpecError(`${label} has no frontmatter`);
  const line = /^tools:[ \t]*(.*)$((?:\r?\n[ \t]*-[^\n]*)*)/m.exec(frontmatter);
  if (line === null) throw new AgentSpecError(`${label} declares no tools: line`);
  const inline = line[1]!.trim();
  const items =
    inline === ''
      ? line[2]!.split('\n').map((item) => item.replace(/^[ \t]*-/, ''))
      : inline.replace(/^\[(.*)\]$/, '$1').split(',');
  return items.map((tool) => tool.trim().replace(/^["']|["']$/g, '')).filter((tool) => tool !== '');
}

/**
 * The tools a runner call gets: the declared ones, minus host-only git. Any
 * other tool is refused before a process is started.
 */
export function runnerTools(declared: string[]): string[] {
  const tools: string[] = [];
  for (const tool of declared) {
    if (HOST_ONLY_TOOLS.includes(tool)) continue;
    if (!RUNNER_TOOLS.includes(tool)) {
      throw new AgentSpecError(`Tool ${tool} is not allowed: the runner grants only ${RUNNER_TOOLS.join(', ')}`);
    }
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools;
}
