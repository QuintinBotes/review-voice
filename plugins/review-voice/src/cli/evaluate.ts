import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, openDatabaseReadOnly, StoreOutdatedError } from '../store/db.ts';
import type { Database } from '../store/db.ts';
import { byFamily, computeMetrics, DEFAULT_WINDOW_DAYS, describeByFamily, evaluationReport, formatMetricValue, metricMark, metricTarget } from '../evaluate/metrics.ts';
import { htmlDocument, renderEvaluationHtml } from '../evaluate/report.ts';
import { readRecallResults, recallMetrics, type RecallResults } from '../evaluate/recall-results.ts';
import {
  calibrationReport,
  CalibrationInputError,
  formatCalibrationText,
  labellingSheet,
  loadStoredRuns,
  parseLabels,
  parseThresholds,
  sampleCandidates,
  type LabelEntry,
} from '../evaluate/calibration.ts';
import type { Thresholds } from '../scoring/score.ts';
import { flag, resolveOutPath } from './shared.ts';
import { terminalSafe, terminalSafeDeep } from '../terminal.ts';

/** The first token `argv` holds that is none of the named flags or a flag's value, or null. */
function unknownArg(argv: string[], valueFlags: readonly string[], booleanFlags: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (valueFlags.includes(token)) {
      index += 1;
      continue;
    }
    if (booleanFlags.includes(token)) continue;
    return token;
  }
  return null;
}

function requiredFlag(argv: string[], name: string, what: string): string | null {
  const value = flag(argv, name);
  if (value !== null) return value;
  console.error(argv.includes(name) ? `${name} needs ${what}.` : `${name} <${what}> is required.`);
  return null;
}

/** The store for a read-only subcommand: null when there is none, undefined after printing why it cannot be read. */
function readStore(): Database | null | undefined {
  try {
    return openDatabaseReadOnly();
  } catch (error) {
    if (!(error instanceof StoreOutdatedError)) throw error;
    console.error(error.message);
    return undefined;
  }
}

/** `review-voice evaluate calibration --labels <file> [--thresholds <file>] [--repository <o/r>] [--text]` (#481). */
function calibrationCommand(argv: string[]): number {
  const unknown = unknownArg(argv, ['--labels', '--thresholds', '--repository'], ['--text', '--json']);
  if (unknown !== null) {
    console.error(`evaluate calibration: unknown argument ${unknown}.`);
    return 2;
  }
  if (argv.includes('--text') && argv.includes('--json')) {
    console.error('--text and --json are exclusive.');
    return 2;
  }
  const labelsFile = requiredFlag(argv, '--labels', 'file');
  if (labelsFile === null) return 2;
  const repository = flag(argv, '--repository');
  if (argv.includes('--repository') && repository === null) {
    console.error('--repository needs owner/repo.');
    return 2;
  }
  // Read before the store is opened, as --recall is: a bad file is a bad
  // invocation and should not touch the data directory on the way out.
  let labels: LabelEntry[];
  try {
    labels = parseLabels(readFileSync(labelsFile, 'utf8'));
  } catch (error) {
    console.error(
      error instanceof CalibrationInputError
        ? error.message
        : `Cannot read labels file ${labelsFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  let thresholds: Thresholds | null = null;
  if (argv.includes('--thresholds')) {
    const file = flag(argv, '--thresholds');
    if (file === null) {
      console.error('--thresholds needs a YAML or JSON file.');
      return 2;
    }
    try {
      thresholds = parseThresholds(readFileSync(file, 'utf8'), file);
    } catch (error) {
      console.error(
        error instanceof CalibrationInputError
          ? error.message
          : `Cannot read thresholds file ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
  }
  const db = readStore();
  if (db === undefined) return 2;
  try {
    const report = terminalSafeDeep(calibrationReport(db, labels, { repository, thresholds }));
    if (argv.includes('--text')) process.stdout.write(terminalSafe(formatCalibrationText(report)));
    else console.log(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    db?.close();
  }
}

/** The ISO cutoff a `label-sample --since` names: a date, a date-time, or `Nd` as `evaluate` spells it. */
function sampleSince(value: string): string | null {
  const days = /^(\d{1,5})d$/.exec(value);
  if (days !== null) return new Date(Date.now() - Number(days[1]) * 86_400_000).toISOString();
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** `review-voice evaluate label-sample --out <file> --n <k> --seed <s> [--repository <o/r>] [--since <date>]` (#481). */
function labelSampleCommand(argv: string[]): number {
  const unknown = unknownArg(argv, ['--out', '--n', '--seed', '--repository', '--since'], []);
  if (unknown !== null) {
    console.error(`evaluate label-sample: unknown argument ${unknown}.`);
    return 2;
  }
  const out = requiredFlag(argv, '--out', 'file');
  const count = requiredFlag(argv, '--n', 'k');
  const seed = requiredFlag(argv, '--seed', 's');
  if (out === null || count === null || seed === null) return 2;
  if (!/^\d+$/.test(count) || Number(count) < 1 || !Number.isSafeInteger(Number(count))) {
    console.error('--n needs a positive whole number, such as 40.');
    return 2;
  }
  const repository = flag(argv, '--repository');
  if (argv.includes('--repository') && repository === null) {
    console.error('--repository needs owner/repo.');
    return 2;
  }
  let since: string | null = null;
  if (argv.includes('--since')) {
    const wanted = flag(argv, '--since');
    since = wanted === null ? null : sampleSince(wanted);
    if (since === null) {
      console.error('--since takes a date such as 2026-01-31, a date-time, or Nd such as 90d.');
      return 2;
    }
  }
  const db = readStore();
  if (db === undefined) return 2;
  try {
    const runs = loadStoredRuns(db, { repository, since });
    const pool = runs.flatMap((run) => run.candidates);
    const sample = sampleCandidates(pool, { n: Number(count), seed });
    const sheet = terminalSafeDeep(labellingSheet(sample.selected));
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.error(`Cannot write ${out}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    console.log(
      JSON.stringify(
        terminalSafeDeep({
          out,
          requested: Number(count),
          sampled: sample.selected.length,
          seed,
          strata: sample.strata,
          unstratified: sample.unstratified,
        }),
        null,
        2,
      ),
    );
    return 0;
  } finally {
    db?.close();
  }
}

export function evaluateCommand(argv: string[]): number {
  if (argv[0] === 'calibration') return calibrationCommand(argv.slice(1));
  if (argv[0] === 'label-sample') return labelSampleCommand(argv.slice(1));
  if (argv[0] !== undefined && !argv[0].startsWith('--')) {
    console.error(`evaluate: unknown subcommand ${argv[0]}; use calibration or label-sample, or no subcommand for the metrics.`);
    return 2;
  }
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
      // A rule id holds the category the analyst gave, which nothing checks against a list.
      const report = terminalSafeDeep(evaluationReport(db, metrics, { windowDays }));
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
    for (const line of describeByFamily(byFamily(db))) console.log(line);
    // A metric below target is information, not a command failure.
    return 0;
  } finally {
    db.close();
  }
}
