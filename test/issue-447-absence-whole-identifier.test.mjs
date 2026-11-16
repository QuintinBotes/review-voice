/**
 * #447: "no module named `__future`" was contradicted by every
 * `from __future__ import annotations` in the repository, and by the defective
 * line itself, because the absent name was matched as a substring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAbsenceClaim, gitGrep } from '../plugins/review-voice/src/scoring/existence.ts';

const CLAIM = 'Python reads it as an ordinary import of a module named `__future`, and no such module exists, so the revision file fails to import.';
const none = () => [];

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-447-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app/models.py'), 'from __future__ import annotations\n\nclass Order: ...\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(dir, 'migrations'));
    const migration = Array.from({ length: 20 }, (_, i) => (i === 14 ? 'from __future import annotations' : `# line ${i + 1}`)).join('\n');
    writeFileSync(join(dir, 'migrations/0042_orders.py'), `${migration}\n`);
    git('add', '-A');
    git('commit', '-qm', 'head');
    return fn(dir, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const anchor = { path: 'migrations/0042_orders.py', line: 15 };

test('a name found only inside a longer identifier does not contradict the claim', () =>
  withRepo((dir, base) => {
    const result = checkAbsenceClaim(CLAIM, dir, base, undefined, null, none, undefined, anchor);
    assert.deepEqual(result.checked, ['__future']);
    assert.deepEqual(result.found, []);
  }));

test('in the working tree the finding\'s own line does not contradict it, another line does', () =>
  withRepo((dir) => {
    assert.deepEqual(checkAbsenceClaim(CLAIM, dir, null, undefined, null, none, undefined, anchor).found, []);
    // Without the anchor the typo itself is a whole-name hit.
    assert.deepEqual(checkAbsenceClaim(CLAIM, dir, null, undefined, null, none).found, ['__future']);
  }));

test('a whole-name match elsewhere still contradicts the claim', () =>
  withRepo((dir) => {
    writeFileSync(join(dir, 'app/__future.py'), 'import __future\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    assert.equal(gitGrep('__future', dir, null, anchor), true);
    assert.equal(gitGrep('__futur', dir, null), false, 'a prefix is not a whole name');
  }));

test('score keeps the verified typo finding eligible, with the added line as the anchor', () =>
  withRepo((dir, base) => {
    const bundle = join(new URL('..', import.meta.url).pathname, 'plugins/review-voice/dist/review-voice.mjs');
    const patch = join(dir, 'diff.patch');
    writeFileSync(patch, execFileSync('git', ['diff', '--no-ext-diff', '--unified=3', base, 'HEAD'], { cwd: dir, encoding: 'utf8' }));
    const verification = join(dir, 'verification.json');
    writeFileSync(verification, JSON.stringify([{ candidate_id: 'cand_001', verified: true, evidence_quality: 'high', technical_confidence: 0.97 }]));
    const candidate = { candidate_id: 'cand_001', path: anchor.path, line: anchor.line, category: 'correctness', severity: 'blocking', claim: CLAIM, failure_mode: 'alembic upgrade head fails for every deployment.', evidence: ['migrations/0042_orders.py:15'], technical_confidence: 0.95 };
    for (const ref of [[], ['--base', base]]) {
      const result = execFileSync(process.execPath, [bundle, 'score', '--verification', verification, '--diff-file', patch, '--min-score', '0', ...ref], {
        cwd: dir,
        encoding: 'utf8',
        input: JSON.stringify({ candidates: [candidate] }),
        env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
      });
      const out = JSON.parse(result);
      assert.deepEqual(out.absenceContradicted, [], ref.join(' ') || 'working tree');
      assert.deepEqual(out.eligible.map((e) => e.candidate_id), ['cand_001'], ref.join(' ') || 'working tree');
    }
  }));
