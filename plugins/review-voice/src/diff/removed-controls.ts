import { basename, extname } from 'node:path';
import { countHunks, type RemovedLine } from './complexity.ts';
import { splitLine, type Language, type Rule, type SplitLine } from './type-escapes.ts';

/**
 * Lines a change removes that look like a control: a guard, a refusal, a
 * decorator, a middleware registration or an allowlist entry. Evidence for the
 * analyst, never a finding and never a verdict input. Every kind is lexical (no
 * parser), so each is a lead that says "a line like this was taken out"; whether
 * the control still holds elsewhere is for the analyst to search.
 *
 * The union is closed on purpose: a new kind is a new reading of removed text,
 * and docs/ARCHITECTURE.md names each one.
 */
export type RemovedControlKind = 'guard' | 'refusal' | 'decorator' | 'middleware' | 'allowlist-entry';

export interface RemovedControl {
  path: string;
  /**
   * The new-side line the removal stood before, so a line that replaces the
   * control shares it. Line 1 for a file with no new side.
   */
  line: number;
  kind: RemovedControlKind;
  /** The removed line, trimmed and cut at 120 characters. */
  text: string;
  /**
   * Set when the file has no new side: the change deletes it, and the text is
   * read from the base blob rather than a hunk, or removes every line of it.
   * Either way no surviving line can anchor a finding.
   */
  deletedFile?: true;
}

/** A file the change deletes and its text at the base. */
export interface DeletedFile {
  path: string;
  text: string;
}

const MAX_PER_FILE = 20;
const MAX_TEXT = 120;
// A minified line is not a control and would make a lazy pattern slow, so only
// the start of a line is read.
const MAX_SCANNED_LINE = 1000;

// The words that make a conditional a check on who may do what, or on how much.
// Matched at a word start, after an underscore or digit, in an upper-case
// run, or at a camelCase hump, so `isAdmin` and `RATE_LIMIT` hit and
// `generate` does not.
const GUARD_WORDS = [
  'auth', 'authoriz', 'permission', 'role', 'scope', 'token', 'session', 'owner', 'admin', 'allow', 'deny',
  'validate', 'verify', 'check', 'limit', 'quota', 'rate', 'throttle', 'sanitize', 'escape', 'csrf', 'origin',
];
const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
const GUARD_WORD = new RegExp(
  `(?<![A-Za-z])(?:${GUARD_WORDS.join('|')}|${GUARD_WORDS.map(capitalised).join('|')}|${GUARD_WORDS.map((w) => w.toUpperCase()).join('|')})` +
    `|(?<=[a-z0-9])(?:${GUARD_WORDS.map(capitalised).join('|')})`,
);

/**
 * What follows a conditional keyword up to the end of its condition: the
 * balanced parentheses when it opens with one, else the rest of the line, so
 * `if (ready) { authenticate(); }` is not read as a check on authentication.
 */
function conditionAfter(line: SplitLine, from: number): string {
  // The parentheses are balanced on the code view, where string contents are
  // blanked, so a `)` inside a string does not end the condition early; the
  // text returned is the raw view of the same span, strings intact, because
  // the words are read from it. Both views are the same length.
  const code = line.code.slice(from);
  const open = /^\s*\(/.exec(code);
  if (open === null) return line.raw.slice(from, toBody(code, from, 0));
  let depth = 0;
  for (let index = open[0].length - 1; index < code.length; index += 1) {
    if (code[index] === '(') depth += 1;
    else if (code[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        // A group followed by a boolean operator is the first operand of a
        // longer condition (Python's `if (a) and b:`), which runs on to the body.
        const continues = /^\s*(?:and|or|&&|\|\|)(?![\w$])/.test(code.slice(index + 1));
        return line.raw.slice(from, continues ? toBody(code, from, index + 1) : from + index + 1);
      }
    }
  }
  return line.raw.slice(from);
}

// Where a condition without an enclosing parenthesis ends: at the token that
// opens the body in the languages read here (a `:` followed by space or the
// line end in Python, `then` or `do` in Ruby, `{` in Go), or the line end.
// So `if ready: print('admin')` is a condition on `ready` alone, while a Ruby
// symbol (`when :admin`) is still part of its condition. `code` is the line's
// code view from `from`, searched from `start`; the result is an index into
// the raw line for `slice`, or undefined for the line end.
function toBody(code: string, from: number, start: number): number | undefined {
  const body = /:(?=\s|$)|\{|\bthen\b|\bdo\b/.exec(code.slice(start));
  return body === null ? undefined : from + start + body.index;
}

// A name that marks a middleware as an access or abuse control. `require` needs
// what follows it to continue the name, so `require('cors')` is not one.
const MIDDLEWARE_NAME = '(?:[Aa]uth|[Vv]erify|[Rr]equire[A-Z_]|[Cc]srf|CSRF|[Rr]ate_?[Ll]imit|RATE_?LIMIT)';

// Words that make a line a statement rather than one element of a list.
const STATEMENT_WORD =
  /\b(?:if|else|elif|for|foreach|while|do|switch|case|default|try|catch|except|finally|return|break|continue|throw|raise|when|import|export|const|let|var|def|class|function)\b/;

// A name that says the list around an entry is an allowlist.
const ALLOWLIST_NAME = /allow|whitelist|permitted|roles|scopes|origins/i;

// A pattern that matches a line once, for a rule whose test is a function of
// the whole line rather than a match inside it.
const WHOLE_LINE = /^.*$/g;

/**
 * One element of a list and nothing else: a quoted string, a bare identifier
 * or path, or `key: value`, with an optional trailing comma. Read by plain
 * string operations rather than one regular expression, because the
 * expression that said the same backtracked for seconds on a long quoted
 * value holding a comma.
 */
function isListElement(raw: string): boolean {
  let text = raw.trim();
  if (text.endsWith(',')) text = text.slice(0, -1).trimEnd();
  if (text === '') return false;
  const quote = text[0] as string;
  // A whole quoted string is an element; a quoted key (`"reader": true`) is
  // not one, and falls through to the key and value check below.
  if ((quote === '"' || quote === "'" || quote === '`') && text.length >= 2 && text.endsWith(quote) && !text.slice(1, -1).includes(quote)) {
    return true;
  }
  if (/^[\w$.@*/-]+$/.test(text)) return true;
  const colon = text.indexOf(':');
  if (colon <= 0) return false;
  const key = text.slice(0, colon).trim();
  const value = text.slice(colon + 1).trim();
  return /^["']?[\w$.-]+["']?$/.test(key) && value !== '' && !value.includes(',');
}

const RULES: Rule<RemovedControlKind>[] = [
  {
    // Matched on code so a conditional named only in a string is not one; the
    // words are read from the condition as written, so `if (role === 'admin')`
    // counts for what it compares against. Not a parser: `if (isReady) check()`
    // is read as a conditional on `isReady`, which has no such word, and passes.
    kind: 'guard',
    in: 'code',
    // Declarations and assignments can name a variable guard without introducing a conditional.
    pattern: /\b(?:if|elif|unless|guard|when|case)\b(?!\s*=)/g,
    accept: (match, line) =>
      !/\b(?:const|let|var)\s+$/.test(line.code.slice(0, match.index ?? 0)) &&
      GUARD_WORD.test(conditionAfter(line, (match.index ?? 0) + match[0].length)),
  },
  {
    // The keyword is read from the code view, so a `return` that merely sits in
    // a string is not one; what follows it is read from the raw line, since the
    // refusal is mostly a status or a message: `throw new Error('Forbidden')`
    // keeps its word. Code and raw are the same length, so the index carries.
    kind: 'refusal',
    in: 'code',
    pattern: /\b(?:throw|raise|return)\b/g,
    accept: (match, line) =>
      /^.{0,160}?(?:\b40[13]\b|Forbidden|Unauthori[sz]ed|TooMany|Invalid|Denied)/.test(line.raw.slice((match.index ?? 0) + match[0].length)),
  },
  {
    // An attribute or decorator that gates a handler. Code only, and anchored
    // to the start of the line, so `'@Authorize'` in a string is not one.
    kind: 'decorator',
    in: 'code',
    pattern:
      /^\s*[@[]\s*(?:[\w.]+\.)?(?:authori[sz]e\w*|require_?(?:role|auth|permission|login)\w*|login_required|permission_required|permission_classes|pre_?authorize|post_?authorize|roles?_?required|roles?_?allowed|secured|use_?guards|roles?(?=\s*\())\b/gi,
  },
  {
    // A registration that puts an access or abuse control in front of routes.
    kind: 'middleware',
    in: 'code',
    pattern: new RegExp(`\\.use\\([^;]*?${MIDDLEWARE_NAME}`, 'g'),
  },
  {
    kind: 'middleware',
    in: 'code',
    pattern: new RegExp(`\\b(?:router|app|routes?)\\.\\w+\\([^;]*?${MIDDLEWARE_NAME}`, 'g'),
  },
  {
    // One element of a list, removed from a file or declaration whose name says
    // it is an allowlist (the scanner checks the name). Read from the raw line
    // for the element and the code for what disqualifies it, so a quoted
    // `'for'` is an entry and a bare `for` is not.
    kind: 'allowlist-entry',
    in: 'raw',
    pattern: WHOLE_LINE,
    accept: (_match, line) => isListElement(line.raw) && !/[=(]/.test(line.code) && !STATEMENT_WORD.test(line.code),
  },
];

function language(quotes: string, lineComment: string, blockComments: boolean): Language<RemovedControlKind> {
  return { rules: RULES, quotes, lineComment, blockComments };
}

const C_STYLE = language('\'"', '//', true);
// The script languages have regular expression literals; Go, PHP and the hash
// languages read here do not, or (Ruby) rarely hold a control word in one.
const SCRIPT: Language<RemovedControlKind> = { ...language('\'"`', '//', true), regexLiterals: true };
const GO = language('\'"`', '//', true);
const HASH = language('\'"', '#', false);
// PHP comments with `#` as well as `//`; `#[` opens an attribute.
const PHP: Language<RemovedControlKind> = { ...C_STYLE, altLineComment: '#' };

const LANGUAGES: Record<string, Language<RemovedControlKind>> = {
  ...Object.fromEntries(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => [ext, SCRIPT])),
  ...Object.fromEntries(['.cs', '.java', '.kt'].map((ext) => [ext, C_STYLE])),
  '.php': PHP,
  '.go': GO,
  '.py': HASH,
  '.rb': HASH,
};

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The kinds one line reads as, in table order, once each. */
function kindsIn(
  text: string,
  lang: Language<RemovedControlKind>,
  allowlisted: boolean,
): RemovedControlKind[] {
  const line = splitLine(text.slice(0, MAX_SCANNED_LINE), lang);
  const kinds = new Set<RemovedControlKind>();
  for (const rule of lang.rules) {
    if (rule.kind === 'allowlist-entry' && !allowlisted) continue;
    for (const match of line[rule.in].matchAll(rule.pattern)) {
      if (rule.accept === undefined || rule.accept(match, line)) {
        kinds.add(rule.kind);
        break;
      }
    }
  }
  return [...kinds];
}

const EVERY_PATH = { has: (): boolean => true };

/**
 * Controls on the lines the diff removes from the given files, and on every
 * line of the files it deletes outright, per language by extension; any other
 * extension gets none.
 *
 * A removed line whose text, with whitespace collapsed, is added back anywhere
 * in the diff (any file) is a move, not a removal, and is dropped: a guard that
 * relocates into shared middleware is not a lost control. A line that is
 * entirely a comment, or names a keyword only in a comment, never matches.
 *
 * At most 20 per file, earliest first, sorted by path then line. A file with
 * no new side, deleted or emptied of every line, has no surviving line, so its
 * entries sit at line 1 with `deletedFile: true`; a deleted file's only
 * allowlist mark is its basename (there is no enclosing scope).
 */
export function findRemovedControls(
  diff: string,
  paths: readonly string[],
  deletedFiles: readonly DeletedFile[] = [],
): RemovedControl[] {
  const wanted = new Set(paths);
  const hunks = countHunks(diff, EVERY_PATH);
  // Every added line of every file, not only the production ones: a guard moved
  // into a shared module is still added back. Counted, not merely noted: one
  // addition accounts for one removal, so the same guard taken out of two
  // places and put back in one is still one lost control. A file's own moves
  // are settled first, and every file's removals spend the pool, wanted or not,
  // so a guard moved within a test helper cannot cancel a removal elsewhere.
  const added = new Map<string, number>();
  const addedByFile = new Map<string, Map<string, number>>();
  for (const hunk of hunks) {
    const own = addedByFile.get(hunk.path) ?? new Map<string, number>();
    addedByFile.set(hunk.path, own);
    for (const line of hunk.added) {
      const key = collapse(line.text);
      added.set(key, (added.get(key) ?? 0) + 1);
      own.set(key, (own.get(key) ?? 0) + 1);
    }
  }
  const spend = (pool: Map<string, number>, key: string): boolean => {
    const left = pool.get(key) ?? 0;
    if (left === 0) return false;
    pool.set(key, left - 1);
    return true;
  };
  const netted = (text: string): boolean => spend(added, collapse(text));

  const found: RemovedControl[] = [];
  const byPath = new Map<string, RemovedControl[]>();
  const entriesOf = (path: string): RemovedControl[] => {
    const entries = byPath.get(path) ?? [];
    byPath.set(path, entries);
    return entries;
  };

  // First pass: a removal matched by an addition in its own file is a move
  // within that file, and spends that addition in both pools.
  const movedWithinFile = new Set<RemovedLine>();
  for (const hunk of hunks) {
    const own = addedByFile.get(hunk.path);
    if (own === undefined) continue;
    for (const removed of hunk.removed) {
      const key = collapse(removed.text);
      if (spend(own, key)) {
        spend(added, key);
        movedWithinFile.add(removed);
      }
    }
  }

  for (const hunk of hunks) {
    const lang = wanted.has(hunk.path) ? LANGUAGES[extname(hunk.path).toLowerCase()] : undefined;
    const named = ALLOWLIST_NAME.test(basename(hunk.path));
    // A hunk whose new side starts at line 0 is the whole of a file emptied of
    // every line (git writes `+0,0`); nothing survives to anchor on.
    const emptied = hunk.line === 0;
    for (const removed of hunk.removed) {
      if (movedWithinFile.has(removed) || netted(removed.text)) continue;
      if (lang === undefined) continue;
      const { line, text, scope } = removed;
      const allowlisted = named || (scope !== null && ALLOWLIST_NAME.test(scope));
      for (const kind of kindsIn(text, lang, allowlisted)) {
        const entry: RemovedControl = { path: hunk.path, line, kind, text: text.trim().slice(0, MAX_TEXT) };
        if (emptied) entry.deletedFile = true;
        entriesOf(hunk.path).push(entry);
      }
    }
  }
  for (const entries of byPath.values()) {
    // Stable, so removals that share an anchor keep the order they had.
    entries.sort((a, b) => a.line - b.line);
    found.push(...entries.slice(0, MAX_PER_FILE));
  }

  for (const file of deletedFiles) {
    const lang = LANGUAGES[extname(file.path).toLowerCase()];
    if (lang === undefined) continue;
    const allowlisted = ALLOWLIST_NAME.test(basename(file.path));
    let kept = 0;
    // Every line is read, cap or no cap, so each one still spends the addition
    // that nets it; stopping early would hand that addition to another file's
    // removal of the same text. Only what is emitted is capped.
    for (const raw of file.text.split('\n')) {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (netted(text)) continue;
      if (kept >= MAX_PER_FILE) continue;
      for (const kind of kindsIn(text, lang, allowlisted)) {
        if (kept >= MAX_PER_FILE) break;
        found.push({ path: file.path, line: 1, kind, text: text.trim().slice(0, MAX_TEXT), deletedFile: true });
        kept += 1;
      }
    }
  }

  return found.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}
