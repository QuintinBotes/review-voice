import { execFileSync } from 'node:child_process';

/**
 * A claim that something is not in the repository.
 *
 * This is the cheapest class of claim to check and the most damaging to get
 * wrong. On one pull request the analyst asserted, at confidence 0.90 and then
 * 0.93 on a re-run, that four files "do not exist anywhere in the repo". All
 * four were present, and it went on to propose replacing correct
 * cross-references with wrong ones. A reviewer that invents an absence tells
 * the author to break working code.
 *
 * The verifier caught it both times. It should not have to: the repository is
 * right here, and `git grep` settles the question in milliseconds.
 */
const ASSERTS_ABSENCE = [
  /\b(?:does|do)\s+not\s+exist\b/i,
  /\b(?:is|are)\s+(?:not\s+(?:present|defined|declared)|missing|absent)\b/i,
  /\bno\s+such\s+(?:file|symbol|function|component|hook|module|export)\b/i,
  /\bnever\s+(?:defined|declared|exported)\b/i,
  /\bcannot\s+be\s+found\b/i,
  /\bnowhere\s+in\s+the\s+(?:repo|repository|codebase)\b/i,
];

export function assertsAbsence(text: string): boolean {
  return ASSERTS_ABSENCE.some((pattern) => pattern.test(text));
}

/**
 * Identifiers a claim names, taken from backticks and from file-like and
 * CamelCase words.
 *
 * Only tokens distinctive enough to search for. A claim about `data` or `id`
 * would match everywhere and prove nothing.
 */
export function namedSymbols(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const token = (match[1] ?? '').trim();
    if (token.length >= 4 && !/\s/.test(token)) found.add(token);
  }
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*\.(?:tsx?|jsx?|cs|py|go|rb|java|kt|rs))\b/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  for (const match of text.matchAll(/\b([a-z][A-Za-z0-9]{4,}[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]{3,})\b/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }

  // A path or filename is the strongest signal, so keep the basename too.
  for (const token of [...found]) {
    const base = token.split('/').pop();
    if (base !== undefined && base !== token && base.length >= 4) found.add(base);
  }

  return [...found];
}

export interface ExistenceCheck {
  /** Symbols the claim said were absent but which the repository contains. */
  found: string[];
  checked: string[];
  /** True when the search could not run, in which case nothing is concluded. */
  inconclusive: boolean;
  /**
   * Which tree answered, always stated.
   *
   * An empty `found` is not corroboration unless this names the tree under
   * review. Searching a checkout 179 commits behind the pull request base
   * reported `found: []` with `inconclusive: false` for two files that exist,
   * which reads as the guard confirming the claim rather than failing to
   * evaluate it.
   */
  searchedRef: string;
}

export type Searcher = (symbol: string, cwd: string, ref: string | null) => boolean;

/**
 * Whether the repository contains a literal token.
 *
 * `git grep` rather than a filesystem walk: it respects the repository's own
 * idea of what is tracked, and it is fast enough to run per symbol.
 */
export const gitGrep: Searcher = (symbol, cwd, ref) => {
  // The ref goes after the pattern: `git grep -F --quiet -- <sym> <ref>` is
  // rejected, because everything after `--` is a pathspec.
  const args =
    ref === null
      ? ['grep', '--fixed-strings', '--quiet', '--', symbol]
      : ['grep', '--fixed-strings', '--quiet', symbol, ref];
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch (error) {
    // Exit 1 is "no match", which is the answer. Anything else is a failure to
    // ask the question, and must not be read as an answer.
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
};

/**
 * Checks a claim of absence against the repository.
 *
 * A claim that names nothing searchable is left alone: this contradicts
 * specific assertions, it does not grade vagueness.
 */
export function checkAbsenceClaim(
  text: string,
  cwd: string,
  ref: string | null = null,
  search: Searcher = gitGrep,
): ExistenceCheck | null {
  if (!assertsAbsence(text)) return null;

  const symbols = namedSymbols(text);
  if (symbols.length === 0) return null;

  const searchedRef = ref ?? 'working tree';
  const found: string[] = [];
  const checked: string[] = [];

  for (const symbol of symbols.slice(0, 12)) {
    try {
      checked.push(symbol);
      if (search(symbol, cwd, ref)) found.push(symbol);
    } catch {
      // A search that could not run is not an answer. A missing ref exits
      // 128, which must never be read as "the symbol is absent".
      return { found: [], checked, inconclusive: true, searchedRef };
    }
  }

  return { found, checked, inconclusive: false, searchedRef };
}
