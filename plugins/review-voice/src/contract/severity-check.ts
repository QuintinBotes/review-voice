import { scoresAtLocation } from '../publish/verdict.ts';
import { splitFindings, parseFinding } from './parse.ts';
import type { Violation } from './validate.ts';

/** The severity a scored entry carries: a plain string, or the derived-tier object `scores` holds. */
function severityOf(score: { severity?: unknown }): string | null {
  const value = score.severity;
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'object' && value !== null) {
    const inner = (value as { severity?: unknown }).severity;
    if (typeof inner === 'string') return inner.toLowerCase();
  }
  return null;
}

/**
 * The scored entries a rendered review is checked against: the `eligible`
 * list of `RV score` output when given that, else a bare array or `scores`.
 * Only entries that shipped can back a finding, so `scores` is filtered to
 * the eligible ones.
 */
export function scoredEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== 'object' || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record['eligible'])) return record['eligible'];
  if (Array.isArray(record['scores'])) {
    return record['scores'].filter(
      (entry) => typeof entry === 'object' && entry !== null && (entry as { eligible?: unknown }).eligible === true,
    );
  }
  return [];
}

/**
 * Violations for rendered findings whose severity tag disagrees with the
 * severity the score derived at that path and line.
 *
 * Posting holds a finding whose tag has no matching score, silently, so the
 * disagreement is caught here while the editor can still retry.
 */
export function checkSeverityAgainstScores(output: string, scores: readonly unknown[]): Violation[] {
  const violations: Violation[] = [];
  for (const block of splitFindings(output)) {
    const finding = parseFinding(block.raw, block.startLine);
    if (finding.path === null || finding.line === null || finding.severity === null) continue;
    const where = `${finding.path}:${finding.line}`;
    const here = scoresAtLocation(scores, finding.path, finding.line);
    if (here.length === 0) {
      violations.push({
        code: 'severity_no_score',
        line: finding.startLine,
        message: `${where} is tagged ${finding.severity} but there is no scored candidate at that path:line.`,
      });
      continue;
    }
    const derived = here.map(severityOf).filter((value): value is string => value !== null);
    if (!derived.includes(finding.severity)) {
      violations.push({
        code: 'severity_mismatch',
        line: finding.startLine,
        message:
          `${where} is tagged ${finding.severity} but its score derived ${derived.join('/') || 'no severity'}. ` +
          'Use the severity from the score, which is the one that can post.',
      });
    }
  }
  return violations;
}
