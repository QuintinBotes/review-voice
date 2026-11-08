import { writeFileSync, mkdirSync, statSync, lstatSync, renameSync, rmSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MODES } from '../review/plan.ts';
import { RECALL_CLASSES, type RecallClass } from '../evaluate/recall-results.ts';
import { RecallUsageError, runRecall } from '../evaluate/recall.ts';
import { flag, realExistingPath } from './shared.ts';

/**
 * Scores recall over the fixtures. It runs the review driver itself, one
 * fixture at a time, so it is never run through `runInProcess` (which does not
 * nest): the driver calls that for its own stages.
 */
/** cli.ts's runInProcess, passed in, since no module under src/cli imports cli.ts (S12). */
type InProcessRunner = (
  argv: string[],
  options: { stdin?: string; fetchImpl?: typeof fetch },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function recallCommand(argv: string[], runInProcess: InProcessRunner): Promise<number> {
  const known = new Set(['--fixtures', '--class', '--runner', '--mode', '--out', '--only', '--keep']);
  const valued = new Set(['--fixtures', '--class', '--runner', '--mode', '--out', '--only']);
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--') ? !known.has(arg) : !valued.has(argv[index - 1] ?? '')) {
      console.error(`Unexpected argument ${arg}.`);
      return 2;
    }
  }
  for (const name of valued) {
    if (argv.includes(name) && flag(argv, name) === null) {
      console.error(`${name} needs a value.`);
      return 2;
    }
  }
  const fixtures = flag(argv, '--fixtures');
  if (fixtures === null) {
    console.error('recall needs --fixtures <dir>.');
    return 2;
  }
  const classText = flag(argv, '--class');
  const classes: RecallClass[] = [];
  for (const name of classText === null ? RECALL_CLASSES : classText.split(',')) {
    const found = RECALL_CLASSES.find((known) => known === name);
    if (found === undefined) {
      console.error(`--class takes ${RECALL_CLASSES.join(', ')} (comma separated); ${name} is not scored.`);
      return 2;
    }
    if (!classes.includes(found)) classes.push(found);
  }
  const runner = flag(argv, '--runner') ?? 'claude';
  if (runner !== 'claude' && runner !== 'fake') {
    console.error('--runner takes claude or fake.');
    return 2;
  }
  const modeFlag = flag(argv, '--mode');
  const mode = MODES.find((candidate) => candidate === modeFlag);
  if (argv.includes('--mode') && mode === undefined) {
    console.error(`--mode takes one of ${MODES.join(', ')}.`);
    return 2;
  }
  const out = resolve(flag(argv, '--out') ?? 'results.json');
  // A link at the output path would be written through to wherever it points,
  // and a dangling one looks like a missing file to every existence check.
  let linked = false;
  try {
    linked = lstatSync(out).isSymbolicLink();
  } catch {
    // Nothing there yet, which is the ordinary case.
  }
  if (linked) {
    console.error(`--out ${out} is a symbolic link; name the file itself.`);
    return 2;
  }
  // Judged by where the two are, not how they are spelled: a link under the
  // fixtures, or a name that merely begins with two dots, is still inside.
  const inside = relative(realExistingPath(resolve(fixtures)), realExistingPath(out));
  const outside = inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  if (!outside) {
    console.error(`--out ${out} is inside the fixtures; recall never writes there.`);
    return 2;
  }
  if (existsSync(out) && statSync(out).isDirectory()) {
    console.error(`--out ${out} is a directory; name the results file.`);
    return 2;
  }

  let run;
  try {
    mkdirSync(dirname(out), { recursive: true });
    run = await runRecall(
      { fixtures, classes, runner, mode, only: flag(argv, '--only'), keep: argv.includes('--keep') },
      {
        commandWith: (fetchImpl) => (args, stdin) => runInProcess(args, { stdin, fetchImpl }),
        onResult: (result) => {
          const verdict =
            result.skipped !== undefined
              ? `skipped: ${result.skipped}`
              : result.error !== undefined
                ? `failed: ${result.error.split('\n')[0]}`
                : result.class === 'positive'
                  ? result.hit === true
                    ? `hit (line delta ${result.lineDelta})`
                    : result.lineDelta === null || result.lineDelta === undefined
                      ? 'miss (no finding on the expected file)'
                      : `miss (line delta ${result.lineDelta})`
                  : result.silent === true
                    ? 'silent'
                    : `not silent (${result.findings} finding(s))`;
          console.log(`${result.name.padEnd(48)} ${verdict}`);
        },
      },
    );
  } catch (error) {
    if (error instanceof RecallUsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  // Written beside the destination and moved into place: whatever sits at
  // `out` by now (a file hard-linked elsewhere, a link put there during the
  // run) is replaced as a directory entry, never written through.
  const staging = `${out}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  writeFileSync(staging, `${JSON.stringify(run.results, null, 2)}\n`, { flag: 'wx' });
  renameSync(staging, out);
  const { summary } = run.results;
  const figure = (value: number | null): string => (value === null ? 'no data' : value.toFixed(2));
  console.log(
    `key-bug recall ${figure(summary.keyBugRecall)}, causal-line hit ${figure(summary.causalLineHit)}, clean silence ${figure(summary.cleanSilence)}; ` +
      `${summary.positives} positive(s), ${summary.cleanFixtures} clean, ${summary.skipped} skipped, ${summary.failedRuns} failed run(s)`,
  );
  console.log(`Results: ${out}`);
  if (run.kept) console.log(`Kept: ${run.dataDir}`);
  // A failed run is a hole in the measurement, so it fails the command; the file is still written.
  return summary.failedRuns > 0 ? 1 : 0;
}
