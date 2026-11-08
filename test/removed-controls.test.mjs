import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { countHunks } from '../plugins/review-voice/src/diff/complexity.ts';
import { parseHunks } from '../plugins/review-voice/src/diff/hunks.ts';
import { findRemovedControls } from '../plugins/review-voice/src/diff/removed-controls.ts';
import { normalisePatch } from '../plugins/review-voice/src/evaluate/fixtures.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function patch(path, removed, added = ['run();'], start = 1) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${removed.length} +${start},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');
}

test('removed lines retain their new-side anchors, original text and enclosing scope', () => {
  const diff = [
    '--- a/src/routes.ts',
    '+++ b/src/routes.ts',
    '@@ -10,5 +20,4 @@',
    ' export function route(request) {',
    '-  if (requireRole(request)) return handle(request);',
    '-  deny(request);',
    '+  handle(request);',
    '   audit(request);',
    '-  verify(request);',
    '+  finish(request);',
    '',
  ].join('\n');
  const [hunk] = countHunks(diff, { has: (path) => path === 'src/routes.ts' });
  assert.deepEqual(hunk.removed, [
    { line: 21, text: '  if (requireRole(request)) return handle(request);', scope: 'export function route(request) {' },
    { line: 21, text: '  deny(request);', scope: 'export function route(request) {' },
    { line: 23, text: '  verify(request);', scope: 'export function route(request) {' },
  ]);
  assert.deepEqual(hunk.added.map(({ line }) => line), [21, 23]);

  const scoped = patch('src/routes.ts', ['  if (isAdmin) act();']).replace('@@\n', '@@ function route() {\n');
  assert.equal(countHunks(scoped, new Set(['src/routes.ts']))[0].removed[0].scope, 'function route() {');
  assert.equal(countHunks(patch('src/routes.ts', ['  check();']), new Set(['src/routes.ts']))[0].removed[0].scope, null);
});

for (const [name, kind] of [
  ['removed-auth-check', 'guard'],
  ['removed-rate-limit', 'middleware'],
  ['removed-allowlist-entry', 'allowlist-entry'],
  ['moved-auth-check', null],
]) {
  test(`${name} has exactly the expected removed-control evidence`, () => {
    const dir = join(root, 'fixtures', kind === null ? 'negative' : 'positive', name);
    const { expect } = parse(readFileSync(join(dir, 'case.yaml'), 'utf8'));
    const diff = normalisePatch(readFileSync(join(dir, 'diff.patch'), 'utf8'));
    const hunks = parseHunks(diff);
    const controls = findRemovedControls(diff, [...hunks.keys()]);
    if (kind === null) {
      assert.deepEqual(controls, []);
      assert.equal(expect.output, 'No actionable findings.');
    } else {
      const removed = countHunks(diff, new Set([expect.path])).flatMap((hunk) => hunk.removed);
      assert.deepEqual(controls, [{
        path: expect.path, line: expect.line, kind,
        text: removed.find(({ line }) => line === expect.line).text.trim(),
      }]);
      assert.ok(hunks.get(expect.path).added.has(expect.line));
    }
  });
}

for (const [path, text, kind] of [
  ['src/check.ts', "if (value === 'admin') act();", 'guard'],
  ['src/check.py', 'if permission: act()', 'guard'],
  ['src/check.rb', 'unless permission then stop end', 'guard'],
  ['src/check.rb', 'when :admin', 'guard'],
  ['src/check.ts', "throw new Error('Forbidden');", 'refusal'],
  ['src/check.py', 'return 403', 'refusal'],
  ['src/check.ts', '@RequireRole("admin")', 'decorator'],
  ['src/check.cs', '[Authorize]', 'decorator'],
  ['src/check.py', '@login_required', 'decorator'],
  ['src/check.ts', 'app.use(verifySession);', 'middleware'],
  ['src/check.ts', 'router.get("/records", requireRole, readRecords);', 'middleware'],
  ['src/allowed-origins.ts', '  "https://client.example.test",', 'allowlist-entry'],
  ['src/roles.ts', '  reader,', 'allowlist-entry'],
  ['src/scopes.ts', '  records: true,', 'allowlist-entry'],
]) {
  test(`${kind} matches ${text} in ${path}`, () => {
    assert.deepEqual(findRemovedControls(patch(path, [text]), [path]), [{ path, line: 1, kind, text: text.trim() }]);
  });
}

test('an enclosing allowlist declaration qualifies an entry in a neutrally named file', () => {
  const diff = patch('src/config.ts', ['  "reader",']).replace('@@\n', '@@ const permittedRoles = [\n');
  assert.equal(findRemovedControls(diff, ['src/config.ts'])[0].kind, 'allowlist-entry');
  assert.deepEqual(findRemovedControls(patch('src/config.ts', ['  "reader",']), ['src/config.ts']), []);
});

for (const [path, removed] of [
  ['src/check.ts', [
    '// if (isAdmin) act();',
    '/* router.use(auth); */',
    ' * @RequireRole("admin")',
    'run(); // if (isAdmin) act();',
    'if (ready) act(); // permission',
    'if (ready /* permission */) act();',
    'const guard = "if (isAdmin) act();";',
    'const guard: string = "if (isAdmin) act();";',
    'guard = "if (isAdmin) act();";',
    'const decorator = "@Authorize";',
    'const middleware = `router.use(auth);`;',
  ]],
  ['src/check.py', ['# if permission: act()', 'if ready: act() # permission', 'example = "@login_required"']],
  ['src/roles.ts', ['// "admin",', '/* "admin", */', 'const role = "admin";', 'return role;', 'readRole(),']],
]) {
  test(`comments, quoted code and statements in ${path} do not invent controls`, () => {
    assert.deepEqual(findRemovedControls(patch(path, removed), [path]), []);
  });
}

test('netting includes additions outside the selected paths and deleted-file controls', () => {
  const guard = 'if (isAdmin) act();';
  // Two additions, one for the removed line and one for the deleted file's line.
  const diff = patch('src/check.ts', [guard]) + patch('test/helper.ts', [], ['  if  (isAdmin)   act();', guard]);
  assert.deepEqual(findRemovedControls(diff, ['src/check.ts'], [{ path: 'src/deleted.ts', text: guard }]), []);
});

test('each file keeps at most 20 entries, earliest first across hunks', () => {
  const early = Array.from({ length: 15 }, (_, i) => `if (permission${i}) act();`);
  const late = Array.from({ length: 15 }, (_, i) => `if (role${i}) act();`);
  const diff = patch('src/a.ts', late, ['later();'], 50) + patch('src/a.ts', early)
    + patch('src/b.ts', ['if (isAdmin) act();']);
  const controls = findRemovedControls(diff, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(controls.filter(({ path }) => path === 'src/a.ts').map(({ text }) => text), [...early, ...late.slice(0, 5)]);
  assert.equal(controls.filter(({ path }) => path === 'src/b.ts').length, 1);
  const deleted = findRemovedControls('', [], [{ path: 'src/gone.ts', text: [...early, ...late].join('\n') }]);
  assert.deepEqual(deleted.map(({ text }) => text), [...early, ...late.slice(0, 5)]);
  assert.ok(deleted.every(({ line, deletedFile }) => line === 1 && deletedFile === true));
});

test('evidence text is trimmed and capped at 120 characters', () => {
  const text = `  if (permission) act('${'x'.repeat(150)}');`;
  const [control] = findRemovedControls(patch('src/check.ts', [text]), ['src/check.ts']);
  assert.equal(control.text, text.trim().slice(0, 120));
});

test('both analyst and verifier prompts require removedControls evidence', () => {
  for (const agent of ['diff-analyst', 'evidence-verifier']) {
    assert.match(readFileSync(join(root, 'plugins/review-voice/agents', `${agent}.md`), 'utf8'), /\bremovedControls\b/);
  }
});

// Netting counts occurrences: one addition accounts for one removal, so the
// same guard taken out of two places and put back in one is one lost control.
test('netting is by occurrence, so two removals against one addition leave one', () => {
  const guard = 'if (isAdmin) act();';
  const diff = patch('src/a.ts', [guard]) + patch('src/b.ts', [guard]) + patch('src/shared.ts', [], [guard]);
  const found = findRemovedControls(diff, ['src/a.ts', 'src/b.ts']);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'guard');
  // The addition is spent on the first removal in diff order, so the second is the one reported.
  assert.equal(found[0].path, 'src/b.ts');
});

// The allowlist element check is linear in the line, so a long quoted value
// holding a comma is decided at once rather than by backtracking.
test('a long quoted property value with a comma is decided quickly and is not an entry', () => {
  const line = `  role: "${' '.repeat(900)}, admin",`;
  const diff = patch('config/allowlist.ts', [line]);
  const started = Date.now();
  const found = findRemovedControls(diff, ['config/allowlist.ts']);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed}ms`);
  assert.deepEqual(found, []);
  const quick = findRemovedControls(patch('config/allowlist.ts', ["  'admin',"]), ['config/allowlist.ts']);
  assert.deepEqual(quick.map((entry) => entry.kind), ['allowlist-entry']);
});

// A removal that nothing follows in its hunk is anchored to the last surviving
// line, as a deletion site is placed; an emptied file anchors at line 1.
test('a trailing removal is anchored to the last surviving line, and an emptied file to line 1', () => {
  const trailing = [
    'diff --git a/src/end.ts b/src/end.ts',
    '--- a/src/end.ts',
    '+++ b/src/end.ts',
    '@@ -1,2 +1,1 @@',
    ' work();',
    '-if (isAdmin) act();',
    '',
  ].join('\n');
  assert.deepEqual(findRemovedControls(trailing, ['src/end.ts']).map((entry) => entry.line), [1]);
  const emptied = [
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ b/src/gone.ts',
    '@@ -1,2 +0,0 @@',
    '-if (isAdmin) act();',
    '-work();',
    '',
  ].join('\n');
  // Nothing survives in an emptied file, so its entries carry the deleted-file mark.
  assert.deepEqual(findRemovedControls(emptied, ['src/gone.ts']).map((entry) => [entry.line, entry.deletedFile]), [[1, true]]);
  const kept = findRemovedControls(trailing, ['src/end.ts']);
  assert.equal(kept[0].deletedFile, undefined, 'a file with a surviving line is anchored on it');
});

// A grouped first operand is part of a longer condition, which runs on to the
// body; the body itself is still not the condition.
test('a Python condition that groups its first operand runs on to the body colon', () => {
  const found = findRemovedControls(patch('src/gate.py', ['if (record is not None) and user.is_admin:'], ['if record is not None:']), ['src/gate.py']);
  assert.deepEqual(found.map((entry) => entry.kind), ['guard']);
  assert.deepEqual(findRemovedControls(patch('src/gate.py', ["if (ready) and done: print('admin')"]), ['src/gate.py']), []);
  const ruby = findRemovedControls(patch('src/gate.rb', ['if (ready) && admin? then deny end']), ['src/gate.rb']);
  assert.deepEqual(ruby.map((entry) => entry.kind), ['guard']);
});

// PHP comments with `#` as well as `//`, and `#[` opens an attribute.
test('a PHP hash comment is not a control, while PHP code is read as before', () => {
  const comments = Array.from({ length: 20 }, (_, i) => `# if ($permission${i}) act();`);
  const found = findRemovedControls(patch('src/Gate.php', [...comments, 'if ($permission) act();']), ['src/Gate.php']);
  assert.deepEqual(found.map((entry) => [entry.kind, entry.text]), [['guard', 'if ($permission) act();']]);
  const attribute = findRemovedControls(patch('src/Gate.php', ["#[IsGranted('ROLE_ADMIN')]"]), ['src/Gate.php']);
  assert.deepEqual(attribute, [], 'an attribute is read as code, and this one is not a decorator the table names');
});

// A quoted key is one element of an allowlist too, and a refusal keyword that
// only sits inside a string is not a refusal.
test('a quoted allowlist key is an entry, and a quoted refusal keyword is not a refusal', () => {
  const keyed = findRemovedControls(patch('src/roles.ts', ['  "reader": true,'], ['  "*": true,']), ['src/roles.ts']);
  assert.deepEqual(keyed.map((entry) => entry.kind), ['allowlist-entry']);
  const single = findRemovedControls(patch('src/roles.ts', ["  'reader': ['read'],"]), ['src/roles.ts']);
  assert.deepEqual(single.map((entry) => entry.kind), ['allowlist-entry']);
  const examples = Array.from({ length: 20 }, (_, i) => `const example${i} = "return 403";`);
  const found = findRemovedControls(patch('src/check.ts', [...examples, 'if (!permission) stop();']), ['src/check.ts']);
  assert.deepEqual(found.map((entry) => [entry.kind, entry.text]), [['guard', 'if (!permission) stop();']]);
  const real = findRemovedControls(patch('src/check.ts', ["throw new Error('Forbidden');", 'return res.status(403).end();']), ['src/check.ts']);
  assert.deepEqual(real.map((entry) => entry.kind), ['refusal', 'refusal']);
});

// The condition's parentheses are balanced on the code view, so a `)` inside a
// string does not end the condition before the word that makes it a guard.
test('a parenthesis inside a string does not cut the condition short', () => {
  const found = findRemovedControls(patch('src/check.ts', ["if (name.endsWith(')') && !isAdmin) return false;"]), ['src/check.ts']);
  assert.deepEqual(found.map((entry) => entry.kind), ['guard']);
});

// Netting is consumed for every line of a deleted file, cap or no cap, so the
// cap on one file's entries never hands an addition to another file's removal.
test('the deleted-file cap limits what is emitted, not what is netted', () => {
  const G = 'if (isAdmin) act();';
  const distinct = Array.from({ length: 20 }, (_, i) => `if (isAdmin${i}) act();`);
  const diff = patch('src/shared.ts', [], [G]);
  const found = findRemovedControls(diff, [], [
    { path: 'src/a.ts', text: [...distinct, G].join('\n') },
    { path: 'src/b.ts', text: G },
  ]);
  assert.equal(found.filter((entry) => entry.path === 'src/a.ts').length, 20, 'a.ts is capped');
  assert.deepEqual(found.filter((entry) => entry.path === 'src/b.ts').map((entry) => entry.text), [G], 'the one addition was spent on a.ts, so b.ts keeps its removal');
});

// A file's own move is cancelled first, and every file's removals spend the
// pool, so a guard moved within a test helper cannot cancel a production
// removal of the same text.
test('a move inside a test file does not net an unrelated production removal', () => {
  const guard = 'if (!isAdmin) return false;';
  const diff = patch('src/route.ts', [guard]) + patch('test/helper.ts', [guard], [guard]);
  const found = findRemovedControls(diff, ['src/route.ts']);
  assert.deepEqual(found.map((entry) => [entry.path, entry.kind]), [['src/route.ts', 'guard']]);
  // The same guard moved from the production file into the helper is a move.
  const moved = findRemovedControls(patch('src/route.ts', [guard]) + patch('test/helper.ts', [], [guard]), ['src/route.ts']);
  assert.deepEqual(moved, []);
});

// Without a parenthesis the condition ends where the body begins, so a word in
// the body does not make a guard, and twenty such lines do not crowd one out.
test('a Python condition ends at the colon, so a word in the body is not a guard', () => {
  const bodies = Array.from({ length: 20 }, (_, i) => `if ready${i}: print('admin')`);
  const found = findRemovedControls(patch('src/gate.py', [...bodies, 'if not permission: stop()']), ['src/gate.py']);
  assert.deepEqual(found.map((entry) => entry.text), ['if not permission: stop()']);
  const ruby = findRemovedControls(patch('src/gate.rb', ['if ready then grant_admin end', 'unless admin? then deny end']), ['src/gate.rb']);
  assert.deepEqual(ruby.map((entry) => entry.text), ['unless admin? then deny end']);
});

// A regular expression literal is blanked like a string in the script
// languages, so a keyword inside one is not a control, while a division before
// a guard on the same line leaves the guard.
test('a regex literal is not a control, and a division before a guard leaves the guard', () => {
  const literals = Array.from({ length: 20 }, (_, i) => `const example${i} = /if (isAdmin${i})/;`);
  const lines = [...literals, 'const RE = /throw|return 403 Forbidden/;', 'if (!permission) stop();'];
  const found = findRemovedControls(patch('src/check.ts', lines), ['src/check.ts']);
  assert.deepEqual(found.map((entry) => entry.text), ['if (!permission) stop();']);
  const divided = findRemovedControls(patch('src/check.ts', ['const share = total / count; if (!isAdmin) deny();']), ['src/check.ts']);
  assert.deepEqual(divided.map((entry) => entry.kind), ['guard']);
  const cls = findRemovedControls(patch('src/check.ts', ['const slashes = /[/]/; if (!isAdmin) deny();']), ['src/check.ts']);
  assert.deepEqual(cls.map((entry) => entry.kind), ['guard'], 'a slash inside a character class does not close the literal');
});
