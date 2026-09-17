import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

/** Run validate-output with `output` on stdin. */
function validate(output, flags = []) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, 'validate-output', '--json', ...flags], {
      input: output,
      encoding: 'utf8',
    });
    return { code: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.status, result: JSON.parse(error.stdout || '{}'), stderr: error.stderr };
  }
}

const codes = (r) => r.result.violations.map((v) => v.code);

// The two examples in the specification are the contract's own reference
// output. If the validator rejects them, the validator is wrong.
test('accepts the specification’s example findings verbatim', () => {
  const output = [
    '[blocking] `src/auth/session.ts:84` — The response returns the refresh token',
    'before the transaction commits, so a retry can mint two valid tokens. Commit',
    'before sending the response.',
    '',
    '[important] `.github/workflows/release.yml:52` — The publish job can run after',
    'a skipped verification job. Make verification a required dependency.',
  ].join('\n');
  const { code, result } = validate(output);
  assert.equal(code, 0, JSON.stringify(result.violations));
  assert.equal(result.findingCount, 2);
});

test('accepts the exact no-findings response', () => {
  const { code, result } = validate('No actionable findings.\n');
  assert.equal(code, 0);
  assert.equal(result.findingCount, 0);
});

test('rejects a reworded no-findings response', () => {
  const { code, result } = validate('No actionable findings found.');
  assert.equal(code, 1);
  assert.deepEqual(codes({ result }), ['no_findings_response']);
});

test('rejects an empty review', () => {
  assert.equal(validate('').code, 1);
  assert.equal(validate('   \n  ').code, 1);
});

test('there is no cap on how many findings are reported', () => {
  // A count cap and a word budget do the same job, and the count is the worse
  // of the two: on tight findings it discards ones the budget would allow.
  const output = Array.from(
    { length: 12 },
    (_, i) => `[minor] \`src/a${i}.ts:${i + 1}\` — Something breaks here. It fails. Fix it.`,
  ).join('\n\n');
  const { code, result } = validate(output, ['--max-total-words', '2000']);
  assert.equal(code, 0, JSON.stringify(result.violations));
  assert.equal(result.findingCount, 12);
});

test('a cap applies when policy asks for one', () => {
  const output = Array.from(
    { length: 6 },
    (_, i) => `[minor] \`src/a${i}.ts:${i + 1}\` — Something breaks here. It fails. Fix it.`,
  ).join('\n\n');
  const { code, result } = validate(output, ['--max-findings', '5']);
  assert.equal(code, 1);
  assert.ok(codes({ result }).includes('too_many_findings'));
});

test('nit and question are severities, not banned words', () => {
  const output = [
    '[blocking] `src/a.ts:1` — Token returned before commit. A retry mints two. Commit first.',
    '[nit] `src/b.ts:2` — Name says format but it also validates. Readers expect one job. Split it.',
    '[question] `src/c.ts:3` — Is the down migration exercised? A rollback path that never runs does not work.',
  ].join('\n\n');
  const { code, result } = validate(output);
  assert.equal(code, 0, JSON.stringify(result.violations));
  assert.equal(result.findingCount, 3);
});

test('findings must be ordered by severity', () => {
  // A reader who stops halfway has to have seen the most serious findings.
  const output = [
    '[nit] `src/b.ts:2` — Name says format but it also validates. Readers expect one job. Split it.',
    '[blocking] `src/a.ts:1` — Token returned before commit. A retry mints two. Commit first.',
  ].join('\n\n');
  const { code, result } = validate(output);
  assert.equal(code, 1);
  assert.ok(codes({ result }).includes('severity_order'));
});

test('the word budget scales with the size of the change', () => {
  const output = Array.from(
    { length: 20 },
    (_, i) => `[minor] \`src/a${i}.ts:${i + 1}\` — A problem here that takes a few more words to state properly. It fails silently. Fix it.`,
  ).join('\n\n');

  // A flat budget written for an ordinary pull request becomes a reason to
  // drop real findings on a large one.
  const atFloor = validate(output);
  assert.equal(atFloor.code, 1, 'should not fit the floor budget');
  assert.ok(codes(atFloor).includes('output_too_long'));

  const scaled = validate(output, ['--scale-to-files', '30']);
  assert.equal(scaled.code, 0, JSON.stringify(scaled.result.violations));
});

test('rejects a finding over the word limit', () => {
  const prose = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
  const { code, result } = validate(`[minor] \`src/a.ts:1\` — ${prose}`);
  assert.equal(code, 1);
  assert.ok(codes({ result }).includes('finding_too_long'));
});

test('counts prose only, so a long path does not consume the budget', () => {
  const deep = 'src/very/deeply/nested/directory/structure/with/a/long/name/module.ts';
  const prose = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const { code } = validate(`[minor] \`${deep}:1\` — ${prose}`);
  assert.equal(code, 0, 'exactly 40 prose words must pass regardless of path length');
});

test('enforces the total word budget across findings', () => {
  const prose = Array.from({ length: 38 }, (_, i) => `word${i}`).join(' ');
  const output = Array.from(
    { length: 5 },
    (_, i) => `[minor] \`src/a${i}.ts:1\` — ${prose}`,
  ).join('\n');
  const { code, result } = validate(output);
  assert.equal(code, 1);
  assert.ok(codes({ result }).includes('output_too_long'));
  assert.equal(result.totalWords, 190);
});

test('rejects malformed shapes', () => {
  const cases = [
    'The auth code looks wrong.',
    '[minor] src/a.ts:1 — No backticks around the location.',
    '[minor] `src/a.ts:1` - Hyphen instead of an em dash.',
    '[critical] `src/a.ts:1` — Unknown severity.',
  ];
  for (const output of cases) {
    assert.equal(validate(output).code, 1, `should reject: ${output}`);
  }
});

test('rejects hedges that hide the claim', () => {
  // "You might consider" states nothing to agree or disagree with.
  for (const prose of [
    'Consider renaming this. It is unclear. Rename it.',
    'This might fail under load. Requests drop. Add a limit.',
    'It may be worth adding a guard. State is lost. Add one.',
  ]) {
    const { code, result } = validate(`[minor] \`src/a.ts:1\` — ${prose}`);
    assert.equal(code, 1, prose);
    assert.ok(codes({ result }).includes('forbidden_phrase'), prose);
  }
});

test('forbidden phrases match whole words only', () => {
  const { code } = validate(
    '[minor] `src/a.ts:1` — The initialiser runs twice. State is overwritten. Guard it.',
  );
  assert.equal(code, 0);
});

test('words that read as summary markers are allowed in prose', () => {
  // "overall latency" and "the summary endpoint" are real phrases, and word
  // boundaries cannot tell them from a summary section.
  const { code, result } = validate(
    '[minor] `src/a.ts:1` — Overall latency is not measured on the summary endpoint. Regressions go unseen. Add a timer.',
  );
  assert.equal(code, 0, JSON.stringify(result.violations));
});

test('rejects greetings, headings and summaries', () => {
  const finding = '[minor] `src/a.ts:1` — It breaks here. Data is lost. Guard it.';
  const cases = [
    [`## Review\n\n${finding}`, 'heading'],
    [`Hi! Here are my notes.\n\n${finding}`, 'greeting'],
    [`${finding}\n\nOverall the code is solid.`, 'summary'],
    [`I reviewed the diff.\n\n${finding}`, 'preamble'],
  ];
  for (const [output, expected] of cases) {
    const { code, result } = validate(output);
    assert.equal(code, 1, output);
    assert.ok(codes({ result }).includes(expected), `${expected} not in ${codes({ result })}`);
  }
});

test('rejects two findings at the same location', () => {
  const output = [
    '[minor] `src/a.ts:1` — First problem here. It fails. Fix it.',
    '[minor] `src/a.ts:1` — Second problem here. It also fails. Fix it too.',
  ].join('\n');
  const { code, result } = validate(output);
  assert.equal(code, 1);
  assert.ok(codes({ result }).includes('duplicate_location'));
});

test('reports every violation at once, not just the first', () => {
  const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
  const output = [
    '## Review',
    `[minor] \`src/a.ts:1\` — Consider ${long}`,
    '[minor] `src/a.ts:1` — Duplicate location here. It fails. Fix it.',
  ].join('\n');
  const { result } = validate(output);
  const found = codes({ result });
  for (const expected of ['heading', 'finding_too_long', 'forbidden_phrase', 'duplicate_location']) {
    assert.ok(found.includes(expected), `${expected} missing from ${found}`);
  }
});

test('limits are configurable', () => {
  const output = [
    '[minor] `src/a.ts:1` — One problem here. It fails. Fix it.',
    '[minor] `src/b.ts:2` — Two problems here. It fails. Fix it.',
  ].join('\n');
  assert.equal(validate(output).code, 0);
  assert.equal(validate(output, ['--max-findings', '1']).code, 1);
});

test('a bad flag value is an invocation error, not a contract failure', () => {
  try {
    execFileSync(process.execPath, [bundle, 'validate-output', '--max-findings', 'lots'], {
      input: 'No actionable findings.',
      encoding: 'utf8',
    });
    assert.fail('should have exited non-zero');
  } catch (error) {
    assert.equal(error.status, 2, 'exit 2 distinguishes bad invocation from a failed review');
  }
});

test('reports every forbidden phrase in a finding, not just the first', () => {
  const { code, result } = validate(
    '[minor] `src/a.ts:1` — Consider whether this might be worth changing. It could potentially fail. Fix it.',
  );
  assert.equal(code, 1);
  const phrases = result.violations.filter((v) => v.code === 'forbidden_phrase');
  assert.ok(phrases.length >= 3, `expected several, got ${phrases.length}`);
});

test('trailing prose after the last finding counts against it', () => {
  // Absorbing trailing text is deliberate: it is either a wrapped continuation
  // or an unwanted summary, and both should cost budget rather than slip past.
  const { result } = validate(
    '[minor] `src/a.ts:1` — It breaks here. Data is lost. Guard it.\nAnd some extra commentary.',
  );
  assert.ok(result.totalWords > 11);
});
