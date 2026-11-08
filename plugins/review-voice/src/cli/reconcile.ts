import { readFileSync } from 'node:fs';
import { parseSecondPass, parseTieBreaks, reconcile, ReconcileInputError, type TieBreak } from '../verify/reconcile.ts';
import { readStdin, flag, verificationProblem, verdictList } from './shared.ts';

/**
 * Applies the second pass to the candidates, settling disputes by tie-break.
 *
 * Replaces applying each verdict by hand. A candidate is disputed when the
 * evidence-verifier traced its impact at 0.85 or more and the second pass
 * downgraded or dropped it; without a tie-break for it the second pass stands,
 * exactly as before, and `disputes` says what a tie-break would settle.
 */
export function reconcileCommand(argv: string[]): number {
  let candidates: Record<string, unknown>[];
  try {
    const parsed = JSON.parse(readStdin()) as { candidates?: unknown } | unknown[];
    const list = Array.isArray(parsed) ? parsed : (parsed as { candidates?: unknown }).candidates;
    if (!Array.isArray(list)) throw new Error('no candidates');
    candidates = list as Record<string, unknown>[];
  } catch {
    console.error('Expected {"candidates": [...]} on stdin, as they were before the second pass.');
    return 2;
  }

  const verificationFile = flag(argv, '--verification');
  const secondPassFile = flag(argv, '--second-pass');
  if (verificationFile === null || secondPassFile === null) {
    console.error('reconcile needs --verification <file> (step 3) and --second-pass <file> (the verify report).');
    return 2;
  }

  let verifications: Record<string, unknown>[];
  try {
    verifications = verdictList(JSON.parse(readFileSync(verificationFile, 'utf8')) as unknown);
  } catch (error) {
    console.error(`Cannot read ${verificationFile}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const problem = verificationProblem(verifications);
  if (problem !== null) {
    console.error(`Malformed verification - ${problem}`);
    return 2;
  }
  // Read as "nothing was traced" it would make every dispute disappear.
  if (verifications.length === 0) {
    console.error(`${verificationFile} contained no verifications, so no dispute could be detected.`);
    return 2;
  }

  let secondPass: ReturnType<typeof parseSecondPass>;
  try {
    secondPass = parseSecondPass(JSON.parse(readFileSync(secondPassFile, 'utf8')) as unknown);
  } catch (error) {
    console.error(`Cannot read the second pass from ${secondPassFile}: ${(error as Error).message}`);
    return 2;
  }

  let tieBreaks: TieBreak[] | null = null;
  const tieBreaksFile = flag(argv, '--tie-breaks');
  if (tieBreaksFile !== null) {
    try {
      tieBreaks = parseTieBreaks(JSON.parse(readFileSync(tieBreaksFile, 'utf8')) as unknown);
    } catch (error) {
      console.error(`Cannot read tie-breaks from ${tieBreaksFile}: ${(error as Error).message}`);
      return 2;
    }
  }

  try {
    const result = reconcile(candidates, verifications, secondPass, tieBreaks);
    for (const note of result.notes) console.error(note);
    console.log(
      JSON.stringify(
        { candidates: result.candidates, disputes: result.disputes, applied: result.applied, tieBreaks: result.tieBreaks },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    if (error instanceof ReconcileInputError) {
      console.error(`Cannot reconcile: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
