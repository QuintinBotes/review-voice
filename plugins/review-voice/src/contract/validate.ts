import { DEFAULT_LIMITS, SEVERITY_ORDER, type ContractLimits, type Severity } from './limits.ts';
import { countWords } from './words.ts';
import { parseFinding, splitFindings, type ParsedFinding } from './parse.ts';

export interface Violation {
  /** Stable machine-readable code, so a retry prompt can be built from it. */
  code: string;
  /** 1-indexed line in the submitted output, when attributable. */
  line?: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  findingCount: number;
  totalWords: number;
  violations: Violation[];
}

/**
 * Anything that looks like a heading, a greeting, or a summary. The contract
 * says findings only; this catches the shapes models reach for when they want
 * to add framing around them.
 */
const STRUCTURAL_NOISE: { pattern: RegExp; code: string; message: string }[] = [
  { pattern: /^#{1,6}\s/m, code: 'heading', message: 'Markdown heading. The output is findings only.' },
  { pattern: /^\s*(hi|hello|hey|thanks|great)\b/im, code: 'greeting', message: 'Greeting. The output is findings only.' },
  {
    pattern: /^\s*(here(?:'s| is)\b|i (?:reviewed|looked|found|have)\b|i've\b)/im,
    code: 'preamble',
    message: 'Preamble describing the review. State findings without narrating them.',
  },
  {
    pattern: /^\s*(in (?:summary|conclusion)|to summari[sz]e|overall)\b/im,
    code: 'summary',
    message: 'Summary section. The output is findings only.',
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Forbidden phrases match on word boundaries, so "nit" never fires on
 * "initial". Every match is returned rather than the first: this feeds a retry
 * prompt, and an editor that fixes one phrase only to be rejected for the next
 * one burns a round trip per word.
 */
function findForbiddenPhrases(prose: string, phrases: readonly string[]): string[] {
  return phrases.filter((phrase) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, 'iu').test(prose),
  );
}

function validateFinding(
  finding: ParsedFinding,
  limits: ContractLimits,
  violations: Violation[],
): number {
  const at = finding.startLine;

  if (finding.severity === null || finding.path === null) {
    violations.push({
      code: 'format',
      line: at,
      message:
        'Does not match: [severity] `path:line` — Problem. Consequence. Suggested fix. ' +
        '(severity is blocking, important or minor; the separator is an em dash)',
    });
    // Without a parse there is nothing further to check on this finding.
    return 0;
  }

  if (finding.prose.length === 0) {
    violations.push({ code: 'empty', line: at, message: 'Finding has no text after the separator.' });
    return 0;
  }

  const words = countWords(finding.prose);
  if (words > limits.maxWordsPerFinding) {
    violations.push({
      code: 'finding_too_long',
      line: at,
      message: `${words} words; the limit is ${limits.maxWordsPerFinding}. Cut it or drop the finding.`,
    });
  }

  for (const phrase of findForbiddenPhrases(finding.prose, limits.forbiddenPhrases)) {
    violations.push({
      code: 'forbidden_phrase',
      line: at,
      message: `Contains "${phrase}". State the problem rather than hedging about it.`,
    });
  }

  return words;
}

export function validateOutput(
  output: string,
  limits: ContractLimits = DEFAULT_LIMITS,
): ValidationResult {
  const violations: Violation[] = [];
  const trimmed = output.trim();

  // The no-findings case is exact. Accepting near-misses here would make the
  // "silence is meaningful" guarantee unmeasurable.
  if (splitFindings(output).length === 0) {
    if (trimmed !== limits.noFindingsResponse) {
      violations.push({
        code: 'no_findings_response',
        message:
          `Output contains no findings, so it must be exactly ${JSON.stringify(limits.noFindingsResponse)}. ` +
          `Got ${JSON.stringify(trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed)}.`,
      });
    }
    return { valid: violations.length === 0, findingCount: 0, totalWords: 0, violations };
  }

  for (const { pattern, code, message } of STRUCTURAL_NOISE) {
    if (pattern.test(output)) violations.push({ code, message });
  }

  const findings = splitFindings(output).map((block) => parseFinding(block.raw, block.startLine));

  if (limits.maxFindings !== null && findings.length > limits.maxFindings) {
    violations.push({
      code: 'too_many_findings',
      message: `${findings.length} findings; the limit is ${limits.maxFindings}. Keep the most material.`,
    });
  }

  let totalWords = 0;
  const seenLocations = new Map<string, number>();

  for (const finding of findings) {
    totalWords += validateFinding(finding, limits, violations);

    if (finding.path !== null && finding.line !== null) {
      const location = `${finding.path}:${finding.line}`;
      const first = seenLocations.get(location);
      if (first !== undefined) {
        violations.push({
          code: 'duplicate_location',
          line: finding.startLine,
          message: `Second finding at ${location}; the first is at output line ${first}. Merge them or drop one.`,
        });
      } else {
        seenLocations.set(location, finding.startLine);
      }
    }
  }

  // Ordering is part of the contract: a reader who stops halfway must have
  // seen the most serious findings, so severity may not run backwards.
  const ranks = findings
    .filter((finding) => finding.severity !== null)
    .map((finding) => SEVERITY_ORDER[finding.severity as Severity]);
  for (let i = 1; i < ranks.length; i += 1) {
    if (ranks[i]! < ranks[i - 1]!) {
      violations.push({
        code: 'severity_order',
        message:
          'Findings are not ordered by severity. Present blocking first and question last, so a reader who stops early has seen the most serious.',
      });
      break;
    }
  }

  if (totalWords > limits.maxTotalWords) {
    violations.push({
      code: 'output_too_long',
      message: `${totalWords} words total; the limit is ${limits.maxTotalWords}.`,
    });
  }

  return { valid: violations.length === 0, findingCount: findings.length, totalWords, violations };
}
