import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAgentName } from './tools.ts';
import type { AgentResult, AgentSpec } from './types.ts';

/**
 * Canned agents for tests (docs/adr/0021). The call counter lives on disk so a
 * test can drive several separate CLI processes and still address each call
 * as `<name>.<n>.json`.
 */
export function runFake(
  spec: AgentSpec,
  prompt: string,
  dir: string,
  cwd = '',
  addDirs: string[] = [],
): Omit<AgentResult, 'seconds'> {
  checkAgentName(spec.name);
  const calls = join(dir, '.calls');
  mkdirSync(calls, { recursive: true });
  const counter = join(calls, `${spec.name}.count`);
  const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) || 0 : 0) + 1;
  writeFileSync(counter, `${n}\n`);
  writeFileSync(join(calls, `${spec.name}.${n}.prompt.txt`), prompt);
  writeFileSync(
    join(calls, `${spec.name}.${n}.spec.json`),
    `${JSON.stringify(
      {
        name: spec.name,
        model: spec.model,
        tools: spec.tools,
        timeoutMs: spec.timeoutMs ?? null,
        cwd,
        addDirs,
        // Only when the spec has one, so existing spec.json assertions hold.
        ...(spec.runner === undefined ? {} : { runner: { family: spec.runner.family, label: spec.runner.label } }),
      },
      null,
      2,
    )}\n`,
  );

  const numbered = join(dir, `${spec.name}.${n}.json`);
  const fallback = join(dir, `${spec.name}.json`);
  const path = existsSync(numbered) ? numbered : fallback;
  if (!existsSync(path)) {
    return { ok: false, output: null, costUsd: null, error: `no fake output: neither ${numbered} nor ${fallback} exists` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return { ok: false, output: null, costUsd: null, error: `${path} is not JSON: ${(error as Error).message}` };
  }
  const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  if (typeof record['error'] === 'string') return { ok: false, output: null, costUsd: null, error: record['error'] };
  if ('output' in record) {
    const tokens = record['tokens'];
    return {
      ok: true,
      output: record['output'],
      costUsd: null,
      ...(typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? { tokens } : {}),
    };
  }
  return { ok: false, output: null, costUsd: null, error: `${path} has neither "output" nor "error"` };
}
