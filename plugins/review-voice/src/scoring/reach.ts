import { gitGrepPaths, namedSymbols, type PathSearcher } from './existence.ts';
import { classify } from '../diff/classify.ts';

/** How far a claim's named implementation is shared through the repository. */
export type Reach = 'local' | 'component' | 'repository';

/**
 * The deterministic evidence used to derive a finding's severity.
 *
 * `reach: null` is intentional: no searchable symbol, no hits, or an
 * inconclusive search must retain the legacy category tier rather than guess
 * that a defect is local.
 */
export interface ReachCheck {
  reach: Reach | null;
  /**
   * Where the searched symbols came from, so a surprising reach is traceable.
   * `hunks` is the changed file's own; `diff` is the rest of the change, used
   * when the finding names a file the pull request does not touch; `claim` is
   * the fallback when no diff was supplied.
   */
  symbolSource: 'hunks' | 'diff' | 'claim';
  /**
   * True when no touched symbol existed at the reviewed ref and the changed
   * file's own module name stood in for them.
   */
  moduleFallback: boolean;
  /** Symbols actually given to git grep, in search order. */
  symbols: string[];
  /**
   * Symbols searched but excluded from the measure: absent from the changed
   * file, or so common that their spread describes the language rather than
   * this change.
   */
  ignoredSymbols: string[];
  /** Distinct repository-relative paths git grep found. */
  paths: string[];
  /** Code paths counted for spread, after prose and non-source are dropped. */
  countedPaths: string[];
  /** Distinct directories represented by `countedPaths`. */
  directoryCount: number;
  /** Distinct directories outside the changed file's own directory. */
  outsideDirectoryCount: number;
  /** True when git could not answer every search. */
  inconclusive: boolean;
  /** The tree searched, so a result can be audited against the reviewed ref. */
  searchedRef: string;
}

/**
 * Identifiers the diff actually adds or removes in one file.
 *
 * The claim is the wrong source for this. `namedSymbols` exists to find things
 * to check for absence, where a broad net is cheap, and reach wants the
 * opposite: the symbol the change touched, not every word the finding used.
 * Excluding symbols the changed file does not contain caught `Math.round` and
 * a local `canEdit`, but not the case that matters most - a finding whose whole
 * point is that some symbol is the **wrong** referent names that symbol, and it
 * is genuinely in the file, so containment cannot tell them apart.
 *
 * Only `+` and `-` lines are read. A symbol sitting in a context line is what
 * the change is near, not what it changed.
 */
export function symbolsFromHunks(diff: string, changedPath: string | null): string[] {
  // `null` means every file in the diff. A finding about a broken consumer
  // names the consumer, which the pull request does not touch, so there are no
  // hunks for its path - and that is the shape of every broken-consumer
  // finding, the class that produced the only build breaker this reviewer has
  // caught. The symbol whose spread matters is the one the diff changed
  // elsewhere, so the whole diff is the right source when the named file has
  // no hunks of its own.
  const wanted = changedPath === null ? null : normalisePath(changedPath);
  const found = new Set<string>();
  let inFile = false;

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ') || raw.startsWith('+++ ')) {
      // `+++ b/path`, and the `diff --git` header for renames.
      const match = /^\+\+\+ [ab]\/(.+)$/.exec(raw);
      if (match?.[1] !== undefined) inFile = wanted === null || normalisePath(match[1]) === wanted;
      else if (raw.startsWith('diff --git ')) inFile = false;
      continue;
    }
    if (!inFile) continue;
    if (raw.startsWith('--- ')) continue;
    if (!raw.startsWith('+') && !raw.startsWith('-')) continue;

    // The same shapes `namedSymbols` accepts, so both sources agree on what
    // counts as a searchable identifier.
    const text = raw.slice(1);
    for (const m of text.matchAll(
      /\b([a-z][A-Za-z0-9]{4,}[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]{3,}|[A-Z][A-Z0-9]+_[A-Z0-9_]+)\b/g,
    )) {
      if (m[1] !== undefined) found.add(m[1]);
    }
  }

  return [...found];
}

/**
 * Initial, calibrated-by-guess recognition of files whose change reaches the
 * repository even when one named symbol happens to have few hits. Keep this
 * explicit until a measured run can calibrate it.
 */
const REPOSITORY_WIDE_TOOLCHAIN_PATHS = [
  /(?:^|\/)(?:eslint\.config\.[^/]+|\.eslintrc(?:\.[^/]+)?|biome\.json|\.stylelintrc(?:\.[^/]+)?|\.prettierrc(?:\.[^/]+)?)$/i,
  /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i,
  /^(?:\.github\/workflows\/|\.gitlab-ci(?:\.yml)?$|\.circleci\/config\.yml$|azure-pipelines(?:\.[^/]+)?\.ya?ml$|Jenkinsfile$)/i,
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum)$/i,
  /^(?:package\.json|Makefile|GNUmakefile|justfile|Taskfile\.ya?ml|turbo\.json|nx\.json)$/i,
  /^(?:scripts|tools|build|bin)\//i,
];

function normalisePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function directoryOf(path: string): string {
  const parts = normalisePath(path).split('/');
  parts.pop();
  return parts.join('/');
}

function directoryCount(paths: Iterable<string>): number {
  return new Set([...paths].map(directoryOf)).size;
}

/**
 * Prose that mentions a symbol is not a use of it.
 *
 * Measured on this repository before this filter existed: `deriveSeverity`
 * spread across `docs`, `plugins` and `test` and so read as repository-wide on
 * the strength of a changelog entry, while `GitHubClient` - referenced from
 * eight files and genuinely central - read as merely component. Reach is a
 * claim about code coupling, so only code counts toward it.
 */
const PROSE_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc']);

function isCode(path: string): boolean {
  const name = normalisePath(path).split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (PROSE_EXTENSIONS.has(extension)) return false;
  return classify(normalisePath(path)) === 'source';
}

/**
 * A symbol so common that its spread says nothing about this change.
 *
 * `namedSymbols` exists to find things to check for absence, where a broad net
 * is cheap and a false hit merely costs a search. Reach needs the opposite. On
 * a live run a `correctness` defect in one date formatter was raised a tier
 * because the claim mentioned `Math.round`, which appears in 58 directories,
 * and a local `const canEdit` in one React component reached 158 - neither is
 * a shared implementation, both are just common words.
 *
 * Measured by hits rather than by a language-specific denylist: a name in this
 * many directories is a common word in any language, and a denylist would have
 * to be maintained per ecosystem to catch the same thing.
 */
const NON_DISCRIMINATING_DIRECTORIES = 12;

/** Whether a path sits inside the changed file's own directory subtree. */
function withinSubtree(path: string, changedDirectory: string): boolean {
  if (changedDirectory === '') return false;
  const normalised = normalisePath(path);
  return normalised === changedDirectory || normalised.startsWith(`${changedDirectory}/`);
}

function isRepositoryWideToolchainPath(path: string): boolean {
  const normalised = normalisePath(path);
  return REPOSITORY_WIDE_TOOLCHAIN_PATHS.some((pattern) => pattern.test(normalised));
}

/**
 * Computes reach from repository evidence rather than asking an agent to judge
 * it. The reviewed ref is passed directly to every search.
 */
export function computeReach(
  text: string,
  changedPath: string,
  cwd: string,
  ref: string | null = null,
  search: PathSearcher = gitGrepPaths,
  /** The diff under review. When given, it decides which symbols count. */
  diff: string | null = null,
): ReachCheck {
  const searchedRef = ref ?? 'working tree';

  // Symbols the diff touched, when the diff is available; otherwise the
  // claim's, which is what every caller had before the diff was threaded
  // through and remains the honest fallback.
  const ownHunks = diff === null ? [] : symbolsFromHunks(diff, changedPath);
  // A finding whose file the diff does not touch still has a diff to measure:
  // the symbol it is about was changed somewhere else.
  const anyHunks = diff === null || ownHunks.length > 0 ? [] : symbolsFromHunks(diff, null);
  const source: 'hunks' | 'diff' | 'claim' =
    ownHunks.length > 0 ? 'hunks' : anyHunks.length > 0 ? 'diff' : 'claim';
  const symbols = (
    source === 'hunks' ? ownHunks : source === 'diff' ? anyHunks : namedSymbols(text)
  ).slice(0, 12);
  const searched: string[] = [];
  const ignored: string[] = [];
  const hits = new Set<string>();
  let usedModuleFallback = false;

  const normalisedChangedPath = normalisePath(changedPath);
  const changedDirectory = directoryOf(changedPath);

  const result = (reach: Reach | null, inconclusive: boolean): ReachCheck => {
    const counted = [...hits].filter(isCode).sort();
    const outside = counted.filter(
      (path) => normalisePath(path) !== normalisedChangedPath && !withinSubtree(path, changedDirectory),
    );
    return {
      reach,
      symbolSource: source,
      moduleFallback: usedModuleFallback,
      symbols: searched,
      ignoredSymbols: [...ignored].sort(),
      paths: [...hits].sort(),
      countedPaths: counted,
      directoryCount: directoryCount(counted),
      outsideDirectoryCount: directoryCount(outside),
      inconclusive,
      searchedRef,
    };
  };

  // There is no deterministic evidence of spread without a distinctive name.
  if (symbols.length === 0) return result(null, false);

  for (const symbol of symbols) {
    searched.push(symbol);
    let found: string[];
    try {
      found = search(symbol, cwd, ref);
    } catch {
      // Do not classify partial evidence. A bad ref, timeout, or failed grep
      // is absent reach, never an implicit "only the changed file" answer.
      return result(null, true);
    }

    const code = found.filter(isCode);

    // Reach is the spread of the code under review, not of every word the
    // finding happens to use. A symbol the changed file does not contain is
    // not part of this change, however widely it is used elsewhere.
    // Containment in the named file is the right test when the symbol came
    // from that file's own hunks. For a broken-consumer finding the symbol
    // lives in the file the change touched, not in the one the finding names.
    if (source !== 'diff' && !code.some((path) => normalisePath(path) === normalisedChangedPath)) {
      ignored.push(symbol);
      continue;
    }

    if (directoryCount(code) > NON_DISCRIMINATING_DIRECTORIES) {
      ignored.push(symbol);
      continue;
    }

    for (const path of found) hits.add(path);
  }

  // A repository-wide toolchain file is itself deterministic reach evidence.
  // It still needs a searchable claim and successful searches above: a failed
  // grep must remain absent rather than being promoted by this shortcut.
  if (isRepositoryWideToolchainPath(changedPath)) return result('repository', false);

  // Spread is measured in code. A symbol named only in prose has no
  // deterministic evidence of coupling, so it is absent rather than local.
  let counted = [...hits].filter(isCode);

  // A symbol the change introduces does not exist at the base ref, so it has
  // no spread there by construction. Measuring at base is right for a modified
  // symbol - its callers are what the change puts at risk - but it left reach
  // absent for most findings, because most findings are about new code.
  //
  // The module is the proxy. A new symbol added to a file that half the
  // repository imports carries that file's blast radius, even though nothing
  // references the symbol itself yet.
  if (counted.length === 0 && source !== 'claim') {
    const moduleName = normalisePath(changedPath).split('/').pop()?.replace(/\.[^.]+$/, '');
    if (moduleName !== undefined && moduleName.length >= 4) {
      searched.push(moduleName);
      try {
        for (const path of search(moduleName, cwd, ref)) hits.add(path);
      } catch {
        return result(null, true);
      }
      counted = [...hits].filter(isCode);
      usedModuleFallback = counted.length > 0;
    }
  }

  if (counted.length === 0) return result(null, false);

  // Measured relative to the changed file, never against absolute tree depth.
  //
  // An earlier version counted distinct top-level directories, which is inert
  // in the monorepo layouts this reviewer is actually pointed at: under
  // `packages/` or `plugins/` every source file shares one top-level
  // directory, so genuinely shared code read as narrow while a stray docs hit
  // read as repository-wide.
  if (counted.every((path) => normalisePath(path) === normalisedChangedPath)) {
    return result('local', false);
  }

  const outsideDirectories = directoryCount(
    counted.filter(
      (path) => normalisePath(path) !== normalisedChangedPath && !withinSubtree(path, changedDirectory),
    ),
  );

  // One neighbouring directory is a component relationship; several is the
  // repository. The boundary is an initial guess, deliberately explicit so a
  // measured run can revise it without restoring an agent judgement here.
  if (outsideDirectories >= 2) return result('repository', false);

  return result('component', false);
}
