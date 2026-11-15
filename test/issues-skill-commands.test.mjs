/**
 * #385, #377, #390 and #388: the commands a slash-command review runs say what
 * they read, scaled or found, and keep what the verifier confirmed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-skill-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (dir, args, input = '') =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: dir, encoding: 'utf8', input, env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } });

const ENTRY = { candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.9, required_context_missing: [], reason: 'Confirmed.' };

test('#385: a reply with prose and a fenced bare array is read for the JSON, and --out writes it alone', () =>
  withDir((dir) => {
    const reply = `I checked every candidate against the head.\n\n\`\`\`json\n${JSON.stringify([ENTRY], null, 2)}\n\`\`\`\n`;
    const out = join(dir, 'verification.json');
    const result = run(dir, ['check-verification', '--out', out], reply);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /only the JSON was read/);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), [ENTRY]);

    const plain = run(dir, ['check-verification'], JSON.stringify({ verifications: [ENTRY] }));
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stderr, '');

    const none = run(dir, ['check-verification'], 'I could not verify anything.');
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no JSON was found in this reply/);
  }));

test('#388: also_at is checked, and reaches the eligible entry', () =>
  withDir((dir) => {
    const bad = run(dir, ['check-verification'], JSON.stringify([{ ...ENTRY, also_at: ['docs/a.md'] }]));
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /also_at must be a list of at most 10 "path:line" references/);

    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify([{ ...ENTRY, also_at: ['docs/a.md:12', 'docs/a.md:30'] }]));
    const candidate = { candidate_id: 'cand_001', path: 'docs/a.md', line: 4, category: 'documentation', severity: 'nit', claim: 'The table row names the old flag.', failure_mode: 'Readers pass a flag that no longer exists.', evidence: ['docs/a.md:4'], technical_confidence: 0.9 };
    const scored = run(dir, ['score', '--verification', verification, '--min-score', '0'], JSON.stringify({ candidates: [candidate] }));
    assert.equal(scored.status, 0, scored.stderr);
    assert.deepEqual(JSON.parse(scored.stdout).eligible[0].alsoAt, ['docs/a.md:12', 'docs/a.md:30']);
  }));

test('#377: an explicit --max-total-words that scaling raised is named in the output', () =>
  withDir((dir) => {
    const review = '[minor] `src/a.ts:3` - the retry loop never stops when the server keeps timing out.';
    const scaled = run(dir, ['validate-output', '--max-total-words', '600', '--scale-to-files', '18'], review);
    assert.equal(scaled.status, 0, scaled.stderr);
    assert.match(scaled.stdout, /\/1620 words \(--max-total-words 600, scaled to 18 files\)\./);

    const kept = run(dir, ['validate-output', '--max-total-words', '2000', '--scale-to-files', '18'], review);
    assert.match(kept.stdout, /\/2000 words\.$/m);
    const implicit = run(dir, ['validate-output', '--scale-to-files', '18'], review);
    assert.match(implicit.stdout, /\/1620 words\.$/m);
  }));

test('#390: an empty conventions result says where it looked', () =>
  withDir((dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const result = run(dir, ['conventions']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /No convention documents found\. Looked for: CLAUDE\.md, .*AGENTS\.md, .*\.claude\/skills\//);
    assert.ok(JSON.parse(result.stdout).searched.includes('CLAUDE.md'));
  }));
