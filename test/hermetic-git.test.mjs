/**
 * Tests must not read the developer's global git config (#517): a global
 * core.hooksPath once ran a secret scanner on every test commit, and under that
 * load the timing tests failed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const preload = fileURLToPath(new URL('./support/hermetic-git.mjs', import.meta.url));

test('npm test preloads the hermetic git config into every test process', () => {
  const script = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test;
  assert.match(script, /--import \.\/test\/support\/hermetic-git\.mjs/);
});

test('a global hooksPath that fails every commit does not reach a commit made under the preload', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rv-hermetic-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hooks = join(home, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "global hook ran" >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const hostile = join(home, 'gitconfig');
  writeFileSync(hostile, `[core]\n\thooksPath = ${hooks}\n[user]\n\tname = Someone Else\n\temail = someone@example.org\n`);
  const repo = join(home, 'repo');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: hostile, HOME: home };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;

  // Without the preload the hostile config applies: the control for what follows.
  execFileSync('git', ['init', '-q', repo], { env });
  const control = spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'control'], { env, encoding: 'utf8' });
  assert.notEqual(control.status, 0, 'the hostile hook fails a commit with no preload');

  // Under the preload, the same environment commits, with the test identity.
  const code = `
    const { execFileSync } = require('node:child_process');
    execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'commit', '-q', '--allow-empty', '-m', 'under preload'], { stdio: 'pipe' });
    process.stdout.write(execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'log', '-1', '--format=%ae'], { encoding: 'utf8' }).trim());
  `;
  const run = spawnSync(process.execPath, ['--import', preload, '-e', code], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'test@example.com');
});
