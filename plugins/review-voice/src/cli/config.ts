import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CONFIG_SOURCES } from '../policy/load.ts';
import { resolveTrustedConfig } from '../review/config.ts';
import { flag, githubClient, inferRepository } from './shared.ts';

/**
 * The configuration a pull request review reads, chosen as the driver chooses
 * it, so the slash command's stage commands read that file and not the
 * checked-out head's (#357). The caller runs every stage command with
 * `--trusted-config <dir>`, which reads the choice back from TRUSTED_CONFIG.
 */
export async function configCommand(argv: string[]): Promise<number> {
  const dir = flag(argv, '--dir');
  if (argv[0] !== 'resolve' || dir === null) {
    console.error('Usage: review-voice config resolve --pr <n> --dir <dir> [--repository owner/repo] [--config <path>]');
    return 2;
  }
  const pullNumber = Number(flag(argv, '--pr'));
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    console.error('--pr needs a pull request number.');
    return 2;
  }
  if (statSync(resolve(dir), { throwIfNoEntry: false })?.isDirectory() !== true) {
    console.error(`--dir ${dir} is not a directory.`);
    return 2;
  }
  const trusted = join(resolve(dir), TRUSTED_CONFIG);
  // A refused re-run into the same directory must not leave an earlier choice for the stages to read.
  rmSync(trusted, { force: true });
  const flagged = flag(argv, '--config');
  if (argv.includes('--config') && flagged === null) {
    console.error('--config needs a value.');
    return 2;
  }
  const repository = flag(argv, '--repository') ?? inferRepository(process.cwd());
  if (repository === null) {
    console.error('Cannot tell which repository. Pass --repository <owner/repo>.');
    return 2;
  }

  const { data } = await githubClient([repository]).get<{ base?: { sha?: unknown; ref?: unknown } }>(`/repos/${repository}/pulls/${pullNumber}`);
  const base = { sha: typeof data.base?.sha === 'string' ? data.base.sha : null, ref: typeof data.base?.ref === 'string' ? data.base.ref : null };
  const notes: string[] = [];
  // Absolute, as the driver's run directory is, because the loader ignores a relative REVIEW_VOICE_CONFIG and would read the checkout.
  // Real, because --trusted-config refuses a path through a symbolic link, and macOS keeps its temporary directories under one.
  const chosen = resolveTrustedConfig({ repository, pullNumber, base, dir: realpathSync(dir), flagged }, notes);
  if (typeof chosen === 'string') {
    console.error(chosen);
    return 2;
  }
  const { path, ref } = chosen.source;
  if (chosen.stated !== 'default' && (path === undefined || statSync(path, { throwIfNoEntry: false })?.isFile() !== true)) {
    console.error(`The configuration ${path ?? ''} is not a file, so it has no SHA-256 to bind the stages to.`);
    return 2;
  }
  const sha256 = path === undefined || chosen.stated === 'default' ? null : sha256Of(path);
  writeFileSync(trusted, JSON.stringify({ path, source: chosen.stated, sha256 }), { mode: 0o600 });
  console.log(JSON.stringify({ path, source: chosen.stated, ...(ref === undefined ? {} : { ref }), notes }));
  return 0;
}

export const TRUSTED_CONFIG = 'trusted-config.json';

const sha256Of = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The real path of a directory, or null when there is none. */
function realDirectory(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * `--trusted-config <dir>`, which every command takes: it sets
 * REVIEW_VOICE_CONFIG and REVIEW_VOICE_CONFIG_SOURCE for this process from the
 * file `config resolve --dir <dir>` wrote. An option and not a variable prefix,
 * so the slash commands' `Bash(node:*)` rule matches each stage command.
 * Pull request code that runs as the reviewer can rewrite that file, so it is
 * bound to the bytes it names and never confers an operator source by itself.
 * Returns argv without the option and its value, or the problem that refuses
 * the run.
 */
export function withTrustedConfig(argv: string[]): string[] | string {
  const index = argv.indexOf('--trusted-config', 1);
  if (index === -1) return argv;
  const dir = argv[index + 1];
  if (dir === undefined || dir.startsWith('--')) return '--trusted-config needs the directory config resolve wrote to.';
  const file = join(resolve(dir), TRUSTED_CONFIG);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `--trusted-config: ${file} does not exist. Run review-voice config resolve --dir ${dir} first.`
      : `--trusted-config: ${file} cannot be read (${(error as Error).message}).`;
  }
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON is reported as the wrong shape below.
  }
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const { path, source, sha256 } = record ?? {};
  if (record === null || Object.keys(record).length !== 3 || typeof path !== 'string' || typeof source !== 'string' || (typeof sha256 !== 'string' && sha256 !== null)) {
    return `--trusted-config: ${file} must hold exactly {"path", "source", "sha256"}, the first two strings and sha256 a string or null, as config resolve writes it.`;
  }
  const known = CONFIG_SOURCES.find((kind) => kind === source);
  if (known === undefined) return `--trusted-config: ${file} names the source ${source}, which is not one of ${CONFIG_SOURCES.join(', ')}.`;
  if (!isAbsolute(path)) return `--trusted-config: ${file} names the path ${path}, which is not absolute.`;
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink() === true || realDirectory(dirname(path)) !== dirname(path)) {
    return `--trusted-config: ${file} names the path ${path}, which is a symbolic link, runs through one, or lies in no directory.`;
  }
  if (known === 'default') {
    // With the built-in defaults, config resolve names a path it left empty on purpose.
    if (entry !== undefined) return `--trusted-config: ${file} names the built-in defaults at ${path}, where something now exists.`;
    if (sha256 !== null) return `--trusted-config: ${file} names the built-in defaults, so its sha256 must be null.`;
  } else {
    if (entry?.isFile() !== true) return `--trusted-config: ${file} names the path ${path}, which is not a file.`;
    if (sha256Of(path) !== sha256) return `--trusted-config: ${path} is not the file config resolve chose, since its SHA-256 differs from the one ${file} holds.`;
  }
  if (known === 'flag') {
    return `--trusted-config: ${file} names the source flag, which it cannot confer, since the slash commands never pass --config. To review with your own file, set REVIEW_VOICE_CONFIG to its absolute path before config resolve, or run review --pr --config <path>.`;
  }
  if (known === 'checkout') return `--trusted-config: ${file} names the source checkout, a file from a checkout, which is never trusted.`;
  const operator = process.env['REVIEW_VOICE_CONFIG'];
  const stated = process.env['REVIEW_VOICE_CONFIG_SOURCE'];
  if (known === 'env' && (operator !== path || (stated !== undefined && stated !== 'env'))) {
    return `--trusted-config: ${file} names the source env, which only the operator's own environment confers, and it does not hold REVIEW_VOICE_CONFIG=${path} with no other source stated.`;
  }
  process.env['REVIEW_VOICE_CONFIG'] = path;
  process.env['REVIEW_VOICE_CONFIG_SOURCE'] = known;
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}
