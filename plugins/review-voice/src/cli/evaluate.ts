import { writeFileSync } from 'node:fs';
import { openDatabase } from '../store/db.ts';
import { computeMetrics, DEFAULT_WINDOW_DAYS, evaluationReport, formatMetricValue, metricMark, metricTarget } from '../evaluate/metrics.ts';
import { htmlDocument, renderEvaluationHtml } from '../evaluate/report.ts';
import { readRecallResults, recallMetrics, type RecallResults } from '../evaluate/recall-results.ts';
import { flag, resolveOutPath } from './shared.ts';

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
  const json = argv.includes('--json');
  const html = argv.includes('--html');
  const out = flag(argv, '--out');
  if (json && html) {
    console.error('--json and --html are exclusive.');
    return 2;
  }
  if (argv.includes('--out') && !html) {
    console.error('--out needs --html.');
    return 2;
  }
  if (argv.includes('--out') && out === null) {
    console.error('--out needs a path.');
    return 2;
  }
  const db = openDatabase();
  try {
    const metrics = [...computeMetrics(db, { windowDays }), ...recallMetrics(recall)];
    if (json || html) {
      const report = evaluationReport(db, metrics, { windowDays });
      if (json) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
      }
      const fragment = renderEvaluationHtml(report);
      if (out === null) {
        process.stdout.write(fragment);
        return 0;
      }
      try {
        writeFileSync(resolveOutPath(out, 'evaluation.html'), htmlDocument(fragment, 'Review Voice evaluation'), 'utf8');
      } catch (error) {
        console.error(`Cannot write ${out}: expected a file path or a directory; ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
      return 0;
    }
    for (const metric of metrics) {
      const mark = metricMark(metric);
      // The dash is three characters wide, not four, so a padStart(4) would
      // change every unscored line; the column is what it has always been.
      const column = mark === '-' ? '  -' : mark === 'ok' ? '  ok' : mark;
      console.log(`${column}  ${metric.name.padEnd(32)} ${formatMetricValue(metric).padStart(8)}  ${metricTarget(metric)}`);
      console.log(`      ${metric.basis}`);
    }
    // A metric below target is information, not a command failure.
    return 0;
  } finally {
    db.close();
  }
}
