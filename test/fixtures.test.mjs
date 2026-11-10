import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHunks } from '../plugins/review-voice/src/diff/hunks.ts';
import { normalisePatch } from '../plugins/review-voice/src/evaluate/fixtures.ts';

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

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out;
}

/**
 * Reads the keys the harness needs by line matching, as the rest of this file
 * does, so the test needs no YAML parser. `path` and `line` are the two-space
 * indented keys of `expect:`; `harness` is a top-level key.
 */
function readExpectation(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^expect:/.test(line));
  const block = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (line !== '' && !/^\s/.test(line)) break;
    block.push(line);
  }
  const key = (name) => block.map((line) => new RegExp(`^  ${name}:\\s*(\\S.*?)\\s*$`).exec(line)).find(Boolean)?.[1] ?? null;
  const harness = /^harness:\s*(\S+)/m.exec(text)?.[1] ?? null;
  return { path: key('path'), line: key('line'), harness };
}

/** What the fixture annotations must satisfy, as problems; an empty list is a pass. */
function annotationProblems(group, expectation, patchText) {
  const { path, line, harness } = expectation;
  const problems = [];
  if (line !== null && path === null) problems.push('has a line but no path');
  if (line !== null && group !== 'positive') problems.push('is not a positive fixture but names a line');
  if (group === 'positive') {
    if (path !== null && line === null) problems.push('names a path but no line');
    if (path === null && harness !== 'skip') problems.push('has no path and is not marked harness: skip');
  }
  if (path !== null && line !== null) {
    if (!/^[1-9]\d*$/.test(line)) {
      problems.push(`line ${line} is not a positive whole number`);
    } else {
      const added = parseHunks(normalisePatch(patchText)).get(path)?.added;
      if (added === undefined) problems.push(`path ${path} is not in the patch`);
      else if (!added.has(Number(line))) problems.push(`line ${line} is not an added line of ${path}`);
    }
  }
  return problems;
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
    for (const file of files(dir)) {
      const text = readFileSync(file, 'utf8');
      for (const { pattern, why } of forbidden) {
        const match = pattern.exec(text);
        assert.equal(match, null, `${group}/${name}/${file.slice(dir.length + 1)} contains a ${why}: ${match?.[0]}`);
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

test('every positive names the added line of its causal path, or is marked harness: skip', () => {
  let named = 0;
  let skipped = 0;
  for (const { group, name, dir } of cases()) {
    const expectation = readExpectation(readFileSync(join(dir, 'case.yaml'), 'utf8'));
    const problems = annotationProblems(group, expectation, readFileSync(join(dir, 'diff.patch'), 'utf8'));
    assert.deepEqual(problems, [], `${group}/${name}: ${problems.join('; ')}`);
    if (expectation.line !== null) named += 1;
    if (expectation.harness === 'skip') skipped += 1;
  }
  assert.ok(named >= 19, `expected every positive with a path to name a line, found ${named}`);
  // S16 adds two reproduction fixtures whose outcome needs the confined runner, not the recall harness.
  assert.equal(skipped, 3, 'only simplification-dispatcher and the two reproduction fixtures are outside the harness');
});

test('clean and absence fixtures never name a line', () => {
  for (const { group, name, dir } of cases()) {
    if (group === 'positive') continue;
    const { line } = readExpectation(readFileSync(join(dir, 'case.yaml'), 'utf8'));
    assert.equal(line, null, `${group}/${name} must not carry expect.line`);
  }
});

test('simplification-dispatcher is the one positive outside the harness, with a reason', () => {
  const text = readFileSync(join(fixtures, 'positive/simplification-dispatcher/case.yaml'), 'utf8');
  assert.equal(readExpectation(text).harness, 'skip');
  assert.match(text, /^harness_reason:\s*"[^"\n]+"$/m);
});

test('the annotation check rejects each way a line can be wrong', () => {
  const patch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' keep', '+added', ' tail', ''].join('\n');
  const good = { path: 'src/a.ts', line: '2', harness: null };
  assert.deepEqual(annotationProblems('positive', good, patch), []);

  const missing = annotationProblems('positive', { ...good, line: null }, patch);
  assert.match(missing.join(), /names a path but no line/);

  const contextLine = annotationProblems('positive', { ...good, line: '1' }, patch);
  assert.match(contextLine.join(), /line 1 is not an added line of src\/a\.ts/);

  const beyond = annotationProblems('positive', { ...good, line: '9' }, patch);
  assert.match(beyond.join(), /line 9 is not an added line/);

  const wrongFile = annotationProblems('positive', { ...good, path: 'src/b.ts' }, patch);
  assert.match(wrongFile.join(), /path src\/b\.ts is not in the patch/);

  for (const group of ['negative', 'no-findings']) {
    assert.match(annotationProblems(group, good, patch).join(), /is not a positive fixture but names a line/);
  }

  const unmarked = annotationProblems('positive', { path: null, line: null, harness: null }, patch);
  assert.match(unmarked.join(), /has no path and is not marked harness: skip/);
  assert.deepEqual(annotationProblems('positive', { path: null, line: null, harness: 'skip' }, patch), []);
});

test('the annotation check reads the normalised patch, not the raw file', () => {
  // The header under-counts the new side, so reading it literally would end the
  // hunk before the second added line; the recounted copy keeps it.
  const patch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+one', '+two', ''].join('\n');
  assert.deepEqual(annotationProblems('positive', { path: 'src/a.ts', line: '3', harness: null }, patch), []);
});

test('case.yaml keys are read from the expect block only', () => {
  const text = 'name: x\nasserts: "a"\nharness: skip\nexpect:\n  path: a/b.ts\n  line: 12\n  category: c\n';
  assert.deepEqual(readExpectation(text), { path: 'a/b.ts', line: '12', harness: 'skip' });
  assert.deepEqual(readExpectation('name: x\nline: 5\nexpect:\n  findings: 1\n'), { path: null, line: null, harness: null });
});
