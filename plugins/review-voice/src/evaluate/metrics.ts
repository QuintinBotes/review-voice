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
  /**
   * `gate` is a contract the reviewer must meet. `goal` is something to aim
   * at, reported but never failed.
   *
   * The two used to be reported identically, which produced a standing
   * failure on `median_words_per_finding`: the target said 28 while the
   * contract the validator enforces says 40, so every compliant review failed
   * a metric it had not broken. A number that cannot be met by following the
   * rules is not a target, it is a mislabelled aspiration.
   */
  kind: 'gate' | 'goal';
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

  const agreement = candidateSetAgreement(db);

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
    kind: Metric['kind'] = 'gate',
  ): Metric => ({
    name,
    value,
    target,
    meets: value === null ? null : meets(value),
    basis,
    kind,
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
    // Counts are a property of the pull requests reviewed, not of the
    // reviewer. Since the output contract stopped capping findings, a run that
    // correctly reports nine defects in a large diff was failing a target that
    // asked it to report two.
    metric(
      'median_findings_per_review',
      median(findingsPerRun),
      'no target',
      () => true,
      `${runs.length} runs; a count reflects the diff, not the reviewer`,
      'goal',
    ),
    metric(
      'p95_findings_per_review',
      percentile(findingsPerRun, 95),
      'no target',
      () => true,
      `${runs.length} runs; a count reflects the diff, not the reviewer`,
      'goal',
    ),
    metric(
      'median_words_per_finding',
      median(wordsPerFinding),
      '<= 28',
      (v) => v <= 28,
      `${wordsPerFinding.length} findings; the contract ceiling is 40, this is the brevity to aim for`,
      'goal',
    ),
    metric(
      'p95_words_per_finding',
      percentile(wordsPerFinding, 95),
      '<= 40',
      (v) => v <= 40,
      `${wordsPerFinding.length} findings; this is the contract ceiling the validator enforces`,
    ),
    // The variance nobody was tracking. Severity stability was measured for
    // three releases while which findings exist at all was not, and on one
    // pull request reviewed twice the two runs agreed on two candidates of
    // eight. For a reviewer that is the more consequential variance: a single
    // run is a sample, not the answer.
    metric(
      'candidate_set_agreement',
      agreement.value,
      'no target',
      () => true,
      agreement.basis,
      'goal',
    ),
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


/**
 * How much two reviews of the same diff agree on which findings exist.
 *
 * Jaccard over `path:line`, across every diff reviewed more than once. Location
 * rather than wording, because the editor rewrites prose and two runs naming
 * the same defect at the same line are the same finding however they phrase it.
 *
 * Reported and never scored. There is no defensible target yet, and inventing
 * one would be worse than saying the number out loud.
 */
function candidateSetAgreement(db: Database): { value: number | null; basis: string } {
  const rows = db
    .prepare('SELECT diff_hash, candidates_json FROM review_runs WHERE diff_hash IS NOT NULL')
    .all() as { diff_hash: string; candidates_json: string | null }[];

  const byDiff = new Map<string, Set<string>[]>();

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.candidates_json ?? '[]');
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : ((parsed as { candidates?: unknown[] }).candidates ?? []);
    const located = new Set(
      (list as Record<string, unknown>[])
        .map((candidate) => `${String(candidate['path'] ?? '')}:${String(candidate['line'] ?? '')}`)
        .filter((key) => key !== ':'),
    );
    if (located.size === 0) continue;

    const existing = byDiff.get(row.diff_hash);
    if (existing === undefined) byDiff.set(row.diff_hash, [located]);
    else existing.push(located);
  }

  const scores: number[] = [];
  let pairs = 0;

  for (const sets of byDiff.values()) {
    if (sets.length < 2) continue;
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        const a = sets[i] as Set<string>;
        const b = sets[j] as Set<string>;
        const shared = [...a].filter((key) => b.has(key)).length;
        const union = new Set([...a, ...b]).size;
        if (union === 0) continue;
        scores.push(shared / union);
        pairs += 1;
      }
    }
  }

  if (pairs === 0) {
    return {
      value: null,
      basis: 'no diff has been reviewed twice; record two runs of one diff to measure this',
    };
  }

  return {
    value: median(scores),
    basis: `${pairs} pair(s) of runs over the same diff, by path:line`,
  };
}
