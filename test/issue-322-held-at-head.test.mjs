/** #322: the past-the-end check on a held entry reads the file at --head, never the working tree. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

/** f.txt has 3 lines at the first commit and 12 at the second; the working tree is left at the first. */
function recordHeld(line) {
  const base = mkdtempSync(join(tmpdir(), 'rv-322-'));
  const repo = join(base, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'f.txt'), lines(3));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'f.txt'), lines(12));
    git('commit', '-q', '-am', 'second');
    const second = git('rev-parse', 'HEAD');
    writeFileSync(join(base, 'd.patch'), `${git('diff', first, second)}\n`);
    git('checkout', '-q', first);
    writeFileSync(join(base, 'c.json'), JSON.stringify({ candidates: [{ path: 'f.txt', line }] }));
    writeFileSync(join(base, 'h.json'), JSON.stringify({ held: [{ path: 'f.txt', line, verdict: 'unverified', source: 's', reason: 'r' }] }));
    return spawnSync(
      process.execPath,
      [
        bundle,
        'record',
        '--repository',
        'o/r',
        '--base',
        first,
        '--head',
        second,
        '--diff-file',
        join(base, 'd.patch'),
        '--candidates',
        join(base, 'c.json'),
        '--held',
        join(base, 'h.json'),
      ],
      { cwd: repo, encoding: 'utf8', input: 'No actionable findings.', env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(base, 'data') } },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('a held line that exists at --head is not warned about when the working tree is older', () => {
  const done = recordHeld(10);
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(done.stderr, /past the end/);
});

test('a held line past the end at --head is warned about with the line count at --head', () => {
  const done = recordHeld(13);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /Held entry f\.txt:13 is past the end of the file \(12 lines\)/);
});

/** f.txt has 3 lines at HEAD and 12 in the working tree, or in the index on a staged review; `diff --out` writes the manifest. */
function recordUncommittedHeld(line, { staged = false, head = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rv-322-wt-'));
  const repo = join(base, 'repo');
  const out = join(base, 'out');
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: join(base, 'data') };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'f.txt'), lines(3));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'f.txt'), lines(12));
    if (staged) {
      git('add', 'f.txt');
      writeFileSync(join(repo, 'f.txt'), lines(3));
    }
    execFileSync(process.execPath, [bundle, 'diff', ...(staged ? ['--staged'] : []), '--out', out], { cwd: repo, env, stdio: 'ignore' });
    writeFileSync(join(base, 'h.json'), JSON.stringify({ held: [{ path: 'f.txt', line, verdict: 'unverified', source: 's', reason: 'r' }] }));
    return spawnSync(
      process.execPath,
      [
        bundle,
        'record',
        '--repository',
        'o/r',
        ...(head ? ['--head', git('rev-parse', 'HEAD')] : []),
        '--diff-file',
        join(out, 'diff.patch'),
        '--files',
        join(out, 'files.json'),
        '--held',
        join(base, 'h.json'),
      ],
      { cwd: repo, encoding: 'utf8', input: 'No actionable findings.', env },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('a working-tree review checks a held line against the working tree, with or without --head', () => {
  for (const head of [true, false]) {
    const added = recordUncommittedHeld(10, { head });
    assert.equal(added.status, 0, added.stderr);
    assert.doesNotMatch(added.stderr, /past the end/, `--head passed: ${head}`);
    const past = recordUncommittedHeld(13, { head });
    assert.match(past.stderr, /Held entry f\.txt:13 is past the end of the file \(12 lines\)/, `--head passed: ${head}`);
  }
});

test('a staged review checks a held line against the index, not HEAD or the working tree', () => {
  const added = recordUncommittedHeld(10, { staged: true });
  assert.equal(added.status, 0, added.stderr);
  assert.doesNotMatch(added.stderr, /past the end/);
  assert.match(recordUncommittedHeld(13, { staged: true }).stderr, /Held entry f\.txt:13 is past the end of the file \(12 lines\)/);
});

/** A base review: main has f.txt at 3 lines, feat at 12; `diff --base main --out` runs on feat, then `checkout` is checked out. */
function recordBaseHeld(line, head, checkout = 'feat') {
  const base = mkdtempSync(join(tmpdir(), 'rv-322-base-'));
  const repo = join(base, 'repo');
  const out = join(base, 'out');
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: join(base, 'data') };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'f.txt'), lines(3));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    git('branch', '-M', 'main');
    git('checkout', '-q', '-b', 'feat');
    writeFileSync(join(repo, 'f.txt'), lines(12));
    git('commit', '-q', '-am', 'second');
    execFileSync(process.execPath, [bundle, 'diff', '--base', 'main', '--out', out], { cwd: repo, env, stdio: 'ignore' });
    git('checkout', '-q', checkout);
    writeFileSync(join(base, 'h.json'), JSON.stringify({ held: [{ path: 'f.txt', line, verdict: 'unverified', source: 's', reason: 'r' }] }));
    return spawnSync(
      process.execPath,
      [
        bundle,
        'record',
        '--repository',
        'o/r',
        ...(head === null ? [] : ['--head', head]),
        '--diff-file',
        join(out, 'diff.patch'),
        '--files',
        join(out, 'files.json'),
        '--held',
        join(base, 'h.json'),
      ],
      { cwd: repo, encoding: 'utf8', input: 'No actionable findings.', env },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const PAST_12 = /Held entry f\.txt:13 is past the end of the file \(12 lines\)/;

test('a base review resolves a --head ref name or HEAD and checks the held line at it', () => {
  for (const head of ['feat', 'HEAD']) {
    const past = recordBaseHeld(13, head);
    assert.equal(past.status, 0, past.stderr);
    assert.match(past.stderr, PAST_12, `--head ${head}`);
    assert.doesNotMatch(recordBaseHeld(12, head).stderr, /past the end/, `--head ${head}`);
  }
});

test('a --head ref name is read at that ref when the checkout is elsewhere', () => {
  assert.doesNotMatch(recordBaseHeld(10, 'feat', 'main').stderr, /past the end/);
  assert.match(recordBaseHeld(13, 'feat', 'main').stderr, PAST_12);
});

test('a base review without --head checks the held line against the working tree, as before', () => {
  assert.match(recordBaseHeld(13, null).stderr, PAST_12);
  assert.doesNotMatch(recordBaseHeld(12, null).stderr, /past the end/);
});

test('a --head that names no commit here says the held lines were not checked', () => {
  const done = recordBaseHeld(13, 'no-such-ref');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stderr, /--head no-such-ref is not a commit in this clone, so held lines were not checked/);
  assert.doesNotMatch(done.stderr, /past the end/);
});
