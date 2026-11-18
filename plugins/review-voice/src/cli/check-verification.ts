import { readFileSync, writeFileSync } from 'node:fs';
import { readStdin, flag, VERDICT_KEYS, verificationProblem, verdictList, correctionPattern } from './shared.ts';
import { jsonInReply } from '../agents/reply-json.ts';
import { significantWords } from '../scoring/score.ts';

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
/** Each candidate's text by id, from check-candidates output ({kept}), {candidates}, or a bare array. */
function keptCandidates(value: unknown): Map<string, string[]> {
  const record = value as { kept?: unknown; candidates?: unknown } | null;
  const list = Array.isArray(value) ? value : Array.isArray(record?.kept) ? record.kept : Array.isArray(record?.candidates) ? record.candidates : [];
  const kept = new Map<string, string[]>();
  for (const entry of list as Record<string, unknown>[]) {
    const id = entry?.['candidate_id'];
    if (typeof id !== 'string') continue;
    const texts = [entry['claim'], entry['failure_mode'] ?? entry['failureMode'], ...(Array.isArray(entry['evidence']) ? entry['evidence'] : [])];
    kept.set(id, texts.filter((text): text is string => typeof text === 'string'));
  }
  return kept;
}

/** The sentence of a candidate's text sharing the most words with a correction's `wrong`. */
function nearestSentence(texts: string[], wrong: string): string | null {
  const words = significantWords(wrong);
  let best: { sentence: string; shared: number } | null = null;
  for (const sentence of texts.flatMap((text) => text.split(/(?<=[.!?])\s+/))) {
    const shared = [...significantWords(sentence)].filter((word) => words.has(word)).length;
    if (shared > 0 && (best === null || shared > best.shared)) best = { sentence, shared };
  }
  return best?.sentence ?? null;
}

export function checkVerificationCommand(argv: string[]): number {
  const candidatesFile = flag(argv, '--candidates');
  let kept: Map<string, string[]> | null = null;
  if (candidatesFile !== null) {
    try {
      kept = keptCandidates(JSON.parse(readFileSync(candidatesFile, 'utf8')) as unknown);
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
  if (kept !== null) {
    const verified = new Set(list.map((entry) => (entry as { candidate_id?: unknown }).candidate_id));
    const missing = [...kept.keys()].filter((id) => !verified.has(id));
    if (missing.length > 0) {
      for (const id of missing) console.error(`No verification for kept candidate ${id}.`);
      console.error('Re-run the evidence-verifier for the missing candidates.');
      return 2;
    }
    // score holds a finding whose correction matches nothing; here the
    // verifier can still be asked to quote it (#457).
    const unmatched: string[] = [];
    for (const entry of list) {
      const id = (entry as { candidate_id?: unknown }).candidate_id;
      const texts = typeof id === 'string' ? kept.get(id) : undefined;
      if (texts === undefined) continue;
      for (const { wrong } of (entry['corrections'] as { wrong: string }[] | undefined) ?? []) {
        const pattern = correctionPattern(wrong);
        if (texts.some((text) => text.search(pattern) !== -1)) continue;
        const near = nearestSentence(texts, wrong);
        unmatched.push(
          `${String(id)}: the correction's wrong ${JSON.stringify(wrong)} is not in the candidate's claim, failure mode or evidence` +
            (near === null ? '.' : `; the nearest sentence is ${JSON.stringify(near)}.`),
        );
      }
    }
    if (unmatched.length > 0) {
      for (const line of unmatched) console.error(line);
      console.error(
        'score would hold these findings. Re-run the evidence-verifier with wrong copied verbatim from the candidate, not paraphrased.',
      );
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
