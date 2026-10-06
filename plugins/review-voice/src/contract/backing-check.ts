import { scoresAtLocation } from '../publish/verdict.ts';
import { splitFindings, parseFinding } from './parse.ts';
import type { Violation } from './validate.ts';

/**
 * Words that widen a finding to every case. The editor has no tools and may
 * only compress what the verifier established, yet on a finding about a
 * banner shown "while the query is still loading" it wrote "on every open",
 * and, told not to, "on every load" (#79). Each is a claim about reach that
 * only the scored finding can back.
 */
const ABSOLUTES = ['every', 'everyone', 'everything', 'everywhere', 'always', 'never', 'all'];

const WORD = /[a-z]+/g;

/** The words of a text, lower case, with code spans and blocks left out. */
function wordsOf(text: string): Set<string> {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  return new Set(prose.toLowerCase().match(WORD) ?? []);
}

/** Every text of a scored entry that may back what the editor writes. */
function backingText(entry: Record<string, unknown>): string {
  const parts: unknown[] = [entry['claim'], entry['failureMode'], entry['failure_mode']];
  const evidence = entry['evidence'];
  if (Array.isArray(evidence)) parts.push(...evidence);
  const fix = entry['fix'];
  if (typeof fix === 'object' && fix !== null) parts.push((fix as { text?: unknown }).text);
  const repeat = entry['possibleRepeatOf'];
  if (typeof repeat === 'object' && repeat !== null) {
    const remaining = (repeat as { remaining?: unknown }).remaining;
    if (Array.isArray(remaining)) parts.push(...remaining);
  }
  return parts.filter((part): part is string => typeof part === 'string').join(' ');
}

/**
 * Violations for rendered findings that use an absolute word - every, always,
 * never, all - that their scored claim, failure mode, evidence and fix do not.
 *
 * Checked as a word, not as meaning: "never closes" is not backed by "is not
 * closed". That is deliberate, since the editor can always keep the scored
 * wording, and a retry is cheaper than a posted overstatement. Code spans are
 * ignored, so `Promise.all` in a fix is not read as a claim.
 */
export function checkUnbackedAbsolutes(output: string, scores: readonly unknown[]): Violation[] {
  const violations: Violation[] = [];
  for (const block of splitFindings(output)) {
    const finding = parseFinding(block.raw, block.startLine);
    if (finding.path === null || finding.line === null) continue;
    const here = scoresAtLocation(scores, finding.path, finding.line);
    // A finding with no score is `severity_no_score`'s to report.
    if (here.length === 0) continue;
    const backed = wordsOf(here.map((entry) => backingText(entry as Record<string, unknown>)).join(' '));
    const said = wordsOf(finding.prose);
    const unbacked = ABSOLUTES.filter((word) => said.has(word) && !backed.has(word));
    if (unbacked.length === 0) continue;
    violations.push({
      code: 'unbacked_absolute',
      line: finding.startLine,
      message:
        `${finding.path}:${finding.line} says ${unbacked.map((word) => `"${word}"`).join(', ')}, ` +
        'which its scored claim, failure mode, evidence and fix do not. ' +
        'State the consequence as the finding states it; do not widen its reach.',
    });
  }
  return violations;
}
