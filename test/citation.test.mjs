import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkCitation } from '../plugins/review-voice/src/scoring/citation.ts';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'rv-cite-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return root;
}

test('a cited path that does not exist is caught, and the near miss is named', () => {
  // Observed: a candidate cited modules/productChecklist/hooks/... where the
  // real file is modules/productCheckList/utils/... The line number was right
  // and the substance was right, and the citation would have sent the author to
  // a path that does not exist.
  const root = repo({ 'modules/productCheckList/utils/useFilters.tsx': 'export const x = 1;\n' });
  try {
    const wrong = checkCitation('modules/productChecklist/hooks/useFilters.tsx', root, 'HEAD', null);
    assert.equal(wrong.resolves, false);
    assert.equal(wrong.suggestion, 'modules/productCheckList/utils/useFilters.tsx');

    const right = checkCitation('modules/productCheckList/utils/useFilters.tsx', root, 'HEAD', null);
    assert.equal(right.resolves, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file the change adds resolves from the diff, not the base ref', () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  const diff = [
    'diff --git a/src/brandNew.ts b/src/brandNew.ts',
    '--- /dev/null',
    '+++ b/src/brandNew.ts',
    '@@ -0,0 +1 @@',
    '+export const b = 2;',
  ].join('\n');
  try {
    assert.equal(checkCitation('src/brandNew.ts', root, 'HEAD', diff).resolves, true);
    assert.equal(checkCitation('src/brandNew.ts', root, 'HEAD', null).resolves, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a search that cannot run is inconclusive, never a wrong-path verdict', () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const check = checkCitation('src/a.ts', root, 'refs/does-not-exist', null);
    assert.equal(check.inconclusive, true);
    assert.equal(check.resolves, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
