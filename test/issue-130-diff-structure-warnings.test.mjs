/** Issue #130: diff applies structural defaults and must say when it does. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function source(lines) {
  return Array.from({ length: lines }, (_, index) => `export const value${index} = ${index};`).join('\n') + '\n';
}

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'rv-130-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.useConfigOnly', 'false');
  mkdirSync(join(directory, '.review-voice'));
  mkdirSync(join(directory, 'src'));
  writeFileSync(
    join(directory, '.review-voice', 'config.yaml'),
    [
      'review:',
      '  structure:',
      '    max_file_lines: many',
      '  human_review:',
      '    structure:',
      '      file_line_crossing: yes',
      '',
    ].join('\n'),
  );
  writeFileSync(join(directory, 'src', 'large.ts'), source(1000));
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  writeFileSync(join(directory, 'src', 'large.ts'), source(1001));
  return directory;
}

test('diff reports all loaded structural warnings and retains the defaults', () => {
  const directory = repository();
  const output = join(directory, 'out');
  try {
    const context = JSON.parse(execFileSync(process.execPath, [bundle, 'context'], { cwd: directory, encoding: 'utf8' }));
    const result = spawnSync(process.execPath, [bundle, 'diff', '--out', output], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    for (const warning of context.warnings) {
      assert.match(result.stderr, new RegExp(`Warning: ${warning.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    const summary = JSON.parse(result.stdout).summary;
    assert.equal(summary.structure.sizeCrossings.length, 1, 'invalid max_file_lines uses the default 1000');
    assert.equal(summary.complexity.level, 'normal', 'invalid file_line_crossing uses the default false');
    assert.deepEqual(summary.complexity.reasons, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
