/**
 * #389: branchGrowth named a statement of a shell script as a function, and
 * attributed a line past a function's closing brace to that function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countHunks } from '../plugins/review-voice/src/diff/complexity.ts';

function scopes(path, lines, start = 1) {
  const oldCount = lines.filter((l) => !l.startsWith('+')).length;
  const newCount = lines.filter((l) => !l.startsWith('-')).length;
  const diff = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${oldCount} +${start},${newCount} @@`, ...lines, ''].join('\n');
  return countHunks(diff, new Set([path])).flatMap((hunk) => hunk.branches.map((branch) => [branch.line, branch.scope]));
}

test('in a shell script only a function is a scope, and a statement never is', () => {
  const lines = [
    ' probe() {  # probe <agent>',
    '+  if [ -z "$1" ]; then return 1; fi',
    ' }',
    ' why=$(probe "$agent") || die "$why" 4',
    ' main "$@"',
    '+if [ -n "$why" ]; then echo "$why"; fi',
  ];
  assert.deepEqual(scopes('bin/check.sh', lines), [
    [2, 'probe() {  # probe <agent>'],
    [6, null],
  ]);
});

test('a script with no extension is a shell script when the diff shows its shebang', () => {
  const lines = ['+#!/usr/bin/env bash', '+main "$@"', '+if [ -n "$why" ]; then exit 4; fi'];
  assert.deepEqual(scopes('bin/check', lines), [[3, null]]);
});

test('past a closing brace in the first column the scope ends, in any language', () => {
  const lines = [' function first() {', '+  if (a) {}', ' }', '+if (b) {}'];
  assert.deepEqual(scopes('src/a.ts', lines), [
    [2, 'function first() {'],
    [4, null],
  ]);
});

test('an assignment with no space is not a declaration', () => {
  const lines = [' function first() {', ' }', ' retries=3', '+if (b) {}'];
  assert.deepEqual(scopes('src/tool', lines), [[4, null]]);
});
