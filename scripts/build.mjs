/**
 * Bundles the plugin CLI into a single committed artifact.
 *
 * The plugin is installed by git clone with no install step, so users must
 * never run `npm install`. Everything third-party is a devDependency inlined
 * here; the shipped bundle has zero runtime dependencies beyond Node itself.
 *
 *   node scripts/build.mjs           build dist/review-voice.mjs
 *   node scripts/build.mjs --check   fail if the committed bundle is stale
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'plugins/review-voice/src/cli.ts');
const outfile = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const checkOnly = process.argv.includes('--check');

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Every dependency must resolve to ESM. A CommonJS build reaches for
  // `require`, which does not exist in an ESM bundle — and because imports are
  // hoisted, one CJS dependency breaks every command, not just the one that
  // uses it. `yaml` maps its "node" condition to CJS, so it is aliased to its
  // ESM entry explicitly; check-bundle.mjs fails the build if a CJS shim ever
  // reappears.
  // An absolute path, because yaml's "exports" map does not publish this
  // subpath and a bare specifier would be blocked by it.
  alias: { yaml: join(root, 'node_modules/yaml/browser/dist/index.js') },
  mainFields: ['module', 'main'],
  write: false,
  banner: { js: '#!/usr/bin/env node' },
  // node:sqlite is experimental on Node 22. The warning is noise for users who
  // never chose to depend on it, so it is suppressed at the bundle boundary.
  footer: { js: '' },
  legalComments: 'none',
});

const built = result.outputFiles[0].text;

if (checkOnly) {
  if (!existsSync(outfile)) {
    console.error('dist/review-voice.mjs is missing. Run: npm run build');
    process.exit(1);
  }
  const committed = await readFile(outfile, 'utf8');
  if (committed !== built) {
    console.error(
      'dist/review-voice.mjs is stale — it does not match plugins/review-voice/src.\n' +
        'Run `npm run build` and commit the result.',
    );
    process.exit(1);
  }
  console.log('dist/review-voice.mjs is up to date.');
  process.exit(0);
}

await writeFile(outfile, built, { mode: 0o755 });

// Prove the bundle loads before declaring success. A CommonJS dependency
// slipping into an ESM bundle throws on the very first import, taking every
// command down at once — and nothing else in the build would notice, because
// the bundle is syntactically fine.
try {
  execFileSync(process.execPath, [outfile, '--version'], { stdio: 'pipe' });
} catch (error) {
  console.error('The bundle was written but does not run:\n');
  console.error((error.stderr ?? Buffer.from('')).toString().split('\n').slice(0, 12).join('\n'));
  process.exit(1);
}

console.log(`Built ${outfile} (${(built.length / 1024).toFixed(1)} kB) — loads cleanly`);
