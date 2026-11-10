import { openDatabase } from '../store/db.ts';
import { computeMetrics, DEFAULT_WINDOW_DAYS, stageSeconds } from '../evaluate/metrics.ts';
import { readRecallResults, recallMetrics, type RecallResults } from '../evaluate/recall-results.ts';
import { postedBreakdown } from '../store/outcomes.ts';
import { approvalBreakdown } from '../store/approvals.ts';
import { flag } from './shared.ts';

export function evaluateCommand(argv: string[]): number {
  // Read before the store is opened: a bad file is a bad invocation, and
  // should not touch the data directory on the way out.
  let recall: RecallResults | null = null;
  if (argv.includes('--recall')) {
    const file = flag(argv, '--recall');
    if (file === null) {
      console.error('--recall needs a results file written by `review-voice recall`.');
      return 2;
    }
    try {
      recall = readRecallResults(file);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  // The window for the `_recent` posted rates. Checked before the store is
  // opened for the same reason as --recall.
  let windowDays = DEFAULT_WINDOW_DAYS;
  if (argv.includes('--since')) {
    const wanted = flag(argv, '--since');
    const match = wanted === null ? null : /^(\d{1,5})d$/.exec(wanted);
    if (match === null) {
      console.error('--since takes a whole number of days, such as 30d.');
      return 2;
    }
    windowDays = Number(match[1]);
  }
  const db = openDatabase();
  try {
    const metrics = [...computeMetrics(db, { windowDays }), ...recallMetrics(recall)];
    if (argv.includes('--json')) {
      const { bySeverity, byLane, byRule, byEvidenceBlock } = postedBreakdown(db);
      const approvals = approvalBreakdown(db);
      console.log(
        JSON.stringify(
          {
            metrics,
            posted_breakdown: { by_severity: bySeverity, by_lane: byLane, by_rule: byRule, by_evidence_block: byEvidenceBlock },
            approval_breakdown: {
              by_mode: approvals.byMode,
              by_complexity: approvals.byComplexity,
              by_independence: approvals.byIndependence,
              by_origin: approvals.byOrigin,
            },
            stage_seconds: stageSeconds(db),
          },
          null,
          2,
        ),
      );
    } else {
      for (const metric of metrics) {
        const value = metric.value === null ? 'no data' : (Number.isInteger(metric.value) && metric.name.endsWith('_tracked') ? String(metric.value) : metric.value.toFixed(2));
        // A goal that is not met is not a failure, and printing it as one
        // trains the reader to ignore the word.
        const mark =
          metric.meets === null || metric.target === 'no target'
            ? '  -'
            : metric.meets
              ? '  ok'
              : metric.kind === 'goal'
                ? 'over'
                : 'FAIL';
        const target =
          metric.target === 'no target'
            ? 'reported, not scored'
            : metric.kind === 'goal'
              ? `goal ${metric.target}`
              : `target ${metric.target}`;
        console.log(`${mark}  ${metric.name.padEnd(32)} ${value.padStart(8)}  ${target}`);
        console.log(`      ${metric.basis}`);
      }
    }
    // A metric below target is information, not a command failure.
    return 0;
  } finally {
    db.close();
  }
}
