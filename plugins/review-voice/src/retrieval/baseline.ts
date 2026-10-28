import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../store/db.ts';

/** True when no review history has been synced, so the baseline voice applies (ADR 0030). */
export function isCorpusEmpty(db: Database): boolean {
  return (db.prepare('SELECT COUNT(*) AS n FROM review_events').get() as { n: number }).n === 0;
}

/**
 * The shipped baseline voice guide. The same file is found from the bundle in
 * dist/ and from the sources under src/, which sit at different depths.
 */
export function baselineVoice(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const relative of ['..', '../..']) {
    const candidate = join(here, relative, 'templates', 'voice.baseline.md');
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8').trim();
  }
  throw new Error('templates/voice.baseline.md is missing from the plugin.');
}
