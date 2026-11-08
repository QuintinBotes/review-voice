import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AgentSpecError, readAgentTools, runAgent, runnerTools, schemaForRunner } from '../agents/runner.ts';
import { readStdin, numericFlag, flag } from './shared.ts';

/**
 * Runs one agent through the runner (docs/adr/0021): the prompt on stdin, the
 * AgentResult as JSON on stdout. Tools come from the agent file, never a flag,
 * and the runner narrows them to read-only file tools.
 */
export async function agentCommand(argv: string[]): Promise<number> {
  const name = flag(argv, '--name');
  const model = flag(argv, '--model');
  const schemaPath = flag(argv, '--schema');
  if (name === null || model === null || schemaPath === null) {
    console.error('agent needs --name <agent>, --model <model> and --schema <file.json>.');
    return 2;
  }
  let tools: string[];
  try {
    tools = readAgentTools(name);
    runnerTools(tools);
  } catch (error) {
    if (error instanceof AgentSpecError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;
  } catch (error) {
    console.error(`Cannot read the schema ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    console.error(`The schema ${schemaPath} must be a JSON object.`);
    return 2;
  }
  // Relative $refs resolve next to the schema file, as they would for a validator.
  const schemaDir = dirname(resolve(schemaPath));
  try {
    schemaForRunner(schema, schemaDir);
  } catch (error) {
    if (error instanceof AgentSpecError) {
      console.error(`The schema ${schemaPath} cannot be given to an agent: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const cwd = flag(argv, '--cwd') ?? process.cwd();
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    console.error(`--cwd ${cwd} is not a directory.`);
    return 2;
  }
  const timeout = numericFlag(argv, '--timeout', 0);
  if (timeout === null || (argv.includes('--timeout') && timeout === 0) || timeout > 3600) {
    console.error('--timeout takes a whole number of seconds from 1 to 3600.');
    return 2;
  }

  const prompt = readStdin();
  const result = await runAgent(
    { name, model, tools, schema, schemaDir, ...(timeout > 0 ? { timeoutMs: timeout * 1000 } : {}) },
    prompt,
    cwd,
  );
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}
