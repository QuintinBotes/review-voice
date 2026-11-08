import { basename, extname } from 'node:path';
import { countHunks } from './complexity.ts';
import { splitLine, type Language, type Rule } from './type-escapes.ts';

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
   * control shares it. Line 1 for a deleted file, which has no new side.
   */
  line: number;
  kind: RemovedControlKind;
  /** The removed line, trimmed and cut at 120 characters. */
  text: string;
  /** Read from the base blob of a file the change deletes, not from a hunk. */
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
function conditionAfter(raw: string, from: number): string {
  const rest = raw.slice(from);
  const open = /^\s*\(/.exec(rest);
  if (open === null) return rest;
  let depth = 0;
  for (let index = open[0].length - 1; index < rest.length; index += 1) {
    if (rest[index] === '(') depth += 1;
    else if (rest[index] === ')') {
      depth -= 1;
      if (depth === 0) return rest.slice(0, index + 1);
    }
  }
  return rest;
}

// A name that marks a middleware as an access or abuse control. `require` needs
// what follows it to continue the name, so `require('cors')` is not one.
const MIDDLEWARE_NAME = '(?:[Aa]uth|[Vv]erify|[Rr]equire[A-Z_]|[Cc]srf|CSRF|[Rr]ate_?[Ll]imit|RATE_?LIMIT)';

// Words that make a line a statement rather than one element of a list.
const STATEMENT_WORD =
  /\b(?:if|else|elif|for|foreach|while|do|switch|case|default|try|catch|except|finally|return|break|continue|throw|raise|when|import|export|const|let|var|def|class|function)\b/;

// A name that says the list around an entry is an allowlist.
const ALLOWLIST_NAME = /allow|whitelist|permitted|roles|scopes|origins/i;

// One element of a list and nothing else: a quoted string, a bare identifier or
// path, or `key: value`, with an optional trailing comma.
const LIST_ELEMENT =
  /^\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[\w$.@*/-]+|["']?[\w$.-]+["']?\s*:\s*[^,]+?)\s*,?\s*$/g;

const RULES: Rule<RemovedControlKind>[] = [
  {
    // Matched on code so a conditional named only in a string is not one; the
    // words are read from the condition as written, so `if (role === 'admin')`
    // counts for what it compares against. Not a parser: `if (isReady) check()`
    // is read as a conditional on `isReady`, which has no such word, and passes.
    kind: 'guard',
    in: 'code',
    pattern: /\b(?:if|elif|unless|guard|when|case)\b/g,
    accept: (match, line) => GUARD_WORD.test(conditionAfter(line.raw, (match.index ?? 0) + match[0].length)),
  },
  {
    // A refusal is mostly a status or a message, so it is read from the raw
    // line: `throw new Error('Forbidden')` keeps its word. A `return` that merely
    // sits in a string is read too; that is the price of reading strings at all.
    kind: 'refusal',
    in: 'raw',
    pattern: /\b(?:throw|raise|return)\b.{0,160}?(?:\b40[13]\b|Forbidden|Unauthori[sz]ed|TooMany|Invalid|Denied)/g,
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
    pattern: LIST_ELEMENT,
    accept: (_match, line) => !/[=(]/.test(line.code) && !STATEMENT_WORD.test(line.code),
  },
];

function language(quotes: string, lineComment: string, blockComments: boolean): Language<RemovedControlKind> {
  return { rules: RULES, quotes, lineComment, blockComments };
}

const C_STYLE = language('\'"', '//', true);
const SCRIPT = language('\'"`', '//', true);
const GO = language('\'"`', '//', true);
const HASH = language('\'"', '#', false);

const LANGUAGES: Record<string, Language<RemovedControlKind>> = {
  ...Object.fromEntries(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => [ext, SCRIPT])),
  ...Object.fromEntries(['.cs', '.java', '.kt', '.php'].map((ext) => [ext, C_STYLE])),
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
 * At most 20 per file, earliest first, sorted by path then line. A deleted
 * file has no new side, so its entries sit at line 1 with `deletedFile: true`,
 * and only its basename can mark an allowlist (there is no enclosing scope).
 */
export function findRemovedControls(
  diff: string,
  paths: readonly string[],
  deletedFiles: readonly DeletedFile[] = [],
): RemovedControl[] {
  const wanted = new Set(paths);
  const hunks = countHunks(diff, EVERY_PATH);
  // Every added line of every file, not only the production ones: a guard moved
  // into a test helper or a shared module is still added back.
  const added = new Set<string>();
  for (const hunk of hunks) {
    for (const line of hunk.added) added.add(collapse(line.text));
  }

  const found: RemovedControl[] = [];
  const byPath = new Map<string, RemovedControl[]>();
  const entriesOf = (path: string): RemovedControl[] => {
    const entries = byPath.get(path) ?? [];
    byPath.set(path, entries);
    return entries;
  };

  for (const hunk of hunks) {
    if (!wanted.has(hunk.path)) continue;
    const lang = LANGUAGES[extname(hunk.path).toLowerCase()];
    if (lang === undefined) continue;
    const named = ALLOWLIST_NAME.test(basename(hunk.path));
    for (const { line, text, scope } of hunk.removed) {
      if (added.has(collapse(text))) continue;
      const allowlisted = named || (scope !== null && ALLOWLIST_NAME.test(scope));
      for (const kind of kindsIn(text, lang, allowlisted)) {
        entriesOf(hunk.path).push({ path: hunk.path, line, kind, text: text.trim().slice(0, MAX_TEXT) });
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
    for (const raw of file.text.split('\n')) {
      if (kept >= MAX_PER_FILE) break;
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (added.has(collapse(text))) continue;
      for (const kind of kindsIn(text, lang, allowlisted)) {
        if (kept >= MAX_PER_FILE) break;
        found.push({ path: file.path, line: 1, kind, text: text.trim().slice(0, MAX_TEXT), deletedFile: true });
        kept += 1;
      }
    }
  }

  return found.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}
