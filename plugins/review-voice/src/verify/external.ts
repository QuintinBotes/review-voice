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
   * finding is downgraded instead - an unsure verifier should not be able to
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

/**
 * Extracts top-level `{...}` regions by matching braces, ignoring any inside
 * strings.
 *
 * A regex cannot do this. Greedy matching swallows two objects into one
 * unparseable span; non-greedy stops at the first closing brace and breaks on
 * the nested objects a real verdict contains.
 */
function jsonCandidates(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        found.push(text.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
      }
    }
  }

  return found;
}

function parseVerdict(stdout: string): RawVerdict | null {
  // Verifiers are chatty, and may revise themselves. The last well-formed
  // verdict wins rather than requiring the command to emit nothing else.
  for (const candidate of jsonCandidates(stdout).reverse()) {
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
 * that silently deletes findings is the count cap in a different coat - the
 * failure has to be visible, or a bad verifier is indistinguishable from a
 * clean diff.
 */
/** What running the verifier produced. Injectable so tests need no subprocess. */
export interface RunResult {
  stdout: string;
  stderr: string;
  failed: boolean;
}

export type Runner = (command: string, input: string, timeoutMs: number, cwd: string) => RunResult;

const spawnRunner: Runner = (command, input, timeoutMs, cwd) => {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    input,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    failed: result.error !== undefined || result.status === null,
  };
};

export function verifyFindings(
  findings: VerifiableFinding[],
  config: VerifierConfig,
  options: { cwd: string; runner?: Runner },
): VerificationReport {
  const name = config.name ?? 'external';

  if (!config.enabled || config.command.trim().length === 0 || findings.length === 0) {
    return { enabled: false, verifier: null, verdicts: [], didNotRun: findings.length > 0 ? [name] : [] };
  }

  const dropThreshold = config.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
  const verdicts: FindingVerdict[] = [];
  const didNotRun: string[] = [];

  const runner = options.runner ?? spawnRunner;

  for (const finding of findings) {
    const result = runner(
      config.command,
      JSON.stringify(finding),
      (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
      options.cwd,
    );

    const unavailable = result.failed;
    const raw = unavailable ? null : parseVerdict(`${result.stdout}\n${result.stderr}`);

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
          ? 'verifier did not run'
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
      // A confirmation may still weaken the tier, never strengthen it - a
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
