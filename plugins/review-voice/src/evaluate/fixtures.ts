import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Turns a fixture directory into a two-commit git repository, so the real
 * review pipeline can be pointed at a fixture exactly as it would be at a pull
 * request: a base commit that holds what the diff changed from, and a head
 * commit that holds the result.
 *
 * Fixture patches are hand-written and are never edited. Several of them have
 * hunk headers that disagree with their bodies, so git refuses them as they
 * stand. `normalisePatch` produces the copy git applies, and the fixtures test
 * parses that same copy, so what the harness reviews is what the test checked.
 */

/** The identity every fixture commit carries; it never inherits the operator's. */
const AUTHOR_NAME = 'review-voice-fixtures';
const AUTHOR_EMAIL = 'fixtures@example.com';

/**
 * A fixed commit time keeps both commit ids reproducible for one fixture, so a
 * recorded result can be compared with the next run of the same fixture.
 */
const COMMIT_DATE = '2026-01-01T00:00:00Z';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * The configuration written when a fixture ships none. The diff lane is built
 * in and cannot be redefined, so only the structure lane is listed; with the
 * size and kind gates off it reaches every fixture, which the structural
 * positives need because the default configuration runs the diff lane only.
 */
const DEFAULT_CONFIG = [
  'review:',
  '  lanes:',
  '    - name: structure',
  '      agent: structure-analyst',
  '      prefix: st_',
  '      when: { min_changed_source_lines: 0, exclude_kinds: [] }',
  '',
].join('\n');

function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** A line the author left empty, with or without a stripped context space. */
function isBlank(line: string): boolean {
  return withoutCarriageReturn(line) === '';
}

/**
 * Rewrites a hand-written patch into one `git apply` accepts, without changing
 * what it says.
 *
 * - Every hunk header is recounted from the body that follows it.
 * - A hunk body ends at the next `@@` line, a `diff --git` line, or a `--- `
 *   line immediately followed by a `+++ ` line. The last is how a fixture
 *   starts its next file without a `diff --git` line, which a hunk header that
 *   counts too many lines would otherwise swallow.
 * - A body line with no leading marker is a context line. That reads more
 *   widely than `parseHunks`, which accepts only a blank unmarked line and ends
 *   the hunk at any other.
 * - File headers and every other line outside a hunk are kept as written.
 *
 * Blank lines at the end of a hunk are context only while the original header
 * still counts lines on both sides. Otherwise they are the separation between
 * files, or the end of the text, and are dropped.
 */
export function normalisePatch(text: string): string {
  const lines = text.split('\n');
  // The element after the final newline is the end of the text, not a line.
  if (lines[lines.length - 1] === '') lines.pop();

  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    const header = HUNK_HEADER.exec(withoutCarriageReturn(line));
    if (header === null) {
      // A malformed header would otherwise be copied through as prose and make
      // every body line after it look like part of the previous file.
      if (line.startsWith('@@ ')) throw new Error(`malformed hunk header on patch line ${index + 1}: ${line}`);
      out.push(line);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < lines.length && !endsHunk(lines, end)) end += 1;

    const body: string[] = [];
    let trailingBlanks = 0;
    let oldCount = 0;
    let newCount = 0;
    for (const raw of lines.slice(index + 1, end)) {
      if (isBlank(raw)) {
        trailingBlanks += 1;
        continue;
      }
      // Blank lines inside the body are context whose space was stripped.
      for (; trailingBlanks > 0; trailingBlanks -= 1) {
        body.push(' ');
        oldCount += 1;
        newCount += 1;
      }
      const marker = raw[0];
      if (marker === '\\') {
        body.push(raw);
      } else if (marker === '+') {
        body.push(raw);
        newCount += 1;
      } else if (marker === '-') {
        body.push(raw);
        oldCount += 1;
      } else if (marker === ' ') {
        body.push(raw);
        oldCount += 1;
        newCount += 1;
      } else {
        body.push(` ${raw}`);
        oldCount += 1;
        newCount += 1;
      }
    }
    const declaredOld = header[2] === undefined ? 1 : Number(header[2]);
    const declaredNew = header[4] === undefined ? 1 : Number(header[4]);
    while (trailingBlanks > 0 && oldCount < declaredOld && newCount < declaredNew) {
      body.push(' ');
      oldCount += 1;
      newCount += 1;
      trailingBlanks -= 1;
    }

    out.push(`@@ -${header[1]},${oldCount} +${header[3]},${newCount} @@${header[5] ?? ''}`, ...body);
    index = end;
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

function endsHunk(lines: string[], index: number): boolean {
  const line = lines[index] as string;
  if (line.startsWith('@@ ') || line.startsWith('diff --git ')) return true;
  return line.startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ ');
}

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  lines: string[];
}

interface PatchFile {
  oldPath: string | null;
  newPath: string | null;
  hunks: PatchHunk[];
}

/** Strips the one leading `a/` or `b/` git puts on a path, as `-p1` does. */
function headerPath(raw: string): string | null {
  const path = raw.split('\t')[0] as string;
  if (path === '/dev/null') return null;
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

/** Reads a normalised patch: its counts are exact, so they delimit each hunk. */
function parsePatchFiles(normalised: string): PatchFile[] {
  const lines = normalised.split('\n');
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = withoutCarriageReturn(lines[index] as string);
    if (line.startsWith('--- ') && withoutCarriageReturn(lines[index + 1] ?? '').startsWith('+++ ')) {
      current = {
        oldPath: headerPath(line.slice(4)),
        newPath: headerPath(withoutCarriageReturn(lines[index + 1] as string).slice(4)),
        hunks: [],
      };
      files.push(current);
      index += 2;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) {
      index += 1;
      continue;
    }
    if (current === null) throw new Error(`hunk on patch line ${index + 1} has no file header before it`);
    const oldCount = Number(header[2]);
    const newCount = Number(header[4]);
    const hunk: PatchHunk = { oldStart: Number(header[1]), oldCount, lines: [] };
    index += 1;
    let seenOld = 0;
    let seenNew = 0;
    while (index < lines.length && (seenOld < oldCount || seenNew < newCount || (lines[index] as string).startsWith('\\'))) {
      const body = lines[index] as string;
      hunk.lines.push(body);
      if (body.startsWith('-')) seenOld += 1;
      else if (body.startsWith('+')) seenNew += 1;
      else if (!body.startsWith('\\')) {
        seenOld += 1;
        seenNew += 1;
      }
      index += 1;
    }
    current.hunks.push(hunk);
  }
  return files;
}

/** A line of text a fixture's reconstructed file gets where the patch shows none. */
function fillerFor(path: string): string {
  const extension = basename(path).includes('.') ? (basename(path).split('.').pop() as string).toLowerCase() : '';
  const hash = ['yml', 'yaml', 'tf', 'py', 'rb', 'sh', 'toml', 'ini', 'cfg', 'conf', 'md', 'txt'];
  return hash.includes(extension) ? '# filler' : '// filler';
}

/**
 * Rejects a path that could leave the repository. Fixture patches are data from
 * the repository, and a header such as `+++ b/../outside` or one naming `.git`
 * must never be written to disk.
 */
function confinedPath(path: string, label: string): string {
  const segments = path.split('/');
  const unsafe =
    path === '' ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git');
  if (unsafe) throw new Error(`${label}: patch path ${JSON.stringify(path)} is not a repository-relative path`);
  return path;
}

/** Writes a file under `root`, after proving the resolved path is inside it. */
function writeInside(root: string, path: string, content: string, label: string): void {
  const target = resolve(root, path);
  const inside = relative(resolve(root), target);
  if (inside === '' || inside.startsWith('..') || inside.split(sep).includes('..')) {
    throw new Error(`${label}: ${JSON.stringify(path)} resolves outside the repository`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

interface PreImage {
  lines: Map<number, string>;
  /** True when the patch says the last line of the old file has no newline. */
  noFinalNewline: boolean;
}

/**
 * Collects the old-side lines every hunk shows for each existing file. Two
 * hunks that disagree about one line, or one hunk that disagrees with itself
 * through a repeated range, cannot describe a single pre-image.
 */
function reconstruct(files: PatchFile[], label: string): Map<string, PreImage> {
  const images = new Map<string, PreImage>();
  for (const file of files) {
    if (file.oldPath === null) continue;
    const path = confinedPath(file.oldPath, label);
    let image = images.get(path);
    if (image === undefined) {
      image = { lines: new Map(), noFinalNewline: false };
      images.set(path, image);
    }
    for (const hunk of file.hunks) {
      let lineNumber = hunk.oldStart;
      let lastOld: number | null = null;
      // A no-newline marker describes the line printed just above it. After an
      // added line it says the new file has no final newline, which is nothing
      // about the old one, so only a context or removed line above it counts.
      let aboveIsOld = false;
      for (const body of hunk.lines) {
        if (body.startsWith('\\')) {
          if (aboveIsOld && lastOld !== null && lastOld === Math.max(...image.lines.keys())) image.noFinalNewline = true;
          continue;
        }
        if (body.startsWith('+')) {
          aboveIsOld = false;
          continue;
        }
        aboveIsOld = true;
        const text = body.slice(1);
        const known = image.lines.get(lineNumber);
        if (known !== undefined && known !== text) {
          throw new Error(
            `${label}: ${path} line ${lineNumber} is ${JSON.stringify(known)} in one hunk and ${JSON.stringify(text)} in another, so the patch context does not match a single pre-image`,
          );
        }
        image.lines.set(lineNumber, text);
        lastOld = lineNumber;
        lineNumber += 1;
      }
    }
  }
  return images;
}

/** Every regular file under `dir`, relative to it. A symlink is refused, never followed. */
function contextFiles(dir: string, label: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const stat = lstatSync(join(dir, path));
    if (stat.isSymbolicLink()) throw new Error(`${label}: context/${path} is a symbolic link`);
    if (stat.isDirectory()) out.push(...contextFiles(dir, label, path));
    else if (stat.isFile()) out.push(confinedPath(path, label));
    else throw new Error(`${label}: context/${path} is not a regular file`);
  }
  return out;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Nothing from the operator's git configuration or identity may leak into a
  // fixture repository, so every GIT_ variable is dropped before ours are set.
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: COMMIT_DATE,
    GIT_COMMITTER_DATE: COMMIT_DATE,
  };
}

function git(cwd: string, label: string, args: string[]): string {
  try {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], {
      cwd,
      env: gitEnvironment(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : (error as Error).message;
    throw new Error(`${label}: git ${args[0]} failed: ${detail}`);
  }
}

export interface MaterializeOptions {
  /** How errors name the fixture. Defaults to `<class>/<name>` from the directory. */
  name?: string;
}

export interface MaterializedFixture {
  /** The base commit: the reconstructed pre-image, context files and configuration. */
  base: string;
  /** The head commit: the base with the fixture's patch applied. */
  head: string;
  /** Repository-relative paths the patch changes, in patch order. */
  files: string[];
}

/**
 * Builds the fixture's git repository in `targetDir`, which must be empty or
 * absent, and leaves the head commit checked out on the `feature` branch.
 *
 * The base is rebuilt from the patch because a fixture ships a diff and not a
 * repository. Each hunk's context and removed lines are placed at their
 * old-side line numbers; lines the patch does not show are filler, and a file
 * under `context/` replaces the reconstruction entirely. Nothing under
 * `fixtureDir` is written. A patch whose context cannot be one file is an
 * error that names the fixture.
 */
export function materializeFixture(fixtureDir: string, targetDir: string, options: MaterializeOptions = {}): MaterializedFixture {
  const label = options.name ?? `${basename(dirname(resolve(fixtureDir)))}/${basename(resolve(fixtureDir))}`;
  const patchPath = join(fixtureDir, 'diff.patch');
  if (!existsSync(patchPath)) throw new Error(`${label}: fixture has no diff.patch`);
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`${label}: target directory ${targetDir} is not empty`);
  }

  let normalised: string;
  let files: PatchFile[];
  try {
    normalised = normalisePatch(readFileSync(patchPath, 'utf8'));
    files = parsePatchFiles(normalised);
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
  for (const file of files) {
    if (file.newPath !== null) confinedPath(file.newPath, label);
  }
  const images = reconstruct(files, label);

  const contextDir = join(fixtureDir, 'context');
  const supplied = new Map<string, string>();
  if (existsSync(contextDir)) {
    for (const path of contextFiles(contextDir, label)) supplied.set(path, readFileSync(join(contextDir, path), 'utf8'));
  }

  mkdirSync(targetDir, { recursive: true });
  git(targetDir, label, ['init', '-q', '-b', 'main', '--template=']);

  for (const [path, image] of images) {
    const given = supplied.get(path);
    if (given !== undefined) {
      const actual = given.split('\n');
      for (const [number, text] of image.lines) {
        if (actual[number - 1] !== text) {
          throw new Error(
            `${label}: patch context for ${path} line ${number} is ${JSON.stringify(text)} but context/${path} has ${JSON.stringify(actual[number - 1] ?? null)}`,
          );
        }
      }
      continue;
    }
    const last = image.lines.size === 0 ? 0 : Math.max(...image.lines.keys());
    const filler = fillerFor(path);
    const content: string[] = [];
    for (let number = 1; number <= last; number += 1) content.push(image.lines.get(number) ?? filler);
    const text = content.length === 0 ? '' : content.join('\n') + (image.noFinalNewline ? '' : '\n');
    writeInside(targetDir, path, text, label);
  }
  for (const [path, text] of supplied) writeInside(targetDir, path, text, label);

  const configPath = join(fixtureDir, 'config.yaml');
  let config = DEFAULT_CONFIG;
  if (existsSync(configPath)) {
    if (!lstatSync(configPath).isFile()) throw new Error(`${label}: config.yaml is not a regular file`);
    config = readFileSync(configPath, 'utf8');
  }
  writeInside(targetDir, '.review-voice/config.yaml', config, label);

  git(targetDir, label, ['add', '-A']);
  git(targetDir, label, ['commit', '-q', '-m', `base: ${label}`]);
  const base = git(targetDir, label, ['rev-parse', 'HEAD']).trim();

  git(targetDir, label, ['checkout', '-q', '-b', 'feature']);
  // The normalised copy lives outside the repository so it is never part of
  // either commit, and outside the fixture so the fixture is never written.
  const scratch = mkdtempSync(join(tmpdir(), 'rv-fixture-patch-'));
  try {
    const copy = join(scratch, 'normalised.patch');
    writeFileSync(copy, normalised);
    try {
      git(targetDir, label, ['apply', '--whitespace=nowarn', copy]);
    } catch (error) {
      throw new Error(`${(error as Error).message} (the patch does not apply to its reconstructed pre-image)`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  git(targetDir, label, ['add', '-A']);
  git(targetDir, label, ['commit', '-q', '-m', `head: ${label}`]);
  const head = git(targetDir, label, ['rev-parse', 'HEAD']).trim();

  const changed: string[] = [];
  for (const file of files) {
    const path = file.newPath ?? file.oldPath;
    if (path !== null && !changed.includes(path)) changed.push(path);
  }
  return { base, head, files: changed };
}
