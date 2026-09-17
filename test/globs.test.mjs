import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frontmatterPaths,
  globToRegExp,
  governsAny,
  pointerTarget,
} from '../plugins/review-voice/src/conventions/globs.ts';

// A repository declaring which paths a rule governs is the repository saying
// when the rule applies. Ranking by directory proximity instead sent a 14 KB
// semaphore guide to a pull request with no semaphores, and dropped every rule
// whose glob matched the changed files.

const POINTER = `---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---
@.agents/rules/routing.md`;

test('declared paths are read from frontmatter', () => {
  assert.deepEqual(frontmatterPaths(POINTER), ['**/*.ts', '**/*.tsx']);
});

test('the inline list form is read too', () => {
  assert.deepEqual(frontmatterPaths('---\npaths: ["src/**/*.cs", "*.sln"]\n---\nbody'), [
    'src/**/*.cs',
    '*.sln',
  ]);
});

test('a document with no frontmatter declares nothing', () => {
  assert.deepEqual(frontmatterPaths('# A rule\n\nSome guidance.'), []);
});

test('another key ends the path list', () => {
  assert.deepEqual(frontmatterPaths('---\npaths:\n  - "a/*.ts"\nname: routing\n---\n'), ['a/*.ts']);
});

test('globs compile to the right shapes', () => {
  assert.equal(globToRegExp('**/*.tsx').test('packages/app/src/A.tsx'), true);
  assert.equal(globToRegExp('**/*.tsx').test('A.tsx'), true, '**/ must match zero directories');
  assert.equal(globToRegExp('**/*.tsx').test('packages/app/src/A.ts'), false);
  assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/nested/a.ts'), false, '* must not cross a separator');
  assert.equal(globToRegExp('a.b.ts').test('axbxts'), false, 'dots are literal');
});

test('a rule governs a change when any glob matches', () => {
  const globs = frontmatterPaths(POINTER);
  assert.equal(governsAny(globs, ['packages/commander/src/Grid.tsx']), true);
  assert.equal(governsAny(globs, ['docs/readme.md']), false);
  assert.equal(governsAny([], ['a.tsx']), false);
  assert.equal(governsAny(globs, []), false);
});

test('a bare pattern matches at any depth, the way these files write it', () => {
  assert.equal(governsAny(['*.tsx'], ['packages/app/src/A.tsx']), true);
});

test('a pointer file names the document that holds the rule', () => {
  assert.equal(pointerTarget(POINTER), '.agents/rules/routing.md');
});

test('a document with real content is not a pointer', () => {
  assert.equal(pointerTarget('---\npaths:\n  - "*.ts"\n---\nHandlers validate first.'), null);
  assert.equal(pointerTarget('Just prose.'), null);
});
