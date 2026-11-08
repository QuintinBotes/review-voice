import { readFileSync } from 'node:fs';
import { readStdin, flag, VERDICT_KEYS, verificationProblem, verdictList } from './shared.ts';

/**
 * Checks evidence-verifier output against the verification schema, straight
 * after the verifier runs.
 *
 * `score` runs the same checks, but it is the stage after verification. A
 * verifier that wrote `evidence_quality: "strong"` was refused there with
 * every earlier stage already spent, and relaunching it then meant a cold
 * start. Failing here costs one re-run of one agent while its context is warm.
 */
/** Candidate ids from check-candidates output ({kept}), {candidates}, or a bare array. */
function keptCandidateIds(value: unknown): string[] {
  const record = value as { kept?: unknown; candidates?: unknown } | null;
  const list = Array.isArray(value) ? value : Array.isArray(record?.kept) ? record.kept : Array.isArray(record?.candidates) ? record.candidates : [];
  return list
    .map((entry) => (entry as { candidate_id?: unknown } | null)?.candidate_id)
    .filter((id): id is string => typeof id === 'string');
}

export function checkVerificationCommand(argv: string[]): number {
  const candidatesFile = flag(argv, '--candidates');
  let keptIds: string[] | null = null;
  if (candidatesFile !== null) {
    try {
      keptIds = keptCandidateIds(JSON.parse(readFileSync(candidatesFile, 'utf8')) as unknown);
    } catch (error) {
      console.error(`Cannot read ${candidatesFile}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readStdin()) as unknown;
  } catch {
    console.error('Expected the evidence-verifier output as JSON on stdin.');
    return 2;
  }
  const list = verdictList(parsed);
  if (list.length === 0) {
    console.error(
      `No verifications found. Expected an array, or an object with one of: ${VERDICT_KEYS.join(', ')}, ` +
        'each entry carrying candidate_id.',
    );
    return 2;
  }
  const problem = verificationProblem(list);
  if (problem !== null) {
    console.error(`Malformed verification - ${problem}`);
    console.error('Re-run the evidence-verifier with the schema restated. Do not hand-translate its output.');
    return 2;
  }
  // A kept candidate the verifier skipped would otherwise score on the analyst's own
  // confidence and read as weighed and held (#165).
  if (keptIds !== null) {
    const verified = new Set(list.map((entry) => (entry as { candidate_id?: unknown }).candidate_id));
    const missing = keptIds.filter((id) => !verified.has(id));
    if (missing.length > 0) {
      for (const id of missing) console.error(`No verification for kept candidate ${id}.`);
      console.error('Re-run the evidence-verifier for the missing candidates.');
      return 2;
    }
  }
  console.log(JSON.stringify({ valid: true, verifications: list.length }, null, 2));
  return 0;
}
