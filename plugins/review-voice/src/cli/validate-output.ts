import { readFileSync } from 'node:fs';
import { validateOutput } from '../contract/validate.ts';
import { checkSeverityAgainstScores, scoredEntries } from '../contract/severity-check.ts';
import { checkUnbackedAbsolutes } from '../contract/backing-check.ts';
import { DEFAULT_LIMITS, totalWordBudget, type ContractLimits } from '../contract/limits.ts';
import { readStdin, numericFlag, flag } from './shared.ts';

export function validateOutputCommand(argv: string[]): number {
  const maxFindings = numericFlag(argv, '--max-findings', DEFAULT_LIMITS.maxFindings ?? 0);
  const maxWords = numericFlag(argv, '--max-words-per-finding', DEFAULT_LIMITS.maxWordsPerFinding);
  const maxTotal = numericFlag(argv, '--max-total-words', DEFAULT_LIMITS.maxTotalWords);

  if (maxFindings === null || maxWords === null || maxTotal === null) {
    console.error('Limit flags take a non-negative integer.');
    return 2;
  }

  // The budget scales with the change: --scale-to-files keeps that arithmetic
  // in the CLI rather than asking a prompt to compute it.
  const scaleTo = numericFlag(argv, '--scale-to-files', 0);
  const scaledTotal = scaleTo !== null && scaleTo > 0 ? totalWordBudget(scaleTo) : maxTotal;

  const limits: ContractLimits = {
    ...DEFAULT_LIMITS,
    maxFindings: argv.includes('--max-findings') ? maxFindings : null,
    maxWordsPerFinding: maxWords,
    maxTotalWords: Math.max(scaledTotal, maxTotal === DEFAULT_LIMITS.maxTotalWords ? scaledTotal : maxTotal),
  };

  const output = readStdin();
  const result = validateOutput(output, limits);

  // A tag that disagrees with its score is otherwise held silently at post
  // time, after the editor can no longer retry.
  const scoresFlag = flag(argv, '--scores');
  if (argv.includes('--scores') && scoresFlag === null) {
    console.error('--scores needs the JSON file that `RV score` printed.');
    return 2;
  }
  if (scoresFlag !== null) {
    let entries: unknown[];
    try {
      entries = scoredEntries(JSON.parse(readFileSync(scoresFlag, 'utf8')));
    } catch (error) {
      console.error(`Cannot read ${scoresFlag}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    result.violations.push(...checkSeverityAgainstScores(output, entries));
    // An impact the finding does not state - "on every load" - passes every
    // other check (#79), so it is caught here while the editor can retry.
    result.violations.push(...checkUnbackedAbsolutes(output, entries));
    result.valid = result.violations.length === 0;
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }

  if (result.valid) {
    console.log(
      `Contract satisfied: ${result.findingCount} finding(s), ${result.totalWords}/${limits.maxTotalWords} words.`,
    );
    return 0;
  }

  // Every violation is reported, not just the first: a retry is only useful if
  // the editor can see everything it has to fix.
  for (const violation of result.violations) {
    const where = violation.line === undefined ? '' : `line ${violation.line}: `;
    console.error(`[${violation.code}] ${where}${violation.message}`);
  }
  console.error(`\n${result.violations.length} contract violation(s).`);
  return 1;
}
