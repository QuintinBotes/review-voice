import type { Database } from '../store/db.ts';
import { validateOutput } from '../contract/validate.ts';
import { DEFAULT_LIMITS } from '../contract/limits.ts';
import { countWords } from '../contract/words.ts';
import { splitFindings, parseFinding } from '../contract/parse.ts';

export interface Metric {
  name: string;
  value: number | null;
  target: string;
  meets: boolean | null;
  /** How the number was arrived at, so a passing metric can be checked. */
  basis: string;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? null;
}

function median(values: number[]): number | null {
  return percentile(values, 50);
}

interface RunRow {
  output_json: string;
}

/**
 * Computes the specification's evaluation metrics from recorded runs and
 * feedback.
 *
 * A metric with no data reports null rather than a flattering default. A
 * reviewer that has never run is not a reviewer with perfect compliance, and
 * reporting 100% from zero samples is how a dashboard starts lying.
 */
export function computeMetrics(db: Database): Metric[] {
  const runs = db.prepare('SELECT output_json FROM review_runs').all() as unknown as RunRow[];

  const findingsPerRun: number[] = [];
  const wordsPerFinding: number[] = [];
  let compliantOutputs = 0;
  let noFindingsRuns = 0;
  let exactNoFindings = 0;

  for (const run of runs) {
    let output = '';
    try {
      output = (JSON.parse(run.output_json) as { output: string }).output ?? '';
    } catch {
      continue;
    }

    const parsed = splitFindings(output).map((block) => parseFinding(block.raw, block.startLine));
    findingsPerRun.push(parsed.length);

    for (const finding of parsed) {
      if (finding.prose.length > 0) wordsPerFinding.push(countWords(finding.prose));
    }

    if (validateOutput(output).valid) compliantOutputs += 1;

    if (parsed.length === 0) {
      noFindingsRuns += 1;
      if (output.trim() === DEFAULT_LIMITS.noFindingsResponse) exactNoFindings += 1;
    }
  }

  const feedback = db.prepare('SELECT action, COUNT(*) AS n FROM feedback GROUP BY action').all() as {
    action: string;
    n: number;
  }[];
  const by = Object.fromEntries(feedback.map((row) => [row.action, row.n]));
  const kept = (by['keep'] ?? 0) + (by['rewrite'] ?? 0);
  const dismissed = by['dismiss'] ?? 0;
  const labelled = kept + dismissed;

  const ratio = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : numerator / denominator;

  const metric = (
    name: string,
    value: number | null,
    target: string,
    meets: (v: number) => boolean,
    basis: string,
  ): Metric => ({
    name,
    value,
    target,
    meets: value === null ? null : meets(value),
    basis,
  });

  return [
    metric(
      'owner_accepted_precision',
      ratio(kept, labelled),
      '>= 0.80',
      (v) => v >= 0.8,
      // Unlabelled findings are excluded: counting silence as a dismissal
      // would make the reviewer look worse the quieter its user is.
      `(${kept} kept or rewritten) / (${labelled} labelled); unlabelled excluded`,
    ),
    metric('median_findings_per_review', median(findingsPerRun), '<= 2', (v) => v <= 2, `${runs.length} runs`),
    metric('p95_findings_per_review', percentile(findingsPerRun, 95), '<= 5', (v) => v <= 5, `${runs.length} runs`),
    metric('median_words_per_finding', median(wordsPerFinding), '<= 28', (v) => v <= 28, `${wordsPerFinding.length} findings`),
    metric('p95_words_per_finding', percentile(wordsPerFinding, 95), '<= 40', (v) => v <= 40, `${wordsPerFinding.length} findings`),
    metric(
      'contract_compliance',
      ratio(compliantOutputs, runs.length),
      '= 1.00',
      (v) => v >= 1,
      `${compliantOutputs}/${runs.length} recorded outputs pass validate-output`,
    ),
    metric(
      'exact_no_findings_compliance',
      ratio(exactNoFindings, noFindingsRuns),
      '= 1.00',
      (v) => v >= 1,
      `${exactNoFindings}/${noFindingsRuns} empty reviews used the exact string`,
    ),
  ];
}
