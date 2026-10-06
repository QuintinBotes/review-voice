import { spawnSync } from 'node:child_process';
import type { DecisiveEvidence, FindingVerdict, RawVerdict, VerificationReport, Verdict } from './types.ts';

export interface VerifiableFinding {
  candidateId: string;
  path: string;
  line: number;
  severity: string;
  claim: string;
  failureMode: string;
  evidence: string[];
}

/**
 * What change the finding is about.
 *
 * Without this the command was handed a finding and nothing else, and ran with
 * the session's own `cwd`, so it judged whatever the working tree happened to
 * be rather than the diff under review. A verifier asked "is this claim true?"
 * with no way to see the change answers about the wrong code, confidently: a
 * test run of it returned a false rejection at 0.99.
 *
 * `base` and `head` are supplied only when they are actually readable locally
 * - `diff --pr` now reports that rather than assuming it. A ref that is not
 * there is worse than no ref, because a command told to read it will fail in a
 * way it may mistake for evidence.
 */
export interface VerificationContext {
  repository: string | null;
  /** Path to the unified diff under review, already on disk from step 1. */
  diffPath: string | null;
  base: string | null;
  head: string | null;
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

/** What `verify` says when the pass is off because nothing is configured. */
export const HOW_TO_ENABLE =
  'Add a `verification:` block to .review-voice/config.yaml with `enabled: true` and a `command` ' +
  'that runs a different model on the candidates JSON from stdin (optional: name, timeout_seconds, ' +
  'drop_threshold). See templates/config.example.yaml.';

/** Severity tiers, weakest last, so a downgrade has somewhere to go. */
const TIERS = ['blocking', 'important', 'minor', 'nit', 'question'];

function downgrade(severity: string): string {
  // A question is weaker than a nit already: turning it into one would make
  // a doubting verdict assert what the analyst only asked.
  if (severity === 'question') return 'question';
  const index = TIERS.indexOf(severity);
  if (index === -1 || index >= TIERS.length - 2) return 'nit';
  return TIERS[index + 1] ?? 'nit';
}

/** At most this many decisive lines are kept: they are places to look, not a review. */
const MAX_DECISIVE_EVIDENCE = 10;

/**
 * The verifier's decisive lines, keeping only well-formed entries. The
 * command's output is untrusted, and a malformed entry is no place to look.
 */
function decisiveEvidence(raw: RawVerdict): DecisiveEvidence[] {
  const list = raw.decisive_evidence ?? raw.decisiveEvidence;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry): entry is DecisiveEvidence => {
      const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      return (
        typeof e['path'] === 'string' && e['path'].length > 0 &&
        Number.isInteger(e['line']) && (e['line'] as number) > 0 &&
        typeof e['why'] === 'string' && e['why'].trim().length > 0
      );
    })
    .slice(0, MAX_DECISIVE_EVIDENCE)
    .map((entry) => ({ path: entry.path, line: entry.line, why: entry.why }));
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

const VERDICTS: readonly string[] = ['confirmed', 'rejected', 'uncertain'];

function parseVerdict(stdout: string): RawVerdict | null {
  // Verifiers are chatty, and may revise themselves. The last well-formed
  // verdict wins rather than requiring the command to emit nothing else.
  for (const candidate of jsonCandidates(stdout).reverse()) {
    try {
      const parsed = JSON.parse(candidate) as RawVerdict;
      if (typeof parsed.verdict !== 'string') continue;
      // The last verdict is the answer. A label outside the three, such as
      // "REFUTED", is no verdict: read as a confirmation it would keep a
      // finding the verifier meant to reject, and skipping it would apply an
      // earlier draft the verifier had revised.
      const label = parsed.verdict.toLowerCase();
      return VERDICTS.includes(label) ? { ...parsed, verdict: label as Verdict } : null;
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
  options: { cwd: string; runner?: Runner; context?: VerificationContext },
): VerificationReport {
  const name = config.name ?? 'external';

  if (!config.enabled || config.command.trim().length === 0) {
    return {
      enabled: false,
      verifier: null,
      verdicts: [],
      didNotRun: findings.length > 0 ? [name] : [],
      howToEnable: HOW_TO_ENABLE,
    };
  }
  if (findings.length === 0) {
    return { enabled: false, verifier: null, verdicts: [], didNotRun: [] };
  }

  const dropThreshold = config.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
  const verdicts: FindingVerdict[] = [];
  const didNotRun: string[] = [];

  const runner = options.runner ?? spawnRunner;

  for (const finding of findings) {
    const result = runner(
      config.command,
      JSON.stringify({ ...finding, context: options.context ?? null }),
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
    // The command's output is untrusted: a reason that is not text is none.
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    const decisive = decisiveEvidence(raw);

    let outcome: FindingVerdict['outcome'] = 'kept';
    let finalSeverity = finding.severity;
    let proposedSeverity: string | undefined;

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
    } else if (
      raw.suggested_severity !== undefined &&
      raw.suggested_severity !== 'question' &&
      TIERS.includes(raw.suggested_severity) &&
      TIERS.indexOf(finding.severity) !== -1 &&
      TIERS.indexOf(raw.suggested_severity) < TIERS.indexOf(finding.severity) &&
      decisive.length > 0 &&
      reason.trim().length > 0
    ) {
      // A worse impact the verifier traced is a proposal, not a change: the
      // tier stays, and `reconcile` hands it to the tie-break. Without lines
      // to check it there is nothing to settle, and it is ignored as before.
      proposedSeverity = raw.suggested_severity;
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
      ...(decisive.length > 0 ? { decisiveEvidence: decisive } : {}),
      ...(proposedSeverity === undefined ? {} : { proposedSeverity }),
    });
  }

  return { enabled: true, verifier: name, verdicts, didNotRun: [...new Set(didNotRun)] };
}
