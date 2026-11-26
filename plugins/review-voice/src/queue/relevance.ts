import { globToRegExp } from '../conventions/globs.ts';
import { GitHubError, type GitHubClient } from '../github/client.ts';
import type { RelevanceConfig } from './config.ts';

/** One reason a pull request concerns the configured team (docs/adr/0038). */
export interface RelevanceSignal {
  kind: 'owned' | 'path' | 'added_line' | 'author' | 'keyword';
  detail: string;
}

export interface RelevanceResult {
  relevant: boolean;
  signals: RelevanceSignal[];
  /** Share of changed lines in team-owned files, to two decimals; null when it cannot be told. */
  ownedShare: number | null;
  /** True when the file list stopped at the cap, so the share covers only the files read. */
  truncated: boolean;
  /** Human text: the signals that matched, or why none did. */
  reasons: string[];
}

/** The pull request fields the check needs beyond its number, as the caller already read them. */
export interface RelevancePull {
  title: string;
  body: string;
  author: string;
  /** The base commit sha CODEOWNERS is read at, so the pull request cannot choose its own owners. */
  baseSha: string;
}

export interface RelevanceDeps {
  client: GitHubClient;
  config: RelevanceConfig;
  repository: string;
  pull: number;
  pullRequest: RelevancePull;
  /** The file-list cap; overridable for tests. */
  maxFiles?: number;
}

/** GitHub serves at most 3000 files for one pull request; the check stops there too. */
export const MAX_RELEVANCE_FILES = 3000;

/** Where GitHub looks for CODEOWNERS, in its order. */
export const CODEOWNERS_PATHS: readonly string[] = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

interface RawFile {
  filename?: unknown;
  previous_filename?: unknown;
  additions?: unknown;
  deletions?: unknown;
  patch?: unknown;
}

interface ChangedFile {
  filename: string;
  previousFilename: string | null;
  changedLines: number;
  patch: string | null;
}

const lower = (value: string): string => value.toLowerCase();
const round2 = (value: number): number => Math.round(value * 100) / 100;
const fixed2 = (value: number): string => value.toFixed(2);

// ---------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------

export interface CodeownersEntry {
  pattern: string;
  /** The owners as written (`@user`, `@org/team` or an email); empty un-owns the path. */
  owners: string[];
}

/**
 * CODEOWNERS lines in file order. Blank lines and `#` comments are ignored;
 * a token starting with `#` ends a line's owners, as no owner is spelled
 * that way. A line holding only a pattern is kept: it un-owns its paths.
 */
export function parseCodeowners(text: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // GitHub does not support escaping a leading #, so `\#` lines own nothing.
    if (line === '' || line.startsWith('#') || line.startsWith('\\#')) continue;
    const tokens = line.split(/\s+/).filter((token) => token.length > 0);
    const first = tokens[0];
    if (first === undefined) continue;
    const owners: string[] = [];
    for (const token of tokens.slice(1)) {
      if (token.startsWith('#')) break;
      owners.push(token);
    }
    entries.push({ pattern: first, owners });
  }
  return entries;
}

/**
 * Whether one CODEOWNERS pattern matches a repository-relative path, under
 * GitHub's rules: a pattern with no slash (a trailing one aside) matches at
 * any depth, other patterns are relative to the root, a trailing `/` names
 * a directory and everything under it, and `*`, `**` and `?` behave as the
 * repository's glob matcher has them. A pattern whose last segment has no wildcard naming a
 * directory also covers the files under it, as in gitignore.
 */
export function codeownersPatternMatches(pattern: string, path: string): boolean {
  const target = path.replace(/^\//, '');
  let body = pattern;
  const directory = body.endsWith('/');
  if (directory) body = body.slice(0, -1);
  if (body === '') return false;
  const anchored = body.includes('/');
  if (body.startsWith('/')) body = body.slice(1);
  if (body === '') return false;

  const tests: RegExp[] = [];
  const add = (glob: string): void => {
    try {
      tests.push(globToRegExp(glob));
    } catch {
      // A pattern the glob matcher cannot compile matches nothing.
    }
  };
  if (anchored) {
    add(body);
    if (directory) add(`${body}/**`);
    else if (!/[*?[]/.test(body.slice(body.lastIndexOf('/') + 1))) add(`${body}/**`);
  } else {
    add(body);
    add(`**/${body}`);
    if (directory || !/[*?[]/.test(body)) {
      add(`${body}/**`);
      add(`**/${body}/**`);
    }
  }
  return tests.some((candidate) => candidate.test(target));
}

/**
 * The owners of one path: the owners of the last matching line, or null when
 * no line matches. An empty list is an explicit un-owning, which a later
 * line could still override, so it is distinct from null only to callers
 * that report it; for ownership both mean nobody owns the path.
 */
export function codeownersOwners(entries: readonly CodeownersEntry[], path: string): string[] | null {
  let owners: string[] | null = null;
  for (const entry of entries) {
    if (codeownersPatternMatches(entry.pattern, path)) owners = entry.owners;
  }
  return owners;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** A config glob against changed paths, with the bare-pattern reading `governsAny` uses. */
function globMatchesPath(glob: string, path: string): boolean {
  try {
    if (globToRegExp(glob).test(path)) return true;
    return !glob.includes('/') && globToRegExp(`**/${glob}`).test(path);
  } catch {
    return false;
  }
}

/** The first added line of a patch matching `pattern`, with its head (new-file) line number. */
function addedLineMatch(patch: string, pattern: RegExp): number | null {
  let headLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      headLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (pattern.test(line.slice(1))) return headLine;
      headLine += 1;
    } else if (line.startsWith(' ') || line === '') {
      headLine += 1;
    }
    // A removed line (`-`) or a `\` note consumes no head line.
  }
  return null;
}

/** A whole-word, case-insensitive test: `extract` does not match `extraction`. */
function keywordMatches(keyword: string, text: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  } catch {
    return false;
  }
}

type CodeownersRead =
  | { kind: 'found'; path: string; entries: CodeownersEntry[] }
  | { kind: 'missing' }
  | { kind: 'unreadable'; detail: string };

/**
 * CODEOWNERS at the base sha, from the first of GitHub's locations that
 * exists. A 404 tries the next location; any other failure, or a file the
 * contents endpoint will not inline as text, is unreadable rather than
 * missing. Neither is an error for the check.
 */
async function readCodeowners(client: GitHubClient, repository: string, baseSha: string): Promise<CodeownersRead> {
  // An empty ref would read the default branch, which is not the base the
  // pull request was opened against, so say unknown instead of reading it.
  if (baseSha === '') return { kind: 'unreadable', detail: 'the pull request named no base commit' };
  for (const path of CODEOWNERS_PATHS) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    let data: { type?: unknown; encoding?: unknown; content?: unknown };
    try {
      ({ data } = await client.get<{ type?: unknown; encoding?: unknown; content?: unknown }>(
        `/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(baseSha)}`,
      ));
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) continue;
      return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
    }
    if (data?.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
      return { kind: 'unreadable', detail: `${path} exists at the base but could not be read as a text file` };
    }
    return { kind: 'found', path, entries: parseCodeowners(Buffer.from(data.content, 'base64').toString('utf8')) };
  }
  return { kind: 'missing' };
}

/** The pull request's files with patches, paginated to the cap. */
async function readFiles(
  client: GitHubClient,
  repository: string,
  pull: number,
  maxFiles: number,
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const files: ChangedFile[] = [];
  let truncated = false;
  let next: string | null = `/repos/${repository}/pulls/${pull}/files?per_page=100`;
  while (next !== null) {
    const page: { data: RawFile[]; linkNext: string | null } = await client.get<RawFile[]>(next);
    if (!Array.isArray(page.data)) break;
    for (const raw of page.data) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (typeof raw?.filename !== 'string' || raw.filename.length === 0) continue;
      const lines = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0);
      files.push({
        filename: raw.filename,
        previousFilename: typeof raw.previous_filename === 'string' ? raw.previous_filename : null,
        changedLines: lines(raw.additions) + lines(raw.deletions),
        patch: typeof raw.patch === 'string' ? raw.patch : null,
      });
    }
    if (truncated) break;
    next = page.linkNext;
    if (next !== null && files.length >= maxFiles) truncated = true;
  }
  return { files, truncated };
}

/**
 * Whether a pull request concerns the configured team, from GitHub reads
 * only (docs/adr/0038): no model, no clone. Reads the file list with
 * patches and CODEOWNERS at the base, through the caller's allowlisted
 * client, and reports every signal that matched.
 */
export async function checkRelevance(deps: RelevanceDeps): Promise<RelevanceResult> {
  const { client, config, repository, pull, pullRequest } = deps;
  const signals: RelevanceSignal[] = [];
  const { files, truncated } = await readFiles(client, repository, pull, deps.maxFiles ?? MAX_RELEVANCE_FILES);

  // Owned share.
  let ownedShare: number | null = null;
  let ownedNote: string;
  let ownedSignal = false;
  if (config.teams.length === 0) {
    ownedNote = 'Owned share not checked: no teams are configured (queue.relevance.teams and queue.teams are empty).';
  } else {
    const codeowners = await readCodeowners(client, repository, pullRequest.baseSha);
    if (codeowners.kind === 'missing') {
      ownedNote =
        `Owned share unknown: no CODEOWNERS at the base (${CODEOWNERS_PATHS.join(', ')}).`;
    } else if (codeowners.kind === 'unreadable') {
      ownedNote = `Owned share unknown: CODEOWNERS at the base could not be read (${codeowners.detail}).`;
    } else {
      const wanted = new Set(config.teams.map((team) => `@${lower(team)}`));
      const matchedTeams = new Set<string>();
      let total = 0;
      let owned = 0;
      for (const file of files) {
        total += file.changedLines;
        const owners = codeownersOwners(codeowners.entries, file.filename) ?? [];
        const teamsHere = owners.filter((owner) => wanted.has(lower(owner)));
        if (teamsHere.length === 0) continue;
        if (config.ignoreOwnedPaths.some((glob) => globMatchesPath(glob, file.filename))) continue;
        owned += file.changedLines;
        for (const team of teamsHere) {
          matchedTeams.add(config.teams.find((configured) => `@${lower(configured)}` === lower(team)) ?? team.replace(/^@/, ''));
        }
      }
      if (total === 0) {
        ownedShare = 0;
        ownedNote = 'Owned share 0.00: the pull request changes no lines in the files read.';
      } else {
        const share = owned / total;
        ownedShare = round2(share);
        if (owned > 0 && share >= config.minOwnedShare) {
          ownedSignal = true;
          signals.push({
            kind: 'owned',
            detail:
              `owned share ${fixed2(share)} meets min_owned_share ${fixed2(config.minOwnedShare)} ` +
              `(${owned} of ${total} changed lines in files owned by ${[...matchedTeams].map((team) => `@${team}`).join(', ')} ` +
              `via ${codeowners.path})`,
          });
          ownedNote = '';
        } else {
          ownedNote =
            `Owned share ${fixed2(share)} is below min_owned_share ${fixed2(config.minOwnedShare)} ` +
            `(${owned} of ${total} changed lines in team-owned files via ${codeowners.path}).`;
        }
      }
    }
  }

  // Paths.
  for (const glob of config.paths) {
    const file = files.find(
      (candidate) =>
        globMatchesPath(glob, candidate.filename) ||
        (candidate.previousFilename !== null && globMatchesPath(glob, candidate.previousFilename)),
    );
    if (file !== undefined) signals.push({ kind: 'path', detail: `path ${glob} matched ${file.filename}` });
  }

  // Added lines.
  for (const source of config.addedLinePatterns) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, 'i');
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.patch === null) continue;
      const line = addedLineMatch(file.patch, pattern);
      if (line !== null) {
        signals.push({ kind: 'added_line', detail: `added line pattern ${source} matched ${file.filename}:${line}` });
        break;
      }
    }
  }

  // Author.
  if (config.authors.some((login) => lower(login) === lower(pullRequest.author))) {
    signals.push({ kind: 'author', detail: `author @${pullRequest.author} is in queue.relevance.authors` });
  }

  // Keywords in the title and description.
  const text = `${pullRequest.title}\n${pullRequest.body}`;
  for (const keyword of config.keywords) {
    if (keywordMatches(keyword, text)) {
      signals.push({ kind: 'keyword', detail: `keyword "${keyword}" in the title or description` });
    }
  }

  const reasons = signals.map((signal) => signal.detail);
  if (!ownedSignal && ownedNote !== '') reasons.push(ownedNote);
  if (truncated) reasons.push(`The file list was truncated at ${files.length} files; the owned share covers only those.`);
  if (signals.length === 0) reasons.push('No relevance signal matched.');

  return { relevant: signals.length > 0, signals, ownedShare, truncated, reasons };
}
