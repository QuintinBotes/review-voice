import { writeFileSync } from 'node:fs';
import { readThread } from '../diff/thread.ts';
import { githubClient, inferRepository, flag, resolveOutPath } from './shared.ts';

export async function threadCommand(argv: string[]): Promise<number> {
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

  const result = await readThread({ repository, pullNumber, client: githubClient([repository]) });
  // Local only, never posted: the review goes on without thread resolution.
  for (const warning of result.warnings ?? []) console.error(`Warning: ${warning}`);
  const out = flag(argv, '--out');
  if (out === null) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  try {
    const path = resolveOutPath(out, 'thread.json');
    writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');
    console.log(
      JSON.stringify(
        {
          path,
          comments: result.comments.length,
          truncated: result.truncated,
          ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(
      `Cannot write ${out}: expected a file path or a directory; ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}
