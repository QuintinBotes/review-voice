import { readFileSync, writeFileSync } from 'node:fs';
import { readStdin, flag, VERDICT_KEYS, verificationProblem, verdictList, applyCorrections } from './shared.ts';
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
/** Candidates from check-candidates output ({kept}), {candidates}, or a bare array. */
function candidateEntries(value: unknown): Record<string, unknown>[] {
  const record = value as { kept?: unknown; candidates?: unknown } | null;
  const list = Array.isArray(value) ? value : Array.isArray(record?.kept) ? record.kept : Array.isArray(record?.candidates) ? record.candidates : [];
  return list.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}

/** Candidate ids from check-candidates output ({kept}), {candidates}, or a bare array. */
function keptCandidateIds(value: unknown): string[] {
  return candidateEntries(value)
    .map((entry) => entry['candidate_id'] ?? entry['candidateId'])
    .filter((id): id is string => typeof id === 'string');
}

/** Candidate text by id, for the verbatim correction check (#457). */
function candidateTexts(value: unknown): Map<string, { claim: string; failureMode: string; evidence: string[] }> {
  const texts = new Map<string, { claim: string; failureMode: string; evidence: string[] }>();
  for (const entry of candidateEntries(value)) {
    const id = entry['candidate_id'] ?? entry['candidateId'];
    if (typeof id !== 'string') continue;
    const failure = entry['failure_mode'] ?? entry['failureMode'];
    texts.set(id, {
      claim: typeof entry['claim'] === 'string' ? entry['claim'] : '',
      failureMode: typeof failure === 'string' ? failure : '',
      evidence: Array.isArray(entry['evidence']) ? entry['evidence'].filter((item): item is string => typeof item === 'string') : [],
    });
  }
  return texts;
}

export function checkVerificationCommand(argv: string[]): number {
  const candidatesFile = flag(argv, '--candidates');
  let keptIds: string[] | null = null;
  let texts: Map<string, { claim: string; failureMode: string; evidence: string[] }> | null = null;
  if (candidatesFile !== null) {
    try {
      const candidates = JSON.parse(readFileSync(candidatesFile, 'utf8')) as unknown;
      keptIds = keptCandidateIds(candidates);
      texts = candidateTexts(candidates);
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
    const verified = new Set(list.map((entry) => entry['candidate_id'] ?? entry['candidateId']));
    const missing = keptIds.filter((id) => !verified.has(id));
    if (missing.length > 0) {
      for (const id of missing) console.error(`No verification for kept candidate ${id}.`);
      console.error('Re-run the evidence-verifier for the missing candidates.');
      return 2;
    }
  }
  // The same verbatim check score runs, while the verifier can still fix it:
  // a correction that matches nothing would hold a confirmed finding (#457).
  if (texts !== null) {
    const misses: string[] = [];
    for (const entry of list) {
      const id = entry['candidate_id'] ?? entry['candidateId'];
      if (typeof id !== 'string') continue;
      const candidate = texts.get(id);
      if (candidate === undefined) continue;
      const fixes = entry['corrections'];
      if (!Array.isArray(fixes)) continue;
      // verificationProblem has already checked each is a {wrong, right} pair of strings.
      const { unmatched } = applyCorrections(candidate, fixes as { wrong: string; right: string }[]);
      for (const wrong of unmatched) {
        misses.push(
          `${id}: correction ${JSON.stringify(wrong)} is not in the candidate's claim, failure mode or evidence; ` +
            '"wrong" must be copied verbatim from the candidate text.',
        );
      }
    }
    if (misses.length > 0) {
      for (const miss of misses) console.error(miss);
      console.error('Re-run the evidence-verifier with the schema restated. Do not hand-translate its output.');
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
