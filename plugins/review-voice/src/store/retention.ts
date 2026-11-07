import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './db.ts';

/**
 * How long local data lives (PRIVACY.md, docs/adr/0005). `watch` applies it
 * once per pass and `purge --runs` applies it on request; `review` never does,
 * so a user who runs neither sees nothing deleted.
 */
export interface RetentionConfig {
  /** Run directories under `<data dir>/runs` older than this many days are removed; 0 or null disables. */
  runsDays: number | null;
  /** Audit events older than this many days are removed, except the posting records; 0 or null disables. */
  auditDays: number | null;
}

/** The periods PRIVACY.md and ADR 0005 already promise, so enforcing them makes the documents true. */
export const DEFAULT_RETENTION: RetentionConfig = { runsDays: 30, auditDays: 180 };

export interface RunDirectories {
  count: number;
  paths: string[];
}

export interface RetentionResult {
  runDirectories: RunDirectories;
  auditEvents: number;
}

const DAY_MS = 86_400_000;

/** A period that switches its sweep on: a whole number of days above zero. */
const enabled = (days: number | null): days is number => typeof days === 'number' && Number.isFinite(days) && days > 0;

/** The run directories directly under `<data dir>/runs`, with their mtime. Symlinks are never followed or removed. */
function runEntries(dataDir: string): { path: string; mtimeMs: number }[] {
  const runs = join(dataDir, 'runs');
  if (!existsSync(runs)) return [];
  const entries: { path: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(runs).sort()) {
    const path = join(runs, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) entries.push({ path, mtimeMs: stat.mtimeMs });
  }
  return entries;
}

function remove(paths: string[]): RunDirectories {
  const removed: string[] = [];
  for (const path of paths) {
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return { count: removed.length, paths: removed };
}

/** The run directories `purge --runs` would remove: all of them, or those last changed before `before`. */
export function previewRunDirectories(dataDir: string, before: Date | null): RunDirectories {
  const paths = runEntries(dataDir)
    .filter((entry) => before === null || entry.mtimeMs < before.getTime())
    .map((entry) => entry.path);
  return { count: paths.length, paths };
}

/** The only place run directories are deleted; confined to the entries of `<data dir>/runs`. */
export function removeRunDirectories(dataDir: string, before: Date | null): RunDirectories {
  return remove(previewRunDirectories(dataDir, before).paths);
}

/**
 * Run directories past `runsDays`, by directory mtime. A directory with no
 * `verdict.json` is a failed run and is kept for twice that, so it can be
 * resumed by hand.
 */
function expiredRunDirectories(dataDir: string, days: number | null, now: Date): string[] {
  if (!enabled(days)) return [];
  return runEntries(dataDir)
    .filter((entry) => {
      const limit = existsSync(join(entry.path, 'verdict.json')) ? days : days * 2;
      return entry.mtimeMs < now.getTime() - limit * DAY_MS;
    })
    .map((entry) => entry.path);
}

/**
 * The posting rows stay: `keyBlocked`, `sentInline` and the held-finding and
 * outcome readers treat them as the single write path's memory with no time
 * bound, so deleting them could let a review be posted twice. Only `purge`
 * removes them.
 */
const AUDIT_WHERE = "created_at < ? AND action NOT LIKE 'review_post_%'";

function auditCutoff(days: number | null, now: Date): string | null {
  return enabled(days) ? new Date(now.getTime() - days * DAY_MS).toISOString() : null;
}

/** What `applyRetention` would remove, without removing it. */
export function previewRetention(dataDir: string, db: Database, config: RetentionConfig, now: Date = new Date()): RetentionResult {
  const paths = expiredRunDirectories(dataDir, config.runsDays, now);
  const cutoff = auditCutoff(config.auditDays, now);
  const auditEvents = cutoff === null ? 0 : (db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE ${AUDIT_WHERE}`).get(cutoff) as { n: number }).n;
  return { runDirectories: { count: paths.length, paths }, auditEvents };
}

/** Removes exactly what `previewRetention` lists. */
export function applyRetention(dataDir: string, db: Database, config: RetentionConfig, now: Date = new Date()): RetentionResult {
  const planned = previewRetention(dataDir, db, config, now);
  const runDirectories = remove(planned.runDirectories.paths);
  const cutoff = auditCutoff(config.auditDays, now);
  const auditEvents = cutoff === null ? 0 : Number(db.prepare(`DELETE FROM audit_events WHERE ${AUDIT_WHERE}`).run(cutoff).changes);
  return { runDirectories, auditEvents };
}

/** The one line a `watch` pass prints, or null when the sweep removed nothing. */
export function retentionLine(result: RetentionResult): string | null {
  const { count } = result.runDirectories;
  if (count === 0 && result.auditEvents === 0) return null;
  return `removed ${count} run director${count === 1 ? 'y' : 'ies'}, ${result.auditEvents} audit event${result.auditEvents === 1 ? '' : 's'}`;
}
