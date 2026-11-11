import { openDatabase } from '../store/db.ts';
import { checkOutcomes } from '../store/outcomes.ts';
import { postReplies } from '../publish/reply.ts';
import { ReviewWriter } from '../github/writer.ts';
import { flag, githubClient, inferRepository, inProcessState, repositoryConfig } from './shared.ts';

/**
 * One bounded reply per own finding on one pull request (docs/adr/0035). The
 * thread is read as `outcomes` reads it, then each pending question gets the
 * rendered reply, posted only with --confirm and only while posting is on.
 */
export async function replyCommand(argv: string[]): Promise<number> {
  const pullNumber = Number(flag(argv, '--pr'));
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    console.error('--pr needs a pull request number.');
    return 2;
  }
  const named = flag(argv, '--repository');
  if (argv.includes('--repository') && (named === null || !/^[^/\s]+\/[^/\s]+$/.test(named))) {
    console.error('--repository takes owner/repo.');
    return 2;
  }
  const repository = named ?? inferRepository(process.cwd());
  if (repository === null) {
    console.error('Cannot tell which repository. Pass --repository <owner/repo>.');
    return 2;
  }
  const sinceFlag = flag(argv, '--since');
  const days = sinceFlag === null ? 30 : /^(\d+)d$/.exec(sinceFlag)?.[1];
  if (days === undefined || (argv.includes('--since') && sinceFlag === null)) {
    console.error('--since takes a number of days such as 30d.');
    return 2;
  }
  const since = new Date(Date.now() - Number(days) * 86_400_000).toISOString();

  // As `outcomes`: naming the repository is the consent for reading it, and
  // the config decides posting and whose reply is the owner's.
  const config = repositoryConfig();
  const allowlist = named === null ? (config?.allowlist ?? []) : [named];
  const db = openDatabase();
  try {
    const client = githubClient(allowlist);
    const checked = await checkOutcomes({ db, client, allowlist, repository, pullNumber, since, ownerReviewer: config?.ownerReviewer ?? null });
    for (const warning of checked.warnings) console.error(warning);
    for (const skipped of checked.skipped) console.error(`${skipped.repository}#${skipped.pullNumber}: skipped, ${skipped.reason}`);
    const { exitCode, replies, refused } = await postReplies({
      db,
      client,
      repository,
      pullNumber,
      questions: checked.questions,
      // Built from the recorded run's repository, not from --repository.
      writerFor: (runRepositories) =>
        new ReviewWriter({ allowlist: runRepositories, ...(inProcessState()?.fetchImpl === undefined ? {} : { fetchImpl: inProcessState()!.fetchImpl }) }),
      confirm: argv.includes('--confirm'),
      postingEnabled: config?.postingEnabled ?? false,
    });
    // Exit 2 for the switch says why, with or without a question to carry the reason.
    for (const reason of refused) console.error(`${reason}; nothing can be sent.`);
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ questions: checked.questions, replies, refused }, null, 2));
      return exitCode;
    }
    if (replies.length === 0) console.log(`No pending question on ${repository}#${pullNumber}.`);
    for (const result of replies) {
      const { question } = result;
      console.log(`${question.path}:${question.line} ${question.askedBy} (${question.stance}) ${result.status}${result.reasons.length === 0 ? '' : `: ${result.reasons.join('; ')}`}`);
      if (result.body !== null) console.log(`  ${result.body}`);
    }
    return exitCode;
  } finally {
    db.close();
  }
}
