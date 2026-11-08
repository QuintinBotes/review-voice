import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { parseHunks, type FileHunks } from '../diff/hunks.ts';
import { reanchorCandidates, reanchorScores } from '../diff/reanchor.ts';
import { flag } from './shared.ts';

/**
 * Moves one scored candidate to a corrected changed line, keeping its
 * verification and score. A finding anchored a line off otherwise goes back
 * through the analyst, the anchor check and scoring for a claim that did not
 * change. Exit 1 is a refusal, with the reason on stderr.
 */
export function reanchorCommand(argv: string[]): number {
  const candidateId = flag(argv, '--candidate');
  const line = Number(flag(argv, '--line'));
  const scoresFile = flag(argv, '--scores');
  const diffFile = flag(argv, '--diff-file');
  if (candidateId === null || !Number.isInteger(line) || line < 1 || scoresFile === null || diffFile === null) {
    console.error('Usage: reanchor --candidate <id> --line <n> [--path <p>] --scores <file> --diff-file <patch> [--candidates <file>]');
    return 2;
  }
  if (argv.includes('--path') && flag(argv, '--path') === null) {
    console.error('--path needs the file the finding belongs in.');
    return 2;
  }

  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
  let scores: unknown;
  let hunks: Map<string, FileHunks>;
  try {
    scores = readJson(scoresFile);
    hunks = parseHunks(readFileSync(diffFile, 'utf8'));
  } catch (error) {
    console.error(`Cannot read input: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const result = reanchorScores(scores, candidateId, { path: flag(argv, '--path'), line }, hunks);
  if (!result.ok) {
    console.error(`Not re-anchored: ${result.refused}`);
    return 1;
  }

  // Every file is checked before either is written, so a refusal leaves both
  // as they were.
  const candidatesFile = flag(argv, '--candidates');
  let candidates: unknown = null;
  if (candidatesFile !== null) {
    try {
      candidates = reanchorCandidates(readJson(candidatesFile), candidateId, result.to);
    } catch (error) {
      console.error(`Cannot read ${candidatesFile}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    if (candidates === null) {
      console.error(`${candidatesFile} has no candidate ${candidateId}; nothing was re-anchored.`);
      return 2;
    }
  }

  // Both written beside their targets first and then renamed, candidates
  // first, so a failure part way leaves no half-written file and never a
  // score that moved without its candidate.
  const staged: [string, string][] = [];
  try {
    if (candidatesFile !== null) {
      staged.push([`${candidatesFile}.reanchor-${process.pid}`, candidatesFile]);
      writeFileSync(staged[staged.length - 1]![0], `${JSON.stringify(candidates, null, 2)}\n`);
    }
    staged.push([`${scoresFile}.reanchor-${process.pid}`, scoresFile]);
    writeFileSync(staged[staged.length - 1]![0], `${JSON.stringify(result.updated, null, 2)}\n`);
    for (const [temporary, target] of staged) renameSync(temporary, target);
  } catch (error) {
    for (const [temporary] of staged) rmSync(temporary, { force: true });
    console.error(`Cannot write: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  console.log(JSON.stringify({ candidateId, from: result.from, to: result.to, anchorCheck: result.anchorCheck }, null, 2));
  return 0;
}
