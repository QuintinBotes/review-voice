/**
 * The fixture materialiser: every fixture becomes a two-commit repository whose
 * diff is the fixture's patch, and a patch that cannot be a diff of one file is
 * an error that names the fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHunks } from '../plugins/review-voice/src/diff/hunks.ts';
import { materializeFixture, normalisePatch } from '../plugins/review-voice/src/evaluate/fixtures.ts';
import { selectFixtures } from '../plugins/review-voice/src/evaluate/recall.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, 'fixtures');

function scratch(t, prefix = 'rv-eval-fixtures-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixtureDirs() {
  const out = [];
  for (const group of readdirSync(fixtures)) {
    const groupDir = join(fixtures, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      if (statSync(join(groupDir, name)).isDirectory()) out.push({ group, name, dir: join(groupDir, name) });
    }
  }
  return out;
}

/** Every file under `dir` with its bytes, to prove a fixture was not written to. */
function snapshot(dir, prefix = '') {
  const out = new Map();
  for (const entry of readdirSync(join(dir, prefix))) {
    const path = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(join(dir, path)).isDirectory()) for (const [key, value] of snapshot(dir, path)) out.set(key, value);
    else out.set(path, readFileSync(join(dir, path)).toString('base64'));
  }
  return out;
}

/** A throwaway fixture: `<tmp>/<group>/<name>` with the given files. */
function makeFixture(t, files, name = 'demo', group = 'positive') {
  const base = scratch(t, 'rv-eval-case-');
  const dir = join(base, group, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function readPath(repo, path) {
  return readFileSync(join(repo, path), 'utf8');
}

/**
 * Every added and removed line of every file in a patch whose hunk counts are
 * exact, which both a normalised patch and `git diff` output are, with the
 * line number each holds on its own side: an added line at its new-file number,
 * a removed line at its old-file number. Keeping the numbers is what lets two
 * diffs be compared line by line instead of by how many times a text occurs.
 */
function changedLines(patch) {
  const files = new Map();
  const lines = patch.split('\n');
  let path = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ ')) {
      const next = lines[index + 1].slice(4);
      const old = line.slice(4);
      path = next === '/dev/null' ? old.replace(/^a\//, '') : next.replace(/^b\//, '');
      if (!files.has(path)) files.set(path, { added: new Map(), removed: new Map() });
      index += 1;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header === null || path === null) continue;
    let oldLine = Number(header[1]);
    let newLine = Number(header[3]);
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    while ((oldLeft > 0 || newLeft > 0) && index + 1 < lines.length) {
      index += 1;
      const body = lines[index];
      // A no-newline marker belongs to the line above and is on neither side.
      if (body.startsWith('\\')) continue;
      if (body.startsWith('+')) {
        files.get(path).added.set(newLine, body.slice(1));
        newLine += 1;
        newLeft -= 1;
      } else if (body.startsWith('-')) {
        files.get(path).removed.set(oldLine, body.slice(1));
        oldLine += 1;
        oldLeft -= 1;
      } else {
        oldLine += 1;
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
    }
  }
  return files;
}

/** The added and removed text of every file in a patch, in patch order. */
function changedText(patch) {
  const files = new Map();
  for (const [path, { added, removed }] of changedLines(patch)) files.set(path, { added: [...added.values()], removed: [...removed.values()] });
  return files;
}

/** The lines of `path` at `rev`, or null when the revision has no such file. */
function linesAt(repo, rev, path) {
  try {
    // Stderr is piped so a new or deleted file's absence stays quiet.
    return execFileSync('git', ['show', `${rev}:${path}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n');
  } catch {
    return null;
  }
}

function byText([, left], [, right]) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Proves a materialised diff changes the same lines its patch does, line by
 * line, and returns the changes git kept as context instead of reporting.
 *
 * Comparing how many times each text is added and removed is not enough: it
 * cancels an addition against a removal wherever they sit, and says nothing
 * about a line that is missing from one diff when the other makes up for it
 * elsewhere. So each direction is checked on its own, by position:
 *
 * - Everything git reports as added or removed is added or removed by the patch
 *   at that same line number. Nothing is invented and nothing moves.
 * - Everything the patch changes that git does not report must be an unchanged
 *   line in the repository, holding the patch's text at the patch's line number
 *   in the head for an addition and in the base for a removal.
 * - Such a line exists only because the patch removes a line and adds it back
 *   unchanged, which no diff reports, so the additions git dropped and the
 *   removals git dropped are the same texts, the same number of times each.
 *
 * `patch` and `actual` are `{ added, removed }` maps from line number to text.
 */
function compareChanges(file, patch, actual, baseLines, headLines) {
  for (const [line, text] of actual.added) {
    assert.equal(patch.added.get(line), text, `${file}:${line}: git adds ${JSON.stringify(text)} where the normalised patch does not`);
  }
  for (const [line, text] of actual.removed) {
    assert.equal(patch.removed.get(line), text, `${file}:${line}: git removes ${JSON.stringify(text)} where the normalised patch does not`);
  }
  // Whatever the patch changes is where the patch says in the repository too.
  for (const [line, text] of patch.added) {
    assert.equal(headLines?.[line - 1], text, `${file}:${line}: the head does not hold the line the normalised patch adds`);
  }
  for (const [line, text] of patch.removed) {
    assert.equal(baseLines?.[line - 1], text, `${file}:${line}: the base does not hold the line the normalised patch removes`);
  }
  const keptAdded = [...patch.added].filter(([line]) => !actual.added.has(line));
  const keptRemoved = [...patch.removed].filter(([line]) => !actual.removed.has(line));
  assert.deepEqual(
    keptAdded.sort(byText).map(([, text]) => text),
    keptRemoved.sort(byText).map(([, text]) => text),
    `${file}: git dropped a change the patch makes that is not a line removed and added back unchanged`,
  );
  return { keptAdded, keptRemoved };
}

/**
 * The line of the head that git pairs with an unchanged line of the base, worked
 * out only from the changes git reported. The head line is the base line less
 * the removals before it plus the additions up to it, and which additions come
 * before it depends on where it lands, so the position is found by repeating
 * until it stops moving. It only ever moves forward, so it always stops.
 */
function headLineOf(oldLine, { added, removed }) {
  let removedBefore = 0;
  for (const line of removed.keys()) if (line < oldLine) removedBefore += 1;
  let newLine = oldLine - removedBefore;
  for (;;) {
    let addedUpTo = 0;
    for (const line of added.keys()) if (line <= newLine) addedUpTo += 1;
    const next = oldLine - removedBefore + addedUpTo;
    if (next === newLine) return newLine;
    newLine = next;
  }
}

/**
 * Proves that every change git kept as context was kept as itself: the base
 * line the patch removes is, to git, the very head line the patch adds back.
 *
 * `compareChanges` already shows that the lines git dropped are the same texts
 * on both sides. That alone would pass a patch that removes `x` in one place and
 * adds `x` somewhere unrelated, with git pairing `x` with something else. Here
 * each dropped removal is followed through git's own pairing of unchanged lines
 * to the head line it lands on, and that line must be a dropped addition of the
 * same text, so the dropped additions and removals match one to one by position.
 *
 * `kept` is what `compareChanges` returned and `actual` is what git reported.
 */
function pairKept(file, kept, actual) {
  assert.equal(kept.keptAdded.length, kept.keptRemoved.length, `${file}: git dropped a different number of additions and removals`);
  const dropped = new Map(kept.keptAdded);
  const landed = new Set();
  for (const [oldLine, text] of kept.keptRemoved) {
    const newLine = headLineOf(oldLine, actual);
    assert.equal(dropped.get(newLine), text, `${file}:${oldLine}: git pairs the removed line with head line ${newLine}, which is not the same line added back by the patch`);
    assert.equal(landed.has(newLine), false, `${file}:${newLine}: two removed lines pair with one added line`);
    landed.add(newLine);
  }
  assert.equal(landed.size, dropped.size, `${file}: an added line the patch makes and git drops is not paired with a removal`);
}

/**
 * Net occurrences of each line text: added counts up, removed counts down. Any
 * two diffs between the same pair of files have the same net, whichever lines
 * they pair up, so this compares diffs that git and the fixture author aligned
 * differently, such as a patch that removes a line and adds it back unchanged.
 */
function netChange({ added, removed }) {
  const net = new Map();
  for (const text of added) net.set(text, (net.get(text) ?? 0) + 1);
  for (const text of removed) net.set(text, (net.get(text) ?? 0) - 1);
  return new Map([...net].filter(([, count]) => count !== 0));
}

/** What `git diff` reports between the two commits, one entry per file and no rename detection. */
function materialisedDiff(repo, { base, head }) {
  return git(repo, 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', base, head);
}

const none = () => ({ added: new Map(), removed: new Map() });
const ascending = (left, right) => left - right;

/**
 * Compares the materialised diff of one fixture with its normalised patch, file
 * by file, and returns each file's `{ keptAdded, keptRemoved }`. The patch's
 * added lines must also be the added lines `parseHunks` finds in it, which ties
 * this comparison to the parser the rest of the suite relies on.
 */
function compareFixtureDiff(repo, { base, head }, normalised, gitDiff) {
  const patch = changedLines(normalised);
  const actual = changedLines(gitDiff);
  const parsed = parseHunks(normalised);
  const kept = new Map();
  for (const file of new Set([...patch.keys(), ...actual.keys()])) {
    const expected = patch.get(file) ?? none();
    assert.deepEqual([...expected.added.keys()].sort(ascending), [...(parsed.get(file)?.added ?? [])].sort(ascending), `${file}: parseHunks and the line comparison disagree about the normalised patch`);
    const reported = actual.get(file) ?? none();
    const dropped = compareChanges(file, expected, reported, linesAt(repo, base, file), linesAt(repo, head, file));
    pairKept(file, dropped, reported);
    kept.set(file, dropped);
  }
  return kept;
}

function expectation(dir) {
  const text = readFileSync(join(dir, 'case.yaml'), 'utf8');
  return { path: /^ {2}path:\s*(\S+)/m.exec(text)?.[1] ?? null, line: Number(/^ {2}line:\s*(\d+)/m.exec(text)?.[1] ?? 0) || null };
}

// ---------------------------------------------------------------------------
// normalisePatch
// ---------------------------------------------------------------------------

test('normalisePatch recounts both sides of a header from the body', () => {
  const patch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,14 +10,17 @@ function f() {', ' one', '-two', '+TWO', '+three', ' four', ''].join('\n');
  const out = normalisePatch(patch);
  assert.equal(out, ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,3 +10,4 @@ function f() {', ' one', '-two', '+TWO', '+three', ' four', ''].join('\n'));
});

test('normalisePatch counts an under-counted new side', () => {
  const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', ' keep', '+a', '+b', '+c', ''].join('\n');
  assert.match(normalisePatch(patch), /^@@ -1,1 \+1,4 @@$/m);
  assert.equal(parseHunks(normalisePatch(patch)).get('x.ts').added.size, 3);
  // Read as written, the header ends the hunk before any added line.
  assert.equal(parseHunks(patch).get('x.ts').added.size, 0);
});

test('normalisePatch ends an over-counted hunk at a bare file header', () => {
  const patch = [
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -1,5 +1,5 @@',
    ' keep',
    '-old',
    '+new',
    '--- a/src/two.ts',
    '+++ b/src/two.ts',
    '@@ -1,2 +1,2 @@',
    '-before',
    '+after',
    '',
  ].join('\n');
  const out = normalisePatch(patch);
  assert.equal(
    out,
    [
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '@@ -1,1 +1,1 @@',
      '-before',
      '+after',
      '',
    ].join('\n'),
  );
  const hunks = parseHunks(out);
  assert.deepEqual([...hunks.get('src/one.ts').added], [2]);
  assert.deepEqual([...hunks.get('src/two.ts').added], [1]);
  // Read as written, the over-counted hunk swallows the second file's headers
  // as a removed and an added line, and the second file never appears.
  assert.equal(parseHunks(patch).has('src/two.ts'), false);
});

test('normalisePatch ends a hunk at a diff --git line and keeps every file header', () => {
  const patch = [
    'diff --git a/a.ts b/a.ts',
    'index 1111111..2222222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,9 +1,9 @@',
    '-x',
    '+y',
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -1 +1 @@',
    '-p',
    '+q',
    '',
  ].join('\n');
  const out = normalisePatch(patch);
  assert.ok(out.includes('diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n'));
  assert.ok(out.includes('index 1111111..2222222 100644\n'));
  assert.match(out, /^@@ -1,1 \+1,1 @@$/m);
  assert.equal(out.match(/^@@ /gm).length, 2);
});

test('normalisePatch reads an unmarked non-blank line as context', () => {
  const patch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,4 +1,5 @@', ' first', '-return {};', '+const a = 1;', '+return { a };', '}', ' last', ''].join('\n');
  const out = normalisePatch(patch);
  assert.ok(out.includes('\n }\n last\n'), out);
  assert.match(out, /^@@ -1,4 \+1,5 @@$/m);
  // parseHunks ends the hunk at the unmarked brace, so it loses the last line.
  assert.deepEqual([...parseHunks(out).get('src/a.ts').added], [2, 3]);
});

test('normalisePatch keeps a blank context line whose space was stripped', () => {
  const patch = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,4 @@', ' top', '', ' bottom', '+added', ''].join('\n');
  assert.equal(normalisePatch(patch), ['--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,4 @@', ' top', ' ', ' bottom', '+added', ''].join('\n'));
});

test('normalisePatch drops blank separators after a hunk and keeps a counted trailing blank', () => {
  const separated = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,2 @@', ' top', '+added', '', '', ''].join('\n');
  assert.match(normalisePatch(separated), /^@@ -1,1 \+1,2 @@\n top\n\+added\n$/m);

  const counted = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@', '-one', '+ONE', ' two', '', ''].join('\n');
  assert.equal(normalisePatch(counted), ['--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@', '-one', '+ONE', ' two', ' ', ''].join('\n'));
});

test('normalisePatch keeps the section text after a header and the no-newline marker', () => {
  const patch = ['--- a/a.ts', '+++ b/a.ts', '@@ -3,1 +3,1 @@ export function f() {', '-a', '+b', '\\ No newline at end of file', ''].join('\n');
  const out = normalisePatch(patch);
  assert.match(out, /^@@ -3,1 \+3,1 @@ export function f\(\) \{$/m);
  assert.ok(out.endsWith('+b\n\\ No newline at end of file\n'));
});

test('normalisePatch is the identity on a well-formed patch and handles the empty patch', () => {
  const patch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new', ''].join('\n');
  assert.equal(normalisePatch(patch), patch);
  assert.equal(normalisePatch(''), '');
});

test('normalisePatch refuses a malformed hunk header', () => {
  assert.throws(() => normalisePatch('--- a/a.ts\n+++ b/a.ts\n@@ -x +y @@\n+z\n'), /malformed hunk header on patch line 3/);
});

test('normalisePatch never changes the fixture it reads', () => {
  for (const { dir } of fixtureDirs()) {
    const before = readFileSync(join(dir, 'diff.patch'), 'utf8');
    normalisePatch(before);
    assert.equal(readFileSync(join(dir, 'diff.patch'), 'utf8'), before);
  }
});

// ---------------------------------------------------------------------------
// materializeFixture over every fixture
// ---------------------------------------------------------------------------

const all = fixtureDirs();

test('the materialiser is exercised over a real suite', () => {
  assert.ok(all.length >= 39, `expected every fixture class, found ${all.length}`);
  for (const group of ['positive', 'negative', 'no-findings', 'prompt-injection', 'confinement']) {
    assert.ok(all.some((entry) => entry.group === group), `no ${group} fixture`);
  }
});

for (const { group, name, dir } of all) {
  test(`materialises ${group}/${name} into base and head commits`, (t) => {
    const before = snapshot(dir);
    const target = join(scratch(t), 'repo');
    const result = materializeFixture(dir, target);

    assert.deepEqual(snapshot(dir), before, 'a fixture file was modified');

    assert.equal(git(target, 'rev-list', '--count', 'HEAD').trim(), '2');
    assert.equal(git(target, 'rev-parse', 'HEAD').trim(), result.head);
    assert.equal(git(target, 'rev-parse', `${result.head}^`).trim(), result.base);
    assert.notEqual(result.base, result.head);
    assert.equal(git(target, 'status', '--porcelain').trim(), '', 'the working tree is not the head commit');
    for (const sha of [result.base, result.head]) {
      assert.equal(git(target, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', sha).trim(), 'review-voice-fixtures <fixtures@example.com>|review-voice-fixtures <fixtures@example.com>');
    }

    // Every fixture ships no configuration of its own, so each gets the
    // generated one, which turns the structure lane on beside the diff lane.
    const config = git(target, 'show', `${result.base}:.review-voice/config.yaml`);
    if (!existsSync(join(dir, 'config.yaml'))) {
      assert.match(config, /name: structure/);
      assert.match(config, /agent: structure-analyst/);
      assert.match(config, /prefix: st_/);
      assert.match(config, /min_changed_source_lines: 0/);
      assert.match(config, /exclude_kinds: \[\]/);
    }
    assert.equal(readPath(target, '.review-voice/config.yaml'), config);
    assert.ok(result.files.length > 0);
    for (const file of result.files) assert.equal(git(target, 'cat-file', '-t', `${result.head}:${file}`).trim(), 'blob', file);

    // A prompt-injection or confinement fixture is scored for absence, so for
    // those it is enough that the patch applied.
    if (group === 'prompt-injection' || group === 'confinement') return;

    const normalised = normalisePatch(readFileSync(join(dir, 'diff.patch'), 'utf8'));
    const hunks = parseHunks(normalised);
    const { path, line } = expectation(dir);
    if (path !== null && line !== null) {
      // The head holds the causal line, and the text there is the one the
      // patch adds at that line, not whatever the filler happens to put there.
      const patchLine = [...hunks.get(path).patchLines].find(([, fileLine]) => fileLine === line)?.[0];
      assert.ok(patchLine !== undefined, `${path}:${line} is not a patch line`);
      const added = normalised.split('\n')[patchLine - 1];
      assert.ok(added.startsWith('+'), `${path}:${line} is not an added line`);
      assert.equal(readPath(target, path).split('\n')[line - 1], added.slice(1));
    }

    // The materialised diff changes the same lines the normalised patch does.
    // Filler never appears in either, because the patch never touches it.
    const patchChanges = changedText(normalised);
    const gitDiff = materialisedDiff(target, result);
    const gitChanges = changedText(gitDiff);
    const gitHunks = parseHunks(gitDiff);
    for (const file of new Set([...patchChanges.keys(), ...gitChanges.keys()])) {
      const expected = netChange(patchChanges.get(file) ?? { added: [], removed: [] });
      const actual = netChange(gitChanges.get(file) ?? { added: [], removed: [] });
      assert.deepEqual([...actual].sort(), [...expected].sort(), `${file}: materialised diff differs from the normalised patch`);
      const patchAdded = hunks.get(file)?.added ?? new Set();
      for (const added of gitHunks.get(file)?.added ?? []) {
        assert.ok(patchAdded.has(added), `${file}:${added} is added in the repository but not by the normalised patch`);
      }
    }

    // The checks above compare net text, which cancels an addition against a
    // removal. The exact comparison is in `compareChanges`, line by line.
    compareFixtureDiff(target, result, normalised, gitDiff);
  });
}

// ---------------------------------------------------------------------------
// The line-by-line comparison of the materialised diff with the normalised patch
// ---------------------------------------------------------------------------

test('a patch that removes lines and adds them back is context in git, accounted for one for one', (t) => {
  const dir = join(fixtures, 'positive/transaction-ordering');
  const target = join(scratch(t), 'repo');
  const result = materializeFixture(dir, target);
  const normalised = normalisePatch(readFileSync(join(dir, 'diff.patch'), 'utf8'));
  const kept = compareFixtureDiff(target, result, normalised, materialisedDiff(target, result)).get('src/auth/session.ts');

  // The patch removes `const token = ...` and `res.json(...)` and adds each back
  // unchanged, and git keeps whichever it can match as unchanged context.
  const patch = changedText(normalised).get('src/auth/session.ts');
  assert.ok(kept.keptAdded.length > 0, 'the fixture no longer removes and re-adds an unchanged line');
  assert.equal(kept.keptAdded.length, kept.keptRemoved.length);
  for (const [, text] of [...kept.keptAdded, ...kept.keptRemoved]) {
    assert.ok(patch.added.includes(text) && patch.removed.includes(text), `${JSON.stringify(text)} is not both removed and added by the patch`);
  }
  // What git does report is the rest of the change, at the patch's own lines.
  const reported = changedLines(materialisedDiff(target, result)).get('src/auth/session.ts');
  assert.ok(reported.added.size > 0 && reported.removed.size > 0);
  assert.ok(reported.added.size < changedLines(normalised).get('src/auth/session.ts').added.size);
});

test('the line comparison accepts a diff that is the patch, line for line', () => {
  const patch = { added: new Map([[2, 'new']]), removed: new Map([[2, 'old']]) };
  const kept = compareChanges('f.ts', patch, patch, ['a', 'old', 'c'], ['a', 'new', 'c']);
  assert.deepEqual(kept, { keptAdded: [], keptRemoved: [] });
});

test('the line comparison rejects an addition git does not report when nothing was removed to match it', () => {
  const patch = { added: new Map([[2, 'new']]), removed: new Map() };
  assert.throws(() => compareChanges('f.ts', patch, none(), ['a'], ['a', 'new']), /f\.ts: git dropped a change the patch makes/);
});

test('the line comparison rejects a removal git reports at a line the patch does not remove, though the net text is equal', () => {
  const patch = { added: new Map(), removed: new Map([[2, 'x']]) };
  const actual = { added: new Map(), removed: new Map([[5, 'x']]) };
  // Both remove one `x`, so a net count of text cannot tell them apart.
  assert.throws(() => compareChanges('f.ts', patch, actual, ['a', 'x', 'c', 'd', 'x'], ['a', 'c', 'd']), /f\.ts:5: git removes "x" where the normalised patch does not/);
});

test('the line comparison rejects an addition git reports at a line the patch does not add', () => {
  const patch = { added: new Map([[2, 'x']]), removed: new Map() };
  const actual = { added: new Map([[3, 'x']]), removed: new Map() };
  assert.throws(() => compareChanges('f.ts', patch, actual, ['a', 'b'], ['a', 'x', 'x']), /f\.ts:3: git adds "x" where the normalised patch does not/);
});

test('the line comparison rejects a re-added line that the head does not hold, though the removal cancels it in net text', () => {
  // The patch removes `x` at line 2 and adds it back at line 5; git reports
  // neither, as it would for an unchanged line. The head has no `x` at line 5,
  // so the patch was not applied as written, which a net count of `x` cannot see.
  const patch = { added: new Map([[5, 'x']]), removed: new Map([[2, 'x']]) };
  assert.equal(netChange({ added: ['x'], removed: ['x'] }).size, 0);
  assert.throws(() => compareChanges('f.ts', patch, none(), ['a', 'x'], ['a', 'b', 'c', 'd', 'y']), /f\.ts:5: the head does not hold the line the normalised patch adds/);
});

test('the line comparison rejects a removed line that the base does not hold', () => {
  const patch = { added: new Map(), removed: new Map([[2, 'x']]) };
  assert.throws(() => compareChanges('f.ts', patch, none(), ['a', 'y'], ['a']), /f\.ts:2: the base does not hold the line the normalised patch removes/);
});

test('the line comparison rejects text dropped a different number of times on each side', () => {
  const patch = { added: new Map([[2, 'x'], [4, 'x']]), removed: new Map([[3, 'x']]) };
  assert.throws(() => compareChanges('f.ts', patch, none(), ['a', 'b', 'x'], ['a', 'x', 'b', 'x']), /f\.ts: git dropped a change the patch makes/);
});

test('the line comparison accepts the same text dropped on both sides, wherever the lines sit', () => {
  const patch = { added: new Map([[4, 'x']]), removed: new Map([[2, 'x']]) };
  const kept = compareChanges('f.ts', patch, none(), ['a', 'x', 'c'], ['a', 'c', 'd', 'x']);
  assert.deepEqual(kept, { keptAdded: [[4, 'x']], keptRemoved: [[2, 'x']] });
});

// ---------------------------------------------------------------------------
// Exact equality of the materialised diff with the normalised patch
// ---------------------------------------------------------------------------

const sorted = (map) => [...map].sort(([left], [right]) => left - right);

// These two patches remove a line and add the same line back elsewhere in one
// hunk, so git matches the two as one unchanged line and reports neither. They
// are the only fixtures where the materialised diff is smaller than the patch.
const readding = new Set(['no-findings/formatting-only', 'positive/transaction-ordering']);

test('git reports exactly the lines the normalised patch adds and removes, at the same line numbers, in every scored fixture', (t) => {
  const withDropped = [];
  for (const { group, name, dir } of all) {
    if (group === 'prompt-injection' || group === 'confinement') continue;
    const label = `${group}/${name}`;
    const target = join(scratch(t), 'repo');
    const result = materializeFixture(dir, target);
    const normalised = normalisePatch(readFileSync(join(dir, 'diff.patch'), 'utf8'));
    const patch = changedLines(normalised);
    const actual = changedLines(materialisedDiff(target, result));

    for (const file of new Set([...patch.keys(), ...actual.keys()])) {
      const expected = patch.get(file) ?? none();
      const reported = actual.get(file) ?? none();
      // Each direction on its own: an addition cannot make up for a removal.
      if (!readding.has(label)) {
        assert.deepEqual(sorted(reported.added), sorted(expected.added), `${label} ${file}: the added lines differ`);
        assert.deepEqual(sorted(reported.removed), sorted(expected.removed), `${label} ${file}: the removed lines differ`);
        continue;
      }
      // Everything git reports is in the patch at the same line, and what it
      // does not report is accounted for one for one by `pairKept`.
      for (const [line, text] of reported.added) assert.equal(expected.added.get(line), text, `${label} ${file}:${line}: an added line the patch does not make`);
      for (const [line, text] of reported.removed) assert.equal(expected.removed.get(line), text, `${label} ${file}:${line}: a removed line the patch does not make`);
      const dropped = compareChanges(file, expected, reported, linesAt(target, result.base, file), linesAt(target, result.head, file));
      pairKept(file, dropped, reported);
      if (dropped.keptAdded.length > 0) withDropped.push(label);
    }
  }
  assert.deepEqual([...new Set(withDropped)].sort(), [...readding].sort());
});

test('every positive anchors on a line git reports as added once the fixture is built, not only on one the patch adds', (t) => {
  // A line the patch removes and adds back unchanged comes out of git as context;
  // check-candidates refuses an anchor there, so such a fixture could never score.
  let checked = 0;
  let further = 0;
  // Read by the harness, so the anchors checked are the ones a recall run scores against.
  for (const { dir, expectation: { class: group, name, path, line, anchors } } of selectFixtures({ fixtures, classes: ['positive'], only: null })) {
    if (path === null || line === null) continue;
    const target = join(scratch(t), 'repo');
    const result = materializeFixture(dir, target);
    const reported = parseHunks(materialisedDiff(target, result));
    // The accepted anchors of expect.anchors are held to the same check as expect.line.
    for (const [key, anchor] of [['expect.line', { path, line }], ...anchors.map((anchor) => ['expect.anchors', anchor])]) {
      const added = reported.get(anchor.path)?.added ?? new Set();
      assert.ok(added.has(Number(anchor.line)), `${group}/${name}: ${key} ${anchor.path}:${anchor.line} is not an added line of the diff git reports (${[...added].sort((a, b) => a - b).join(',')})`);
    }
    checked += 1;
    further += anchors.length;
  }
  assert.ok(checked >= 19, `expected every positive with a path to be checked, found ${checked}`);
  assert.ok(further >= 4, `expected the accepted anchors of issue 340 to be checked, found ${further}`);
});

test('a line git pairs with a removed line is found from what git reported', (t) => {
  // What git reports for transaction-ordering: line 12 of the base is replaced
  // by new lines 12 and 13, and two more lines are added at 15 and 16. It is
  // read from the built fixture, because written out here it went stale when
  // the fixture's hunk moved.
  const target = join(scratch(t), 'repo');
  const built = materializeFixture(join(fixtures, 'positive/transaction-ordering'), target);
  const actual = changedLines(materialisedDiff(target, built)).get('src/auth/session.ts');
  assert.deepEqual([...actual.added.keys()].sort(ascending), [12, 13, 15, 16]);
  assert.deepEqual([...actual.removed.keys()], [12]);
  assert.equal(headLineOf(10, actual), 10);
  assert.equal(headLineOf(11, actual), 11);
  assert.equal(headLineOf(13, actual), 14);
  assert.equal(headLineOf(14, actual), 17);
  // With nothing reported every line stays where it is, and an insertion shifts what follows.
  assert.equal(headLineOf(7, none()), 7);
  assert.equal(headLineOf(2, { added: new Map([[2, 'x']]), removed: new Map() }), 3);
  assert.equal(headLineOf(2, { added: new Map(), removed: new Map([[1, 'x']]) }), 1);
});

test('the pairing accepts a removal and an addition that git matched as one unchanged line', () => {
  const actual = { added: new Map([[2, 'new']]), removed: new Map([[2, 'old']]) };
  // Base line 3 is head line 3, and the patch removes it at 3 and adds it at 3.
  assert.doesNotThrow(() => pairKept('f.ts', { keptAdded: [[3, 'x']], keptRemoved: [[3, 'x']] }, actual));
  // An insertion before it moves it: base line 2 is head line 3.
  const inserted = { added: new Map([[2, 'y']]), removed: new Map() };
  assert.doesNotThrow(() => pairKept('f.ts', { keptAdded: [[3, 'x']], keptRemoved: [[2, 'x']] }, inserted));
});

test('the pairing rejects a removal and an addition of the same text that git did not match to each other', () => {
  // Both texts are `x`, once removed and once added, so counting texts is satisfied.
  // But git reports nothing, so base line 2 is head line 2 and not the added 5.
  const kept = { keptAdded: [[5, 'x']], keptRemoved: [[2, 'x']] };
  assert.throws(() => pairKept('f.ts', kept, none()), /f\.ts:2: git pairs the removed line with head line 2, which is not the same line added back/);
});

test('the pairing rejects dropped additions and removals that do not come in equal numbers', () => {
  assert.throws(() => pairKept('f.ts', { keptAdded: [[2, 'x'], [4, 'x']], keptRemoved: [[2, 'x']] }, none()), /f\.ts: git dropped a different number of additions and removals/);
});

// A no-newline marker is about the line above it. Which file that is decides
// whether the base or the head ends without a newline, and a base written with
// the wrong ending is one `git apply` refuses.
const marker = '\\ No newline at end of file';
const noNewlineShapes = [
  {
    name: 'on a removed line, so only the base lacks a final newline',
    body: [' one', '-two', marker, '+two'],
    base: 'one\ntwo',
    head: 'one\ntwo\n',
  },
  {
    name: 'on an added line, so only the head lacks a final newline',
    body: [' one', '-two', '+TWO', marker],
    base: 'one\ntwo\n',
    head: 'one\nTWO',
  },
  {
    name: 'on a context line, so neither side has a final newline',
    body: ['-one', '+ONE', ' two', marker],
    base: 'one\ntwo',
    head: 'ONE\ntwo',
  },
];

for (const { name, body, base, head } of noNewlineShapes) {
  test(`a no-newline marker ${name}, and the diff is still the patch line for line`, (t) => {
    const dir = makeFixture(t, {
      'case.yaml': 'name: demo\nasserts: "x"\nexpect:\n  findings: 1\n',
      'diff.patch': ['--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,2 @@', ...body, ''].join('\n'),
    });
    const target = join(scratch(t), 'repo');
    const result = materializeFixture(dir, target);
    assert.equal(git(target, 'show', `${result.base}:f.ts`), base);
    assert.equal(git(target, 'show', `${result.head}:f.ts`), head);
    const normalised = normalisePatch(readFileSync(join(dir, 'diff.patch'), 'utf8'));
    compareFixtureDiff(target, result, normalised, materialisedDiff(target, result));
  });
}

test('the line reader skips a no-newline marker instead of counting it as a line', () => {
  const diff = ['--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,3 @@', '-a', '\\ No newline at end of file', '+b', '+c', ' d', ''].join('\n');
  const { added, removed } = changedLines(diff).get('f.ts');
  assert.deepEqual([...added], [[1, 'b'], [2, 'c']]);
  assert.deepEqual([...removed], [[1, 'a']]);
});

// ---------------------------------------------------------------------------
// materializeFixture on purpose-built fixtures
// ---------------------------------------------------------------------------

test('the base is rebuilt from context and removed lines at their old-side numbers, with filler between', (t) => {
  const dir = makeFixture(t, {
    'case.yaml': 'name: demo\nasserts: "x"\nexpect:\n  output: "No actionable findings."\n',
    'diff.patch': [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -3,3 +3,3 @@',
      ' three',
      '-four',
      '+FOUR',
      ' five',
      '@@ -8,2 +8,3 @@',
      ' eight',
      '-nine',
      '+nine!',
      '+ten',
      '--- a/ops/run.yml',
      '+++ b/ops/run.yml',
      '@@ -2,1 +2,1 @@',
      '-b',
      '+B',
      '',
    ].join('\n'),
  });
  const target = join(scratch(t), 'repo');
  const { base, head, files } = materializeFixture(dir, target);
  assert.deepEqual(files, ['src/app.ts', 'ops/run.yml']);
  assert.equal(git(target, 'show', `${base}:src/app.ts`), ['// filler', '// filler', 'three', 'four', 'five', '// filler', '// filler', 'eight', 'nine', ''].join('\n'));
  assert.equal(git(target, 'show', `${base}:ops/run.yml`), ['# filler', 'b', ''].join('\n'));
  assert.equal(git(target, 'show', `${head}:src/app.ts`), ['// filler', '// filler', 'three', 'FOUR', 'five', '// filler', '// filler', 'eight', 'nine!', 'ten', ''].join('\n'));
});

test('a new file has no base version and a deleted file has no head version', (t) => {
  const dir = makeFixture(t, {
    'case.yaml': 'name: demo\nasserts: "x"\nexpect:\n  findings: 1\n',
    'diff.patch': ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+a', '+b', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y', ''].join('\n'),
  });
  const target = join(scratch(t), 'repo');
  const { base, head, files } = materializeFixture(dir, target);
  assert.deepEqual(files, ['src/new.ts', 'src/gone.ts']);
  assert.throws(() => git(target, 'cat-file', '-e', `${base}:src/new.ts`));
  assert.equal(git(target, 'show', `${head}:src/new.ts`), 'a\nb\n');
  assert.equal(git(target, 'show', `${base}:src/gone.ts`), 'x\ny\n');
  assert.throws(() => git(target, 'cat-file', '-e', `${head}:src/gone.ts`));
});

test('a context file replaces the reconstruction, and other context files are in the base', (t) => {
  const dir = makeFixture(t, {
    'case.yaml': 'name: demo\nasserts: "x"\nexpect:\n  findings: 1\n',
    'diff.patch': ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -2,3 +2,3 @@', ' two', '-three', '+THREE', ' four', ''].join('\n'),
    'context/src/app.ts': 'one\ntwo\nthree\nfour\n',
    'context/src/other.ts': 'unrelated\n',
  });
  const target = join(scratch(t), 'repo');
  const { base, head } = materializeFixture(dir, target);
  assert.equal(git(target, 'show', `${base}:src/app.ts`), 'one\ntwo\nthree\nfour\n');
  assert.equal(git(target, 'show', `${base}:src/other.ts`), 'unrelated\n');
  assert.equal(git(target, 'show', `${head}:src/app.ts`), 'one\ntwo\nTHREE\nfour\n');
});

test('a fixture-root config.yaml is copied into the base instead of the generated one', (t) => {
  const config = 'review:\n  mode: thorough\n';
  const dir = makeFixture(t, {
    'case.yaml': 'name: demo\nasserts: "x"\nexpect:\n  findings: 1\n',
    'diff.patch': ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'),
    'config.yaml': config,
  });
  const target = join(scratch(t), 'repo');
  const { base } = materializeFixture(dir, target);
  assert.equal(git(target, 'show', `${base}:.review-voice/config.yaml`), config);
});

test('the commits carry the fixture identity whatever the operator has configured', (t) => {
  const dir = makeFixture(t, {
    'case.yaml': 'name: demo\nasserts: "x"\nexpect:\n  findings: 1\n',
    'diff.patch': ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'),
  });
  const saved = { name: process.env.GIT_AUTHOR_NAME, email: process.env.GIT_AUTHOR_EMAIL };
  process.env.GIT_AUTHOR_NAME = 'Someone Real';
  process.env.GIT_AUTHOR_EMAIL = 'someone@example.org';
  t.after(() => {
    for (const [key, value] of [['GIT_AUTHOR_NAME', saved.name], ['GIT_AUTHOR_EMAIL', saved.email]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const target = join(scratch(t), 'repo');
  const { head } = materializeFixture(dir, target);
  assert.equal(git(target, 'log', '-1', '--format=%an <%ae>', head).trim(), 'review-voice-fixtures <fixtures@example.com>');
});

test('the same fixture materialises to the same commits twice', (t) => {
  const dir = join(fixtures, 'positive/transaction-ordering');
  const first = materializeFixture(dir, join(scratch(t), 'a'));
  const second = materializeFixture(dir, join(scratch(t), 'b'));
  assert.deepEqual(second, first);
});

// ---------------------------------------------------------------------------
// materializeFixture errors
// ---------------------------------------------------------------------------

test('hunks that contradict each other name the fixture', (t) => {
  const dir = makeFixture(
    t,
    {
      'case.yaml': 'name: contradiction-demo\nasserts: "x"\nexpect:\n  findings: 1\n',
      'diff.patch': ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO', '@@ -2,1 +2,1 @@', '-something else', '+x', ''].join('\n'),
    },
    'contradiction-demo',
  );
  assert.throws(() => materializeFixture(dir, join(scratch(t), 'repo')), (error) => {
    assert.match(error.message, /positive\/contradiction-demo/);
    assert.match(error.message, /a\.ts line 2/);
    return true;
  });
});

test('a context file that contradicts the patch names the fixture', (t) => {
  const dir = makeFixture(
    t,
    {
      'case.yaml': 'name: stale-context\nasserts: "x"\nexpect:\n  findings: 1\n',
      'diff.patch': ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO', ''].join('\n'),
      'context/src/a.ts': 'one\nsomething different\n',
    },
    'stale-context',
  );
  assert.throws(() => materializeFixture(dir, join(scratch(t), 'repo')), /positive\/stale-context.*src\/a\.ts line 2/s);
});

test('a patch git cannot apply to the reconstructed pre-image names the fixture', (t) => {
  // The new file is declared as a change to a file the base does not contain.
  const dir = makeFixture(
    t,
    {
      'case.yaml': 'name: unappliable\nasserts: "x"\nexpect:\n  findings: 1\n',
      'diff.patch': ['--- /dev/null', '+++ b/src/a.ts', '@@ -0,0 +1,1 @@', '+one', ''].join('\n'),
      'context/src/a.ts': 'already here\n',
    },
    'unappliable',
  );
  assert.throws(() => materializeFixture(dir, join(scratch(t), 'repo')), /positive\/unappliable/);
});

test('the error names the fixture given in the options when there is one', (t) => {
  const dir = makeFixture(t, {
    'case.yaml': 'name: x\nasserts: "x"\nexpect:\n  findings: 1\n',
    'diff.patch': ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', ' one', '@@ -1,1 +1,1 @@', ' two', ''].join('\n'),
  });
  assert.throws(() => materializeFixture(dir, join(scratch(t), 'repo'), { name: 'custom/label' }), /custom\/label: a\.ts line 1/);
});

test('a patch path that leaves the repository is refused and nothing is written outside it', (t) => {
  const outer = scratch(t);
  const target = join(outer, 'work', 'repo');
  for (const header of ['b/../../escape.txt', '/etc/escape.txt', 'b/.git/hooks/pre-commit', 'b/sub/../../escape.txt', 'b/C:/escape.txt', 'b/a\\..\\escape.txt']) {
    const dir = makeFixture(
      t,
      {
        'case.yaml': 'name: traversal\nasserts: "x"\nexpect:\n  findings: 1\n',
        'diff.patch': ['--- /dev/null', `+++ ${header}`, '@@ -0,0 +1,1 @@', '+owned', ''].join('\n'),
      },
      'traversal',
    );
    assert.throws(() => materializeFixture(dir, target), /positive\/traversal.*not a repository-relative path/s, header);
    assert.equal(existsSync(join(outer, 'escape.txt')), false);
    assert.equal(existsSync(join(outer, 'work', 'escape.txt')), false);
    rmSync(join(outer, 'work'), { recursive: true, force: true });
  }
  // The old side is checked too, because the base writes there.
  const old = makeFixture(t, {
    'case.yaml': 'name: traversal\nasserts: "x"\nexpect:\n  findings: 1\n',
    'diff.patch': ['--- a/../../escape.txt', '+++ b/ok.txt', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'),
  });
  assert.throws(() => materializeFixture(old, join(outer, 'old-side', 'repo')), /not a repository-relative path/);
  assert.equal(existsSync(join(outer, 'escape.txt')), false);
});

test('a symbolic link under context/ is refused', (t) => {
  const dir = makeFixture(t, {
    'case.yaml': 'name: link\nasserts: "x"\nexpect:\n  findings: 1\n',
    'diff.patch': ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'),
    'context/placeholder.txt': 'x\n',
  });
  execFileSync('ln', ['-s', '/etc/hosts', join(dir, 'context/link.txt')]);
  assert.throws(() => materializeFixture(dir, join(scratch(t), 'repo')), /positive\/demo.*context\/link\.txt is a symbolic link/s);
});

test('a target directory that already holds files is refused untouched', (t) => {
  const dir = makeFixture(t, {
    'case.yaml': 'name: demo\nasserts: "x"\nexpect:\n  findings: 1\n',
    'diff.patch': ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'),
  });
  const target = scratch(t);
  writeFileSync(join(target, 'keep.txt'), 'mine');
  assert.throws(() => materializeFixture(dir, target), /positive\/demo.*not empty/s);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'mine');
  assert.equal(existsSync(join(target, '.git')), false);
});

test('a fixture with no diff.patch is an error that names it', (t) => {
  const dir = makeFixture(t, { 'case.yaml': 'name: demo\n' }, 'no-patch');
  assert.throws(() => materializeFixture(dir, join(scratch(t), 'repo')), /positive\/no-patch: fixture has no diff\.patch/);
});
