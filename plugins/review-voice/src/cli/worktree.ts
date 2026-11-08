import { statSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitError, repositoryRoot } from '../diff/acquire.ts';
import { addHeadWorktree, removeHeadWorktree } from '../review/worktree.ts';
import { flag } from './shared.ts';

/**
 * The pull request's head checked out at <dir>/head, the same safe checkout
 * the driver makes, so the slash command's evidence and second-pass steps run
 * on the code under review (#293). remove is safe to run when nothing is there.
 */
export function worktreeCommand(argv: string[]): number {
  const action = argv[0];
  const dir = flag(argv, '--dir');
  if ((action !== 'add' && action !== 'remove') || dir === null) {
    console.error('Usage: review-voice worktree add --dir <dir> --head <commit> | review-voice worktree remove --dir <dir>');
    return 2;
  }
  if (statSync(resolve(dir), { throwIfNoEntry: false })?.isDirectory() !== true) {
    console.error(`--dir ${dir} is not a directory.`);
    return 2;
  }
  let root: string;
  try {
    root = repositoryRoot(process.cwd());
  } catch (error) {
    if (error instanceof GitError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const headDir = join(resolve(dir), 'head');

  if (action === 'remove') {
    const present = lstatSync(headDir, { throwIfNoEntry: false });
    // A link at the path would make git act on wherever it points.
    if (present?.isSymbolicLink()) rmSync(headDir, { force: true });
    if (present === undefined || present.isSymbolicLink()) {
      console.log(JSON.stringify({ path: headDir, removed: false }));
      return 0;
    }
    if (!removeHeadWorktree(headDir, root)) {
      console.error(`Could not remove the worktree ${headDir}; remove it with git worktree remove.`);
      return 1;
    }
    console.log(JSON.stringify({ path: headDir, removed: true }));
    return 0;
  }

  const head = flag(argv, '--head');
  // A value git would read as an option is never a commit.
  if (head === null || head.startsWith('-')) {
    console.error('worktree add needs --head <commit>.');
    return 2;
  }
  let sha: string;
  try {
    sha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${head}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.error(`--head ${head} is not a commit in this clone. Fetch it and run again.`);
    return 2;
  }
  try {
    addHeadWorktree(headDir, sha, root);
  } catch (error) {
    console.error(`Could not check out ${sha} at ${headDir}: ${String((error as Error).message).split('\n')[0]}`);
    return 1;
  }
  console.log(JSON.stringify({ path: headDir, head: sha }));
  return 0;
}
