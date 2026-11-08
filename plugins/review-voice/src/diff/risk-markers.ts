import { basename, extname } from 'node:path';
import { countHunks } from './complexity.ts';
import { splitLine, type Language, type Rule } from './type-escapes.ts';

/**
 * Added lines that touch a place where review should look harder: a new entry
 * point, a lock or fan-out, a query built from text, an unsafe call. A lead for
 * the specialist lanes and for lane eligibility, never a finding and never a
 * verdict input. Lexical, one line at a time (no parser), so a marker says "a
 * line like this was added", not that anything is wrong. Only the path, line
 * and kind are kept, so no source text is copied into the manifest.
 *
 * The union is closed on purpose: a new kind is a new reading of added text,
 * and docs/ARCHITECTURE.md names each one.
 */
export type RiskMarkerKind = 'new-route' | 'lock-or-async' | 'string-built-query' | 'unsafe';

export interface RiskMarker {
  path: string;
  line: number;
  kind: RiskMarkerKind;
}

const MAX_PER_FILE = 20;
// A minified line is not a marker and would make a pattern slow, so only the
// start of a line is read.
const MAX_SCANNED_LINE = 1000;

// A word read at its start, after a non-letter, or at a camelCase hump, so
// `readLock` and `mutex` hit and `block`, `clock` and `unlock` do not.
const WORD_START = '(?<![A-Za-z])';
const HUMP = '(?<=[a-z0-9])';
const CONCURRENCY_WORDS = ['lock', 'mutex', 'semaphore'];
const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
const CONCURRENCY_WORD = new RegExp(
  `${WORD_START}(?:${[...CONCURRENCY_WORDS, ...CONCURRENCY_WORDS.map(capitalised), ...CONCURRENCY_WORDS.map((w) => w.toUpperCase())].join('|')}|RW(?:Lock|Mutex))` +
    `|${HUMP}(?:${CONCURRENCY_WORDS.map(capitalised).join('|')})`,
  'g',
);

// Rules read from the code view, so a pattern that only a string or a comment
// names is not a marker.
const CODE_RULES: Rule<RiskMarkerKind>[] = [
  {
    kind: 'new-route',
    in: 'code',
    pattern:
      /\bapp\.(?:get|post|put|patch|delete)\s*\(|\brouter\.\w|@(?:Get|Post|Put|Patch|Delete|Route)(?:Mapping)?\b|\[Http(?:Get|Post|Put|Delete)\b|@app\.route\b/g,
  },
  {
    kind: 'lock-or-async',
    in: 'code',
    pattern: CONCURRENCY_WORD,
  },
  {
    kind: 'lock-or-async',
    in: 'code',
    pattern: /\bInterlocked\b|\bsynchronized\b|\bMonitor\.|\bPromise\.all(?:Settled)?\b|\bTask\.WhenAll\b|\bgo\s+func\b|\bParallel\./g,
  },
  {
    kind: 'unsafe',
    in: 'code',
    pattern: /\bunsafe\b|\beval\s*\(|\bexec\s*\(|\bdangerouslySetInnerHTML\b|\bMarshal\.|\bpickle\.loads\b/g,
  },
  {
    // A loader that names SafeLoader on the same line is the safe form.
    kind: 'unsafe',
    in: 'code',
    pattern: /\byaml\.load\s*\(/g,
    accept: (_match, line) => !/SafeLoader/.test(line.code),
  },
];

// `path(` routes a URL in a Django `urls` file, and means nothing elsewhere.
const URL_RULE: Rule<RiskMarkerKind> = { kind: 'new-route', in: 'code', pattern: /(?<![\w.])path\s*\(/g };

/**
 * Whether the quoted segment holding the keyword at `at` is joined to data:
 * a `+`, `%` or `.format(` beside it, or a placeholder inside it. A keyword
 * outside every string, or in a string with neither, is plain text.
 */
function buildsQuery(code: string, raw: string, quotes: string, triple: boolean, at: number): boolean {
  let index = 0;
  while (index < code.length) {
    const char = code[index]!;
    if (!quotes.includes(char)) {
      index += 1;
      continue;
    }
    // The delimiter the tokenizer opened with: three quotes stand for one when
    // the language has triple quotes, and the code view kept them.
    const delimiter = triple && code.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
    const open = index;
    const close = code.indexOf(delimiter, open + delimiter.length);
    // `end` is the closing delimiter, or the line end for a string that goes on.
    const end = close === -1 ? code.length : close;
    if (at > open && at < end) {
      const inside = raw.slice(open + delimiter.length, end);
      const prefix = code.slice(0, open);
      // An f-string interpolates only when it holds a placeholder.
      const interpolated = /\$\{|%s/.test(inside) || (/(?<![\w$])(?:rf|fr|f)$/i.test(prefix) && inside.includes('{'));
      const before = prefix.trimEnd();
      const after = close === -1 ? '' : code.slice(end + delimiter.length).trimStart();
      const joined = before.endsWith('+') || /^(?:\+|%(?!=)|\.format\s*\()/.test(after);
      return interpolated || joined;
    }
    index = close === -1 ? code.length : close + delimiter.length;
  }
  return false;
}

function queryRule(quotes: string, triple: boolean): Rule<RiskMarkerKind> {
  return {
    kind: 'string-built-query',
    in: 'raw',
    pattern: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/g,
    accept: (match, line) => buildsQuery(line.code, line.raw, quotes, triple, match.index ?? 0),
  };
}

function language(quotes: string, lineComment: string, blockComments: boolean, regexLiterals = false, tripleQuotes = false): Language<RiskMarkerKind> {
  return {
    rules: [...CODE_RULES, queryRule(quotes, tripleQuotes)],
    quotes,
    lineComment,
    blockComments,
    ...(regexLiterals ? { regexLiterals } : {}),
    ...(tripleQuotes ? { tripleQuotes } : {}),
  };
}

const SCRIPT = language('\'"`', '//', true, true);
const C_STYLE = language('\'"', '//', true);
const GO = language('\'"`', '//', true);
// PHP comments with `#` as well as `//`; `#[` opens an attribute.
const PHP: Language<RiskMarkerKind> = { ...C_STYLE, altLineComment: '#' };
const HASH = language('\'"', '#', false);
// Python's triple quotes are one delimiter; a docstring or a query written in
// one would otherwise read as code after its first quote.
const PYTHON = language('\'"', '#', false, false, true);

const LANGUAGES: Record<string, Language<RiskMarkerKind>> = {
  ...Object.fromEntries(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => [ext, SCRIPT])),
  ...Object.fromEntries(['.cs', '.java', '.kt'].map((ext) => [ext, C_STYLE])),
  '.php': PHP,
  '.go': GO,
  '.py': PYTHON,
  '.rb': HASH,
};

/** The kinds one line reads as, in table order, once each. */
function kindsIn(text: string, lang: Language<RiskMarkerKind>, urls: boolean): RiskMarkerKind[] {
  const line = splitLine(text.slice(0, MAX_SCANNED_LINE), lang);
  const kinds = new Set<RiskMarkerKind>();
  for (const rule of urls ? [...lang.rules, URL_RULE] : lang.rules) {
    if (kinds.has(rule.kind)) continue;
    for (const match of line[rule.in].matchAll(rule.pattern)) {
      if (rule.accept === undefined || rule.accept(match, line)) {
        kinds.add(rule.kind);
        break;
      }
    }
  }
  return [...kinds];
}

/**
 * Risk markers on the lines the diff adds to the given files, per language by
 * extension; any other extension gets none. A pattern that sits in a string or
 * a comment is not one, and neither is a SQL keyword in a string that nothing
 * is joined to. At most 20 per file, earliest first, sorted by path then line.
 */
export function findRiskMarkers(diff: string, paths: readonly string[]): RiskMarker[] {
  const found: RiskMarker[] = [];
  for (const hunk of countHunks(diff, new Set(paths))) {
    const lang = LANGUAGES[extname(hunk.path).toLowerCase()];
    if (lang === undefined) continue;
    const urls = /^urls?$/i.test(basename(hunk.path, extname(hunk.path)));
    for (const { line, text } of hunk.added) {
      for (const kind of kindsIn(text, lang, urls)) found.push({ path: hunk.path, line, kind });
    }
  }
  found.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
  const perFile = new Map<string, number>();
  return found.filter((marker) => {
    const seen = perFile.get(marker.path) ?? 0;
    perFile.set(marker.path, seen + 1);
    return seen < MAX_PER_FILE;
  });
}
