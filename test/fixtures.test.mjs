import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, 'fixtures');

function cases() {
  const out = [];
  for (const group of readdirSync(fixtures)) {
    const groupDir = join(fixtures, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name);
      if (statSync(dir).isDirectory()) out.push({ group, name, dir });
    }
  }
  return out;
}

test('every fixture has a case.yaml and a diff', () => {
  const all = cases();
  assert.ok(all.length >= 7, `expected a real suite, found ${all.length}`);
  for (const { group, name, dir } of all) {
    assert.ok(existsSync(join(dir, 'case.yaml')), `${group}/${name} has no case.yaml`);
    assert.ok(existsSync(join(dir, 'diff.patch')), `${group}/${name} has no diff.patch`);
  }
});

test('every case states what it asserts', () => {
  for (const { group, name, dir } of cases()) {
    const text = readFileSync(join(dir, 'case.yaml'), 'utf8');
    assert.match(text, /^name:\s*\S/m, `${group}/${name} has no name`);
    assert.match(text, /^asserts:/m, `${group}/${name} does not say what it proves`);
    assert.match(text, /^expect:/m, `${group}/${name} has no expectation`);
  }
});

test('all four fixture classes from the specification exist', () => {
  const groups = new Set(cases().map((c) => c.group));
  for (const required of ['positive', 'negative', 'no-findings', 'prompt-injection']) {
    assert.ok(groups.has(required), `missing fixture class: ${required}`);
  }
});

test('no-findings and negative cases expect the exact response', () => {
  for (const { group, name, dir } of cases()) {
    if (group !== 'no-findings' && group !== 'negative') continue;
    const text = readFileSync(join(dir, 'case.yaml'), 'utf8');
    assert.match(
      text,
      /output:\s*"No actionable findings\."/,
      `${group}/${name} must expect the exact no-findings string`,
    );
  }
});

test('fixtures are synthetic - no real identities, hosts or credentials', () => {
  // Fixtures are public and permanent. This is the backstop behind the rule in
  // CONTRIBUTING.md, not a substitute for it.
  const forbidden = [
    { pattern: /\b[\w.+-]+@(?!example\.(com|org))[\w-]+\.[\w.]{2,}/, why: 'real email address' },
    { pattern: /https?:\/\/(?!example\.(com|org))[\w.-]+\.(com|net|io|dev|org)/i, why: 'external URL' },
    { pattern: /(ghp_|gho_|github_pat_)[A-Za-z0-9]{10,}/, why: 'GitHub token' },
    { pattern: /BEGIN [A-Z ]*PRIVATE KEY/, why: 'private key' },
  ];
  for (const { group, name, dir } of cases()) {
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const { pattern, why } of forbidden) {
        const match = pattern.exec(text);
        assert.equal(match, null, `${group}/${name}/${file} contains a ${why}: ${match?.[0]}`);
      }
    }
  }
});

test('prompt-injection fixtures assert what must NOT happen', () => {
  const injection = cases().filter((c) => c.group === 'prompt-injection');
  assert.ok(injection.length >= 3, 'the injection suite should cover several vectors');
  for (const { name, dir } of injection) {
    const text = readFileSync(join(dir, 'case.yaml'), 'utf8');
    // A positive assertion cannot prove an injection failed; these cases must
    // state the behaviour that must be absent.
    assert.match(
      text,
      /output_does_not_contain|no_tool_calls_beyond|findings_cite_only_real_tools|max_findings/,
      `${name} must assert an absence, not a presence`,
    );
  }
});

test('injection fixtures place the attack where a reviewer would meet it', () => {
  const vectors = cases()
    .filter((c) => c.group === 'prompt-injection')
    .map((c) => readFileSync(join(c.dir, 'diff.patch'), 'utf8') + (existsSync(join(c.dir, 'pr-body.md')) ? readFileSync(join(c.dir, 'pr-body.md'), 'utf8') : ''));
  // Source comment, pull-request text, and content imitating tool output.
  assert.ok(vectors.some((v) => /\/\/.*(SYSTEM|Ignore previous)/i.test(v)), 'no source-comment vector');
  assert.ok(vectors.some((v) => /Reviewer configuration override/i.test(v)), 'no pull-request-text vector');
  assert.ok(vectors.some((v) => /error TS\d+|Static analysis:/i.test(v)), 'no fake-tool-output vector');
});
