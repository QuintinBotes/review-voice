import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const run = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function identity(cwd) {
  run(cwd, 'config', 'user.email', 'test@example.com');
  run(cwd, 'config', 'user.name', 'Test');
  run(cwd, 'config', 'commit.gpgsign', 'false');
}

/**
 * An origin whose path ends in github.com/org/a.git, so the repository guard
 * recognises it, with a base branch that moved on after the pull request was cut.
 */
function scenario() {
  const top = mkdtempSync(join(tmpdir(), 'rv-basefetch-'));
  const origin = join(top, 'github.com', 'org', 'a.git');
  mkdirSync(origin, { recursive: true });
  run(origin, 'init', '-q', '--bare', '-b', 'main');
  run(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

  const author = join(top, 'author');
  run(top, 'clone', '-q', origin, author);
  identity(author);
  run(author, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(author, 'a.txt'), 'a\n');
  run(author, 'add', '-A');
  run(author, 'commit', '-q', '-m', 'one');
  run(author, 'push', '-q', 'origin', 'main');

  const work = join(top, 'work');
  run(top, 'clone', '-q', origin, work);
  identity(work);

  run(author, 'checkout', '-q', '-b', 'topic');
  writeFileSync(join(author, 'b.txt'), 'b\n');
  run(author, 'add', '-A');
  run(author, 'commit', '-q', '-m', 'topic');
  const head = run(author, 'rev-parse', 'HEAD');
  run(author, 'push', '-q', 'origin', 'topic:refs/pull/7/head');

  run(author, 'checkout', '-q', 'main');
  writeFileSync(join(author, 'c.txt'), 'c\n');
  run(author, 'add', '-A');
  run(author, 'commit', '-q', '-m', 'main moves on');
  const base = run(author, 'rev-parse', 'HEAD');
  run(author, 'push', '-q', 'origin', 'main');
  return { top, work, base, head };
}

test('a base commit the pull ref does not reach is fetched by sha', async () => {
  const { top, work, base, head } = scenario();
  try {
    assert.throws(() => run(work, 'cat-file', '-e', `${base}^{commit}`), 'the clone starts without the new base');

    const { acquirePullRequestDiff } = await import('../plugins/review-voice/src/diff/pull-request.ts');
    const original = globalThis.fetch;
    globalThis.fetch = async (url) =>
      /\/pulls\/\d+$/.test(String(url))
        ? new Response(
            JSON.stringify({
              number: 7, title: 't', base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'topic' },
              changed_files: 1, additions: 1, deletions: 0,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : new Response(
            JSON.stringify([{ filename: 'b.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+b' }]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
    let result;
    try {
      process.env.GITHUB_TOKEN = 'test-token';
      result = await acquirePullRequestDiff({
        repository: 'org/a', pullNumber: 7, includeGenerated: false, cwd: work,
      });
    } finally {
      globalThis.fetch = original;
      delete process.env.GITHUB_TOKEN;
    }

    assert.equal(result.refs.head.available, true);
    assert.equal(result.refs.base.available, true);
    assert.equal(result.refs.note, null);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
