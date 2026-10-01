/**
 * The identity guard checks what git would publish, not what happens to be on
 * disk.
 *
 * Walking the directory failed the guard on a contributor's ignored local
 * tooling state, which can never reach the repository. Listing through git
 * must not open the opposite hole: a staged file deleted from the working tree
 * is still committed, and a symlink is published as its link text.
 *
 * Each test copies the guard into a throwaway repository with its own
 * wordlist, so no test depends on, or reveals, a real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = join(root, 'scripts/guard-identity.mjs');
const TERM = 'zebracorp';

function sandbox({ git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-guard-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(guard, join(dir, 'scripts/guard-identity.mjs'));
  writeFileSync(join(dir, '.identity-guard.local'), `${TERM}\n`);
  writeFileSync(join(dir, 'clean.md'), 'Nothing to see.\n');
  if (git) {
    const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run('init', '--quiet');
    writeFileSync(join(dir, '.gitignore'), '.identity-guard.local\nlocal-state/\n');
    run('add', '.gitignore', 'clean.md', 'scripts/guard-identity.mjs');
  }
  return dir;
}

function runGuard(dir) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts/guard-identity.mjs')], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function inSandbox(options, body) {
  const dir = sandbox(options);
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a git-ignored file naming a listed term does not fail the guard', () => {
  inSandbox({}, (dir) => {
    mkdirSync(join(dir, 'local-state'));
    writeFileSync(join(dir, 'local-state/config.json'), `{"owner": "${TERM}"}\n`);
    const { code, output } = runGuard(dir);
    assert.equal(code, 0, output);
  });
});

test('an untracked file git would publish is still checked before it is added', () => {
  inSandbox({}, (dir) => {
    writeFileSync(join(dir, 'notes.md'), `Written for ${TERM}.\n`);
    const { code, output } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(output, /notes\.md:1 - term listed in \.identity-guard\.local/);
  });
});

test('a staged file deleted from the working tree is checked from the index', () => {
  inSandbox({}, (dir) => {
    writeFileSync(join(dir, 'leak.md'), `Owned by ${TERM}.\n`);
    execFileSync('git', ['add', 'leak.md'], { cwd: dir });
    unlinkSync(join(dir, 'leak.md'));
    const { code, output } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(output, /leak\.md:1 - term listed in \.identity-guard\.local/);
  });
});

test('a symlink is checked as the link text git publishes, not as its target', () => {
  inSandbox({}, (dir) => {
    symlinkSync(`../${TERM}/private.md`, join(dir, 'pointer.md'));
    const { code, output } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(output, /pointer\.md:1 - term listed in \.identity-guard\.local/);
  });
});

test('outside a git repository the guard still walks every file', () => {
  inSandbox({ git: false }, (dir) => {
    writeFileSync(join(dir, 'notes.md'), `Written for ${TERM}.\n`);
    const { code, output } = runGuard(dir);
    assert.equal(code, 1);
    assert.match(output, /notes\.md:1/);
  });
});
