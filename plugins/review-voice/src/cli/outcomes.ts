import { openDatabase } from '../store/db.ts';
import { loadConfig } from '../policy/load.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { checkOutcomes, type PendingQuestion } from '../store/outcomes.ts';
import { flag, githubClient } from './shared.ts';

/** The one text-mode line per thread awaiting this tool's reply (docs/adr/0035); `--json` stays an array of outcomes. */
export function pendingQuestionLine(question: PendingQuestion): string {
  return (
    `${question.repository}#${question.pullNumber} ${question.findingId} ${question.path}:${question.line} ` +
    `question from ${question.askedBy} awaiting a reply; run reply --pr ${question.pullNumber}`
  );
}

export async function outcomesCommand(argv: string[]): Promise<number> {
  const repository = flag(argv, '--repository');
  if (argv.includes('--repository') && (repository === null || !/^[^/\s]+\/[^/\s]+$/.test(repository))) {
    console.error('--repository takes owner/repo.');
    return 2;
  }
  const sinceFlag = flag(argv, '--since');
  const days = sinceFlag === null ? 30 : /^(\d+)d$/.exec(sinceFlag)?.[1];
  if (days === undefined || (argv.includes('--since') && sinceFlag === null)) {
    console.error('--since takes a number of days such as 30d.');
    return 2;
  }
  const since = new Date(Date.now() - Number(days) * 86_400_000).toISOString();

  // Naming a repository is the consent for reading it, as `thread` treats it.
  // Otherwise only the allowlisted ones are read, and a run for any other is skipped.
  let allowlist: string[] = repository === null ? [] : [repository];
  // The config is read even with --repository: the owner's login decides whose
  // reply is an owner signal, whichever repository is named.
  let ownerReviewer: string | null = null;
  try {
    const config = loadConfig(repositoryRoot(process.cwd()));
    ownerReviewer = config.ownerReviewer;
    if (repository === null) allowlist = config.allowlist;
  } catch {
    // Not in a repository: no allowlist, so nothing is read, and no owner.
  }

  const db = openDatabase();
  try {
    const result = await checkOutcomes({
      db,
      client: githubClient(allowlist),
      allowlist,
      repository: repository ?? undefined,
      since,
      ownerReviewer,
    });
    for (const warning of result.warnings) console.error(warning);
    for (const skipped of result.skipped) {
      console.error(`${skipped.repository}#${skipped.pullNumber}: skipped, ${skipped.reason}`);
    }
    if (argv.includes('--json')) {
      console.log(
        JSON.stringify(
          result.outcomes.map((o) => ({
            run: o.reviewRunId,
            finding: o.findingId,
            repository: o.repository,
            pull: o.pullNumber,
            path: o.path,
            line: o.line,
            commentId: o.commentId,
            outcome: o.outcome,
            strength: o.strength,
            evidence: o.evidence,
            checkedAt: o.checkedAt,
            reviewIdSource: o.reviewIdSource,
          })),
          null,
          2,
        ),
      );
      return 0;
    }
    for (const o of result.outcomes) {
      console.log(`${o.repository}#${o.pullNumber} ${o.findingId} ${o.path}:${o.line} ${o.outcome} (${o.strength}): ${o.evidence}`);
    }
    for (const question of result.questions) console.log(pendingQuestionLine(question));
    const count = (name: string): number => result.outcomes.filter((o) => o.outcome === name).length;
    console.log(
      `${result.outcomes.length} finding(s) tracked: ${count('fixed')} fixed, ${count('dismissed')} dismissed, ` +
        `${count('resolved')} resolved, ${count('outdated')} outdated, ${count('open')} open, ${count('unknown')} unknown`,
    );
    return 0;
  } finally {
    db.close();
  }
}
