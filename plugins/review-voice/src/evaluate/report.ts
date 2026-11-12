import { formatMetricValue, metricMark, metricTarget, type EvaluationReport, type Metric } from './metrics.ts';
import type { PostedStats, PrecisionStats } from '../store/outcomes.ts';

/**
 * The rendered analytics report: one HTML fragment over the object
 * `evaluate --json` prints, so the two cannot disagree. The fragment uses only
 * the elements GitHub renders in a job summary (headings, paragraphs, tables
 * and details) with no attribute, so the same bytes work appended to
 * `$GITHUB_STEP_SUMMARY` and saved in a file. Deterministic: the producers sort
 * their keys and nothing here reads the clock.
 */

/** Longest string from the store or configuration, in code points, before `...` is appended. */
const CUT_AT = 120;

/**
 * Cut first, then escape, so a cut never splits an entity. Line endings become
 * spaces because a blank line ends the HTML block GitHub renders, and the rest
 * of the cell would then be parsed as Markdown (a link, an image).
 */
function escapeHtml(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cut(text: string): string {
  const points = [...text];
  return points.length > CUT_AT ? `${points.slice(0, CUT_AT).join('')}...` : text;
}

const text = (value: string): string => escapeHtml(cut(value));
const count = (value: number | null): string => (value === null ? 'no data' : String(value));
const rate = (value: number | null): string => (value === null ? 'no data' : value.toFixed(2));

/** The paragraphs are the renderer's own sentences, so they are escaped and never cut. */
const p = (body: string): string => `<p>${escapeHtml(body)}</p>\n`;
const h3 = (title: string): string => `<h3>${text(title)}</h3>\n`;

/** Every cell passes through `text`, so no value reaches the page unescaped. No blank line, or GitHub ends the HTML block. */
function table(headers: string[], rows: string[][]): string {
  const cells = (tag: 'th' | 'td', values: string[]): string => values.map((value) => `<${tag}>${text(value)}</${tag}>`).join('');
  return `<table><thead><tr>${cells('th', headers)}</tr></thead>\n<tbody>\n${rows.map((row) => `<tr>${cells('td', row)}</tr>\n`).join('')}</tbody></table>\n`;
}

/** A section with nothing to show prints one paragraph with `no data` and the reason; never an empty table, never a zero. */
const tableOrNone = (reason: string, headers: string[], rows: string[][]): string => (rows.length === 0 ? p(`no data; ${reason}`) : table(headers, rows));

const METRIC_HEADERS = ['metric', 'value', 'mark', 'target', 'basis'];
const metricRows = (metrics: Metric[]): string[][] =>
  metrics.map((metric) => [metric.name, formatMetricValue(metric), metricMark(metric), metricTarget(metric), metric.basis]);

const POSTED_HEADERS = ['tracked', 'fixed', 'dismissed', 'fixed rate', 'dismissed rate'];
const postedRow = (key: string, stats: PostedStats): string[] => [key, count(stats.tracked), count(stats.fixed), count(stats.dismissed), rate(stats.fixedRate), rate(stats.dismissedRate)];
const postedTable = (key: string, group: Record<string, PostedStats>): string =>
  tableOrNone('no posted finding has a recorded outcome', [key, ...POSTED_HEADERS], Object.entries(group).map(([name, stats]) => postedRow(name, stats)));
const labelTable = (key: string, group: Record<string, PrecisionStats>): string =>
  tableOrNone(
    'no finding has been labelled',
    [key, 'kept', 'dismissed', 'precision'],
    Object.entries(group).map(([name, s]) => [name, count(s.kept), count(s.dismissed), rate(s.precision)]),
  );

export function renderEvaluationHtml(report: EvaluationReport): string {
  const { metrics, posted_breakdown: posted, precision_breakdown: precision } = report;
  const noMetric = 'no metric of this kind';
  // The three tables partition the metrics, so no figure prints twice.
  const gates = metrics.filter((m) => m.kind === 'gate' && m.target !== 'no target');
  const goals = metrics.filter((m) => m.kind === 'goal' && m.target !== 'no target');
  const reported = metrics.filter((m) => m.target === 'no target');
  const blocks = posted.by_evidence_block;
  const anyPosted =
    Object.keys(posted.by_severity).length + Object.keys(posted.by_lane).length + Object.keys(posted.by_rule).length > 0 ||
    blocks.with.tracked + blocks.without.tracked + blocks.unknown.tracked > 0;
  const anyLabel = Object.keys(precision.by_lane).length + Object.keys(precision.by_rule).length > 0;
  return [
    `<h2>Review Voice evaluation</h2>\n`,
    p(
      `Generated at ${report.generated_at}; the recent posted rates cover the last ${report.window_days} days. ` +
        'A figure with no data prints no data, never zero. A gate is a contract; a goal and a reported figure are never failed.',
    ),
    h3('Gates'),
    tableOrNone(noMetric, METRIC_HEADERS, metricRows(gates)),
    h3('Goals'),
    tableOrNone(noMetric, METRIC_HEADERS, metricRows(goals)),
    h3('Reported, not scored'),
    tableOrNone(noMetric, METRIC_HEADERS, metricRows(reported)),
    h3('Seconds by stage'),
    tableOrNone(
      'no run has recorded stage timings',
      ['stage', 'median', 'p95', 'runs', 'unmeasured'],
      Object.entries(report.stage_seconds).map(([stage, s]) => [stage, rate(s.median), rate(s.p95), count(s.runs), count(s.unmeasured)]),
    ),
    h3('Posted findings'),
    anyPosted
      ? p('Rates count strong outcomes only; a weak outcome is tracked and not counted.') +
        postedTable('severity', posted.by_severity) +
        postedTable('lane', posted.by_lane) +
        postedTable('rule', posted.by_rule) +
        table(['evidence block', ...POSTED_HEADERS], (['with', 'without', 'unknown'] as const).map((key) => postedRow(key, blocks[key])))
      : p('no data; no posted finding has a recorded outcome'),
    h3('Owner labels'),
    anyLabel
      ? p('Unlabelled findings are excluded; silence is never a label.') + labelTable('lane', precision.by_lane) + labelTable('rule', precision.by_rule)
      : p('no data; no finding has been labelled'),
    h3('Suppressions since approval'),
    tableOrNone(
      'no approved suppression is active',
      ['rule', 'scopes', 'approved', 'held', 'runs', 'posted fixed', 'posted dismissed', 'labelled kept', 'labelled dismissed', 'basis'],
      report.rule_effectiveness.map((entry) => [
        entry.rule_id,
        entry.suppressions.map((s) => `${s.glob ?? 'everywhere'}${s.policy_version === null ? '' : ` (v${s.policy_version})`}`).join(', '),
        entry.approved_at ?? 'no data',
        count(entry.held),
        count(entry.runs),
        entry.posted === null ? 'no data' : count(entry.posted.fixed),
        entry.posted === null ? 'no data' : count(entry.posted.dismissed),
        entry.feedback === null ? 'no data' : count(entry.feedback.kept),
        entry.feedback === null ? 'no data' : count(entry.feedback.dismissed),
        entry.basis,
      ]),
    ),
  ].join('');
}

/** A complete static page around the fragment, for `--out`: no script, no external resource, a border on the tables and nothing else. */
export function htmlDocument(fragment: string, title: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'table { border-collapse: collapse; margin: 0 0 1em; }',
    'th, td { border: 1px solid #999; padding: 2px 8px; text-align: left; vertical-align: top; }',
    'code { font-family: monospace; }',
    '</style>',
    '</head>',
    '<body>',
    fragment.trimEnd(),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
