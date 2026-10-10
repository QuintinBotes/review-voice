/**
 * A previous head this clone does not have is fetched by sha before the
 * follow-up gives up on a narrower read.
 *
 * After a force-push the reviewed head is reachable from no ref the clone
 * fetched, though origin still has it. Only an origin that is the repository
 * under review is asked; any other origin would supply a commit from the wrong
 * project.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';
import * as prior from '../plugins/review-voice/src/diff/prior.ts';

const run = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function identity(cwd) {
  run(cwd, 'config', 'user.email', 'test@example.com');
  run(cwd, 'config', 'user.name', 'Test');
  run(cwd, 'config', 'commit.gpgsign', 'false');
}

/**
 * An origin whose path ends in github.com/org/a.git. The reviewed head was
 * pushed to the pull ref and then replaced by an amended commit; the working
 * clone has only the current pull head.
 */
function scenario() {
  const top = mkdtempSync(join(tmpdir(), 'rv-priorfetch-'));
  const origin = join(top, 'github.com', 'org', 'a.git');
  mkdirSync(origin, { recursive: true });
  run(origin, 'init', '-q', '--bare', '-b', 'main');
  run(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

  const author = join(top, 'author');
  run(top, 'clone', '-q', origin, author);
  identity(author);
  run(author, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(author, 'a.txt'), 'one\ntwo\nthree\n');
  run(author, 'add', '-A');
  run(author, 'commit', '-q', '-m', 'one');
  run(author, 'push', '-q', 'origin', 'main');
  const base = run(author, 'rev-parse', 'HEAD');

  run(author, 'checkout', '-q', '-b', 'topic');
  writeFileSync(join(author, 'a.txt'), 'one\ntwo\nreviewed\nthree\n');
  run(author, 'add', '-A');
  run(author, 'commit', '-q', '-m', 'topic');
  const reviewed = run(author, 'rev-parse', 'HEAD');
  run(author, 'push', '-q', 'origin', 'topic:refs/pull/7/head');

  writeFileSync(join(author, 'a.txt'), 'one\ntwo\nreviewed\nthree\nfollow-up\n');
  run(author, 'add', '-A');
  run(author, 'commit', '-q', '--amend', '-m', 'topic, amended');
  const head = run(author, 'rev-parse', 'HEAD');
  run(author, 'push', '-q', '-f', 'origin', 'topic:refs/pull/7/head');

  const work = join(top, 'work');
  // `--no-local`: a local clone copies the whole object store, unreachable
  // commits included, and the reviewed head would already be there.
  run(top, 'clone', '-q', '--no-local', origin, work);
  identity(work);
  run(work, 'fetch', '-q', 'origin', 'refs/pull/7/head:refs/review-voice/pr/7/head');
  return { top, work, base, reviewed, head };
}

const plan = (work, scenarioRefs, repository) =>
  planScope({
    priorRun: { reviewRunId: null, headRef: scenarioRefs.reviewed, createdAt: null },
    head: scenarioRefs.head,
    headAvailable: true,
    reviewedFiles: [{ path: 'a.txt' }],
    cwd: work,
    truncated: false,
    forceFull: false,
    base: scenarioRefs.base,
    fetchPriorHead: (sha) => prior.fetchPriorHead(sha, repository, work),
  }).scope;

test('a previous head missing from the clone is fetched from the reviewed repository', () => {
  const refs = scenario();
  try {
    assert.throws(() => run(refs.work, 'cat-file', '-e', `${refs.reviewed}^{commit}`), 'the clone starts without the reviewed head');
    const scope = plan(refs.work, refs, 'org/a');
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.equal(scope.since, refs.reviewed);
    run(refs.work, 'cat-file', '-e', `${refs.reviewed}^{commit}`);
  } finally {
    rmSync(refs.top, { recursive: true, force: true });
  }
});

test('an origin that is not the reviewed repository is never fetched from', () => {
  const refs = scenario();
  try {
    const scope = plan(refs.work, refs, 'acme/web');
    assert.equal(scope.kind, 'full');
    assert.equal(scope.cause, 'compare-unavailable');
    assert.match(scope.detail, /previous head \w{7} is not in this clone; origin is org\/a, not acme\/web/);
    assert.throws(() => run(refs.work, 'cat-file', '-e', `${refs.reviewed}^{commit}`));
  } finally {
    rmSync(refs.top, { recursive: true, force: true });
  }
});

test('anything but a full commit id is never handed to git fetch', () => {
  assert.match(prior.fetchPriorHead('--upload-pack=touch x', 'org/a', process.cwd()), /not a full commit id/);
  assert.match(prior.fetchPriorHead('abc1234', 'org/a', process.cwd()), /not a full commit id/);
});
