import { readFileSync } from 'node:fs';
import { parseHunks, type FileHunks } from '../diff/hunks.ts';
import { extractAnchors } from '../publish/anchors.ts';
import { readStdin, flag } from './shared.ts';

/** Inline anchors from the validated review; see publish/anchors.ts for why. */
export function anchorsCommand(argv: string[]): number {
  const diffFile = flag(argv, '--diff-file');
  const scoresFile = flag(argv, '--scores');
  for (const name of ['--diff-file', '--scores']) {
    if (argv.includes(name) && flag(argv, name) === null) {
      console.error(`${name} needs a file path.`);
      return 2;
    }
  }
  let hunks: Map<string, FileHunks> | null = null;
  let scores: unknown[] = [];
  try {
    if (diffFile !== null) hunks = parseHunks(readFileSync(diffFile, 'utf8'));
    if (scoresFile !== null) {
      const parsed = JSON.parse(readFileSync(scoresFile, 'utf8')) as { scores?: unknown };
      const list = Array.isArray(parsed) ? parsed : parsed.scores;
      scores = Array.isArray(list) ? list : [];
    }
  } catch (error) {
    console.error(`Cannot read input: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const result = extractAnchors(readStdin(), { hunks, scores });
  if (hunks === null) {
    console.error('No --diff-file, so hunk ranges were not checked; only stale-consumer findings (from --scores) were routed to the body.');
  }
  // Without either input the output is what it always was.
  const plain = diffFile === null && scoresFile === null;
  console.log(
    JSON.stringify(plain ? { anchors: result.anchors, unanchorable: result.unanchorable } : result, null, 2),
  );
  return 0;
}
