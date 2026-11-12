import { openDatabase, type Database } from '../store/db.ts';
import { databasePath, dataDirectory } from '../store/paths.ts';
import { latestRun, runDetail, describeOrigin } from '../store/runs.ts';
import { feedbackTotals, unlabelledFindings } from '../store/feedback.ts';
import { loadConfig } from '../policy/load.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { scaledRepositoryShare } from '../corpus/select.ts';
import { corpusCoverage } from '../corpus/store.ts';
import { watchSummary } from '../store/watch.ts';
import { dismissedRateWarning, DEFAULT_WINDOW_DAYS, windowStart } from '../evaluate/metrics.ts';
import { postedStats } from '../store/outcomes.ts';
import { lastSync } from '../sync/state.ts';
import { namedRepositories } from './sync.ts';
import { describeReviewScope } from './explain.ts';
import { terminalSafeDeep } from '../terminal.ts';

function distinctReviewers(db: Database): number {
  return (db.prepare('SELECT COUNT(DISTINCT reviewer_login) AS n FROM review_events').get() as { n: number }).n;
}

export function statusCommand(): number {
  const db = openDatabase();
  try {
    // Health warnings need the allowlist, which only the repository config
    // knows. Outside a repository the counts still work.
    let allowlist: string[] = [];
    let maxRepositoryShare: number | undefined;
    let ownerReviewer: string | null = null;
    try {
      const config = loadConfig(repositoryRoot(process.cwd()));
      ownerReviewer = config.ownerReviewer;
      allowlist = namedRepositories(config.allowlist, 'status');
      maxRepositoryShare = scaledRepositoryShare(allowlist.length);
    } catch {
      // Not in a repository; report counts without allowlist warnings.
    }
    const coverage = corpusCoverage(db, { allowlist, ownerReviewer, ...(maxRepositoryShare === undefined ? {} : { maxRepositoryShare }) });
    const runs = (db.prepare('SELECT COUNT(*) AS n FROM review_runs').get() as { n: number }).n;
    const audits = (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
    const totals = feedbackTotals(db);
    const last = terminalSafeDeep(latestRun(db));
    const lastDetail = terminalSafeDeep(runDetail(db));

    console.log(`data directory   ${dataDirectory()}`);
    console.log(`database         ${databasePath()}`);
    console.log(`review runs      ${runs}`);
    console.log(`audit events     ${audits}`);
    console.log(
      `feedback         ${totals.kept} kept, ${totals.rewritten} rewritten, ${totals.dismissed} dismissed` +
        (totals.other > 0 ? `, ${totals.other} other` : ''),
    );
    const unlabelled = unlabelledFindings(db);
    console.log(
      `owner precision  ${
        totals.ownerPrecision === null
          ? 'not yet measurable (no explicit feedback)'
          : `${(totals.ownerPrecision * 100).toFixed(0)}% of labelled findings`
      }`,
    );
    if (unlabelled > 0) {
      // Said plainly, because the gate this tool rests on is computed from
      // labels and nothing else, and after a full test programme none existed.
      console.log(
        `unlabelled       ${unlabelled} finding(s). Precision cannot be measured until these carry ` +
          'a verdict: /review-voice:feedback <id> keep|dismiss|rewrite',
      );
    }
    // A rising dismissed rate is the earliest sign the reviewer has drifted. It
    // is judged over the default window because `status` takes no flags, and
    // nothing is printed when the sample is too small or the rate is fine.
    const recent = postedStats(db, { since: windowStart(DEFAULT_WINDOW_DAYS) });
    const dismissalWarning = dismissedRateWarning({
      dismissed: recent.dismissed,
      strong: recent.fixed + recent.dismissed,
      windowDays: DEFAULT_WINDOW_DAYS,
    });
    if (dismissalWarning !== null) console.log(dismissalWarning);
    if (last !== null) {
      // The origin goes last so the count and ids keep their position.
      const origin = lastDetail?.provenance == null ? '' : `; ${describeOrigin(lastDetail.provenance)}`;
      console.log(
        `last review      ${last.findings.length} finding(s): ${
          last.findings.map((f) => (f.ruleId === undefined ? f.findingId : `${f.findingId} (${f.ruleId})`)).join(', ') || 'none'
        }${origin}`,
      );
      const recordedScope = describeReviewScope(lastDetail?.scope ?? null);
      if (recordedScope !== null) console.log(`last scope       ${recordedScope}`);
    }
    const sync = lastSync(db);
    console.log(
      `last sync        ${
        sync === null
          ? 'never completed'
          : `${sync.finishedAt ?? sync.startedAt}, ${sync.imported} imported from ${sync.repositories.length} repository/ies`
      }`,
    );
    console.log(
      coverage.total === 0
        ? 'Corpus: baseline voice in use (no synced history)'
        : `Corpus: ${coverage.total} events from ${distinctReviewers(db)} reviewer(s)`,
    );
    console.log(
      `corpus           ${coverage.total} event(s)` +
        (coverage.total === 0
          ? ''
          : ` - ${Object.entries(coverage.byRole).map(([role, n]) => `${n} ${role}`).join(', ')}`),
    );
    for (const [repository, n] of Object.entries(coverage.byRepository)) {
      console.log(`  ${repository.padEnd(45)} ${n}`);
    }
    for (const warning of coverage.warnings) console.log(`  warning        ${warning}`);
    for (const line of watchSummary(db)) console.log(line);
    return 0;
  } finally {
    db.close();
  }
}
