/**
 * #546: lock files are excluded from the diff, and nothing else looked at what
 * a pull request did to its dependencies, so a change adding a package with a
 * known advisory was approved with no word. With
 * `review.human_review.dependency_review` set, `diff --pr` reads GitHub's
 * dependency review, and an added runtime dependency with an advisory at or
 * above that severity raises the change for human review. When the endpoint is
 * unavailable (403, 404) or the review is not of a pull request, a local note
 * says the dependency change was not checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitDiff } from '../plugins/review-voice/src/cli.ts';
import { checkDependencies } from '../plugins/review-voice/src/diff/dependencies.ts';
import { acquirePullRequestDiff } from '../plugins/review-voice/src/diff/pull-request.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { decide } from '../plugins/review-voice/src/publish/verdict.ts';

const REPO = 'QuintinBotes/review-voice-scratch';
const BASE = 'f67c96af63be4d5b4f3fad2a4415a84a3d77c9bf';
const HEAD = '4bf8831ea8adfd12a4d3374f5377d822762e09ea';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PULL = { number: 7, title: 'Bump helmet, add openid', base: { sha: BASE, ref: 'main' }, head: { sha: HEAD, ref: 'deps' }, changed_files: 2, additions: 3, deletions: 1 };
const FILES = [
  {
    sha: '57451d347f05d0a958fb8e01e0375d21d8945a09',
    filename: 'package.json',
    status: 'modified',
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: '@@ -3,3 +3,4 @@\n   "dependencies": {\n-    "helmet": "4.6.0"\n+    "helmet": "5.0.0",\n+    "openid": "2.7.0"\n   }',
  },
  { sha: '59b992fb3dbceb826d5ddea79ee061344f64b9f7', filename: 'package-lock.json', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1,2 @@\n {\n+  "x": 1' },
];

// GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}, shaped as GitHub's REST docs give it.
const COMPARE = [
  { change_type: 'removed', manifest: 'package.json', ecosystem: 'npm', name: 'helmet', version: '4.6.0', package_url: 'pkg:npm/helmet@4.6.0', license: 'MIT', source_repository_url: 'https://github.com/helmetjs/helmet', scope: 'runtime', vulnerabilities: [] },
  { change_type: 'added', manifest: 'package.json', ecosystem: 'npm', name: 'helmet', version: '5.0.0', package_url: 'pkg:npm/helmet@5.0.0', license: 'MIT', source_repository_url: 'https://github.com/helmetjs/helmet', scope: 'runtime', vulnerabilities: [] },
  {
    change_type: 'added', manifest: 'package.json', ecosystem: 'npm', name: 'openid', version: '2.7.0', package_url: 'pkg:npm/openid@2.7.0', license: null, source_repository_url: 'https://github.com/openid/ruby-openid', scope: 'runtime',
    vulnerabilities: [{ severity: 'critical', advisory_ghsa_id: 'GHSA-fqfj-cmh6-hj49', advisory_summary: 'Ruby OpenID', advisory_url: 'https://github.com/advisories/GHSA-fqfj-cmh6-hj49' }],
  },
  // A development dependency, an advisory below the threshold, and a removed package: none holds.
  { change_type: 'added', manifest: 'package.json', ecosystem: 'npm', name: 'mocha', version: '1.0.0', package_url: 'pkg:npm/mocha@1.0.0', license: 'MIT', source_repository_url: null, scope: 'development', vulnerabilities: [{ severity: 'high', advisory_ghsa_id: 'GHSA-dev0-0000-0000', advisory_summary: 'x', advisory_url: 'https://github.com/advisories/GHSA-dev0-0000-0000' }] },
  { change_type: 'added', manifest: 'package.json', ecosystem: 'npm', name: 'leftpad', version: '1.1.0', package_url: 'pkg:npm/leftpad@1.1.0', license: 'GPL-3.0', source_repository_url: null, scope: 'runtime', vulnerabilities: [{ severity: 'low', advisory_ghsa_id: 'GHSA-low0-0000-0000', advisory_summary: 'x', advisory_url: 'https://github.com/advisories/GHSA-low0-0000-0000' }] },
  { change_type: 'removed', manifest: 'package.json', ecosystem: 'npm', name: 'oldpkg', version: '0.1.0', package_url: 'pkg:npm/oldpkg@0.1.0', license: 'MIT', source_repository_url: null, scope: 'runtime', vulnerabilities: [{ severity: 'critical', advisory_ghsa_id: 'GHSA-gone-0000-0000', advisory_summary: 'x', advisory_url: 'https://github.com/advisories/GHSA-gone-0000-0000' }] },
];

function client(compare, requests = []) {
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, method: init?.method });
    if (path.includes('/dependency-graph/compare/')) return typeof compare === 'number' ? json({ message: 'Forbidden' }, compare) : json(compare);
    return json(/\/pulls\/\d+$/.test(path) ? PULL : FILES);
  };
  return new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl, sleep: async () => {} });
}

const check = (github, minSeverity = 'high', files = FILES.map((file) => ({ path: file.filename }))) =>
  checkDependencies({ client: github, repository: REPO, base: BASE, head: HEAD, files, minSeverity });

test('#546: an added runtime dependency with an advisory holds the approval, naming the advisory', async () => {
  const requests = [];
  const result = await check(client(COMPARE, requests));
  assert.deepEqual(requests, [{ path: `/repos/${REPO}/dependency-graph/compare/${BASE}...${HEAD}`, method: 'GET' }]);
  assert.equal(result.hold, '1 added dependency(ies) with an advisory at or above high: openid@2.7.0 (GHSA-fqfj-cmh6-hj49 critical)');
  // The bump kept MIT, so only the new packages' licences are named, and only locally.
  assert.equal(result.note, 'Dependency licences added by this change: openid@2.7.0 (no licence detected), mocha@1.0.0 (MIT), leftpad@1.1.0 (GPL-3.0).');
  assert.doesNotMatch(result.hold, /helmet|mocha|leftpad|oldpkg/);
  // A threshold of low also holds the low advisory, never the development one or the removed one.
  assert.match((await check(client(COMPARE), 'low')).hold, /^2 added .*leftpad@1\.1\.0 \(GHSA-low0-0000-0000 low\)$/);
});

test('#546: diff --pr raises the change for a human, so the review comments rather than approves', async (t) => {
  const github = client(COMPARE);
  const acquired = await acquirePullRequestDiff({ repository: REPO, pullNumber: 7, includeGenerated: false, cwd: '/nonexistent', client: github });
  const result = await emitted(t, { ...acquired, dependencies: await check(github) });
  assert.equal(result.complexity.level, 'high');
  assert.match(result.humanReviewNote, /GHSA-fqfj-cmh6-hj49/);
  assert.match(result.dependencyNote, /^Dependency licences added/);
  assert.equal(result.dependencies, undefined);
  assert.equal(decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: false, needsHuman: true }).event, 'COMMENT');
});

test('#546: a 403 or 404 from the dependency review degrades to a note, and holds nothing', async () => {
  for (const status of [403, 404]) {
    const result = await check(client(status));
    assert.equal(result.hold, null);
    assert.equal(result.note, `Dependency changes were not checked for advisories or licences (package.json, package-lock.json): GitHub's dependency review answered ${status}.`);
  }
});

test('#546: off by default, and no request when no dependency file changed', async () => {
  const requests = [];
  const off = await check(client(COMPARE, requests), null);
  assert.deepEqual(off, { hold: null, note: null }, 'off by default, and silent');
  assert.deepEqual(await check(client(COMPARE, requests), 'high', [{ path: 'src/cart.js' }]), { hold: null, note: null });
  assert.deepEqual(requests, []);
});

test('#546: a branch review that changes a lock file says the dependency change was not checked', async (t) => {
  const result = await emitted(t, {
    diff: '', mode: 'base', base: BASE, head: HEAD, reviewedFileCount: 0, hunkFileCount: 0, excludedFileCount: 1,
    files: [{ path: 'yarn.lock', status: 'modified', additions: 1, deletions: 1, reviewed: false }],
  });
  assert.equal(result.complexity.level, 'normal');
  assert.match(result.dependencyNote, /^Dependency changes were not checked for advisories or licences \(yarn\.lock\): only a pull request review/);
});

/** What `diff` prints for an acquired diff, from an empty clone. */
async function emitted(t, acquired) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-546-'));
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
