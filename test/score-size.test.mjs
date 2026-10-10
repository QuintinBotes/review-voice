import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { storeEvents } from '../plugins/review-voice/src/corpus/store.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const event = (key) => ({
  eventId: `gh_${key}`,
  source: 'github',
  repository: 'org/a',
  pullNumber: 1,
  pullRequestUrl: 'https://example.com/pull/1',
  commentId: key,
  reviewerLogin: 'someone',
  role: 'owner',
  createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  bodyRedacted: `The retry mints duplicate tokens before the transaction commits (${key}). ${'Detail. '.repeat(80)}`,
  filePath: 'src/auth.ts',
  lineStart: 12,
  contentKey: key,
  redactionVersion: '1',
  redactionCounts: {},
});

const long = (word) => `${word} `.repeat(400);

test('score output stays small and carries no precedentIds with 20 long candidates', () => {
  const data = mkdtempSync(join(tmpdir(), 'rv-size-data-'));
  const dir = mkdtempSync(join(tmpdir(), 'rv-size-repo-'));
  try {
    const db = openDatabase(join(data, 'review-voice.db'));
    storeEvents(db, Array.from({ length: 8 }, (_, i) => event(`k${i}`)));
    db.close();

    const candidates = Array.from({ length: 20 }, (_, i) => ({
      candidate_id: `c${i}`, path: 'src/auth.ts', line: 12 + i, category: 'correctness', severity: 'important',
      claim: 'The retry mints duplicate tokens before the transaction commits.',
      failure_mode: 'A client retry creates two tokens for one login.',
      evidence: [long('evidence'), long('more')],
      technical_confidence: 0.9,
      suggested_fix: long('suggested'),
    }));
    const stdout = execFileSync(process.execPath, [bundle, 'score', '--repository', 'org/a'], {
      cwd: dir, input: JSON.stringify({ candidates }), encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    });
    assert.ok(stdout.length < 100 * 1024, `score output was ${stdout.length} bytes`);

    let sawPrecedents = false;
    let longest = 0;
    const walk = (value, key) => {
      if (typeof value === 'string') {
        if (key !== 'claim' && key !== 'failureMode') longest = Math.max(longest, value.length);
      } else if (Array.isArray(value)) {
        value.forEach((v) => walk(v, key));
      } else if (value && typeof value === 'object') {
        assert.ok(!('precedentIds' in value), 'precedentIds must not be serialised');
        if (Array.isArray(value.precedents) && value.precedents.length > 0) sawPrecedents = true;
        Object.entries(value).forEach(([k, v]) => walk(v, k));
      }
    };
    walk(JSON.parse(stdout));
    assert.ok(sawPrecedents, 'the seeded corpus should yield precedents');
    assert.ok(longest <= 700, `a string was ${longest} characters`);
    assert.match(stdout, /"truncated":\s*true/);
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
