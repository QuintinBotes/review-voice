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

/**
 * Where an absence claim says the thing is absent from.
 *
 * Decided from the claim's grammar rather than from how a place is spelled. A
 * list of name shapes could not work: the same pattern that read "in acme-web"
 * as somewhere else, so a claim about this very repository went unchecked, also
 * left a bare path like `packages/commander/modules/eventing` unprotected, so a
 * true scoped claim was deleted. Hyphenation, backticks and capitalisation say
 * nothing about whether a claim is bounded.
 *
 * What matters is whether the assertion carries a locative complement, and
 * whether that complement names the repository under review or somewhere else.
 */
export type AbsenceScope = 'repository' | 'bounded' | 'elsewhere';

/**
 * Determiners, stripped before a complement is classified.
 *
 * Only `the` was stripped, so "in this repository" fell through to be read as a
 * named unit with the determiner captured as the name, and "in this codebase"
 * fell through to bounded. One normalisation rather than a pattern per word.
 */
const DETERMINER = /^(?:the|this|that|these|those|our|your|their|its|his|her|my|a|an)\s+/i;

function withoutDeterminer(complement: string): string {
  let text = complement.trim().replace(/[`'"]/g, '');
  // "in this whole repository" carries two.
  for (let i = 0; i < 3; i += 1) text = text.replace(DETERMINER, '');
  return text.trim();
}

/** Words naming the repository under review, whatever it is called. */
const GENERIC_REPOSITORY = /^(?:entire\s+|whole\s+)?(?:mono)?(?:repo|repository|code\s?base|project|tree)\b/i;

/** A complement naming a distinct published unit rather than a place inside one. */
const NAMED_UNIT = /^(?:the\s+)?(?:@[\w.-]+\/[\w.-]+|[a-z0-9]+(?:-[a-z0-9]+)+)\s*$/i;
const NAMED_UNIT_SUFFIX = /^(?:the\s+)?\S+\s+(?:repo|repository|service|package|library)\b/i;
const ANOTHER_UNIT = /^(?:another|a\s+different|a\s+sibling|the\s+other)\s+(?:repo|repository|package|service)\b/i;

/** The phrase that asserts the absence, and whatever locative follows it. */
const ABSENCE_WITH_COMPLEMENT =
  /\b(?:does|do)\s+not\s+exist|\b(?:is|are)\s+(?:not\s+(?:present|defined|declared)|missing|absent)|\bno\s+such\s+(?:file|symbol|function|component|hook|module|export)|\bnever\s+(?:defined|declared|exported)|\bcannot\s+be\s+found/i;

const LOCATIVE = /\b(?:in|from|within|under|inside|throughout|across)\s+([^.,;]+)/i;

/**
 * Whether a place named in a claim is the repository being reviewed.
 *
 * `--repository` arrives as `owner/name`, and people write the bare name.
 */
function namesThisRepository(complement: string, repository: string | null): boolean {
  if (repository === null) return false;
  const candidates = [repository, repository.split('/').pop() ?? repository]
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  const said = withoutDeterminer(complement).toLowerCase();
  return candidates.some((name) =>
    [name, `${name} repository`, `${name} repo`, `${name} monorepo`, `${name} codebase`].includes(said),
  );
}

/**
 * Absence of a property rather than of the thing.
 *
 * "Never exported" is true precisely when the symbol exists, so a repository
 * search confirms it and refutes nothing. It carries no locative, so grammar
 * alone would read it as a claim about everywhere.
 */
const PROPERTY_NOT_PLACE = /\b(?:ex|im)ported\b|\bnot\s+(?:public|exposed|re-?exported)\b/i;

export function absenceScope(text: string, repository: string | null = null): AbsenceScope {
  if (PROPERTY_NOT_PLACE.test(text)) return 'bounded';
  if (/\b(?:anywhere|nowhere)\b/i.test(text)) return 'repository';

  const assertion = ABSENCE_WITH_COMPLEMENT.exec(text);
  // No assertion at all: the caller checks this first, and an unbounded claim
  // is the repository by default.
  if (assertion === null) return 'repository';

  const after = text.slice(assertion.index + assertion[0].length);
  const locative = LOCATIVE.exec(after);
  // "`X` does not exist." names no place, so it is a claim about everywhere.
  if (locative === null) return 'repository';

  const complement = (locative[1] ?? '').trim();
  const bare = withoutDeterminer(complement);

  if (GENERIC_REPOSITORY.test(bare)) return 'repository';
  if (namesThisRepository(complement, repository)) return 'repository';
  if (ANOTHER_UNIT.test(complement) || NAMED_UNIT.test(bare) || NAMED_UNIT_SUFFIX.test(bare)) {
    return 'elsewhere';
  }

  // Any other place: a module, a directory, a call site, an export list. This
  // repository can confirm the symbol exists and cannot speak to whether it is
  // there, which is the whole content of the claim.
  return 'bounded';
}

/** Whether the text asserts an absence at all, before any question of scope. */
export function assertsAbsence(text: string, repository: string | null = null): boolean {
  if (!ASSERTS_ABSENCE.some((pattern) => pattern.test(text))) return false;
  return absenceScope(text, repository) === 'repository';
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
    // A leading dash is an option to every command that might be asked this
    // question, and this text ultimately comes from the diff.
    if (token.length >= 4 && !/\s/.test(token) && !token.startsWith('-')) found.add(token);
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
    if (base !== undefined && base !== token && base.length >= 4 && !base.startsWith('-')) found.add(base);
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

/** A repository search that reports every path containing the literal token. */
export type PathSearcher = (symbol: string, cwd: string, ref: string | null) => string[];

/**
 * Whether the repository contains a literal token.
 *
 * `git grep` rather than a filesystem walk: it respects the repository's own
 * idea of what is tracked, and it is fast enough to run per symbol.
 */
export const gitGrep: Searcher = (symbol, cwd, ref) => {
  // `-e` marks the next argument as the pattern.
  //
  // Without it a symbol beginning with a dash is parsed as an option, and the
  // symbol comes from review prose that originates in the diff. `git grep -O`
  // opens a pager, so this was argument injection from untrusted text into a
  // subprocess, not merely a malformed query. `namedSymbols` refuses such a
  // token as well; either alone would do, and this is the one that has to
  // hold if the extractor ever changes.
  //
  // The ref goes after the pattern. Everything after `--` is a pathspec, so it
  // cannot be used to separate them.
  const args =
    ref === null
      ? ['grep', '--fixed-strings', '--quiet', '-e', symbol]
      : ['grep', '--fixed-strings', '--quiet', '-e', symbol, ref];
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
 * Lists tracked paths containing a literal token.
 *
 * This deliberately has the same argument safety and failure semantics as
 * `gitGrep`: exit 1 means no match, while a bad ref, timeout, or other failure
 * is re-thrown so callers cannot mistake an unanswered search for a narrow
 * result. `-z` keeps filenames with whitespace or newlines unambiguous.
 */
export const gitGrepPaths: PathSearcher = (symbol, cwd, ref) => {
  const args =
    ref === null
      ? ['grep', '--fixed-strings', '--full-name', '-l', '-z', '-e', symbol]
      : ['grep', '--fixed-strings', '--full-name', '-l', '-z', '-e', symbol, ref];
  try {
    const output = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    // `git grep -l <ref>` prefixes every line with `<ref>:`. Left on, every
    // path compares unequal to the changed file and sits outside its subtree,
    // so `local` becomes unreachable and everything reads as repository-wide.
    // Stripped by exact prefix rather than by splitting on the first colon,
    // because a path may legitimately contain one.
    const prefix = ref === null ? '' : `${ref}:`;
    return output
      .split('\0')
      .filter((path) => path.length > 0)
      .map((path) => (prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path));
  } catch (error) {
    // Match `gitGrep`: only git's documented no-match exit answers the
    // question. In particular, a missing ref exits 128 and must remain an
    // error for reach to mark inconclusive.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
};

/**
 * Checks a claim of absence against the repository.
 *
 * A claim that names nothing searchable is left alone: this contradicts
 * specific assertions, it does not grade vagueness.
 */
/**
 * Checks a claim of absence against the repository.
 *
 * Only the claim is read, never the failure mode. They used to be concatenated
 * and passed as one string, which handed the sentence explaining the
 * consequence a vote on whether the assertion was scoped, and let a symbol
 * named in the mechanism be treated as one the claim said was absent. The same
 * invented claim was checked or ignored depending on how its impact was
 * worded, and a rejection could name a symbol the claim never mentioned.
 */
export function checkAbsenceClaim(
  text: string,
  cwd: string,
  ref: string | null = null,
  search: Searcher = gitGrep,
  repository: string | null = null,
): ExistenceCheck | null {
  const searchedRefLabel = ref ?? 'working tree';

  // Nothing is asserted to be absent, so there is nothing to check and nothing
  // to report. Tested first: a claim mentioning a package by name used to pick
  // up an inert `inconclusive` record for saying nothing of the kind.
  if (!ASSERTS_ABSENCE.some((pattern) => pattern.test(text))) return null;

  const scope = absenceScope(text, repository);

  // A place inside this repository that `git grep` cannot speak to. The symbol
  // existing elsewhere is exactly what the claim assumes.
  if (scope === 'bounded') return null;

  if (scope === 'elsewhere') {
    return {
      found: [],
      checked: [],
      // Not silence. An empty `found` with `inconclusive: false` is the shape
      // that reads as corroboration, and this repository cannot speak for
      // another one.
      inconclusive: true,
      searchedRef: searchedRefLabel,
    };
  }

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
