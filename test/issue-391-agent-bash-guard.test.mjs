/**
 * #391: the agents' `Bash(git:*)` was never enforced, so one ran the script
 * under review. The plugin's PreToolUse hook enforces it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, decide, refusal } from '../plugins/review-voice/hooks/agent-bash-guard.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bash = (command, agent_type = 'review-voice:challenger') => ({ tool_name: 'Bash', agent_type, tool_input: { command } });

test('read-only git runs; anything else an agent asks for is denied', () => {
  for (const ok of ['git show abc123:src/a.ts', 'git -C /tmp/rv/head log -5 --oneline -- src/a.ts', 'git --no-pager diff a...b', 'git grep -n "foo bar" HEAD -- "src/x y.ts"', 'git log --format=%H -- --output']) {
    assert.equal(refusal(ok), null, ok);
  }
  for (const bad of ['node scripts/check.mjs', 'git show HEAD; node x.mjs', 'git log $(whoami)', 'git checkout main', 'git -c core.pager=sh show', 'git grep -Ovim foo', 'git log --output=/tmp/x', 'git diff --ext-diff', 'strings /usr/bin/node > /tmp/s', 'git', 'cat a | git hash-object --stdin']) {
    assert.notEqual(refusal(bad), null, bad);
  }
});

test('only this plugin\'s agents are limited, by bare or namespaced name', () => {
  assert.equal(decide(bash('node x.mjs', null)), null, 'the main conversation');
  assert.equal(decide(bash('node x.mjs', 'other-plugin:builder')), null);
  assert.equal(decide({ tool_name: 'Read', agent_type: 'challenger', tool_input: { file_path: '/x' } }), null);
  for (const agent of ['challenger', 'review-voice:evidence-verifier']) {
    assert.equal(decide(bash('node x.mjs', agent)).hookSpecificOutput.permissionDecision, 'deny', agent);
  }
});

test('every agent the plugin ships is covered, and the hook file runs as configured', () => {
  const shipped = readdirSync(join(plugin, 'agents')).map((file) => file.replace(/\.md$/, '')).sort();
  assert.deepEqual([...AGENTS].sort(), shipped);
  const config = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8'));
  assert.equal(config.hooks.PreToolUse[0].matcher, 'Bash');
  const script = join(plugin, 'hooks/agent-bash-guard.mjs');
  const denied = spawnSync(process.execPath, [script], { input: JSON.stringify(bash('node x.mjs')), encoding: 'utf8' });
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const allowed = spawnSync(process.execPath, [script], { input: JSON.stringify(bash('git show HEAD:a')), encoding: 'utf8' });
  assert.equal(allowed.stdout, '');
  assert.equal(spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' }).status, 0);
});
