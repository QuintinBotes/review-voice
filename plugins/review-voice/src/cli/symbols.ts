import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_TEST_PATHS } from '../diff/complexity.ts';
import { collectSymbolContext, DEFAULT_MAX_MS } from '../diff/symbols.ts';
import { flag, resolveOutPath, repositoryConfig, refExists } from './shared.ts';

/**
 * Gives the agents a bounded list of places worth reading after the diff.
 *
 * The search ref has to resolve before collection begins. Passing a bad ref to
 * git grep would be caught per symbol and correctly marked inconclusive, but
 * treating that as a normal `--base` invocation would quietly turn a caller's
 * request for a reviewed tree into a pile of partial working-tree-like data.
 */
export function symbolsCommand(argv: string[]): number {
  const diffFile = flag(argv, '--diff-file');
  if (diffFile === null) {
    console.error('--diff-file needs a unified diff path.');
    return 2;
  }

  let diff: string;
  try {
    diff = readFileSync(diffFile, 'utf8');
  } catch (error) {
    console.error(`Cannot read ${diffFile}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const baseIndex = argv.indexOf('--base');
  const base = flag(argv, '--base');
  if (baseIndex !== -1 && base === null) {
    console.error('--base needs a git ref, for example: --base origin/main');
    return 2;
  }
  if (base !== null && !refExists(base, process.cwd())) {
    console.error(`--base ${base} does not resolve in this repository. Fetch it before collecting symbol context.`);
    return 2;
  }

  const headIndex = argv.indexOf('--head');
  const head = flag(argv, '--head');
  if (headIndex !== -1 && head === null) {
    console.error('--head needs a git ref, for example: --head HEAD');
    return 2;
  }
  if (head !== null && !refExists(head, process.cwd())) {
    console.error(`--head ${head} does not resolve in this repository. Fetch it before collecting symbol context.`);
    return 2;
  }

  let maxMs = DEFAULT_MAX_MS;
  if (argv.includes('--max-ms')) {
    const wanted = flag(argv, '--max-ms');
    maxMs = wanted !== null && /^\d+$/.test(wanted) ? Number(wanted) : Number.NaN;
    if (!Number.isSafeInteger(maxMs) || maxMs < 1) {
      console.error('--max-ms needs a positive number of milliseconds, for example: --max-ms 60000');
      return 2;
    }
  }

  // The same configured test paths the size signals use, so a repository that
  // names its tests differently gets the same split here.
  const testPaths = repositoryConfig()?.humanReview.testPaths ?? DEFAULT_TEST_PATHS;
  const result = collectSymbolContext({ diff, cwd: process.cwd(), ref: base, head, testPaths, maxMs });
  const out = flag(argv, '--out');
  if (out === null) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  try {
    const path = resolveOutPath(out, 'symbols.json');
    writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');
    console.log(
      JSON.stringify(
        {
          path,
          files: result.files.length,
          downstreamFiles: result.downstreamFiles,
          inconclusiveFiles: result.files.filter((file) => file.inconclusive === true).length,
          budgetExhausted: result.budget.exhausted,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(
      `Cannot write ${out}: expected a file path or a directory; ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}
