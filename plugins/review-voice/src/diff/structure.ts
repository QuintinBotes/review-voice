import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attributeSource, repositoryRoot, type ChangedFile, type DiffResult } from './acquire.ts';
import { parseHunks } from './hunks.ts';
import { countHunks } from './complexity.ts';
import type { ReviewScope } from './incremental.ts';

/**
 * Structural facts about a change that the CLI can measure and a reader pays
 * for. They are evidence for the analyst, never findings on their own, and
 * they play no part in the verdict.
 */
export interface StructureConfig {
  /** A production file that grows from at most this many lines to more is listed. */
  maxFileLines: number;
  /** An existing function that gains at least this many decision points is listed. */
  maxAddedBranchesPerFunction: number;
}

export const DEFAULT_STRUCTURE: StructureConfig = { maxFileLines: 1000, maxAddedBranchesPerFunction: 3 };

export interface SizeCrossing {
  path: string;
  baseLines: number;
  headLines: number;
  threshold: number;
  /**
   * Where a finding about the crossing anchors: the first added line past the
   * threshold, else the first added line. Null when the patch adds no line to
   * the file.
   */
  line: number | null;
}

/**
 * Branching added inside a declaration that exists at the base: a special
 * case bolted onto an existing flow, rather than a new unit that owns it.
 */
export interface BranchGrowth {
  path: string;
  /** The enclosing declaration's line as git names it, cut at 80 characters as git cuts it. */
  function: string;
  /** Added minus removed, inside this declaration. */
  addedDecisionPoints: number;
  threshold: number;
  /** The first added line in it with a decision point. */
  line: number;
}

export interface StructureSignals {
  sizeCrossings: SizeCrossing[];
  branchGrowth: BranchGrowth[];
  /**
   * Production files whose base or head could not be read, so whether they
   * crossed is unknown rather than no. Paths are capped at 20, sorted.
   */
  unmeasured: { count: number; paths: string[] };
}

/** The change being measured: what `diff` emits. */
export interface MeasuredChange {
  mode: DiffResult['mode'];
  base: string | null;
  head: string;
  diff: string;
  files?: readonly ChangedFile[];
  refs?: { head: { available: boolean } };
  scope?: ReviewScope;
}

/** A file's length on each side of the change; null when that side could not be read. */
export interface LineCounts {
  base: number | null;
  head: number | null;
}

/** Where the changed side of a file is read from. */
export type HeadSource = { from: 'worktree' } | { from: 'index' } | { from: 'commit'; commit: string };

/** Where both sides of the change are read from; null for a side that is not available here. */
export interface ChangeSides {
  base: string | null;
  head: HeadSource | null;
}

const MAX_UNMEASURED_LISTED = 20;

/** Lines in a file's content, counting a last line without a newline. */
export function countLines(content: Buffer): number {
  let lines = 0;
  for (const byte of content) {
    if (byte === 0x0a) lines += 1;
  }
  return content.length > 0 && content[content.length - 1] !== 0x0a ? lines + 1 : lines;
}

/**
 * The commit the measured change starts from. A follow-up review reads only
 * what changed since the reviewed head, so a crossing an earlier push made is
 * not reported again; otherwise it is the commit `.gitattributes` is read at.
 */
function startOf(root: string, diff: MeasuredChange): string | null {
  if (diff.scope?.kind === 'incremental' || diff.scope?.kind === 'interdiff') return diff.scope.since;
  return attributeSource(root, diff);
}

/** Where each side is read from: the start of the change, and what the patch was taken from. */
export function changeSides(root: string, diff: MeasuredChange): ChangeSides {
  const base = startOf(root, diff);
  switch (diff.mode) {
    case 'worktree':
      return { base, head: { from: 'worktree' } };
    case 'staged':
      return { base, head: { from: 'index' } };
    case 'base':
      return { base, head: { from: 'commit', commit: diff.head } };
    case 'pull-request':
      return { base, head: diff.refs?.head.available === true ? { from: 'commit', commit: diff.head } : null };
  }
}

/**
 * Blob contents by `<rev>:<path>` spec, from one `git cat-file --batch`.
 * A spec git cannot resolve maps to null, as does every spec when git fails.
 */
function readBlobs(root: string, specs: readonly string[]): Map<string, Buffer | null> {
  const blobs = new Map<string, Buffer | null>(specs.map((spec) => [spec, null]));
  if (specs.length === 0) return blobs;
  let out: Buffer;
  try {
    out = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: `${specs.join('\n')}\n`,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return blobs;
  }
  // Each answer is `<oid> <type> <size>\n<content>\n`, or `<spec> missing\n`.
  let offset = 0;
  for (const spec of specs) {
    const end = out.indexOf(0x0a, offset);
    if (end === -1) break;
    const header = out.subarray(offset, end).toString('utf8');
    offset = end + 1;
    const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (match === null) continue;
    const size = Number(match[2]);
    if (match[1] === 'blob') blobs.set(spec, out.subarray(offset, offset + size));
    offset += size + 1;
  }
  return blobs;
}

/**
 * Line counts at both sides for the files asked about. A file the change adds
 * has no lines at the base. Paths containing a newline cannot be named to
 * `cat-file --batch` and are left unread.
 */
export function measureLines(
  root: string,
  files: readonly ChangedFile[],
  paths: readonly string[],
  sides: ChangeSides,
): Map<string, LineCounts> {
  const asked = new Set(paths);
  const wanted = files.filter((file) => asked.has(file.path) && !file.path.includes('\n'));
  const baseSpec = (file: ChangedFile): string | null =>
    sides.base === null || file.status === 'added' || (file.previousPath ?? file.path).includes('\n')
      ? null
      : `${sides.base}:${file.previousPath ?? file.path}`;
  const headSpec = (file: ChangedFile): string | null => {
    if (sides.head === null || sides.head.from === 'worktree') return null;
    return sides.head.from === 'index' ? `:${file.path}` : `${sides.head.commit}:${file.path}`;
  };
  const specs = wanted.flatMap((file) => [baseSpec(file), headSpec(file)]).filter((spec): spec is string => spec !== null);
  const blobs = readBlobs(root, [...new Set(specs)]);
  const linesOf = (spec: string | null): number | null => {
    const blob = spec === null ? null : (blobs.get(spec) ?? null);
    return blob === null ? null : countLines(blob);
  };
  const fromWorktree = (path: string): number | null => {
    try {
      return countLines(readFileSync(join(root, path)));
    } catch {
      return null;
    }
  };

  const counts = new Map<string, LineCounts>();
  for (const file of wanted) {
    counts.set(file.path, {
      base: file.status === 'added' ? 0 : linesOf(baseSpec(file)),
      head: sides.head?.from === 'worktree' ? fromWorktree(file.path) : linesOf(headSpec(file)),
    });
  }
  return counts;
}

/**
 * Existing declarations the change adds at least the threshold of decision
 * points to, net of the ones it removes from them, summed across hunks. A
 * rewrite that swaps one branch for another is not growth. A hunk without
 * header context, and code after a declaration the change adds, are not
 * attributed to anything. Two declarations with the same text in one file
 * are counted together.
 */
function findBranchGrowth(diff: string, paths: readonly string[], threshold: number): BranchGrowth[] {
  const grown = new Map<string, { path: string; scope: string; net: number; line: number | null }>();
  for (const hunk of countHunks(diff, new Set(paths))) {
    for (const branch of hunk.branches) {
      if (branch.scope === null) continue;
      const key = `${hunk.path}\0${branch.scope}`;
      const entry = grown.get(key) ?? { path: hunk.path, scope: branch.scope, net: 0, line: null };
      entry.net += branch.removed ? -branch.decisionPoints : branch.decisionPoints;
      if (!branch.removed) entry.line = Math.min(entry.line ?? branch.line, branch.line);
      grown.set(key, entry);
    }
  }
  const byPathThenLine = (a: BranchGrowth, b: BranchGrowth): number => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  };
  return [...grown.values()]
    .filter((entry) => entry.line !== null && entry.net >= threshold)
    .map((entry) => ({ path: entry.path, function: entry.scope, addedDecisionPoints: entry.net, threshold, line: entry.line! }))
    .sort(byPathThenLine);
}

/** Files that grow from at most the threshold to more, anchored on the patch, and existing functions that gain branches. */
export function findStructureSignals(
  diff: string,
  paths: readonly string[],
  counts: ReadonlyMap<string, LineCounts>,
  limits: StructureConfig = DEFAULT_STRUCTURE,
): StructureSignals {
  const hunks = parseHunks(diff);
  const threshold = limits.maxFileLines;
  const sizeCrossings: SizeCrossing[] = [];
  const unmeasured: string[] = [];

  for (const path of [...paths].sort()) {
    const lines = counts.get(path);
    if (lines === undefined || lines.base === null || lines.head === null) {
      unmeasured.push(path);
      continue;
    }
    if (lines.base > threshold || lines.head <= threshold) continue;
    const added = [...(hunks.get(path)?.added ?? [])].sort((a, b) => a - b);
    sizeCrossings.push({
      path,
      baseLines: lines.base,
      headLines: lines.head,
      threshold,
      line: added.find((line) => line > threshold) ?? added[0] ?? null,
    });
  }

  return {
    sizeCrossings,
    branchGrowth: findBranchGrowth(diff, paths, limits.maxAddedBranchesPerFunction),
    unmeasured: { count: unmeasured.length, paths: unmeasured.slice(0, MAX_UNMEASURED_LISTED) },
  };
}

/**
 * The structural evidence for a change, measured over `production`. Outside a
 * repository nothing can be read, so every file is unmeasured rather than
 * reported as fine.
 */
export function collectStructure(
  cwd: string,
  change: MeasuredChange,
  production: readonly string[],
  limits: StructureConfig = DEFAULT_STRUCTURE,
): StructureSignals {
  const files = change.files ?? [];
  // A deleted file cannot cross, and a follow-up review marks deletions reviewed.
  const deleted = new Set(files.filter((file) => file.status === 'deleted').map((file) => file.path));
  const paths = production.filter((path) => !deleted.has(path));
  let counts = new Map<string, LineCounts>();
  try {
    const root = repositoryRoot(cwd);
    counts = measureLines(root, files, paths, changeSides(root, change));
  } catch {
    // Nothing measured.
  }
  return findStructureSignals(change.diff, paths, counts, limits);
}
