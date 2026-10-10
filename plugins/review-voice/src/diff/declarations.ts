import { unquoteGitPath } from './hunks.ts';

export interface LexicalDeclaration {
  path: string;
  name: string;
  line: number;
  added: boolean;
}

const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';
const PREFIX = '(?:(?:export|default|declare|public|private|protected|static|abstract|override|readonly)\\s+)*';
const METHOD_PREFIX = '(?:(?:public|private|protected|internal|static|override|async|abstract|readonly|get|set)\\s+)*';
const TYPE = '[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*<[^>{}()]*>)?(?:\\s*\\[\\])?(?:\\?)?(?:\\s*\\.\\s*[A-Za-z_$][A-Za-z0-9_$]*)*';

const TS_FUNCTION = new RegExp(`^\\s*${PREFIX}(?:async\\s+)?function\\s+(${IDENTIFIER})\\s*\\(`);
const VARIABLE_FUNCTION = new RegExp(
  `^\\s*${PREFIX}(?:const|let|var)\\s+(${IDENTIFIER})(?:\\s*:\\s*[^=]+)?\\s*=\\s*(?:async\\b|function\\b|\\(|${IDENTIFIER}\\s*=>)`,
);
const PYTHON_FUNCTION = new RegExp(`^\\s*(?:async\\s+)?def\\s+(${IDENTIFIER})\\s*\\(`);
const GO_FUNCTION = new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s+)?(${IDENTIFIER})\\s*\\(`);
const RUST_FUNCTION = new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+(${IDENTIFIER})\\s*\\(`);
const MODIFIED_METHOD = new RegExp(
  `^\\s*(?:(?:public|private|protected|internal|static|override|async|fun)\\s+)+(?:${TYPE})\\s+(${IDENTIFIER})(?:\\s*<[^>{}()]*>)?\\s*\\(`,
);
const KOTLIN_FUNCTION = new RegExp(
  `^\\s*(?:(?:public|private|protected|internal|override|async|static)\\s+)*fun\\s+(?:<[^>{}()]*>\\s+)?(?:${TYPE}\\s*\\.\\s*)?(${IDENTIFIER})(?:\\s*<[^>{}()]*>)?\\s*\\(`,
);
const CLASS_METHOD = new RegExp(
  `^\\s+${METHOD_PREFIX}(${IDENTIFIER})(?:\\s*<[^>{}()]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^{}]+)?\\{`,
);

const STATEMENT_KEYWORDS = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'switch', 'case', 'catch', 'return',
  'throw', 'try', 'finally', 'do', 'break', 'continue', 'await', 'when', 'with',
  'match', 'loop', 'function', 'def', 'fn', 'class', 'interface', 'enum', 'new',
]);

const STOP_TOKENS = new Set([
  'to', 'from', 'get', 'set', 'is', 'has', 'do', 'make', 'create', 'build', 'new',
  'the', 'a', 'an', 'of', 'for', 'by', 'with', 'on', 'in', 'at', 'as', 'and', 'or',
  'util', 'utils', 'helper', 'helpers',
]);

/** The declaration name a single source line introduces, if it has one. */
export function declarationName(text: string): string | null {
  for (const pattern of [
    TS_FUNCTION,
    VARIABLE_FUNCTION,
    PYTHON_FUNCTION,
    GO_FUNCTION,
    RUST_FUNCTION,
    MODIFIED_METHOD,
    KOTLIN_FUNCTION,
  ]) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) return match[1];
  }

  const method = CLASS_METHOD.exec(text);
  const name = method?.[1];
  if (name === undefined || STATEMENT_KEYWORDS.has(name.toLowerCase())) return null;
  return name;
}

/** Meaningful name words for a duplicate-helper search and comparison. */
export function declarationTokens(name: string): string[] {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0 && !STOP_TOKENS.has(word));

  return [...new Set(words)];
}

/** The two most specific words to give git grep, or null for a generic name. */
export function declarationSearchTokens(name: string): [string, string] | null {
  const tokens = declarationTokens(name);
  if (tokens.length < 2) return null;
  const longest = tokens
    .map((token, index) => ({ token, index }))
    .sort((left, right) => right.token.length - left.token.length || left.index - right.index)
    .slice(0, 2);
  const first = longest[0]?.token;
  const second = longest[1]?.token;
  return first === undefined || second === undefined ? null : [first, second];
}

function normalisePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function headerPath(raw: string): string | null {
  const field = raw.startsWith('"') ? raw : (raw.split('\t', 1)[0] ?? raw);
  const path = unquoteGitPath(field.trimEnd());
  if (path === '/dev/null') return null;
  return normalisePath(path.replace(/^[ab]\//, ''));
}

interface ActiveHunk {
  oldLine: number;
  newLine: number;
  remainingOld: number;
  remainingNew: number;
}

function hunkHeader(line: string): ActiveHunk | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match === null) return null;
  const oldLine = Number(match[1]);
  const newLine = Number(match[3]);
  const remainingOld = Number(match[2] ?? 1);
  const remainingNew = Number(match[4] ?? 1);
  if (![oldLine, newLine, remainingOld, remainingNew].every(Number.isSafeInteger)) return null;
  return { oldLine, newLine, remainingOld, remainingNew };
}

/** Declarations on added and removed hunk lines, with their side's line number. */
export function declarationsFromDiff(diff: string): LexicalDeclaration[] {
  const found: LexicalDeclaration[] = [];
  let path: string | null = null;
  let active: ActiveHunk | null = null;

  const finishWhenCounted = () => {
    if (active !== null && active.remainingOld <= 0 && active.remainingNew <= 0) active = null;
  };

  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (active !== null) {
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith('+')) {
        const name = declarationName(line.slice(1));
        if (path !== null && name !== null) found.push({ path, name, line: active.newLine, added: true });
        active.newLine += 1;
        active.remainingNew -= 1;
        finishWhenCounted();
        continue;
      }
      if (line.startsWith('-')) {
        const name = declarationName(line.slice(1));
        if (path !== null && name !== null) found.push({ path, name, line: active.oldLine, added: false });
        active.oldLine += 1;
        active.remainingOld -= 1;
        finishWhenCounted();
        continue;
      }
      if (line.startsWith(' ') || (line === '' && active.remainingOld > 0 && active.remainingNew > 0)) {
        active.oldLine += 1;
        active.newLine += 1;
        active.remainingOld -= 1;
        active.remainingNew -= 1;
        finishWhenCounted();
        continue;
      }
      active = null;
    }

    if (line.startsWith('diff --git ')) {
      path = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      path = headerPath(line.slice(4));
      continue;
    }
    const header = hunkHeader(line);
    if (header !== null) active = header;
  }

  return found;
}
