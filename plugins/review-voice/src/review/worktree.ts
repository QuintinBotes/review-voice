import { execFileSync } from 'node:child_process';
import { lstatSync, rmSync, unlinkSync } from 'node:fs';

/**
 * Git with every way a checkout can run repository code turned off: hooks
 * (including a clone's own core.hooksPath), LFS filters, fsmonitor and
 * submodule recursion. The head is untrusted pull request content.
 */
export const SAFE_GIT = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'submodule.recurse=false',
];

function safeGit(args: string[], cwd: string): void {
  execFileSync('git', [...SAFE_GIT, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * A detached checkout of `head` at `headDir`, made with SAFE_GIT. Shared by
 * the review driver and `review-voice worktree add`, the slash command's way to
 * the same checkout (#293).
 *
 * A run killed outright (SIGKILL after a watcher's grace period, say, while a
 * configured command held the process) ran no cleanup, so a re-run into the
 * same directory finds its worktree still there. It is the caller's to
 * replace: the directory is the run's own, and the stale checkout is of a head
 * the run reads afresh. Git locks a worktree while it initialises it, so a run
 * killed during the checkout leaves a locked one, which remove refuses and
 * prune keeps; it is unlocked first. Either command fails when there is
 * nothing registered, which is the usual case. A symbolic link at the path
 * would make git act on wherever it points, so a link is unlinked, never
 * followed.
 */
export function addHeadWorktree(headDir: string, head: string, cwd: string = process.cwd()): void {
  const stale = lstatSync(headDir, { throwIfNoEntry: false });
  if (stale?.isSymbolicLink()) {
    unlinkSync(headDir);
  } else {
    for (const args of [['worktree', 'unlock', headDir], ['worktree', 'remove', '--force', '--force', headDir]]) {
      try {
        safeGit(args, cwd);
      } catch {
        // Nothing registered at the path, or not locked: nothing to undo.
      }
    }
    if (stale !== undefined) rmSync(headDir, { recursive: true, force: true });
  }
  safeGit(['worktree', 'prune'], cwd);
  safeGit(['worktree', 'add', '--detach', headDir, head], cwd);
}

/** Removes the worktree at `headDir`; false when git could not. */
export function removeHeadWorktree(headDir: string, cwd: string = process.cwd()): boolean {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', headDir], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
