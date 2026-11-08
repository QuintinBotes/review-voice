import { openFollowUps } from '../store/follow-ups.ts';
import { openDatabase } from '../store/db.ts';
import { inferRepository, flag } from './shared.ts';

/**
 * The partly-addressed follow-ups of a pull request that no recorded run has
 * seen resolved, for the verifier to check at the new head. Reads only the
 * local store.
 */
export function followUpsCommand(argv: string[]): number {
  const pullNumber = Number(flag(argv, '--pr'));
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    console.error('--pr needs a pull request number.');
    return 2;
  }
  const repository = flag(argv, '--repository') ?? inferRepository(process.cwd());
  if (repository === null) {
    console.error('Cannot tell which repository. Pass --repository <owner/repo>.');
    return 2;
  }
  const db = openDatabase();
  try {
    const followUps = openFollowUps(db, repository, pullNumber).map(({ text: _text, recordedAt: _at, ...followUp }) => followUp);
    console.log(JSON.stringify({ followUps }, null, 2));
    return 0;
  } finally {
    db.close();
  }
}
