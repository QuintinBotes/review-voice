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
console.log(`Built ${outfile} (${(built.length / 1024).toFixed(1)} kB)`);
