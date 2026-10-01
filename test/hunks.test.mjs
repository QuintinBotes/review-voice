import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyAnchor, parseHunks, reason } from '../plugins/review-voice/src/diff/hunks.ts';

test('hunk parsing keeps right-side locations through headers, renames and line endings', () => {
  const patch = [
    'diff --git a/src/old-name.ts b/src/new-name.ts',
    'similarity index 80%',
    'rename from src/old-name.ts',
    'rename to src/new-name.ts',
    '--- a/src/old-name.ts',
    '+++ b/src/new-name.ts',
    '@@ -3,3 +3,3 @@',
    ' keep',
    '-removed',
    '+added',
    ' after',
    '@@ -20 +21 @@',
    '-old value',
    '+new value',
    'diff --git a/src/fresh.ts b/src/fresh.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/fresh.ts',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
    '\\ No newline at end of file',
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    'diff --git a/src/delete-only.ts b/src/delete-only.ts',
    '--- a/src/delete-only.ts',
    '+++ b/src/delete-only.ts',
    '@@ -1,3 +1,2 @@',
    ' first',
    ' second',
    '-removed at end',
  ].join('\r\n');

  const hunks = parseHunks(patch);
  const renamed = hunks.get('src/new-name.ts');
  const fresh = hunks.get('src/fresh.ts');
  const deletion = hunks.get('src/delete-only.ts');

  assert.ok(renamed);
  assert.deepEqual([...renamed.added], [4, 21]);
  assert.deepEqual([...renamed.context], [3, 5]);
  assert.deepEqual([...renamed.deletionSites], [4, 21]);
  assert.deepEqual(renamed.ranges, [{ start: 3, end: 5 }, { start: 21, end: 21 }]);
  assert.ok(fresh);
  assert.deepEqual([...fresh.added], [1, 2]);
  assert.equal(hunks.has('src/gone.ts'), false, 'a deleted file has no right-side anchor');
  assert.ok(deletion);
  assert.deepEqual([...deletion.deletionSites], [2], 'an end deletion uses the hunk\'s last right-side line');
});

test('anchor classification distinguishes changed lines from context and patch line numbers', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,64 +1,64 @@',
    ...Array.from({ length: 41 }, (_, index) => ` line ${index + 1}`),
    '-old line 42',
    '+new line 42',
    ...Array.from({ length: 22 }, (_, index) => ` line ${index + 43}`),
    'diff --git a/src/delete.ts b/src/delete.ts',
    '--- a/src/delete.ts',
    '+++ b/src/delete.ts',
    '@@ -1,3 +1,2 @@',
    ' first',
    '-removed',
    ' third',
  ].join('\n');
  const hunks = parseHunks(patch);
  const patchLine = patch.split('\n').findIndex((line) => line === '+new line 42') + 1;

  assert.deepEqual(classifyAnchor(hunks, './src/a.ts', 42).kind, 'added');
  assert.equal(classifyAnchor(hunks, 'src/a.ts', 42).ok, true);
  assert.equal(classifyAnchor(hunks, 'src/delete.ts', 2).kind, 'deletion-site');
  assert.equal(classifyAnchor(hunks, 'src/delete.ts', 2).ok, true);

  const context = classifyAnchor(hunks, 'src/a.ts', 41);
  assert.equal(context.kind, 'context');
  assert.equal(context.ok, false);
  assert.deepEqual(context.nearest, [42]);
  assert.equal(reason(context), 'anchors on src/a.ts:41, an unchanged context line; the nearest changed line is 42.');

  const patchNumber = classifyAnchor(hunks, 'src/a.ts', patchLine);
  assert.deepEqual(patchNumber.patchLine, { path: 'src/a.ts', line: 42 });

  const beyond = classifyAnchor(hunks, 'src/a.ts', 65);
  assert.equal(beyond.kind, 'outside-hunk');
  assert.equal(beyond.beyondHunks, true);
  assert.equal(classifyAnchor(hunks, 'src/missing.ts', 1).kind, 'file-not-in-diff');
});

test('hunk counts separate files when a unified patch omits diff --git headers', () => {
  const hunks = parseHunks(
    [
      '--- a/src/first.ts',
      '+++ b/src/first.ts',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '--- a/src/second.ts',
      '+++ b/src/second.ts',
      '@@ -3 +3 @@',
      '-before',
      '+after',
    ].join('\n'),
  );

  assert.deepEqual([...hunks.get('src/first.ts').added], [1]);
  assert.deepEqual([...hunks.get('src/second.ts').added], [3]);
});

test('a blank context line that lost its leading space does not end the hunk', () => {
  const hunks = parseHunks(
    [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' first',
      '',
      '-old third',
      '+new third',
    ].join('\n'),
  );
  const file = hunks.get('src/a.ts');
  assert.deepEqual([...file.context], [1, 2]);
  assert.deepEqual([...file.added], [3]);
  assert.equal(classifyAnchor(hunks, 'src/a.ts', 3).kind, 'added');
});

test('an anchor check names the location it classified', () => {
  const hunks = parseHunks(['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n'));
  const check = classifyAnchor(hunks, './src/a.ts', 7);
  assert.equal(check.path, 'src/a.ts');
  assert.equal(check.line, 7);
  assert.match(reason(check), /^anchors on src\/a\.ts:7, past every hunk in that file/);
});

test('paths git quotes are decoded, so their anchors are not rejected', () => {
  // `café.ts`, a name with a double quote, and one with a backslash, exactly
  // as git writes them with core.quotePath at its default.
  const patch = [
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    '--- "a/caf\\303\\251.ts"',
    '+++ "b/caf\\303\\251.ts"',
    '@@ -1 +1,2 @@',
    ' first',
    '+second',
    'diff --git "a/q\\"t.ts" "b/q\\"t.ts"',
    '--- "a/q\\"t.ts"',
    '+++ "b/q\\"t.ts"',
    '@@ -1 +1,2 @@',
    ' first',
    '+second',
    'diff --git "a/back\\\\slash.ts" "b/back\\\\slash.ts"',
    '--- "a/back\\\\slash.ts"',
    '+++ "b/back\\\\slash.ts"',
    '@@ -1 +1,2 @@',
    ' first',
    '+second',
  ].join('\n');
  const hunks = parseHunks(patch);
  for (const path of ['café.ts', 'q"t.ts', 'back\\slash.ts']) {
    assert.equal(classifyAnchor(hunks, path, 2).kind, 'added', path);
  }
});

test('a real git diff of a non-ASCII file name anchors on its added line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-hunks-quoted-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'café.ts'), 'first\n');
    git('add', '.');
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'café.ts'), 'first\nsecond\n');
    const patch = git('diff', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/');
    assert.match(patch, /"b\/caf\\303\\251\.ts"/, 'git quotes the name');
    assert.equal(classifyAnchor(parseHunks(patch), 'café.ts', 2).kind, 'added');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an anchor far from any change still names the closest changed line', () => {
  const hunks = parseHunks(['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -40 +40 @@', '-a', '+b'].join('\n'));
  const far = classifyAnchor(hunks, 'src/a.ts', 5);
  assert.deepEqual(far.nearest, [40]);
  assert.match(reason(far), /the nearest changed line is 40/);
});
