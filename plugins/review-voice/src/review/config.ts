import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { originRepository } from '../diff/pull-request.ts';
import { environmentSource, type ConfigSourceKind } from '../policy/load.ts';
import { SAFE_GIT } from './worktree.ts';

export const CONFIG_PATH = '.review-voice/config.yaml';

export const shortRef = (ref: string): string => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref);

/**
 * Where a run's configuration came from. Local only, never posted: the pull
 * request's own checkout is never a source, so its author cannot set the bar.
 */
export interface ConfigSource {
  kind: 'flag' | 'env' | 'base' | 'default';
  /** The base commit (or `refs/remotes/origin/<branch>`) read, for `base` and `default`. */
  ref?: string;
  /** The file the run's stages read. */
  path?: string;
}

export interface TrustedConfig {
  source: ConfigSource;
  /** The value of REVIEW_VOICE_CONFIG_SOURCE beside the path. The loader honours `runners:` only from an operator source. */
  stated: ConfigSourceKind;
}

export interface PullRequestConfig {
  repository: string;
  pullNumber: number;
  /** The pull request's base commit and branch, as GitHub gave them. */
  base: { sha: string | null; ref: string | null };
  /** Absolute. A copy of the base commit's file is written here as config.yaml. */
  dir: string;
  /** `--config`, when the operator passed one. */
  flagged?: string | null | undefined;
}

/** `git show` of one path at one ref, or null when git cannot read it (no such ref, no such file). */
function showAt(ref: string, path: string): Buffer | null {
  try {
    return execFileSync('git', [...SAFE_GIT, 'show', `${ref}:${path}`], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * Chooses the one configuration a pull request review reads, so the
 * checked-out head's own .review-voice/config.yaml is never read: its author
 * could otherwise lower the bar the review applies to that very pull request.
 * Order: --config, an absolute REVIEW_VOICE_CONFIG (how `watch` works), then
 * the base commit. Shared by the review driver and `review-voice config
 * resolve`, the slash command's way to the same choice (#357).
 *
 * A refusal comes back as its message. `notes` gets what the person should be
 * told, local only.
 */
export function resolveTrustedConfig(pull: PullRequestConfig, notes: string[]): TrustedConfig | string {
  const flagged = pull.flagged;
  if (flagged != null && flagged !== '') {
    const path = resolve(flagged);
    if (!existsSync(path)) return `--config ${flagged} does not exist.`;
    return { source: { kind: 'flag', path }, stated: 'flag' };
  }
  const environment = process.env['REVIEW_VOICE_CONFIG'];
  if (environment !== undefined && environment !== '') {
    // A file watch copied from a checkout arrives with that source beside it, and keeps it.
    if (isAbsolute(environment)) return { source: { kind: 'env', path: environment }, stated: environmentSource() };
    notes.push('REVIEW_VOICE_CONFIG must be an absolute path, so it was ignored and the base commit supplied the configuration.');
  }

  const { sha, ref } = pull.base;
  if (sha === null) return `GitHub returned no base commit for ${pull.repository}#${pull.pullNumber}, so there is no trusted configuration to read.`;
  const path = join(pull.dir, 'config.yaml');
  // A re-run into the same directory must not read a copy taken from another base.
  rmSync(path, { force: true });
  let from = sha;
  let content = showAt(sha, CONFIG_PATH);
  // A shallow clone may lack the base commit. The base branch's remote ref is
  // the next best trusted copy only when origin is the repository under review:
  // in a fork clone, origin/<ref> is the pull request author's own branch.
  if (content === null && ref !== null && showAt(sha, '') === null && originRepository(process.cwd())?.toLowerCase() === pull.repository.toLowerCase()) {
    // Fully qualified: a local branch named origin/<ref> would otherwise win the lookup.
    from = `refs/remotes/origin/${ref}`;
    content = showAt(from, CONFIG_PATH);
  }
  if (content === null) {
    notes.push(`No ${CONFIG_PATH} at the base commit ${shortRef(sha)}; the review ran with the built-in defaults.`);
    return { source: { kind: 'default', ref: sha, path }, stated: 'default' };
  }
  writeFileSync(path, content, { mode: 0o600 });
  return { source: { kind: 'base', ref: from, path }, stated: 'base' };
}
