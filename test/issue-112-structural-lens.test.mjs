import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const analyst = read('plugins/review-voice/agents/diff-analyst.md');
const verifier = read('plugins/review-voice/agents/evidence-verifier.md');

const patterns = [
  ['structural-thin-wrapper', 'maintainability'],
  ['structural-mode-parameter', 'maintainability'],
  ['structural-copied-logic', 'maintainability'],
  ['structural-serialized-awaits', 'performance'],
  ['structural-shared-module', 'maintainability'],
  ['structural-silent-fallback', 'maintainability'],
];

test('the analyst and verifier hold structural findings to verifiable evidence', () => {
  for (const prompt of [analyst, verifier]) {
    for (const pattern of [
      'thin pass-through wrapper',
      'one-off boolean or mode',
      'copied logic',
      'independent serialized awaits',
      'feature logic in a shared module',
      'silent fallback',
    ]) {
      assert.ok(prompt.toLowerCase().includes(pattern), `${pattern} is missing from a structural prompt`);
    }
    assert.match(prompt, /and so/);
    assert.match(prompt, /nameable consequence/);
    assert.match(prompt, /`maintainability`/);
    assert.match(prompt, /`performance`/);
  }
});

test('each structural pattern has the evidence its verifier must trace', () => {
  for (const [prompt, evidence] of [
    [
      analyst,
      [
        /one delegating\s+call with the same arguments/,
        /new parameter\s+and every existing call site/,
        /two added blocks that differ only in literals or names/,
        /sequential awaits whose expressions do not use the earlier result/,
        /branch and its other consumers\s+that do not need it/,
        /value every caller sets/,
      ],
    ],
    [
      verifier,
      [
        /one delegation\s+to the cited target with the same arguments/,
        /signature adds the cited\s+parameter and that every cited existing call site now passes it/,
        /two added blocks[\s\S]*structure differs solely in literals or names/,
        /sequential await expressions[\s\S]*no data dependency/,
        /named other consumers[\s\S]*neither select nor need the branch/,
        /through every caller and confirm each establishes the claimed value/,
      ],
    ],
  ]) {
    const normalised = prompt.replace(/\s+/g, ' ');
    for (const requirement of evidence) assert.match(normalised, requirement);
  }
});

test('structural fixtures cover each pattern and a direct-change restraint', () => {
  for (const [name, category] of patterns) {
    const dir = join(root, 'fixtures/positive', name);
    assert.ok(existsSync(join(dir, 'diff.patch')), `${name} has no diff`);
    const fixture = readFileSync(join(dir, 'case.yaml'), 'utf8');
    assert.match(fixture, /^  findings: 1$/m, `${name} must expect one finding`);
    assert.match(fixture, /^  verified: true$/m, `${name} must expect verification`);
    assert.match(fixture, new RegExp(`^  category: ${category}$`, 'm'));
  }

  const restraint = read('fixtures/no-findings/structural-direct-change/case.yaml');
  assert.match(restraint, /output:\s*"No actionable findings\."/);
});

test('fixtures that need repository evidence include it as context', () => {
  for (const name of ['structural-shared-module', 'structural-silent-fallback']) {
    const context = join(root, 'fixtures/positive', name, 'context');
    assert.ok(existsSync(context), `${name} has no repository context`);
  }
});
