/**
 * Review Voice is a personalisation tool built from one person's spec. This
 * guard keeps that person out of the source: the owner reviewer is resolved at
 * runtime from the user's own GitHub identity, never baked in.
 *
 * Exits non-zero if a personal login or private repository name appears
 * anywhere outside the files that are allowed to mention the author.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Patterns that must not appear in shipped source, docs, or fixtures. */
const FORBIDDEN = [
  { pattern: /QuintinBotes\/(REDACTED)/gi, why: 'private repository name from the original spec' },
  { pattern: /owner_reviewer:\s*(?!\$\{|<|"?your-)[A-Za-z]/g, why: 'hardcoded owner_reviewer; use a placeholder' },
];

/** Files permitted to name the author — attribution, not configuration. */
const ALLOWLIST = new Set([
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  '.claude-plugin/marketplace.json',
  'plugins/review-voice/.claude-plugin/plugin.json',
  'plugins/review-voice/README.md',
  '.github/CODEOWNERS',
  'docs/PLAN.md',
  'scripts/guard-identity.mjs',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const TEXT = /\.(ts|mjs|js|json|md|ya?ml|sh|txt)$/;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (TEXT.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

let failures = 0;
for await (const file of walk(root)) {
  const rel = relative(root, file);
  if (ALLOWLIST.has(rel)) continue;
  const text = await readFile(file, 'utf8');
  for (const { pattern, why } of FORBIDDEN) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      console.error(`${rel}:${line} — ${why}: ${JSON.stringify(match[0])}`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} identity guard violation(s). See CONTRIBUTING.md.`);
  process.exit(1);
}
console.log('Identity guard passed.');
