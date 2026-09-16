import type { Database } from '../store/db.ts';
import { computeMetrics } from '../evaluate/metrics.ts';

export interface GateResult {
  allowed: boolean;
  reasons: string[];
  measured: { precision: number | null; labelledFindings: number; contractCompliance: number | null };
}

/**
 * Minimum labelled findings before precision means anything. Three keeps and
 * no dismissals is 100% and tells you nothing.
 */
const MIN_LABELLED = 20;
const MIN_PRECISION = 0.8;

/**
 * Whether Review Voice may post to GitHub.
 *
 * docs/adr/0007 gates posting on the precision targets holding in practice.
 * This reads what was actually measured rather than a setting, because a
 * boolean in a config file is a promise the user makes to themselves, and the
 * point of the gate is that it holds when they would rather it did not.
 *
 * There is deliberately no override. A gate with a bypass is a suggestion.
 */
export function evaluatePostingGate(db: Database, configEnabled: boolean): GateResult {
  const metrics = computeMetrics(db);
  const precisionMetric = metrics.find((m) => m.name === 'owner_accepted_precision');
  const complianceMetric = metrics.find((m) => m.name === 'contract_compliance');

  const feedback = db.prepare('SELECT action, COUNT(*) AS n FROM feedback GROUP BY action').all() as {
    action: string;
    n: number;
  }[];
  const by = Object.fromEntries(feedback.map((row) => [row.action, row.n]));
  const labelled = (by['keep'] ?? 0) + (by['rewrite'] ?? 0) + (by['dismiss'] ?? 0);

  const precision = precisionMetric?.value ?? null;
  const compliance = complianceMetric?.value ?? null;

  const reasons: string[] = [];

  if (!configEnabled) {
    reasons.push('writes.github_posting_enabled is false in .review-voice/config.yaml');
  }
  if (labelled < MIN_LABELLED) {
    reasons.push(
      `only ${labelled} findings have been labelled; ${MIN_LABELLED} are needed before precision means anything`,
    );
  }
  if (precision === null) {
    reasons.push('owner-accepted precision has not been measured');
  } else if (precision < MIN_PRECISION) {
    reasons.push(`measured precision ${precision.toFixed(2)} is below the ${MIN_PRECISION} target in docs/adr/0007`);
  }
  if (compliance !== null && compliance < 1) {
    reasons.push(`contract compliance ${compliance.toFixed(2)} is below 1.00`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    measured: { precision, labelledFindings: labelled, contractCompliance: compliance },
  };
}
