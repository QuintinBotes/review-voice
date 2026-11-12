import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
  const chosen = resolveTrustedConfig({ repository, pullNumber, base, dir: resolve(dir), flagged }, notes);
  if (typeof chosen === 'string') {
    console.error(chosen);
    return 2;
  }
  const { path, ref } = chosen.source;
  writeFileSync(trusted, JSON.stringify({ path, source: chosen.stated }), { mode: 0o600 });
  console.log(JSON.stringify({ path, source: chosen.stated, ...(ref === undefined ? {} : { ref }), notes }));
  return 0;
}

export const TRUSTED_CONFIG = 'trusted-config.json';

/**
 * `--trusted-config <dir>`, which every command takes: it sets
 * REVIEW_VOICE_CONFIG and REVIEW_VOICE_CONFIG_SOURCE for this process from the
 * file `config resolve --dir <dir>` wrote. An option and not a variable prefix,
 * so the slash commands' `Bash(node:*)` rule matches each stage command.
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
  const { path, source } = record ?? {};
  if (record === null || Object.keys(record).length !== 2 || typeof path !== 'string' || typeof source !== 'string') {
    return `--trusted-config: ${file} must hold exactly {"path", "source"}, both strings, as config resolve writes it.`;
  }
  const known = CONFIG_SOURCES.find((kind) => kind === source);
  if (known === undefined) return `--trusted-config: ${file} names the source ${source}, which is not one of ${CONFIG_SOURCES.join(', ')}.`;
  if (!isAbsolute(path)) return `--trusted-config: ${file} names the path ${path}, which is not absolute.`;
  // With the built-in defaults, config resolve names a path it left empty on purpose.
  if (known !== 'default' && statSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
    return `--trusted-config: ${file} names the path ${path}, which is not a file.`;
  }
  process.env['REVIEW_VOICE_CONFIG'] = path;
  process.env['REVIEW_VOICE_CONFIG_SOURCE'] = known;
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}
