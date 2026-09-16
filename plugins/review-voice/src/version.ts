import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The manifest is the single source of truth for the version. Reading it at
 * runtime keeps `plugin.json`, the marketplace entry and `--version` from
 * drifting apart; `claude plugin tag` checks the first two against each other.
 */
export function pluginVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = join(here, '..', '.claude-plugin', 'plugin.json');
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
    const { version } = parsed as { version?: unknown };
    if (typeof version === 'string') return version;
  }
  return '0.0.0-unknown';
}
