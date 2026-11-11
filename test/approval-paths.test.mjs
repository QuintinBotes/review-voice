/**
 * Approval by path (docs/adr/0028 amendment, S22 part A):
 * `verdict.never_approve_paths` and `verdict.only_approve_paths` leave an
 * approval to a person when the pull request's changed paths touch a guarded
 * glob or fall outside the allowed ones. The hold takes never_approve's slot in
 * decide(), the paths stay in the local reasons, and the posted summary ends
 * with one fixed sentence naming the setting. A list that did not load, or one
 * GitHub may have cut, fails closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient, GitHubError } from '../plugins/review-voice/src/github/client.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { approvalPathHold, decide, DEFAULT_VERDICT_POLICY } from '../plugins/review-voice/src/publish/verdict.ts';
import { computeVerdict, postReview } from '../plugins/review-voice/src/publish/post.ts';
import { globToRegExp } from '../plugins/review-voice/src/conventions/globs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const HEAD = 'a'.repeat(40);
const REPO = 'acme/web';
const PR = 7;
const OWNER = 'your-github-login';
const APPROVAL_URL = `https://github.com/${REPO}/pull/${PR}#pullrequestreview-55`;
const failedEntry = { name: 'build', source: 'check-run', result: 'failed', detail: 'failure' };
const rerunEntry = { name: 'e2e', source: 'check-run', result: 'rerun', detail: 'timed_out' };
const FAILING = 'Heads up: `build` failing on this head.';

const NEVER = 'approval is left to a person by policy';
const NEVER_RECHECK = 'there is no approval to re-check under never_approve';
const PATHS_RECHECK = 'there is no approval to re-check under the approval paths';
const TRUNCATED =
  'approval is left to a person, as the pull request lists more files than GitHub returns, so the approval paths cannot be checked';
const MATCHES = (paths) => `approval is left to a person, as verdict.never_approve_paths matches ${paths}`;
const OUTSIDE = (paths) => `approval is left to a person, as verdict.only_approve_paths does not cover ${paths}`;
const NEVER_SENTENCE = 'Approval is held because a changed file matches never_approve_paths.';
const ONLY_SENTENCE = 'Approval is held because a changed file is outside only_approve_paths.';
const UNCHECKED = (setting) => `Approval is held because the changed files could not be checked against ${setting}.`;

const policy = (extra = {}) => ({ neverApprovePaths: [], onlyApprovePaths: [], malformedApprovalPaths: null, ...extra });
const changed = (paths, truncated = false) => ({ paths, truncated });

test('approvalPathHold: the table of reasons and posted sentences', () => {
  const never = policy({ neverApprovePaths: ['db/migrate/**', 'config/*.yaml'] });
  const only = policy({ onlyApprovePaths: ['docs/**', '*.md'] });
  // db/migrate/001.sql matches never and is outside only, so the never-wins row pins the order of the two checks.
  const both = policy({ neverApprovePaths: ['db/migrate/**'], onlyApprovePaths: ['docs/**', 'db/seeds/**'] });
  const cases = [
    ['both lists empty', policy(), changed(['db/migrate/001.sql']), null],
    ['a matching path', never, changed(['src/a.ts', 'db/migrate/001.sql']), { reason: MATCHES('db/migrate/001.sql'), posted: NEVER_SENTENCE }],
    // readChangedPaths lists a rename by both names, so the previous path is in `paths`.
    ['a rename whose previous path matches', never, changed(['src/moved.sql', 'db/migrate/001.sql']), { reason: MATCHES('db/migrate/001.sql'), posted: NEVER_SENTENCE }],
    // A deleted file is a bare path here; the end-to-end case below sends one through readChangedPaths.
    ['a path matching the second glob', never, changed(['config/app.yaml']), { reason: MATCHES('config/app.yaml'), posted: NEVER_SENTENCE }],
    ['no match', never, changed(['src/a.ts', 'db/seeds/a.sql']), null],
    ['wholly inside only_approve_paths', only, changed(['docs/a.md', 'docs/guide/b.md', 'README.md']), null],
    ['one path outside only_approve_paths', only, changed(['docs/a.md', 'src/a.ts']), { reason: OUTSIDE('src/a.ts'), posted: ONLY_SENTENCE }],
    ['both lists set, the never list wins', both, changed(['docs/a.md', 'db/migrate/001.sql']), { reason: MATCHES('db/migrate/001.sql'), posted: NEVER_SENTENCE }],
    ['both lists set, outside the only list', both, changed(['docs/a.md', 'src/a.ts']), { reason: OUTSIDE('src/a.ts'), posted: ONLY_SENTENCE }],
    ['both lists set, inside', both, changed(['docs/a.md', 'db/seeds/a.sql']), null],
    ['a truncated list under never_approve_paths', never, changed(['docs/a.md'], true), { reason: TRUNCATED, posted: UNCHECKED('never_approve_paths') }],
    ['a truncated list under only_approve_paths', only, changed(['docs/a.md'], true), { reason: TRUNCATED, posted: UNCHECKED('only_approve_paths') }],
    ['a truncated list with both lists empty', policy(), changed(['docs/a.md'], true), null],
    [
      'a list that did not load holds without paths',
      policy({ malformedApprovalPaths: 'only_approve_paths' }),
      changed([]),
      {
        reason: 'approval is left to a person, as verdict.only_approve_paths did not load, so the approval paths cannot be checked',
        posted: UNCHECKED('only_approve_paths'),
      },
    ],
  ];
  for (const [name, rule, files, expected] of cases) {
    assert.deepEqual(approvalPathHold(files, rule), expected, name);
  }
});

test('approvalPathHold: the reason names three sorted paths and +N more, and the sentence never names a path', () => {
  const many = ['db/migrate/004.sql', 'db/migrate/002.sql', 'db/migrate/001.sql', 'db/migrate/003.sql', 'db/migrate/005.sql'];
  const hold = approvalPathHold(changed(many), policy({ neverApprovePaths: ['db/migrate/**'] }));
  assert.equal(hold.reason, MATCHES('db/migrate/001.sql, db/migrate/002.sql, db/migrate/003.sql, +2 more'));
  assert.ok(!hold.posted.includes('db/'));
  const three = approvalPathHold(changed(many.slice(0, 3)), policy({ onlyApprovePaths: ['docs/**'] }));
  assert.equal(three.reason, OUTSIDE('db/migrate/001.sql, db/migrate/002.sql, db/migrate/004.sql'));
  // The matcher is anchored and case-sensitive, as the sensitive paths are.
  assert.equal(approvalPathHold(changed(['DB/migrate/001.sql', 'xdb/migrate/a.sql']), policy({ neverApprovePaths: ['db/migrate/**'] })), null);
});

const REASON = MATCHES('db/migrate/001.sql');
const at = (extra = {}) => decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: false, approvalPathHold: REASON, ...extra });

test('decide: a path hold on a mapped APPROVE posts COMMENT with the path reason, for green, pending and red CI', () => {
  for (const ci of ['green', 'pending', 'red']) {
    const decision = at({ ci, failed: [failedEntry] });
    assert.equal(decision.event, 'COMMENT', ci);
    assert.equal(decision.action, 'post', ci);
    assert.equal(decision.exitCode, 0, ci);
    assert.equal(decision.cappedByPolicy, true, ci);
    assert.equal(decision.cappedByCi, false, ci);
    assert.deepEqual(decision.reasons, [REASON], ci);
    assert.deepEqual(decision.annotations, [], ci);
  }
  const annotated = at({ ci: 'red', failed: [failedEntry], policy: { ciRed: 'annotate' } });
  assert.equal(annotated.event, 'COMMENT');
  assert.equal(annotated.cappedByPolicy, true);
  assert.deepEqual(annotated.annotations, [FAILING]);
  assert.deepEqual(annotated.reasons, [REASON]);
});

test('decide: --recheck under a path hold refuses with exit 2 and the stated reason', () => {
  for (const ci of ['green', 'pending', 'red']) {
    const decision = at({ ci, recheck: true, failed: [failedEntry] });
    assert.equal(decision.event, 'COMMENT', ci);
    assert.equal(decision.action, 'refuse', ci);
    assert.equal(decision.exitCode, 2, ci);
    assert.equal(decision.cappedByPolicy, true, ci);
    assert.equal(decision.cappedByCi, false, ci);
    assert.deepEqual(decision.reasons, [PATHS_RECHECK], ci);
  }
});

test('decide: REQUEST_CHANGES and COMMENT are unchanged by a path hold', () => {
  for (const mapped of ['REQUEST_CHANGES', 'COMMENT']) {
    const decision = at({ mapped, ci: 'pending' });
    assert.equal(decision.event, mapped);
    assert.equal(decision.action, 'post');
    assert.equal(decision.exitCode, 0);
    assert.equal(decision.cappedByPolicy, false);
    assert.deepEqual(decision.reasons, []);
  }
});

test('decide: a standing owner approval still carries, and a needs-rerun state still waits with exit 6', () => {
  const carried = at({ ci: 'pending', carriedReviewUrl: APPROVAL_URL });
  assert.equal(carried.action, 'carry');
  assert.equal(carried.event, null);
  assert.equal(carried.carriedReviewUrl, APPROVAL_URL);
  assert.equal(carried.exitCode, 0);
  for (const mapped of ['APPROVE', 'COMMENT', 'REQUEST_CHANGES']) {
    const decision = at({ mapped, ci: 'needs-rerun', rerun: [rerunEntry] });
    assert.equal(decision.event, null, mapped);
    assert.equal(decision.action, 'wait', mapped);
    assert.equal(decision.exitCode, 6, mapped);
  }
  const recheck = at({ ci: 'needs-rerun', recheck: true, rerun: [rerunEntry] });
  assert.equal(recheck.exitCode, 6);
});

test('decide: never_approve keeps its own texts when both apply; the path reason wins over human review; an uncovered carry wins over both', () => {
  const both = at({ policy: { neverApprove: true } });
  assert.deepEqual(both.reasons, [NEVER]);
  assert.equal(both.cappedByPolicy, true);
  assert.deepEqual(at({ recheck: true, policy: { neverApprove: true } }).reasons, [NEVER_RECHECK]);

  const human = at({ needsHuman: true });
  assert.equal(human.event, 'COMMENT');
  assert.deepEqual(human.reasons, [REASON]);

  const uncovered = at({ uncoveredCarry: true });
  assert.equal(uncovered.event, 'COMMENT');
  assert.equal(uncovered.cappedByPolicy, false);
  assert.ok(uncovered.reasons.some((reason) => reason.includes('carried to this head')));
  assert.ok(!uncovered.reasons.includes(REASON));
});

test('decide: without a path hold an APPROVE still approves', () => {
  const decision = decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: false, approvalPathHold: null });
  assert.equal(decision.event, 'APPROVE');
  assert.equal(decision.cappedByPolicy, false);
});

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const run = (name, status, conclusion = null, id = 1) => ({
  id,
  name,
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-10-01T10:00:00Z' : null,
});
const GREEN = [run('build', 'completed', 'success')];
const RED = [run('build', 'completed', 'failure')];
const BASE = 'c'.repeat(40);
// As GitHub names it: the commit the entry shows, the head, and the base for a deletion.
const contents = (filename, ref) => `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent(filename)}?ref=${ref}`;
const file = (filename, previous, ref = HEAD) => ({
  filename,
  status: previous === undefined ? 'modified' : 'renamed',
  ...(previous === undefined ? {} : { previous_filename: previous }),
  contents_url: contents(filename, ref),
});
const removed = (filename) => ({ filename, status: 'removed', contents_url: contents(filename, BASE) });

/** The fake at test/never-approve.test.mjs, which also serves the files list and records every path it was asked for. */
function fakeGitHub({ checks = [GREEN], files = [], head = HEAD } = {}) {
  let checkReads = 0;
  const requests = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    requests.push(parsed.pathname);
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: head } });
    if (parsed.pathname.endsWith('/files')) {
      if (files === null) return new Response('not found', { status: 404 });
      if (!Array.isArray(files)) return json(files);
      // Paged as GitHub pages it: per_page capped at 100, a Link to the next page while more remain.
      const perPage = Math.min(Number(parsed.searchParams.get('per_page') ?? 30), 100);
      const page = Number(parsed.searchParams.get('page') ?? 1);
      const more = page * perPage < files.length;
      const link = `<${parsed.origin}${parsed.pathname}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      return json(files.slice((page - 1) * perPage, page * perPage), 200, more ? { link } : {});
    }
    if (parsed.pathname.endsWith('/reviews')) return json([]);
    if (parsed.pathname.endsWith('/check-runs')) {
      const runs = checks[Math.min(checkReads, checks.length - 1)];
      checkReads += 1;
      return json({ total_count: runs.length, check_runs: runs });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.filesRequests = () => requests.filter((path) => path.endsWith('/files')).length;
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-approval-paths-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    await body(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN = 'No actionable findings.';
const NIT = '[nit] `src/cart.ts:40` - This name shadows the import.';
const MINOR = '[minor] `src/cart.ts:40` - This name shadows the import.';
const verified = (path, line, severity) => ({
  candidateId: `${path}:${line}`,
  path,
  line,
  severity: { severity },
  confidenceSource: 'verifier',
  eligible: true,
});

function verdict(db, impl, review, extra = {}) {
  return computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review, owner: OWNER, ...extra });
}

/** The reasons the guards gave; the fixture records no complexity assessment, which computeVerdict notes on every run. */
const guardReasons = (output) => output.reasons.filter((reason) => reason !== 'no complexity assessment was recorded for this run');

const record = (db, output = CLEAN, scores = []) =>
  recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, scores });

const NEVER_DB = { neverApprovePaths: ['db/migrate/**'] };
const ONLY_DOCS = { onlyApprovePaths: ['docs/**'] };

test('end to end: a change under never_approve_paths comments, the summary names the setting and the reason names the path', async () => {
  await withDb(async (db) => {
    record(db);
    const github = fakeGitHub({ files: [file('db/migrate/001.sql'), file('src/a.ts')] });
    const { exitCode, output } = await verdict(db, github, CLEAN, { policy: NEVER_DB });
    assert.equal(exitCode, 0);
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.action, 'post');
    assert.equal(output.cappedByPolicy, true);
    assert.equal(output.payload.body, `No problems found. ${NEVER_SENTENCE}`);
    assert.deepEqual(guardReasons(output), [REASON]);
    assert.ok(!output.payload.body.includes('db/migrate'));
    assert.equal(github.filesRequests(), 1);
  });
  await withDb(async (db) => {
    record(db, NIT, [verified('src/cart.ts', 40, 'nit')]);
    const { output } = await verdict(db, fakeGitHub({ files: [file('db/migrate/001.sql')] }), NIT, { policy: NEVER_DB });
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.payload.body, `1 nit. ${NEVER_SENTENCE}`);
  });
});

test('end to end: a deleted guarded file holds', async () => {
  await withDb(async (db) => {
    record(db);
    const github = fakeGitHub({ files: [{ filename: 'db/migrate/001.sql', status: 'removed' }, file('src/a.ts')] });
    const { output } = await verdict(db, github, CLEAN, { policy: NEVER_DB });
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.payload.body, `No problems found. ${NEVER_SENTENCE}`);
    assert.deepEqual(guardReasons(output), [REASON]);
  });
});

test('end to end: the files list is read to its last page, where the guarded path is', async () => {
  await withDb(async (db) => {
    record(db);
    const files = [...Array.from({ length: 100 }, (_, i) => file(`docs/${i}.md`)), file('db/migrate/001.sql')];
    const github = fakeGitHub({ files });
    const { output } = await verdict(db, github, CLEAN, { policy: NEVER_DB });
    assert.equal(output.event, 'COMMENT');
    assert.deepEqual(guardReasons(output), [REASON]);
    assert.equal(github.filesRequests(), 2);
  });
});

test('end to end: a rename out of a guarded directory holds, and red CI under annotate keeps its annotation', async () => {
  await withDb(async (db) => {
    record(db);
    const github = fakeGitHub({ checks: [RED], files: [file('src/moved.sql', 'db/migrate/001.sql')] });
    const { output } = await verdict(db, github, CLEAN, { policy: { ...NEVER_DB, ciRed: 'annotate' } });
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.payload.body, `No problems found. ${NEVER_SENTENCE}\n\n${FAILING}`);
    assert.deepEqual(output.annotations, [FAILING]);
    assert.deepEqual(guardReasons(output), [REASON]);
  });
});

test('end to end: only_approve_paths approves a change inside it and comments on one that leaves it', async () => {
  await withDb(async (db) => {
    record(db);
    const { output } = await verdict(db, fakeGitHub({ files: [file('docs/a.md')] }), CLEAN, { policy: ONLY_DOCS });
    assert.equal(output.event, 'APPROVE');
    assert.equal(output.cappedByPolicy, false);
    assert.equal(output.payload.body, 'No problems found.');
  });
  await withDb(async (db) => {
    record(db);
    const { output } = await verdict(db, fakeGitHub({ files: [file('docs/a.md'), file('src/a.ts')] }), CLEAN, { policy: ONLY_DOCS });
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.cappedByPolicy, true);
    assert.equal(output.payload.body, `No problems found. ${ONLY_SENTENCE}`);
    assert.deepEqual(guardReasons(output), [OUTSIDE('src/a.ts')]);
  });
});

test('end to end: 3000 listed files hold as possibly truncated, read in 30 pages', async () => {
  await withDb(async (db) => {
    record(db);
    // One past the ceiling, so the reader's own bound is what stops the read, not the end of the list.
    const files = Array.from({ length: 3001 }, (_, i) => file(`docs/${i}.md`));
    const github = fakeGitHub({ files });
    const { output } = await verdict(db, github, CLEAN, { policy: ONLY_DOCS });
    assert.equal(output.event, 'COMMENT');
    assert.deepEqual(guardReasons(output), [TRUNCATED]);
    assert.equal(output.payload.body, `No problems found. ${UNCHECKED('only_approve_paths')}`);
    assert.equal(github.filesRequests(), 30);
  });
});

test('end to end: no files request with both lists empty, a mapped COMMENT, never_approve on, or a moved head', async () => {
  await withDb(async (db) => {
    record(db);
    const github = fakeGitHub({ files: [file('db/migrate/001.sql')] });
    const { output } = await verdict(db, github, CLEAN);
    assert.equal(output.event, 'APPROVE');
    assert.equal(github.filesRequests(), 0);
  });
  await withDb(async (db) => {
    record(db, MINOR, [verified('src/cart.ts', 40, 'minor')]);
    const github = fakeGitHub({ files: [file('db/migrate/001.sql')] });
    const { output } = await verdict(db, github, MINOR, { policy: NEVER_DB });
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.cappedByPolicy, false);
    assert.equal(output.payload.body, '1 comment, the highest minor.');
    assert.equal(github.filesRequests(), 0);
  });
  await withDb(async (db) => {
    record(db);
    const github = fakeGitHub({ files: [file('db/migrate/001.sql')] });
    const { output } = await verdict(db, github, CLEAN, { policy: { ...NEVER_DB, neverApprove: true } });
    assert.equal(output.event, 'COMMENT');
    assert.deepEqual(guardReasons(output), [NEVER]);
    assert.equal(output.payload.body, 'No problems found.');
    assert.equal(github.filesRequests(), 0);
  });
  await withDb(async (db) => {
    record(db);
    const github = fakeGitHub({ files: [file('db/migrate/001.sql')], head: 'b'.repeat(40) });
    const { exitCode } = await verdict(db, github, CLEAN, { policy: NEVER_DB });
    assert.equal(exitCode, 3);
    assert.equal(github.filesRequests(), 0);
  });
});

test('end to end: a 404 for the files list rejects, so nothing is posted', async () => {
  await withDb(async (db) => {
    record(db);
    await assert.rejects(verdict(db, fakeGitHub({ files: null }), CLEAN, { policy: NEVER_DB }));
  });
});

test('end to end: a 200 files response that is not a list rejects like a 404, so nothing is posted', async () => {
  await withDb(async (db) => {
    record(db);
    // paginate() would read this as an empty list, and an empty list approves.
    await assert.rejects(verdict(db, fakeGitHub({ files: { message: 'not a list' } }), CLEAN, { policy: NEVER_DB }), GitHubError);
  });
});

test('end to end: a list that did not load holds every approval without reading the files', async () => {
  await withDb(async (db) => {
    record(db);
    const github = fakeGitHub({ files: [file('docs/a.md')] });
    const { output } = await verdict(db, github, CLEAN, { policy: { malformedApprovalPaths: 'never_approve_paths' } });
    assert.equal(output.event, 'COMMENT');
    assert.equal(output.cappedByPolicy, true);
    assert.equal(output.payload.body, `No problems found. ${UNCHECKED('never_approve_paths')}`);
    assert.ok(output.reasons.some((reason) => reason.includes('verdict.never_approve_paths did not load')));
    assert.equal(github.filesRequests(), 0);
  });
});

function configFrom(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-approval-paths-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    return loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config: both lists are read as new arrays, default empty, and the defaults are never mutated', () => {
  const config = configFrom('verdict:\n  never_approve_paths: ["db/migrate/**"]\n  only_approve_paths:\n    - "docs/**"\n    - "*.md"\n');
  assert.deepEqual(config.verdictPolicy.neverApprovePaths, ['db/migrate/**']);
  assert.deepEqual(config.verdictPolicy.onlyApprovePaths, ['docs/**', '*.md']);
  assert.equal(config.verdictPolicy.malformedApprovalPaths, null);
  assert.deepEqual(config.warnings, []);

  const defaults = configFrom('verdict:\n  never_approve: false\n');
  assert.deepEqual(defaults.verdictPolicy.neverApprovePaths, []);
  assert.deepEqual(defaults.verdictPolicy.onlyApprovePaths, []);
  assert.notEqual(defaults.verdictPolicy.neverApprovePaths, DEFAULT_VERDICT_POLICY.neverApprovePaths);
  assert.equal(defaults.verdictPolicy.malformedApprovalPaths, null);
  assert.deepEqual(DEFAULT_VERDICT_POLICY.neverApprovePaths, []);
  assert.deepEqual(DEFAULT_VERDICT_POLICY.onlyApprovePaths, []);

  const empty = configFrom('verdict:\n  never_approve_paths: []\n  only_approve_paths: []\n');
  assert.deepEqual(empty.verdictPolicy.neverApprovePaths, []);
  assert.deepEqual(empty.warnings, []);
});

test('config: a malformed list fails closed, with a warning naming the key and the entry', () => {
  const malformations = [
    ['not a list', 'verdict:\n  never_approve_paths: "db/**"\n', 'never_approve_paths', '"db/**"'],
    ['a mapping', 'verdict:\n  only_approve_paths: { a: 1 }\n', 'only_approve_paths', '{"a":1}'],
    ['a non-string entry', 'verdict:\n  only_approve_paths: ["docs/**", 3]\n', 'only_approve_paths', '3'],
    ['a null entry', 'verdict:\n  never_approve_paths:\n    - "db/**"\n    -\n', 'never_approve_paths', 'null'],
    ['a blank entry', 'verdict:\n  never_approve_paths: ["db/**", "  "]\n', 'never_approve_paths', '"  "'],
    ['a list that refers to itself', 'verdict:\n  never_approve_paths: &x [*x]\n', 'never_approve_paths', 'a value that refers to itself'],
  ];
  for (const [name, yaml, key, entry] of malformations) {
    const config = configFrom(yaml);
    assert.equal(config.verdictPolicy.malformedApprovalPaths, key, name);
    assert.deepEqual(config.verdictPolicy.neverApprovePaths, [], name);
    assert.deepEqual(config.verdictPolicy.onlyApprovePaths, [], name);
    assert.deepEqual(
      config.warnings,
      [`verdict.${key} must be a list of globs; ${entry} is not one, so every approval is held until it is fixed.`],
      name,
    );
    // The loaded policy holds the approval as the loader left it.
    assert.ok(approvalPathHold(changed(['docs/a.md']), config.verdictPolicy).reason.includes(`verdict.${key} did not load`), name);
  }
  // The first malformed list is named when both are.
  const both = configFrom('verdict:\n  never_approve_paths: 1\n  only_approve_paths: 2\n');
  assert.equal(both.verdictPolicy.malformedApprovalPaths, 'never_approve_paths');
  assert.equal(both.warnings.length, 2);
  // The rest of the document is still read after a list the loader could not show.
  const cyclic = configFrom('verdict:\n  never_approve_paths: &x [*x]\n  scope_block: true\n');
  assert.equal(cyclic.verdictPolicy.malformedApprovalPaths, 'never_approve_paths');
  assert.equal(cyclic.verdictPolicy.scopeBlock, true);
});

test('documentation: help, the example config, draft-review.md, WATCHER.md, ADR 0028 and the ADR index name both keys', () => {
  const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
  const help = execFileSync(process.execPath, [bundle, 'verdict', '--help'], { encoding: 'utf8' });
  assert.ok(help.includes('verdict.never_approve_paths:'));
  assert.ok(help.includes('verdict.only_approve_paths:'));

  const example = readFileSync(join(root, 'plugins/review-voice/templates/config.example.yaml'), 'utf8');
  assert.ok(example.includes('never_approve_paths: []'));
  assert.ok(example.includes('only_approve_paths: []'));
  const dir = mkdtempSync(join(tmpdir(), 'rv-approval-paths-example-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), example);
    assert.deepEqual(loadConfig(dir).warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const adr = readFileSync(join(root, 'docs/adr/0028-verdict-policies-are-configurable.md'), 'utf8');
  assert.match(adr, /## Amendment - 2026/);
  assert.ok(adr.includes('never_approve_paths'));
  for (const doc of ['docs/adr/README.md', 'plugins/review-voice/commands/draft-review.md', 'docs/WATCHER.md']) {
    const text = readFileSync(join(root, doc), 'utf8');
    assert.ok(text.includes('never_approve_paths'), doc);
    assert.ok(text.includes('only_approve_paths'), doc);
  }
});

const TERMINATORS = [
  ['a line feed', '\n'],
  ['a carriage return', '\r'],
  ['a line separator', '\u2028'],
  ['a paragraph separator', '\u2029'],
];

test('globToRegExp: every wildcard matches a line terminator in a name, and * and ? still stop at a slash', () => {
  for (const [name, t] of TERMINATORS) {
    const cases = [
      ['db/migrate/**', `db/migrate/a${t}b.sql`, true],
      ['db/migrate/**', `db/migrate/${t}/b.sql`, true],
      ['**/*.sql', `db${t}x/migrate/a.sql`, true],
      ['**', `a${t}b/c`, true],
      ['db/*.sql', `db/a${t}b.sql`, true],
      ['db/?.sql', `db/${t}.sql`, true],
      ['db/*.sql', `db/a${t}/b.sql`, false],
      ['db/?', `db/${t}/`, false],
      // Anchored to the whole name: a terminator is not a line boundary.
      ['db/migrate/**', `x${t}db/migrate/a.sql`, false],
      ['db/*.sql', `db/a.sql${t}`, false],
    ];
    for (const [glob, path, expected] of cases) {
      assert.equal(globToRegExp(glob).test(path), expected, `${name}: ${glob} against ${JSON.stringify(path)}`);
    }
  }
});

/** postReview with an APPROVE confirmed, and a writer that records every event it is asked to send. */
async function confirmApprove(db, impl, policy, postingEnabled = true) {
  const sent = [];
  const writer = {
    submitReview: async (_repository, _pull, payload) => {
      sent.push(payload.event);
      return { id: 1, htmlUrl: 'https://example.com/review/1', state: payload.event };
    },
  };
  const { exitCode, output } = await postReview({
    db,
    client: client(impl),
    writerFor: () => writer,
    repository: REPO,
    pullNumber: PR,
    head: HEAD,
    review: CLEAN,
    owner: OWNER,
    confirm: true,
    event: 'APPROVE',
    postingEnabled,
    policy,
  });
  return { exitCode, output, sent };
}

test('postReview: a guarded filename holding a line terminator cannot be approved under either list', async () => {
  for (const [name, t] of TERMINATORS) {
    const guarded = `db/migrate/a${t}b.sql`;
    for (const [setting, rule, reason] of [
      ['never_approve_paths', NEVER_DB, MATCHES(guarded)],
      ['only_approve_paths', ONLY_DOCS, OUTSIDE(guarded)],
    ]) {
      await withDb(async (db) => {
        record(db);
        const { output, sent } = await confirmApprove(db, fakeGitHub({ files: [file('docs/a.md'), file(guarded)] }), rule);
        assert.deepEqual(sent, [], `${name}, ${setting}`);
        assert.equal(output.verdict.event, 'COMMENT', `${name}, ${setting}`);
        assert.equal(output.verdict.cappedByPolicy, true, `${name}, ${setting}`);
        assert.deepEqual(guardReasons(output.verdict), [reason], `${name}, ${setting}`);
      });
    }
  }
});

const UNNAMED = 'approval is left to a person, as GitHub listed a changed file without a usable name, so the approval paths cannot be checked';

test('postReview: a files list with an entry it cannot name holds the approval as a cut list does', async () => {
  // The harness can approve: a well-formed list inside only_approve_paths sends the APPROVE.
  await withDb(async (db) => {
    record(db);
    const { sent } = await confirmApprove(db, fakeGitHub({ files: [file('docs/a.md')] }), ONLY_DOCS);
    assert.deepEqual(sent, ['APPROVE']);
  });
  const malformed = [
    ['an entry without a filename', [{}]],
    ['an empty filename', [file('docs/a.md'), { filename: '', status: 'added' }]],
    ['a rename without its previous name', [{ filename: 'docs/a.sql', status: 'renamed', previous_filename: null }]],
    ['a rename with an empty previous name', [{ filename: 'docs/a.sql', status: 'renamed', previous_filename: '' }]],
    ['a string entry', [file('docs/a.md'), 'db/migrate/001.sql']],
    ['a null entry', [file('docs/a.md'), null]],
    ['a list entry', [file('docs/a.md'), ['db/migrate/001.sql']]],
  ];
  for (const [name, files] of malformed) {
    for (const [setting, rule] of [['never_approve_paths', NEVER_DB], ['only_approve_paths', ONLY_DOCS]]) {
      await withDb(async (db) => {
        record(db);
        const { output, sent } = await confirmApprove(db, fakeGitHub({ files }), rule);
        assert.deepEqual(sent, [], `${name}, ${setting}`);
        assert.equal(output.verdict.event, 'COMMENT', `${name}, ${setting}`);
        assert.equal(output.verdict.cappedByPolicy, true, `${name}, ${setting}`);
        assert.equal(output.verdict.payload.body, `No problems found. ${UNCHECKED(setting)}`, `${name}, ${setting}`);
        assert.deepEqual(guardReasons(output.verdict), [UNNAMED], `${name}, ${setting}`);
      });
    }
  }
});

const OTHER = 'b'.repeat(40);
const UNTIED = 'approval is left to a person, as GitHub did not list the files of the commit being approved, so the approval paths cannot be checked';

/**
 * A fake GitHub where each read of the pull request, and each page of its
 * files, sees the next head in `timeline`, as force pushes between the reads
 * would leave it; `lists` holds each head's files list.
 */
function forcePushed(timeline, lists) {
  let reads = 0;
  const seen = [];
  const next = () => timeline[Math.min(reads++, timeline.length - 1)];
  const impl = async (url, init) => {
    const { pathname } = new URL(String(url));
    if (/\/pulls\/\d+$/.test(pathname)) {
      const head = next();
      seen.push(`head ${head[0]}`);
      return json({ head: { sha: head } });
    }
    if (pathname.endsWith('/files')) {
      const head = next();
      seen.push(`files ${head[0]}`);
      return fakeGitHub({ files: lists[head] })(url, init);
    }
    return fakeGitHub()(url, init);
  };
  impl.seen = seen;
  return impl;
}

test('postReview: a force push away and back between the head read and the files read sends no approval', async () => {
  const cases = [
    ['never_approve_paths', NEVER_DB, [file('db/migrate/001.sql'), file('src/a.ts')], [file('src/a.ts', undefined, OTHER)]],
    ['only_approve_paths', ONLY_DOCS, [file('docs/a.md'), file('src/a.ts')], [file('docs/a.md', undefined, OTHER)]],
  ];
  for (const [setting, rule, atHead, atOther] of cases) {
    // Without the push the head list holds, so the push is what the guard has to see.
    await withDb(async (db) => {
      record(db);
      const { sent, output } = await confirmApprove(db, forcePushed([HEAD], { [HEAD]: atHead }), rule);
      assert.deepEqual(sent, [], setting);
      assert.equal(output.verdict.event, 'COMMENT', setting);
    });
    await withDb(async (db) => {
      record(db);
      const github = forcePushed([HEAD, OTHER, HEAD], { [HEAD]: atHead, [OTHER]: atOther });
      const { exitCode, output, sent } = await confirmApprove(db, github, rule);
      assert.deepEqual(github.seen.slice(0, 2), ['head a', 'files b'], setting);
      assert.deepEqual(sent, [], setting);
      assert.equal(exitCode, 3, setting);
      assert.equal(output.verdict.event, 'COMMENT', setting);
      assert.equal(output.verdict.cappedByPolicy, true, setting);
      assert.equal(output.verdict.payload.body, `No problems found. ${UNCHECKED(setting)}`, setting);
      assert.deepEqual(guardReasons(output.verdict), [UNTIED], setting);
    });
  }
});

test('postReview: a later page read after a force push holds, even when that page names no commit', async () => {
  const docs = Array.from({ length: 100 }, (_, i) => file(`docs/${i}.md`));
  const elsewhere = Array.from({ length: 100 }, (_, i) => file(`docs/${i}.md`, undefined, OTHER));
  // The second page of the head list is the guarded path; the other commit's is a deletion, or nothing.
  for (const [name, atOther] of [
    ['a page of deletions', [...elsewhere, removed('docs/old.md')]],
    ['an empty page', elsewhere],
  ]) {
    await withDb(async (db) => {
      record(db);
      const github = forcePushed([HEAD, HEAD, OTHER, HEAD], { [HEAD]: [...docs, file('db/migrate/001.sql')], [OTHER]: atOther });
      const { output, sent } = await confirmApprove(db, github, ONLY_DOCS);
      assert.deepEqual(github.seen.slice(0, 3), ['head a', 'files a', 'files b'], name);
      assert.deepEqual(sent, [], name);
      assert.deepEqual(guardReasons(output.verdict), [UNTIED], name);
    });
  }
});

test('postReview: a files list is used only when every page names the head being approved', async () => {
  // A deletion names the base, so a list that also names the head approves.
  await withDb(async (db) => {
    record(db);
    const { sent } = await confirmApprove(db, fakeGitHub({ files: [removed('docs/old.md'), file('docs/a.md')] }), ONLY_DOCS);
    assert.deepEqual(sent, ['APPROVE']);
  });
  const untied = [
    ['an entry naming another commit', [file('docs/a.md'), file('docs/b.md', undefined, OTHER)]],
    ['an entry without a contents_url', [file('docs/a.md'), { filename: 'docs/b.md', status: 'added' }]],
    // Nothing in a list of deletions shows which commit it is, so it holds.
    ['only deletions', [removed('docs/old.md')]],
    ['no files', []],
  ];
  for (const [name, files] of untied) {
    for (const [setting, rule] of [['never_approve_paths', NEVER_DB], ['only_approve_paths', ONLY_DOCS]]) {
      await withDb(async (db) => {
        record(db);
        const { output, sent } = await confirmApprove(db, fakeGitHub({ files }), rule);
        assert.deepEqual(sent, [], `${name}, ${setting}`);
        assert.equal(output.verdict.event, 'COMMENT', `${name}, ${setting}`);
        assert.equal(output.verdict.payload.body, `No problems found. ${UNCHECKED(setting)}`, `${name}, ${setting}`);
        assert.deepEqual(guardReasons(output.verdict), [UNTIED], `${name}, ${setting}`);
      });
    }
  }
});

test('config: a document that throws partway leaves posting off, so the approval paths it never reached cannot be bypassed', async () => {
  const POST = 'writes:\n  github_posting_enabled: true\n';
  // A self-referring alias in ci: throws after writes: has turned posting on and before verdict: is read.
  const CYCLIC = 'ci:\n  rerun_signatures: &x [*x]\n';
  for (const [setting, yaml, path] of [
    ['never_approve_paths', 'verdict:\n  never_approve_paths: ["db/migrate/**"]\n', 'db/migrate/001.sql'],
    ['only_approve_paths', 'verdict:\n  only_approve_paths: ["docs/**"]\n', 'src/a.ts'],
  ]) {
    const clean = configFrom(POST + yaml);
    assert.equal(clean.postingEnabled, true, setting);

    const config = configFrom(POST + CYCLIC + yaml);
    assert.equal(config.postingEnabled, false, setting);
    assert.ok(
      config.warnings.some((warning) => warning.startsWith('.review-voice/config.yaml could not be parsed, so posting is off')),
      setting,
    );
    await withDb(async (db) => {
      record(db);
      const github = fakeGitHub({ files: [file(path)] });
      const { exitCode, sent } = await confirmApprove(db, github, config.verdictPolicy, config.postingEnabled);
      assert.deepEqual(sent, [], setting);
      assert.equal(exitCode, 2, setting);
    });
  }
});

test('globToRegExp: ? matches one character outside the BMP, so such a name cannot escape never_approve_paths', async () => {
  const emoji = '\u{1F600}';
  const cases = [
    ['db/v?/**', `db/v${emoji}/001.sql`, true],
    ['db/?.sql', 'db/\u{10400}.sql', true],
    ['db/?.sql', `db/${emoji}${emoji}.sql`, false],
  ];
  for (const [glob, path, expected] of cases) {
    assert.equal(globToRegExp(glob).test(path), expected, `${glob} against ${JSON.stringify(path)}`);
  }

  const guarded = `db/v${emoji}/001.sql`;
  await withDb(async (db) => {
    record(db);
    const { output, sent } = await confirmApprove(db, fakeGitHub({ files: [file(guarded)] }), { neverApprovePaths: ['db/v?/**'] });
    assert.deepEqual(sent, []);
    assert.equal(output.verdict.event, 'COMMENT');
    assert.deepEqual(guardReasons(output.verdict), [MATCHES(guarded)]);
  });
});
