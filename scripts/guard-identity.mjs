/**
 * Review Voice models whoever runs it. This guard keeps a specific person out
 * of the source: the owner reviewer is resolved at runtime from the user's own
 * GitHub identity, never baked in.
 *
 * It deliberately hardcodes no names. An earlier version listed the private
 * repositories it was meant to keep out, which meant the guard itself
 * published them - the exact leak it existed to prevent. Structural patterns
 * catch the general case; anything site-specific belongs in a local, ignored
 * wordlist that never reaches the repository.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Structural patterns: a configuration value that should never be a literal. */
const FORBIDDEN = [
  {
    pattern: /owner_reviewer:\s*(?!\$\{|<|"?your-)[A-Za-z]/g,
    why: 'hardcoded owner_reviewer; use a placeholder such as your-github-login',
  },
  {
    // Em and en dashes read as machine-written and the owner does not use
    // them. Banned everywhere rather than only in findings, so the codebase
    // and its output sound like the same person.
    pattern: /[\u2013\u2014]/gu,
    why: 'em or en dash; use a comma, a full stop, or a plain hyphen',
  },
  {
    // RFC 2606 reserves example.com/net/org and the .example/.test/.invalid
    // TLDs for documentation, including their subdomains - db.example.com is
    // as reserved as example.com. GitHub noreply relays are addresses nobody
    // reads, so they are fine too.
    pattern:
      /\b[\w.+-]+@(?![\w-]+\.)*(?!(?:[\w-]+\.)*(?:example\.(?:com|net|org)|users\.noreply\.github\.com)\b)(?:[\w-]+\.)+[a-z]{2,}\b/gi,
    why: 'real email address; use an example.com or noreply address',
  },
];

/**
 * Optional local wordlist, one term per line, '#' for comments. Terms specific
 * to one contributor's employer or private repositories go here. The file is
 * gitignored precisely so that naming a secret does not publish it.
 */
const LOCAL_WORDLIST = join(root, '.identity-guard.local');

/** Files permitted to name the author - attribution, not configuration. */
const ALLOWLIST = new Set([
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  '.claude-plugin/marketplace.json',
  'plugins/review-voice/.claude-plugin/plugin.json',
  'plugins/review-voice/LICENSE',
  'plugins/review-voice/README.md',
  '.github/CODEOWNERS',
  'docs/PLAN.md',
  'docs/REPO-SECURITY.md',
  'scripts/guard-identity.mjs',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const TEXT = /\.(ts|mjs|js|json|md|ya?ml|sh|txt)$/;

async function loadLocalTerms() {
  if (!existsSync(LOCAL_WORDLIST)) return [];
  const lines = (await readFile(LOCAL_WORDLIST, 'utf8')).split('\n');
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((term) => ({
      pattern: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      why: 'term listed in .identity-guard.local',
    }));
}

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

const checks = [...FORBIDDEN, ...(await loadLocalTerms())];
let failures = 0;

for await (const file of walk(root)) {
  const rel = relative(root, file);
  if (ALLOWLIST.has(rel)) continue;
  const text = await readFile(file, 'utf8');
  for (const { pattern, why } of checks) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      console.error(`${rel}:${line} - ${why}: ${JSON.stringify(match[0])}`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} identity guard violation(s). See CONTRIBUTING.md.`);
  process.exit(1);
}
console.log(`Identity guard passed (${checks.length} patterns).`);
