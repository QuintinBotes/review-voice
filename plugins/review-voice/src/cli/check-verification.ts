import { readFileSync, writeFileSync } from 'node:fs';
import { readStdin, flag, VERDICT_KEYS, verificationProblem, verdictList } from './shared.ts';
import { jsonInReply } from '../agents/reply-json.ts';

export { jsonInReply };

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
  const outFile = flag(argv, '--out');
  if (argv.includes('--out') && outFile === null) {
    console.error('--out needs a file path.');
    return 2;
  }
  const reply = jsonInReply(readStdin());
  if (reply === undefined) {
    console.error(
      'Expected the evidence-verifier output as JSON on stdin: {"verifications": [...]}, or a bare array of the entries. ' +
        'Text or a code fence around the JSON is left out; no JSON was found in this reply.',
    );
    return 2;
  }
  const parsed = reply.value;
  if (reply.wrapped) console.error('The reply had text around its JSON; only the JSON was read.');
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
  // The checked JSON alone, so no stage has to strip a reply by hand.
  if (outFile !== null) {
    try {
      writeFileSync(outFile, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch (error) {
      console.error(`Cannot write ${outFile}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  console.log(JSON.stringify({ valid: true, verifications: list.length, ...(outFile === null ? {} : { out: outFile }) }, null, 2));
  return 0;
}
