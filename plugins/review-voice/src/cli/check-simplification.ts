import { readFileSync } from 'node:fs';
import {
  parseSimplificationCandidate,
  parseSimplificationVerification,
  simplificationDiffProblem,
} from '../simplification.ts';
import { parseHunks, type FileHunks } from '../diff/hunks.ts';
import { readStdin, flag } from './shared.ts';

/**
 * Validates the two short-lived documents of the opt-in simplification pass.
 *
 * Without --candidate this checks the analyst's one optional candidate. With
 * it, stdin is the evidence-verifier's response and the command emits the
 * separately persisted, body-only result. Keeping this outside the ordinary
 * candidate schema prevents it from becoming an inline comment or affecting a
 * verdict by accident.
 */
export function checkSimplificationCommand(argv: string[]): number {
  const diffFile = flag(argv, '--diff-file');
  if (diffFile === null) {
    console.error('--diff-file needs the patch the simplification pass reviewed.');
    return 2;
  }
  const candidateFile = flag(argv, '--candidate');
  if (argv.includes('--candidate') && candidateFile === null) {
    console.error('--candidate needs the checked analyst output.');
    return 2;
  }

  let hunks: Map<string, FileHunks>;
  try {
    hunks = parseHunks(readFileSync(diffFile, 'utf8'));
  } catch (error) {
    console.error(`Cannot read ${diffFile}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let document: unknown;
  try {
    document = JSON.parse(readStdin()) as unknown;
  } catch {
    console.error('Expected simplification JSON on stdin.');
    return 2;
  }

  if (candidateFile === null) {
    const candidate = parseSimplificationCandidate(document);
    if (candidate.problem !== null) {
      console.error(`Malformed simplification candidate - ${candidate.problem}.`);
      console.error('Re-run the analyst with the simplification schema restated. Do not hand-translate its output.');
      return 2;
    }
    if (candidate.value !== null) {
      const problem = simplificationDiffProblem(candidate.value, hunks);
      if (problem !== null) {
        console.error(`Invalid simplification candidate - ${problem}.`);
        console.error('Re-run the analyst with the changed locations from the patch. Do not hand-translate its output.');
        return 2;
      }
    }
    console.log(JSON.stringify({ simplification: candidate.value }, null, 2));
    return 0;
  }

  let candidateDocument: unknown;
  try {
    candidateDocument = JSON.parse(readFileSync(candidateFile, 'utf8')) as unknown;
  } catch (error) {
    console.error(`Cannot read ${candidateFile}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const candidate = parseSimplificationCandidate(candidateDocument);
  if (candidate.problem !== null || candidate.value === null) {
    console.error(
      `Cannot verify ${candidateFile}: ${candidate.problem ?? 'it contains no simplification candidate'}.`,
    );
    return 2;
  }
  const candidateProblem = simplificationDiffProblem(candidate.value, hunks);
  if (candidateProblem !== null) {
    console.error(`Cannot verify ${candidateFile}: ${candidateProblem}.`);
    return 2;
  }

  const verification = parseSimplificationVerification(document, candidate.value);
  if (verification.problem !== null || verification.value === null) {
    console.error(`Malformed simplification verification - ${verification.problem ?? 'missing verification'}.`);
    console.error('Re-run the verifier with the simplification schema restated. Do not hand-translate its output.');
    return 2;
  }
  // Keep the checker output in the verifier's wire format. `record` parses it
  // back to the internal camel-case representation before persistence, so this
  // handoff remains as strict as the verifier response it checked.
  const bodyFindings = verification.value.verified
    ? [
        {
          candidate: candidate.value,
          verification: {
            verified: verification.value.verified,
            elements: verification.value.elements.map((element) => ({
              path: element.path,
              line: element.line,
              exists_in_diff: element.existsInDiff,
            })),
            behavior_preserved: verification.value.behaviorPreserved,
            removes_concepts: verification.value.removesConcepts,
            reason: verification.value.reason,
          },
        },
      ]
    : [];
  console.log(JSON.stringify({ bodyFindings }, null, 2));
  return 0;
}
