import { openDatabase } from '../store/db.ts';
import { computeVerdict, postReview } from '../publish/post.ts';
import { ReviewWriter } from '../github/writer.ts';
import { inProcessState, githubClient, readStdin, inferRepository, flag, repositoryConfig } from './shared.ts';

interface ReviewTarget {
  repository: string;
  pullNumber: number;
  head: string;
  review: string;
  runId: string | undefined;
}

/** Flags shared by `verdict` and `post`; a string is what was wrong with them. */
function reviewTarget(argv: string[], command: string): ReviewTarget | string {
  const pullNumber = Number(flag(argv, '--pr'));
  const repository = flag(argv, '--repository') ?? inferRepository(process.cwd());
  const head = flag(argv, '--head');
  if (!Number.isInteger(pullNumber) || pullNumber < 1 || repository === null || head === null) {
    return `${command} needs --pr <number>, --head <sha> and --repository <owner/repo>, with the validated review on stdin.`;
  }
  const review = readStdin();
  if (review.trim().length === 0) return 'Nothing on stdin. Pipe the validated review in.';
  return { repository, pullNumber, head, review, runId: flag(argv, '--run') ?? undefined };
}

/**
 * The review event, head guard and CI guard, computed and printed. Reads only;
 * see docs/adr/0010. Exit 3 means the head moved, 4 that CI is still running
 * on an approval, 5 that a re-check found CI red, 6 that CI needs a rerun
 * before any event is sent (docs/adr/0013). The `verdict:` settings change
 * which of these apply (docs/adr/0028).
 */
export async function verdictCommand(argv: string[]): Promise<number> {
  const target = reviewTarget(argv, 'verdict');
  if (typeof target === 'string') {
    console.error(target);
    return 2;
  }
  const config = repositoryConfig();
  const db = openDatabase();
  try {
    const { exitCode, output } = await computeVerdict({
      ...target,
      db,
      client: githubClient([target.repository]),
      recheck: argv.includes('--recheck'),
      gateChecks: config?.ciGateChecks ?? [],
      ciRules: config?.ciRules ?? {},
      owner: config?.ownerReviewer ?? null,
      policy: config?.verdictPolicy,
    });
    console.log(JSON.stringify(output, null, 2));
    return exitCode;
  } finally {
    db.close();
  }
}

/**
 * Submits the review with its event: the plugin's one write (docs/adr/0010).
 * Recomputes the verdict live, and sends nothing without --confirm.
 */
export async function postCommand(argv: string[]): Promise<number> {
  const target = reviewTarget(argv, 'post');
  if (typeof target === 'string') {
    console.error(target);
    return 2;
  }
  const config = repositoryConfig();
  const db = openDatabase();
  try {
    const { exitCode, output } = await postReview({
      ...target,
      db,
      client: githubClient([target.repository]),
      // Built from the recorded run's repository, not from --repository.
      writerFor: (allowlist) =>
        new ReviewWriter({ allowlist, ...(inProcessState()?.fetchImpl === undefined ? {} : { fetchImpl: inProcessState()!.fetchImpl }) }),
      confirm: argv.includes('--confirm'),
      event: flag(argv, '--event')?.toUpperCase(),
      postingEnabled: config?.postingEnabled ?? false,
      gateChecks: config?.ciGateChecks ?? [],
      ciRules: config?.ciRules ?? {},
      owner: config?.ownerReviewer ?? null,
      policy: config?.verdictPolicy,
      recheckThread: argv.includes('--recheck-thread'),
    });
    console.log(JSON.stringify(output, null, 2));
    return exitCode;
  } finally {
    db.close();
  }
}
