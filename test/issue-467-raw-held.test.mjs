/** #467: record --held and carry-candidates --held take the raw held lists check-candidates and score emit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { databasePath } from '../plugins/review-voice/src/store/paths.ts';
import { normaliseHeld, heldProblem } from '../plugins/review-voice/src/store/runs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const repeat = { candidateId: 'c1', path: 'a.ts', line: 3, author: 'bob', commentPath: 'a.ts', commentLine: 3, reason: 'Already stated by bob on this pull request.' };
const bodyRepeat = { ...repeat, candidateId: 'c4', commentPath: null, commentLine: null };
const below = { candidateId: 'c2', path: 'a.ts', line: 4, severity: 'important', claim: 'Loop never ends.', confidenceSource: 'verifier', gate: 'score', finalScore: 0.31, threshold: 0.5 };
const rejected = { candidateId: 'c3', path: 'a.ts', line: 5, severity: 'minor', claim: 'Typo.', verified: true, rejectedBecause: 'the verifier refuted it' };
const heldShape = { path: 'a.ts', line: 6, verdict: 'unverified', source: 's', reason: 'r' };

test('normaliseHeld maps each raw shape to a valid held entry', () => {
  const [r, b, j, h] = [repeat, below, rejected, heldShape].map(normaliseHeld);
  assert.equal(r.verdict, 'repeat');
  assert.equal(r.source, 'check-candidates');
  assert.equal(r.reason, repeat.reason);
  assert.equal(b.verdict, 'below-gate');
  assert.equal(b.source, 'score');
  assert.match(b.reason, /^below the score gate/);
  assert.equal(b.severity, 'important');
  assert.equal(b.text, 'Loop never ends.');
  assert.equal(j.verdict, 'refuted');
  assert.equal(j.reason, 'the verifier refuted it');
  assert.equal(j.candidateId, 'c3');
  assert.equal(h, heldShape);
  for (const e of [r, b, j, h]) assert.equal(heldProblem(e), null);
  assert.equal(normaliseHeld(bodyRepeat).verdict, 'repeat');
  assert.notEqual(heldProblem(normaliseHeld({ line: 1, verdict: 'repeat' })), null);
});

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-467-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('record --held records raw entries and refuses one with no path', () => {
  withDir((dir) => {
    const env = { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') };
    const heldFile = join(dir, 'h.json');
    const record = (list) => {
      writeFileSync(heldFile, JSON.stringify(list));
      return spawnSync(process.execPath, [bundle, 'record', '--repository', 'o/r', '--head', 'abc', '--held', heldFile], {
        env,
        input: 'No actionable findings.',
        encoding: 'utf8',
      });
    };
    const ok = record([repeat, bodyRepeat, below, rejected, heldShape]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).stored.held, 5);
    const db = openDatabase(databasePath(env));
    try {
      const text = JSON.stringify(db.prepare('SELECT * FROM review_runs').all());
      for (const verdict of ['repeat', 'below-gate', 'refuted', 'unverified']) assert.match(text, new RegExp(verdict));
    } finally {
      db.close();
    }
    const { path: _p, ...noPath } = repeat;
    assert.equal(record([noPath]).status, 2);
  });
});

test('carry-candidates --held takes raw entries and writes them in held shape', () => {
  withDir((dir) => {
    const repo = join(dir, 'repo');
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.ts'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(''));
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    const since = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'b.ts'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'two');
    const head = git('rev-parse', 'HEAD');
    const rows = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`);
    writeFileSync(join(dir, 'd.patch'), ['diff --git a/a.ts b/a.ts', 'new file mode 100644', '--- /dev/null', '+++ b/a.ts', '@@ -0,0 +1,40 @@', ...rows, ''].join('\n'));
    const cand = { candidate_id: 'cand_001', path: 'a.ts', line: 20, category: 'correctness', severity: 'important', claim: 'C.', failure_mode: 'F.', evidence: ['E.'], technical_confidence: 0.9 };
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ candidates: [cand] }));
    writeFileSync(join(dir, 'v.json'), JSON.stringify({ verifications: [{ candidate_id: 'cand_001', evidence_quality: 'high', technical_confidence: 0.9 }] }));
    writeFileSync(join(dir, 'h.json'), JSON.stringify([repeat, below, rejected]));
    const result = spawnSync(
      process.execPath,
      [bundle, 'carry-candidates', '--candidates', join(dir, 'c.json'), '--verification', join(dir, 'v.json'), '--since', since, '--head', head,
        '--diff-file', join(dir, 'd.patch'), '--out', join(dir, 'out'), '--held', join(dir, 'h.json')],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } },
    );
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(readFileSync(join(dir, 'out', 'held.json'), 'utf8'));
    assert.deepEqual(out.map((e) => e.verdict), ['repeat', 'below-gate', 'refuted']);
  });
});
