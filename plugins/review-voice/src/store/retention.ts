import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** The runs directory as verified: a real directory, with the identity later removals are held to. */
interface RunsParent {
  path: string;
  dev: number;
  ino: number;
}

/** `<data dir>/runs` checked to be a real directory, or null when there is none. */
function runsParent(dataDir: string): RunsParent | null {
  const path = join(dataDir, 'runs');
  if (!existsSync(path)) return null;
  // A runs directory that is itself a link could point anywhere, and readdir
  // would follow it into directories that are not runs. Nothing is swept through it.
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${path} is a symbolic link; retention does not follow it, so nothing was removed.`);
  return { path, dev: stat.dev, ino: stat.ino };
}

/** The run directories directly under `<data dir>/runs`, with their mtime. Symlinks are never followed or removed. */
function runEntries(dataDir: string): { path: string; mtimeMs: number }[] {
  const parent = runsParent(dataDir);
  if (parent === null) return [];
  const entries: { path: string; mtimeMs: number }[] = [];
  for (const name of readdirSync(parent.path).sort()) {
    const path = join(parent.path, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) entries.push({ path, mtimeMs: stat.mtimeMs });
  }
  return entries;
}

/**
 * Removes the listed directories, reading each again immediately before: one
 * that changed since it was listed (a review writing to it), or that is no
 * longer a plain directory, is left alone and counted as `refreshed`. One
 * already gone is skipped quietly. The parent is read again before every
 * removal too: a runs directory swapped for a link since the listing would
 * otherwise redirect a recursive delete outside the data directory.
 */
function remove(paths: string[], expired: (path: string, mtimeMs: number) => boolean, parent: RunsParent): RunDirectories & { refreshed: number } {
  const removed: string[] = [];
  let refreshed = 0;
  for (const path of paths) {
    const now = lstatSync(parent.path);
    if (now.isSymbolicLink() || now.dev !== parent.dev || now.ino !== parent.ino) {
      throw new Error(`${parent.path} changed while it was being swept; nothing more was removed.`);
    }
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || !expired(path, stat.mtimeMs)) {
      refreshed += 1;
      continue;
    }
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return { count: removed.length, paths: removed, refreshed };
}

const olderThan =
  (before: Date | null) =>
  (_path: string, mtimeMs: number): boolean =>
    before === null || mtimeMs < before.getTime();

/** The run directories `purge --runs` would remove: all of them, or those last changed before `before`. */
export function previewRunDirectories(dataDir: string, before: Date | null): RunDirectories {
  const paths = runEntries(dataDir)
    .filter((entry) => before === null || entry.mtimeMs < before.getTime())
    .map((entry) => entry.path);
  return { count: paths.length, paths };
}

/**
 * The only place run directories are deleted. `listed` is the preview being
 * acted on (a fresh one by default); whatever it holds, only direct entries of
 * `<data dir>/runs` that still satisfy `before` at the moment of removal go.
 */
export function removeRunDirectories(
  dataDir: string,
  before: Date | null,
  listed: string[] = previewRunDirectories(dataDir, before).paths,
): RunDirectories & { refreshed: number } {
  const parent = runsParent(dataDir);
  if (parent === null) return { count: 0, paths: [], refreshed: 0 };
  return remove(
    listed.filter((path) => dirname(path) === parent.path),
    olderThan(before),
    parent,
  );
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
 * outcome readers treat them as the write path's memory with no time bound,
 * so deleting them could let a review be posted twice. The reply rows are the
 * second write's memory (docs/adr/0035) and stay for the same reason. Only
 * `purge` removes them.
 */
const AUDIT_WHERE = "created_at < ? AND action NOT LIKE 'review_post_%' AND action NOT LIKE 'review_reply_%'";

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

/** Removes what `previewRetention` lists, except a directory that changed in between, which the next pass sees again. */
export function applyRetention(dataDir: string, db: Database, config: RetentionConfig, now: Date = new Date()): RetentionResult {
  const planned = previewRetention(dataDir, db, config, now);
  const stillExpired = (path: string, mtimeMs: number): boolean => {
    const days = config.runsDays;
    if (!enabled(days)) return false;
    const limit = existsSync(join(path, 'verdict.json')) ? days : days * 2;
    return mtimeMs < now.getTime() - limit * DAY_MS;
  };
  const parent = runsParent(dataDir);
  const { refreshed: _refreshed, ...runDirectories } =
    parent === null ? { count: 0, paths: [], refreshed: 0 } : remove(planned.runDirectories.paths, stillExpired, parent);
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
