/**
 * The committed bundle must not depend on where node_modules resolves (#526).
 * A git worktree that symlinks another checkout's node_modules made esbuild
 * comment 69 bundled files with `../<other checkout>/node_modules/...`, so
 * `check:dist` passed there and failed in CI. This builds the source in such a
 * layout and compares it with the committed bundle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('#526: a build with node_modules symlinked from another checkout is byte-identical to the committed bundle', (t) => {
  const layout = mkdtempSync(join(tmpdir(), 'rv-526-'));
  t.after(() => rmSync(layout, { recursive: true, force: true }));
  mkdirSync(join(layout, 'scripts'));
  mkdirSync(join(layout, 'plugins/review-voice/dist'), { recursive: true });
  cpSync(join(root, 'scripts/build.mjs'), join(layout, 'scripts/build.mjs'));
  cpSync(join(root, 'plugins/review-voice/src'), join(layout, 'plugins/review-voice/src'), { recursive: true });
  // The build ends by running the bundle with --version, which reads the plugin's manifest.
  cpSync(join(root, 'plugins/review-voice/.claude-plugin'), join(layout, 'plugins/review-voice/.claude-plugin'), { recursive: true });
  // esbuild reads tsconfig.json for how it compiles the TypeScript.
  for (const file of ['package.json', 'tsconfig.json']) writeFileSync(join(layout, file), readFileSync(join(root, file)));
  symlinkSync(join(root, 'node_modules'), join(layout, 'node_modules'));

  const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: layout, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const bundle = readFileSync(join(layout, 'plugins/review-voice/dist/review-voice.mjs'), 'utf8');
  assert.equal(/^\/\/ \.\.\//m.test(bundle), false, 'no bundled file is commented with a path outside the repository');
  assert.equal(bundle, readFileSync(join(root, 'plugins/review-voice/dist/review-voice.mjs'), 'utf8'));
});
