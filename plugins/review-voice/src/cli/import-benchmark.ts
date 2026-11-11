import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BenchmarkShapeError, gitEnvironment, importBenchmark, isKnownLicence, readSet } from '../evaluate/benchmark.ts';
import { flag } from './shared.ts';

/** `--set-version` names a directory under docs/benchmarks/, so it is a plain token. */
const SET_VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * True when git says the existing directory `dir` is inside a working tree or
 * a git directory, false when git says it is outside any repository, and git's
 * message when it could not decide (a repository git refuses to read, dubious
 * ownership, no git). Every GIT_ variable is dropped, as `runRecall` drops
 * them, since an exported GIT_DIR would answer for the operator's repository
 * instead of this directory.
 */
function insideGit(dir: string): boolean | string {
  const env: NodeJS.ProcessEnv = {
    ...gitEnvironment(),
    // Discovery otherwise stops at a mount point and says "not a git repository" for a volume mounted inside a working tree.
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    // The outside test below reads git's English message, and git translates it in any other locale.
    LC_ALL: 'C',
  };
  try {
    const answer = execFileSync('git', ['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return answer.split('\n').some((line) => line.trim() === 'true');
  } catch (error) {
    const { status, stderr } = error as { status?: unknown; stderr?: unknown };
    const message = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : (error as Error).message;
    // Only discovery finding no repository (exit 128) means outside; git exits 128 for every
    // other fatal error too, a gitfile it cannot follow included ("not a git repository: <gitdir>"),
    // and a repository git cannot read is still a repository.
    return status === 128 && /not a git repository \(or any of the parent directories\)/.test(message) ? false : message;
  }
}

/** Removes the directories this run made, deepest first, and stops at one that is not empty, which holds another run's import. */
function removeMade(made: readonly string[]): void {
  try {
    for (const dir of [...made].reverse()) rmdirSync(dir);
  } catch {
    // Not empty, so neither is any parent; nothing this run did not write is removed.
  }
}

/** Turns one downloaded benchmark set into recall fixtures outside the repository (S18 part A). */
export function importBenchmarkCommand(argv: string[]): number {
  const valued = new Set(['--from', '--set-version', '--set-licence', '--out', '--licences', '--diffs', '--first']);
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--') ? !valued.has(arg) : !valued.has(argv[index - 1] ?? '')) {
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
  const from = flag(argv, '--from');
  const setVersion = flag(argv, '--set-version');
  const setLicence = flag(argv, '--set-licence');
  const outFlag = flag(argv, '--out');
  if (from === null || setVersion === null || setLicence === null || outFlag === null) {
    console.error('import-benchmark needs --from <file>, --set-version <version>, --set-licence <spdx> and --out <dir>.');
    return 2;
  }
  if (!SET_VERSION.test(setVersion)) {
    console.error(`--set-version must match ${SET_VERSION.source}; it names a directory under docs/benchmarks/.`);
    return 2;
  }
  if (!isKnownLicence(setLicence)) {
    console.error(`--set-licence ${JSON.stringify(setLicence)} is not an SPDX identifier or expression.`);
    return 2;
  }
  let first: number | null = null;
  if (argv.includes('--first')) {
    first = Number(flag(argv, '--first'));
    if (!Number.isInteger(first) || first < 1) {
      console.error('--first needs a positive whole number.');
      return 2;
    }
  }
  const diffs = flag(argv, '--diffs');
  if (diffs !== null && !(existsSync(diffs) && statSync(diffs).isDirectory())) {
    console.error(`--diffs ${diffs} is not a directory.`);
    return 2;
  }
  const out = resolve(outFlag);
  // A link is neither absent nor an empty directory, and a dangling one looks absent to every existence check, so recall refuses one too.
  let linked = false;
  try {
    linked = lstatSync(out).isSymbolicLink();
  } catch {
    // Nothing there yet, which is the ordinary case.
  }
  if (linked) {
    console.error(`--out ${out} is a symbolic link; name a directory that is absent or empty.`);
    return 2;
  }
  let ancestor = out;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    missing.unshift(ancestor);
    ancestor = dirname(ancestor);
  }
  if (!statSync(ancestor).isDirectory()) {
    console.error(`--out ${out} is not an empty directory (${ancestor} is a file).`);
    return 2;
  }
  let entries: string[];
  try {
    entries = ancestor === out ? readdirSync(out) : [];
  } catch (error) {
    console.error(`--out ${out} cannot be listed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (entries.length > 0) {
    console.error(`--out ${out} is not an empty directory.`);
    return 2;
  }
  const inside = insideGit(ancestor);
  if (inside === true) {
    console.error(
      `--out ${out} is inside a git working tree. Imported items are third-party code under their own licences, ` +
        'and CONTRIBUTING.md rule 1 keeps real review data out of the repository; import into a directory outside any repository.',
    );
    return 2;
  }
  if (inside !== false) {
    console.error(`--out ${out} is refused because git could not say whether it is inside a working tree (${inside}).`);
    return 2;
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(from);
  } catch (error) {
    console.error(`--from ${from}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  let items;
  try {
    items = readSet(bytes.toString('utf8'));
  } catch (error) {
    if (!(error instanceof BenchmarkShapeError)) throw error;
    console.error(`--from ${from} is not the shape D2 recorded: ${error.message}`);
    return 2;
  }

  const licences = new Map<string, string>();
  const licencesPath = flag(argv, '--licences');
  if (licencesPath !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(licencesPath, 'utf8'));
    } catch (error) {
      console.error(`--licences ${licencesPath}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    const entries = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.entries(parsed as Record<string, unknown>) : null;
    if (entries === null || !entries.every(([, value]) => typeof value === 'string')) {
      console.error(`--licences ${licencesPath} must be a JSON object from repository to SPDX id.`);
      return 2;
    }
    for (const [repository, licence] of entries) licences.set(repository, licence as string);
  }

  // Staged inside --out, so it shares its file system and --out itself is never replaced; a failure removes only what this run made, leaving --out as it was for a retry.
  // One level at a time, because a recursive mkdir that fails part way does not say which parents it made.
  const made: string[] = [];
  try {
    for (const dir of missing) {
      mkdirSync(dir);
      made.push(dir);
    }
  } catch (error) {
    removeMade(made);
    console.error(`--out ${out} cannot be created: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const staging = join(out, `.rv-import-${randomBytes(6).toString('hex')}`);
  const moved: string[] = [];
  let counts;
  try {
    mkdirSync(staging);
    const stagedInside = insideGit(staging);
    if (stagedInside !== false) throw new Error(`git does not say that ${staging} is outside every working tree${stagedInside === true ? '' : ` (${stagedInside})`}`);
    ({ counts } = importBenchmark({
      items,
      setVersion,
      setSha256: createHash('sha256').update(bytes).digest('hex'),
      setLicence,
      licences,
      diffs,
      first,
      out: staging,
      onRefusal: (detail) => console.error(detail),
    }));
    // The manifest goes first and never replaces a file, so of two runs racing into one --out only one moves anything in.
    copyFileSync(join(staging, 'import.json'), join(out, 'import.json'), constants.COPYFILE_EXCL);
    moved.push('import.json');
    for (const entry of readdirSync(staging)) {
      if (entry === 'import.json') continue;
      renameSync(join(staging, entry), join(out, entry));
      moved.push(entry);
    }
    rmSync(staging, { recursive: true });
  } catch (error) {
    for (const entry of moved) rmSync(join(out, entry), { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    removeMade(made);
    console.error(`--out ${out} cannot be written, and is left as it was: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  console.log(`${counts.fixtures} fixture(s) from ${counts.items} item(s); refused ${counts.refusedItems} item(s) and ${counts.refusedIssues} issue(s).`);
  console.log(`Manifest: ${join(out, 'import.json')}`);
  // Every item refused is a failed import; the manifest still says why.
  return counts.fixtures > 0 ? 0 : 1;
}
