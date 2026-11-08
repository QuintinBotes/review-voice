import { openDatabase } from '../store/db.ts';
import { dataDirectory } from '../store/paths.ts';
import { previewRunDirectories, removeRunDirectories } from '../store/retention.ts';
import { previewPurge, executePurge, type PurgeScope } from '../consent/purge.ts';

/** A run directory changed this recently belongs to a review that may still be running: an unqualified purge keeps it. */
const RECENT_RUN_MS = 10 * 60_000;

export function purgeCommand(argv: string[]): number {
  // A command that deletes consumes every token it is given and refuses the
  // rest: `--before=2026-01-01`, `-before`, a misspelling or a stray word
  // would otherwise read as "no filter".
  let repo: string | undefined;
  let before: string | undefined;
  let runs = false;
  let all = false;
  let confirm = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--runs') runs = true;
    else if (arg === '--all') all = true;
    else if (arg === '--confirm') confirm = true;
    else if (arg === '--repo' || arg === '--before') {
      const value = argv[index + 1];
      // A missing value, as an unquoted empty shell variable leaves, must not read as "no filter".
      if (value === undefined || value === '' || value.startsWith('-')) {
        console.error(arg === '--repo' ? '--repo needs a repository such as owner/repo.' : '--before needs a date such as 2026-01-31.');
        return 2;
      }
      if (arg === '--repo') repo = value;
      else before = value;
      index += 1;
    } else {
      console.error(`purge does not take ${arg}; its options are --repo <owner/repo>, --before <date>, --runs, --all and --confirm.`);
      return 2;
    }
  }
  const scope: PurgeScope = {
    repository: repo,
    // With --runs the date is for the run directories (their mtime); the corpus is not purged by it.
    before: runs ? undefined : before,
    all: all || undefined,
  };

  if (repo === undefined && before === undefined && !all && !runs) {
    console.error('Purge needs a scope: --repo <owner/repo>, --before <date>, --runs, or --all.');
    return 2;
  }
  // Run directories are files, so they are handled beside the database scope, never inside it.
  const directories = runs || all;
  let runsBefore: Date | null = null;
  if (directories && before !== undefined) {
    runsBefore = new Date(`${before}T00:00:00.000Z`);
    // The date must read back as itself: JavaScript turns 2026-02-31 into March 3rd, which would widen a deletion.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(before) || Number.isNaN(runsBefore.getTime()) || runsBefore.toISOString().slice(0, 10) !== before) {
      console.error('--before takes a real date such as 2026-01-31 when it goes with --runs or --all.');
      return 2;
    }
  }
  // Without a date, a directory changed in the last ten minutes is kept: a review
  // may be writing to it, and it may have appeared since the preview was read.
  const cutoff = runsBefore ?? new Date(Date.now() - RECENT_RUN_MS);

  const db = openDatabase();
  try {
    // Deletion is irreversible, so the damage is shown before it is agreed to,
    // not after.
    const preview = previewPurge(db, scope);
    let found: ReturnType<typeof previewRunDirectories> | null = null;
    try {
      found = directories ? previewRunDirectories(dataDirectory(), cutoff) : null;
      // `kept` says how many recent directories an unqualified purge left alone; counted
      // before anything is removed, so the confirmation reports the same figure as the preview.
      const kept = found !== null && runsBefore === null ? previewRunDirectories(dataDirectory(), null).count - found.count : 0;
      // A directory that changed between the listing and its removal is kept as well.
      const report = (listed: { count: number; paths: string[] }, refreshed = 0): { count: number; paths: string[]; kept: number } => ({
        count: listed.count,
        paths: listed.paths,
        kept: kept + refreshed,
      });
      if (!confirm) {
        console.log(JSON.stringify({ wouldRemove: found === null ? preview : { ...preview, runDirectories: report(found) }, confirmed: false }, null, 2));
        return 0;
      }
      const gone = found === null ? null : removeRunDirectories(dataDirectory(), cutoff, found.paths);
      const removed = executePurge(db, scope, gone?.count);
      console.log(JSON.stringify({ removed: gone === null ? removed : { ...removed, runDirectories: report(gone, gone.refreshed) }, confirmed: true }, null, 2));
      return 0;
    } catch (error) {
      // The run directories refused to be read (a symbolic link in their place); nothing was deleted, in the database either.
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  } finally {
    db.close();
  }
}
