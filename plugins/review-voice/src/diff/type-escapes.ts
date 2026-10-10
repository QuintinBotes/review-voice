import { extname } from 'node:path';
import { countHunks } from './complexity.ts';

export type TypeEscapeKind =
  | 'any'
  | 'double-cast'
  | 'non-null'
  | 'ts-ignore'
  | 'ts-expect-error'
  | 'lint-disable'
  | 'null-forgiving'
  | 'dynamic'
  | 'object-cast'
  | 'nullable-disable'
  | 'type-ignore'
  | 'cast';

/** A way out of the type system on a line the change adds. */
export interface TypeEscape {
  path: string;
  line: number;
  kind: TypeEscapeKind;
}

interface Rule {
  kind: TypeEscapeKind;
  /** Code patterns see string contents blanked; directives are read from comments only. */
  in: 'code' | 'comment';
  pattern: RegExp;
  /** Narrows a match, e.g. to the directives that name a type rule. */
  accept?: (match: RegExpMatchArray) => boolean;
}

interface Language {
  rules: Rule[];
  quotes: string;
  lineComment: string;
  blockComments: boolean;
  /** Code lines that name a type without using it, e.g. an import. */
  skip?: RegExp;
}

const MAX_PER_FILE = 20;

// A postfix `!` after a name, `)` or `]` and before what can follow an operand.
// `!=` and `!==` fail the lookahead, as does a prefix `!`.
const POSTFIX_BANG = /[\w$)\]]!(?=[.[)\],;:])/g;

const TYPESCRIPT: Language = {
  quotes: '\'"`',
  lineComment: '//',
  blockComments: true,
  rules: [
    { kind: 'any', in: 'code', pattern: /:\s*any\b|\bas\s+any\b|<any>/g },
    { kind: 'double-cast', in: 'code', pattern: /\bas\s+unknown\s+as\b/g },
    { kind: 'non-null', in: 'code', pattern: POSTFIX_BANG },
    { kind: 'ts-ignore', in: 'comment', pattern: /@ts-ignore\b/g },
    { kind: 'ts-expect-error', in: 'comment', pattern: /@ts-expect-error\b/g },
    {
      kind: 'lint-disable',
      in: 'comment',
      pattern: /\beslint-disable(?:-next-line|-line)?(?![\w-])([^]*)/g,
      // Names no rule (disables them all), or names one from the type-aware set.
      accept: (match) => {
        const rules = (match[1] ?? '').replace(/\*\/[^]*$/, '').split(/\s--\s/)[0]!.trim();
        return rules === '' || rules.includes('@typescript-eslint/');
      },
    },
  ],
};

const CSHARP: Language = {
  quotes: '\'"',
  lineComment: '//',
  blockComments: true,
  rules: [
    { kind: 'null-forgiving', in: 'code', pattern: POSTFIX_BANG },
    { kind: 'dynamic', in: 'code', pattern: /\bdynamic\b/g },
    { kind: 'object-cast', in: 'code', pattern: /\(object\)\s*[\w@$("']/g },
    { kind: 'nullable-disable', in: 'code', pattern: /^\s*#\s*nullable\s+disable\b/g },
    {
      kind: 'nullable-disable',
      in: 'code',
      pattern: /^\s*#\s*pragma\s+warning\s+disable\b(.*)$/g,
      accept: (match) => /\bCS8[67]\d\d\b|\bnullable\b/i.test(match[1] ?? ''),
    },
  ],
};

const PYTHON: Language = {
  quotes: '\'"',
  lineComment: '#',
  blockComments: false,
  skip: /^\s*(?:import\s|from\s+\S+\s+import\b)/,
  rules: [
    { kind: 'type-ignore', in: 'comment', pattern: /type:\s*ignore\b/g },
    { kind: 'cast', in: 'code', pattern: /\bcast\(/g },
    { kind: 'any', in: 'code', pattern: /\bAny\b/g },
  ],
};

const LANGUAGES: Record<string, Language> = {
  ...Object.fromEntries(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => [ext, TYPESCRIPT])),
  '.cs': CSHARP,
  '.py': PYTHON,
  '.pyi': PYTHON,
};

/**
 * One line as code, with string contents blanked, and comment. Lexical, one
 * line at a time: a string or block comment that spans lines is not tracked,
 * so a continuation line is read as code and a template literal can miss or
 * add a hit. A line starting with `*` is the middle of a block comment.
 */
function splitLine(text: string, language: Language): { code: string; comment: string } {
  if (language.blockComments && text.trimStart().startsWith('*')) return { code: '', comment: text };
  let code = '';
  let comment = '';
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === '\\') {
        code += '  ';
        index += 1;
      } else if (char === quote) {
        quote = null;
        code += char;
      } else {
        code += ' ';
      }
    } else if (language.quotes.includes(char)) {
      quote = char;
      code += char;
    } else if (text.startsWith(language.lineComment, index)) {
      comment += text.slice(index);
      break;
    } else if (language.blockComments && text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      comment += `${text.slice(index, end === -1 ? undefined : end + 2)} `;
      if (end === -1) break;
      index = end + 1;
    } else {
      code += char;
    }
  }
  return { code, comment };
}

function kindsIn(text: string, language: Language): TypeEscapeKind[] {
  const { code, comment } = splitLine(text, language);
  const kinds: TypeEscapeKind[] = [];
  for (const rule of language.rules) {
    if (rule.in === 'code' && language.skip?.test(code)) continue;
    const source = rule.in === 'code' ? code : comment;
    for (const match of source.matchAll(rule.pattern)) {
      if (rule.accept === undefined || rule.accept(match)) kinds.push(rule.kind);
    }
  }
  return kinds;
}

/**
 * Type-system escape hatches on the lines the diff adds to the given files,
 * per language by extension; any other extension gets none. At most 20 per
 * file, earliest first, sorted by path then line.
 */
export function findTypeEscapes(diff: string, paths: readonly string[]): TypeEscape[] {
  const found: TypeEscape[] = [];
  for (const hunk of countHunks(diff, new Set(paths))) {
    const language = LANGUAGES[extname(hunk.path).toLowerCase()];
    if (language === undefined) continue;
    for (const { line, text } of hunk.added) {
      for (const kind of kindsIn(text, language)) found.push({ path: hunk.path, line, kind });
    }
  }
  const byPathLineKind = (a: TypeEscape, b: TypeEscape): number => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  };
  found.sort(byPathLineKind);
  const perFile = new Map<string, number>();
  return found.filter((escape) => {
    const seen = perFile.get(escape.path) ?? 0;
    perFile.set(escape.path, seen + 1);
    return seen < MAX_PER_FILE;
  });
}
