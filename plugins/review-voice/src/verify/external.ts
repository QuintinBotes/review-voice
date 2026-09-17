import { spawnSync } from 'node:child_process';
import type { FindingVerdict, RawVerdict, VerificationReport, Verdict } from './types.ts';

export interface VerifiableFinding {
  candidateId: string;
  path: string;
  line: number;
  severity: string;
  claim: string;
  failureMode: string;
  evidence: string[];
}

export interface VerifierConfig {
  enabled: boolean;
  /** A command reading a finding as JSON on stdin and writing a verdict to stdout. */
  command: string;
  name?: string;
  timeoutSeconds?: number;
  /**
   * A rejection at or above this confidence drops the finding. Below it, the
   * finding is downgraded instead — an unsure verifier should not be able to
   * delete evidence.
   */
  dropThreshold?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 90;
const DEFAULT_DROP_THRESHOLD = 0.8;

/** Severity tiers, weakest last, so a downgrade has somewhere to go. */
const TIERS = ['blocking', 'important', 'minor', 'nit', 'question'];

function downgrade(severity: string): string {
  const index = TIERS.indexOf(severity);
  if (index === -1 || index >= TIERS.length - 2) return 'nit';
  return TIERS[index + 1] ?? 'nit';
}

function parseVerdict(stdout: string): RawVerdict | null {
  // Verifiers are chatty. Take the last JSON object in the output rather than
  // requiring the command to emit nothing else.
  const matches = stdout.match(/\{[\s\S]*\}/g);
  if (matches === null) return null;
  for (const candidate of [...matches].reverse()) {
    try {
      const parsed = JSON.parse(candidate) as RawVerdict;
      if (typeof parsed.verdict === 'string') return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * A second verification pass, run by a command the user configured.
 *
 * The point is that it is a *different* model from the one that produced the
 * finding. A verifier from the same family shares the analyst's blind spots:
 * asked whether a plausible-sounding defect is real, it agrees more often than
 * it should. Correlated error is what this breaks.
 *
 * Every verdict is recorded, including the ones that change nothing. A verifier
 * that silently deletes findings is the count cap in a different coat — the
 * failure has to be visible, or a bad verifier is indistinguishable from a
 * clean diff.
 */
export function verifyFindings(
  findings: VerifiableFinding[],
  config: VerifierConfig,
  options: { cwd: string },
): VerificationReport {
  const name = config.name ?? 'external';

  if (!config.enabled || config.command.trim().length === 0 || findings.length === 0) {
    return { enabled: false, verifier: null, verdicts: [], didNotRun: findings.length > 0 ? [name] : [] };
  }

  const dropThreshold = config.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
  const verdicts: FindingVerdict[] = [];
  const didNotRun: string[] = [];

  for (const finding of findings) {
    const result = spawnSync(config.command, {
      cwd: options.cwd,
      shell: true,
      encoding: 'utf8',
      input: JSON.stringify(finding),
      timeout: (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const unavailable = result.error !== undefined || result.status === null;
    const raw = unavailable ? null : parseVerdict(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);

    if (raw === null) {
      // A verifier that could not run has not confirmed anything, and must
      // never be read as agreement. The finding stands unchanged.
      didNotRun.push(name);
      verdicts.push({
        candidateId: finding.candidateId,
        path: finding.path,
        line: finding.line,
        verdict: 'uncertain',
        confidence: 0,
        reason: unavailable
          ? `verifier did not run: ${result.error?.message ?? 'no exit status'}`
          : 'verifier produced no parseable verdict',
        outcome: 'unverified',
        originalSeverity: finding.severity,
        finalSeverity: finding.severity,
        verifier: name,
      });
      continue;
    }

    const verdict: Verdict = raw.verdict;
    const confidence = typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.5;
    const reason = raw.reason ?? '';

    let outcome: FindingVerdict['outcome'] = 'kept';
    let finalSeverity = finding.severity;

    if (verdict === 'rejected') {
      if (confidence >= dropThreshold) {
        outcome = 'dropped';
      } else {
        // Unsure rejection: demote rather than delete.
        outcome = 'downgraded';
        finalSeverity = downgrade(finding.severity);
      }
    } else if (verdict === 'uncertain') {
      outcome = 'downgraded';
      finalSeverity = downgrade(finding.severity);
    } else if (
      raw.suggested_severity !== undefined &&
      TIERS.includes(raw.suggested_severity) &&
      TIERS.indexOf(raw.suggested_severity) > TIERS.indexOf(finding.severity)
    ) {
      // A confirmation may still weaken the tier, never strengthen it — a
      // verifier's job is to doubt, not to escalate.
      outcome = 'downgraded';
      finalSeverity = raw.suggested_severity;
    }

    verdicts.push({
      candidateId: finding.candidateId,
      path: finding.path,
      line: finding.line,
      verdict,
      confidence,
      reason,
      outcome,
      originalSeverity: finding.severity,
      finalSeverity,
      verifier: name,
    });
  }

  return { enabled: true, verifier: name, verdicts, didNotRun: [...new Set(didNotRun)] };
}
