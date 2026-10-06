import { gitGrepPaths, type PathSearcher } from '../scoring/existence.ts';
import {
  isCode,
  NON_DISCRIMINATING_DIRECTORIES,
  symbolsFromHunks,
} from '../scoring/reach.ts';

/** A bounded list of code paths that literally mention one changed symbol. */
export interface SymbolReferences {
  symbol: string;
  references: string[];
  /** The full number of paths behind `references`, before its display cap. */
  referenceCount: number;
  /** Present only when the displayed paths are a strict prefix of the hits. */
  truncated?: true;
}

/** A name too widespread for its literal matches to describe this change. */
export interface CommonSymbol {
  symbol: string;
  common: true;
}

export type SymbolContext = SymbolReferences | CommonSymbol;

export interface SymbolContextFile {
  path: string;
  symbols: SymbolContext[];
  /** Distinctive symbols present in the hunk but omitted by the symbol cap. */
  moreSymbols?: number;
  /** A grep failed or the time budget ran out, so this file's evidence is partial. */
  inconclusive?: true;
  /** Why, when the budget is the cause; a failed grep carries no reason. */
  reason?: 'time-budget';
}

/** What the time budget did to this collection. */
export interface SymbolBudget {
  maxMs: number;
  elapsedMs: number;
  /** True when at least one file was left unfinished for want of time. */
  exhausted: boolean;
}

export interface SymbolContextReport {
  /** The tree which answered the literal searches. */
  searchedRef: string;
  files: SymbolContextFile[];
  /** Untouched code paths that reference at least one reported changed symbol. */
  downstreamFiles: number;
  budget: SymbolBudget;
}

export interface CollectSymbolContextOptions {
  diff: string;
  cwd: string;
  ref: string | null;
  /** Injectable because search failure is evidence too, and needs a cheap test. */
  search?: PathSearcher;
  /** Time budget for the whole collection, enforced between and within searches. */
  maxMs?: number;
  /** Injectable clock, so a budget needs no real waiting to test. */
  now?: () => number;
}

export const DEFAULT_MAX_MS = 60_000;

const MAX_SYMBOLS_PER_FILE = 12;
const MAX_REFERENCES_PER_SYMBOL = 8;

function normalisePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function directoryCount(paths: Iterable<string>): number {
  return new Set([...paths].map((path) => normalisePath(path).split('/').slice(0, -1).join('/'))).size;
}

/**
 * Paths that actually contribute an added or removed line to the patch.
 *
 * `+++` alone is not enough: a file can have headers without a textual hunk,
 * and presenting an empty symbol record for one makes it look as though the
 * extractor inspected source that the diff did not contain. Deleted files have
 * no `b/` path and are intentionally absent for the same reason acquisition
 * excludes them from review.
 */
function pathsWithHunks(diff: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let path: string | null = null;
  let hasHunkLine = false;

  const keepCurrent = () => {
    if (path === null || !hasHunkLine) return;
    const normalised = normalisePath(path);
    if (seen.has(normalised)) return;
    seen.add(normalised);
    paths.push(normalised);
  };

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      keepCurrent();
      path = null;
      hasHunkLine = false;
      continue;
    }

    if (raw.startsWith('+++ ')) {
      // A deleted file says `+++ /dev/null`; it has no reviewed source whose
      // consumers could be checked. `symbolsFromHunks` likewise has no b/path
      // to associate with it.
      const match = /^\+\+\+ b\/(.+)$/.exec(raw);
      path = match?.[1] === undefined ? null : match[1];
      continue;
    }

    if (path === null || raw.startsWith('--- ')) continue;
    if (raw.startsWith('+') || raw.startsWith('-')) hasHunkLine = true;
  }

  keepCurrent();
  return paths;
}

function reportFile(
  diff: string,
  path: string,
  cwd: string,
  ref: string | null,
  search: PathSearcher,
  remaining: () => number,
): { file: SymbolContextFile; references: Set<string> } {
  const allSymbols = symbolsFromHunks(diff, path);
  const omitted = Math.max(0, allSymbols.length - MAX_SYMBOLS_PER_FILE);
  const symbols: SymbolContext[] = [];
  const references = new Set<string>();
  const normalisedPath = normalisePath(path);

  const file = (inconclusive: boolean, reason?: 'time-budget'): SymbolContextFile => ({
    path,
    symbols,
    ...(omitted === 0 ? {} : { moreSymbols: omitted }),
    ...(inconclusive ? { inconclusive: true } : {}),
    ...(reason === undefined ? {} : { reason }),
  });

  for (const symbol of allSymbols.slice(0, MAX_SYMBOLS_PER_FILE)) {
    // Checked before every search: a search is the only slow step, and the
    // budget has to hold however many symbols and files precede this one.
    if (remaining() <= 0) return { file: file(true, 'time-budget'), references };
    let found: string[];
    try {
      found = search(symbol, cwd, ref, remaining());
    } catch {
      // A failed grep is not an empty grep. Leave the symbol that failed out
      // altogether, retain evidence from earlier successful searches, and
      // make the file's incomplete state explicit to its readers.
      return { file: file(true), references };
    }

    const code = new Set(found.filter(isCode).map(normalisePath));

    // This is deliberately the same threshold reach uses. A name in many
    // directories is a language-shaped word, not evidence that every listed
    // path is a caller or a consumer of the behavior under review.
    if (directoryCount(code) > NON_DISCRIMINATING_DIRECTORIES) {
      symbols.push({ symbol, common: true });
      continue;
    }

    const paths = [...code].filter((candidate) => candidate !== normalisedPath).sort();
    for (const candidate of paths) references.add(candidate);
    symbols.push({
      symbol,
      references: paths.slice(0, MAX_REFERENCES_PER_SYMBOL),
      referenceCount: paths.length,
      ...(paths.length > MAX_REFERENCES_PER_SYMBOL ? { truncated: true } : {}),
    });
  }

  return { file: file(false), references };
}

/**
 * Collects bounded, lexical consumer context for the symbols a patch touches.
 *
 * Literal grep hits are deliberately not called call sites. A name can occur
 * in a declaration, a comment-like source string, or a different construct in
 * another language; the evidence is useful for deciding where to read next,
 * not for proving a dependency on its own.
 */
export function collectSymbolContext(options: CollectSymbolContextOptions): SymbolContextReport {
  const search = options.search ?? gitGrepPaths;
  const now = options.now ?? Date.now;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const started = now();
  const remaining = () => maxMs - (now() - started);
  const paths = pathsWithHunks(options.diff);
  // Files the budget never reached are still listed: a missing file reads as
  // "nothing to find", and an unfinished one is not that.
  const records = paths.map((path) =>
    remaining() <= 0
      ? { file: { path, symbols: [], inconclusive: true, reason: 'time-budget' } as SymbolContextFile, references: new Set<string>() }
      : reportFile(options.diff, path, options.cwd, options.ref, search, remaining),
  );
  const changed = new Set(paths.map(normalisePath));
  const downstream = new Set<string>();

  for (const record of records) {
    // A different changed file remains useful context for this file's symbol.
    // It is removed only from the aggregate: `downstreamFiles` measures the
    // untouched consumers the patch may have left behind.
    for (const path of record.references) {
      if (!changed.has(normalisePath(path))) downstream.add(path);
    }
  }

  records.sort(
    (a, b) =>
      b.references.size - a.references.size || a.file.path.localeCompare(b.file.path),
  );

  return {
    searchedRef: options.ref ?? 'working tree',
    files: records.map((record) => record.file),
    downstreamFiles: downstream.size,
    budget: {
      maxMs,
      elapsedMs: Math.max(0, now() - started),
      exhausted: records.some((record) => record.file.reason === 'time-budget'),
    },
  };
}
