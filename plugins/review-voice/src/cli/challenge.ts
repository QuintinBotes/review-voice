import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { repositoryRoot } from '../diff/acquire.ts';
import { parseHunks, type FileHunks } from '../diff/hunks.ts';
import { applyChallenge, candidatesById, challengePrompts, intentStatements, reproductionsById, type HeadReader } from '../verify/challenge.ts';
import { readStdin, flag } from './shared.ts';
import { terminalInert } from '../terminal.ts';

/**
 * The independent challenge (docs/adr/0024): `--emit-prompts` builds one
 * challenger prompt per eligible finding; otherwise the challenger verdicts on
 * stdin are checked and applied to the score document.
 */
export function challengeCommand(argv: string[]): number {
  const scoresFile = flag(argv, '--scores');
  const candidatesFile = flag(argv, '--candidates');
  const emit = argv.includes('--emit-prompts');
  const diffFile = flag(argv, '--diff-file');
  const intentFile = flag(argv, '--intent');
  const reproductionsFile = flag(argv, '--reproductions');
  const outFile = flag(argv, '--out');
  if (scoresFile === null || candidatesFile === null || (!emit && diffFile === null)) {
    console.error(
      'Usage: challenge --scores <file> --candidates <file> [--intent <file>] [--reproductions <file>] [--diff-file <patch>] [--cwd <dir>] [--head <sha>] --emit-prompts\n' +
        '       challenge --scores <file> --candidates <file> --diff-file <patch> [--reproductions <file>] [--cwd <dir>] [--out <file>] < verdicts.json',
    );
    return 2;
  }
  for (const name of ['--intent', '--reproductions', '--diff-file', '--out', '--cwd', '--head']) {
    if (argv.includes(name) && flag(argv, name) === null) {
      console.error(`${name} needs a value.`);
      return 2;
    }
  }

  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
  let scores: unknown;
  let candidates: ReturnType<typeof candidatesById>;
  try {
    scores = readJson(scoresFile);
    candidates = candidatesById(readJson(candidatesFile));
  } catch (error) {
    console.error(`Cannot read input: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  // Read in both modes: the prompts show a reproduction, and applying drops a decisive entry naming its file.
  let reproductions: ReturnType<typeof reproductionsById> = new Map();
  if (reproductionsFile !== null) {
    try {
      reproductions = reproductionsById(readJson(reproductionsFile));
    } catch (error) {
      console.error(`Cannot read ${reproductionsFile}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (emit) {
    let statements: ReturnType<typeof intentStatements> = [];
    if (intentFile !== null) {
      try {
        statements = intentStatements(readJson(intentFile));
      } catch (error) {
        console.error(`Cannot read ${intentFile}: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    }
    // Each prompt names where the code is. Without --cwd that is the clone this
    // command runs in, which is the one every other stage reads.
    const cwd = flag(argv, '--cwd');
    let dir: string | null = null;
    try {
      dir = cwd === null ? repositoryRoot(process.cwd()) : resolve(cwd);
    } catch {
      // Not a repository: the prompt names no directory.
    }
    const head = { dir, sha: flag(argv, '--head') };
    console.log(JSON.stringify({ prompts: challengePrompts(scores, candidates, statements, diffFile, reproductions, head) }, null, 2));
    return 0;
  }

  let verdicts: unknown;
  let hunks: Map<string, FileHunks>;
  try {
    hunks = parseHunks(readFileSync(diffFile!, 'utf8'));
  } catch (error) {
    console.error(`Cannot read ${diffFile}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  try {
    verdicts = JSON.parse(readStdin());
  } catch {
    console.error('Cannot parse the challenger verdicts on stdin as JSON.');
    return 2;
  }

  // With --cwd, the decisive references are read in that checkout of the head.
  // Without it nothing says which tree holds the head, so they are not read.
  const headDir = flag(argv, '--cwd');
  const root = headDir === null ? null : resolve(headDir);
  const readHead: HeadReader | null =
    root === null
      ? null
      : (path) => {
          const file = resolve(root, path);
          if (!file.startsWith(root + sep)) return null;
          try {
            return readFileSync(file, 'utf8').split('\n');
          } catch {
            return null;
          }
        };

  const result = applyChallenge(scores, candidates, verdicts, hunks, reproductions, readHead);
  if (!result.ok) {
    console.error('Challenge refused:');
    for (const problem of result.problems) console.error(`  ${problem}`);
    return 2;
  }
  const body = `${JSON.stringify(result.document, null, 2)}\n`;
  if (outFile === null) {
    // The next stage's input, so the data stays: what JSON leaves raw is written as an escape.
    process.stdout.write(terminalInert(body));
  } else {
    try {
      writeFileSync(outFile, body);
    } catch (error) {
      console.error(`Cannot write ${outFile}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    console.log(JSON.stringify({ out: outFile, ...result.summary }, null, 2));
  }
  return 0;
}
