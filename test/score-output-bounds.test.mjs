import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

/** A repository where one symbol is used by 45 files, and a one-line change to it. */
function widelyUsedSymbol() {
  const dir = mkdtempSync(join(tmpdir(), 'rv-bounds-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (let i = 0; i < 45; i += 1) {
    mkdirSync(join(dir, `pkg${i % 3}`), { recursive: true });
    writeFileSync(join(dir, `pkg${i % 3}/use${i}.ts`), `export const v${i} = computeTotalWidget(${i});\n`);
  }
  writeFileSync(join(dir, 'core.ts'), 'export function computeTotalWidget(n: number) {\n  return n;\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  writeFileSync(join(dir, 'core.ts'), 'export function computeTotalWidget(n: number) {\n  return computeTotalWidget(n - 1);\n}\n');
  const patch = join(dir, 'change.patch');
  writeFileSync(patch, git('diff', '--', 'core.ts'));
  git('checkout', '-q', '--', 'core.ts');
  git('apply', patch);
  return { dir, patch };
}

test('score caps every reach path list at 20 with totals, and stays small', () => {
  const { dir, patch } = widelyUsedSymbol();
  const data = mkdtempSync(join(tmpdir(), 'rv-bounds-data-'));
  try {
    const input = JSON.stringify({
      candidates: [{
        candidate_id: 'c1', path: 'core.ts', line: 2, category: 'correctness', severity: 'important',
        claim: 'computeTotalWidget now returns one more than it was given.',
        failure_mode: 'Every caller of computeTotalWidget is off by one.',
        evidence: ['line 2 adds one'], technical_confidence: 0.9,
      }],
    });
    const stdout = execFileSync(process.execPath, [bundle, 'score', '--diff-file', patch], {
      cwd: dir, input, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
    });
    assert.ok(stdout.length < 20 * 1024, `score output was ${stdout.length} bytes`);

    const lists = [];
    const walk = (value) => {
      if (Array.isArray(value)) {
        if (value.length > 0 && value.every((v) => typeof v === 'string')) lists.push(value);
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    const parsed = JSON.parse(stdout);
    walk(parsed.scores);
    assert.ok(lists.every((list) => list.length <= 20));

    const find = (value) => {
      if (value && typeof value === 'object') {
        if ('pathsTotal' in value) return value;
        for (const item of Object.values(value)) {
          const hit = find(item);
          if (hit) return hit;
        }
      }
      return null;
    };
    const reach = find(parsed.scores);
    assert.ok(reach, 'reach check carries pathsTotal');
    assert.ok(reach.pathsTotal > 20);
    assert.equal(reach.paths.length, 20);
    assert.equal(reach.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
