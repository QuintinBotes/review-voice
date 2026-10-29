import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Makes the clone at `dir` exist and hold the pull request's head. */
export type PrepareClone = (repository: string, pull: number, dir: string) => Promise<void> | void;

export type Run = (command: string, args: string[]) => void;

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** `<workspace>/<owner>/<repo>`; a name that could leave the workspace is refused. */
export function cloneDir(workspace: string, repository: string): string {
  const repo = repository.split('/')[1];
  if (!NAME.test(repository) || repo === '.' || repo === '..') throw new Error(`${repository} is not an owner/repo name`);
  return join(workspace, ...repository.split('/'));
}

const runQuietly: Run = (command, args) => {
  execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000 });
};

const STALE_LOCK_MS = 10 * 60_000;

/**
 * Removes git lock files older than ten minutes: a review killed mid-fetch
 * leaves them, and git then refuses every later fetch. A younger lock may
 * belong to a git still running, so it stays.
 */
export function removeStaleGitLocks(dir: string, now = Date.now()): string[] {
  const git = join(dir, '.git');
  const candidates = ['packed-refs.lock', 'shallow.lock', 'index.lock'].map((name) => join(git, name));
  const walk = (folder: string): void => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.lock')) candidates.push(path);
    }
  };
  walk(join(git, 'refs'));
  const removed: string[] = [];
  for (const path of candidates) {
    try {
      if (now - statSync(path).mtimeMs < STALE_LOCK_MS) continue;
      unlinkSync(path);
      removed.push(path);
    } catch {
      // Not there.
    }
  }
  return removed;
}

/**
 * Clones once, partially, with the user's existing credential (`gh`, or git
 * over https when gh is absent), then fetches the head into the ref `diff
 * --pr` reads. Forced, because a force-push rewrites that ref. Stale git
 * locks from a killed run are cleared first.
 */
export function gitPrepareClone(run: Run = runQuietly): PrepareClone {
  return (repository, pull, dir) => {
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dirname(dir), { recursive: true });
      try {
        run('gh', ['repo', 'clone', repository, dir, '--', '--filter=blob:none']);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        run('git', ['clone', '--filter=blob:none', `https://github.com/${repository}.git`, dir]);
      }
    }
    removeStaleGitLocks(dir);
    run('git', ['-C', dir, 'worktree', 'prune']);
    run('git', ['-C', dir, 'fetch', '--no-tags', '--quiet', 'origin', `+pull/${pull}/head:refs/review-voice/pr/${pull}/head`]);
  };
}
