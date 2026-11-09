import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { GitError, repositoryRoot } from '../diff/acquire.ts';
import { loadConfig } from '../policy/load.ts';
import { dataDirectory } from '../store/paths.ts';
import { candidatesById } from '../verify/challenge.ts';
import { probeSandbox, reproduce, type ReproduceContext, type ReproductionReport } from '../evidence/reproduce.ts';
import { flag } from './shared.ts';

const isDirectory = (path: string): boolean => statSync(resolve(path), { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * Runs the verifier's reproductions in the confined runner (S16). The
 * configuration comes from this checkout or REVIEW_VOICE_CONFIG, as for
 * `evidence`, so a pull request review reads the block from the base commit.
 */
export async function reproduceCommand(argv: string[]): Promise<number> {
  const probeOnly = argv.includes('--probe');
  const required = probeOnly ? ['--worktree', '--run-dir'] : ['--worktree', '--verification', '--candidates', '--out', '--run-dir'];
  for (const name of required) {
    if (flag(argv, name) === null) {
      console.error(`${name} needs a value.`);
      return 2;
    }
  }
  const values = Object.fromEntries(required.map((name) => [name, resolve(flag(argv, name)!)]));
  for (const name of ['--worktree', '--run-dir']) {
    if (!isDirectory(values[name]!)) {
      console.error(`${name} ${values[name]!} is not a directory.`);
      return 2;
    }
  }
  let root: string;
  try {
    root = repositoryRoot(process.cwd());
  } catch (error) {
    if (error instanceof GitError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const config = loadConfig(root).reproduction;
  const ctx: ReproduceContext = {
    worktree: values['--worktree']!,
    runDir: values['--run-dir']!,
    clone: root,
    dataDir: dataDirectory(),
    home: homedir(),
    config,
  };
  // The probe runs only Review Voice's own script, so an owner can see what the
  // machine gives before turning the block on.
  if (probeOnly) {
    console.log(JSON.stringify(await probeSandbox(ctx), null, 2));
    return 0;
  }

  const out = values['--out']!;
  if (!isDirectory(dirname(out))) {
    console.error(`--out ${out}: its directory does not exist.`);
    return 2;
  }
  const skipped =
    process.env['REVIEW_VOICE_NO_COMMANDS'] === '1'
      ? 'REVIEW_VOICE_NO_COMMANDS'
      : !config.enabled
        ? 'reproduction.enabled is false'
        : config.runners.length === 0
          ? 'no reproduction runner is configured'
          : null;
  let report: ReproductionReport;
  if (skipped !== null) {
    report = { enabled: false, sandbox: null, reproductions: [], skipped };
  } else {
    let verification: unknown;
    let candidates: unknown;
    try {
      verification = JSON.parse(readFileSync(values['--verification']!, 'utf8'));
      candidates = JSON.parse(readFileSync(values['--candidates']!, 'utf8'));
    } catch (error) {
      console.error(`Could not read the verification or candidates: ${(error as Error).message}`);
      return 2;
    }
    report = await reproduce(verification, candidatesById(candidates), ctx);
  }
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  // An outcome of any kind, did-not-run included, is a result.
  return 0;
}
