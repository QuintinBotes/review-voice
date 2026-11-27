/**
 * #536: GitHub sends no patch for a source file too large to diff, so the
 * review never read it, and it approved review-voice-scratch#3 ("No problems
 * found") with a 40,007-line source file unread. Such a file, or a file list
 * cut at GitHub's limit, now raises the change for human review, so it is
 * capped at COMMENT like any other change a person must approve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitDiff } from '../plugins/review-voice/src/cli.ts';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { acquirePullRequestDiff } from '../plugins/review-voice/src/diff/pull-request.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { decide } from '../plugins/review-voice/src/publish/verdict.ts';

const REPO = 'QuintinBotes/review-voice-scratch';
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// The live payloads of GET /pulls/3 and /pulls/3/files. GitHub leaves `patch` out of the large file's entry.
const PULL = {
  number: 3,
  title: 'Add regional tax rates',
  base: { sha: 'f67c96af63be4d5b4f3fad2a4415a84a3d77c9bf', ref: 'main' },
  head: { sha: '4bf8831ea8adfd12a4d3374f5377d822762e09ea', ref: 'rates' },
  changed_files: 2,
  additions: 40012,
  deletions: 0,
};
const CART = {
  sha: '57451d347f05d0a958fb8e01e0375d21d8945a09',
  filename: 'src/cart.js',
  status: 'modified',
  additions: 5,
  deletions: 0,
  changes: 5,
  patch:
    '@@ -14,3 +14,8 @@ export function pageOf(items, page, size) {\n   const start = page * size;\n   return items.slice(start, start + size);\n }\n+\n+// Cents of tax on a subtotal for a region.\n+export function taxFor(cents, rateBasisPoints) {\n+  return Math.round(cents * rateBasisPoints / 10000);\n+}',
};
const RATES = { sha: '59b992fb3dbceb826d5ddea79ee061344f64b9f7', filename: 'src/rates.js', status: 'added', additions: 40007, deletions: 0, changes: 40007 };
// A binary also comes without a patch, and GitHub counts no lines for it.
const LOGO = { sha: '0'.repeat(40), filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0 };

async function acquire(files, changedFiles = files.length) {
  const fetchImpl = async (url) => json(/\/pulls\/\d+$/.test(new URL(String(url)).pathname) ? { ...PULL, changed_files: changedFiles } : files);
  return acquirePullRequestDiff({
    repository: REPO,
    pullNumber: 3,
    includeGenerated: false,
    cwd: '/nonexistent',
    client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl, sleep: async () => {} }),
  });
}

test('#536: a source file GitHub sent no patch for raises the change for human review, so it is not approved', async () => {
  const acquired = await acquire([CART, RATES]);
  const assessed = assessComplexity(acquired.diff, acquired.files);
  assert.equal(assessed.level, 'high');
  assert.deepEqual(assessed.reasons, ['1 changed source file(s) not read, GitHub sent no patch (src/rates.js)']);
  const decision = decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: false, needsHuman: true });
  assert.equal(decision.event, 'COMMENT');
});

test('#536: a binary with no patch, and a change whose every file was read, stay normal', async () => {
  for (const files of [[CART, LOGO], [CART]]) {
    const acquired = await acquire(files);
    const assessed = assessComplexity(acquired.diff, acquired.files);
    assert.equal(assessed.level, 'normal', JSON.stringify(assessed.reasons));
  }
});

/** What `diff --pr` prints for an acquired pull request, from an empty clone. */
async function emitted(t, acquired) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-536-'));
  const saved = { cwd: process.cwd(), log: console.log };
  t.after(() => {
    console.log = saved.log;
    process.chdir(saved.cwd);
    rmSync(dir, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  process.chdir(dir);
  let out = '';
  console.log = (text) => void (out += text);
  await emitDiff(acquired, null);
  console.log = saved.log;
  return JSON.parse(out);
}

test('#536: diff --pr flags the unread file in its human-review note', async (t) => {
  const result = await emitted(t, await acquire([CART, RATES]));
  assert.equal(result.complexity.level, 'high');
  assert.match(result.humanReviewNote, /1 changed source file\(s\) not read, GitHub sent no patch \(src\/rates\.js\)/);
});

test('#536: a file list cut short raises the change for human review', async (t) => {
  const acquired = await acquire([CART], 3001);
  assert.equal(acquired.truncated, true);
  const result = await emitted(t, acquired);
  assert.equal(result.complexity.level, 'high');
  assert.ok(result.complexity.reasons.includes('GitHub listed only part of the changed files, so the rest were not read'), JSON.stringify(result.complexity.reasons));
});
