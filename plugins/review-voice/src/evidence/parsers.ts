import { posix } from 'node:path';
import { redact } from '../redact/redact.ts';
import type { EvidenceSignal } from './types.ts';

/**
 * Adapters are thin parsers over tool output, not runners (docs/adr/0003).
 * Each maps a tool's diagnostic format onto attributable signals; anything
 * unrecognised is left alone rather than guessed at.
 */
export interface Adapter {
  name: string;
  /**
   * Chosen from the user's own label for the check plus the command they wrote,
   * falling back to the shape of the output. Matching on the command alone
   * misses `name: dotnet-build` pointing at a wrapper script, which is how
   * real projects are configured.
   */
  matches: (haystack: string, output: string) => boolean;
  /**
   * `root` is the directory the command ran in, for an adapter whose tool prints absolute paths.
   * `mask` is the issue 279 mask, for an adapter that changes the tool's text before returning it.
   */
  parse: (output: string, tool: string, root?: string, mask?: (text: string) => string) => EvidenceSignal[];
  /** The producing tool's name and version when the output itself states them. */
  version?: (output: string) => string | undefined;
}

function signal(
  tool: string,
  kind: string,
  path: string | null,
  line: number | null,
  claim: string,
  raw: string,
  // A compiler or type checker reporting a concrete diagnostic is about as
  // reliable as static evidence gets; it is still not a finding on its own.
  confidence = 0.95,
): EvidenceSignal {
  return {
    kind,
    path,
    line,
    claim,
    evidence: [raw.trim()],
    confidence,
    tool,
  };
}

/** The lead a SARIF producer's name suggests for the analyst's category; not a classification. */
type SarifKind = 'secret' | 'vulnerability' | 'sast_finding' | 'lint_error' | 'static_finding';

const SARIF_KINDS: ReadonlyArray<readonly [RegExp, SarifKind]> = [
  [/gitleaks/, 'secret'],
  [/trivy/, 'vulnerability'],
  [/semgrep|opengrep|codeql/, 'sast_finding'],
  [/ruff|golangci-lint/, 'lint_error'],
];

/** The part of SARIF 2.1.0 the adapter reads; every field may be missing or mistyped in a tool's output. */
interface SarifRule {
  id?: unknown;
  shortDescription?: { text?: unknown };
  defaultConfiguration?: { level?: unknown };
}
interface SarifResult {
  ruleId?: unknown;
  ruleIndex?: unknown;
  rule?: { id?: unknown; index?: unknown; toolComponent?: { index?: unknown } | null };
  level?: unknown;
  kind?: unknown;
  message?: { text?: unknown };
  locations?: unknown;
  suppressions?: unknown;
}
interface SarifRun {
  tool?: {
    driver?: { name?: unknown; version?: unknown; semanticVersion?: unknown; rules?: unknown };
    extensions?: unknown;
  };
  results?: unknown;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
// Only object entries: every list is dereferenced, and a null from a wrapper script must not end the review.
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value.filter((entry) => typeof entry === 'object' && entry !== null) as T[]) : []);
/** The object at a SARIF index, read from the raw array so a null entry from a wrapper script does not shift the index onto another. */
function indexed<T>(value: unknown, index: unknown): T | undefined {
  const entry: unknown = Array.isArray(value) && typeof index === 'number' ? value[index] : undefined;
  return typeof entry === 'object' && entry !== null ? (entry as T) : undefined;
}
const MAX_SARIF_MESSAGE_POINTS = 500;
const MAX_SARIF_RULE_POINTS = 200;

/**
 * The decoded document between the first `{` and the last `}`, since tools
 * print progress and warnings to stderr around it.
 * shortcut: a tool that prints a brace outside the document defeats the slice; the fix is quieting the tool, as the example configuration shows.
 */
function sarifDocument(output: string): { version?: unknown; $schema?: unknown; runs?: unknown } | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  try {
    return JSON.parse(output.slice(start, end + 1)) as { version?: unknown; $schema?: unknown; runs?: unknown };
  } catch {
    return undefined;
  }
}

/** Only a 2.1.0 document with `runs[]` yields; anything else the adapter claimed yields nothing. */
function sarifRuns(output: string): SarifRun[] | undefined {
  const document = sarifDocument(output);
  return document?.version === '2.1.0' && Array.isArray(document.runs) ? list<SarifRun>(document.runs) : undefined;
}

const SARIF_MARKER = /"version"\s*:\s*"2\.1\.0"|"\$schema"\s*:\s*"[^"]*sarif/i;

/**
 * Output that looks like SARIF anywhere is claimed, whether or not it parses,
 * and the decoded fields are read too, so an escaped key cannot hide a
 * document. A text adapter redacts nothing, so a partial or malformed
 * document reaching one would carry the tool's raw text, a matched secret
 * included, into the evidence.
 */
function isSarif(output: string): boolean {
  if (SARIF_MARKER.test(output)) return true;
  const document = sarifDocument(output);
  return document !== undefined && (document.version === '2.1.0' || /sarif/i.test(str(document.$schema) ?? ''));
}

/**
 * The seven tools emit paths relative to the directory they scanned, which
 * is the repository root when the command runs there, so `uriBaseId` is left
 * unresolved; ruff emits absolute `file:///` URIs, made relative under `root`.
 * The analyst reads the file a signal names, so under a root a path that
 * escapes it, or a URI naming another scheme or host, names no path at all.
 */
function sarifPath(uri: string, root: string | undefined): string | null {
  let path = uri;
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    const url = URL.canParse(uri) ? new URL(uri) : undefined;
    if (url?.protocol !== 'file:' || url.host !== '') return null;
    path = url.pathname;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape is left as printed; the analyst can still read it.
  }
  // Normalised after decoding, so an encoded dot segment is resolved, not kept.
  path = posix.normalize(path);
  if (root === undefined) return path;
  const relative = posix.relative(root, posix.resolve(root, path));
  return relative === '' || relative === '..' || relative.startsWith('../') ? null : relative;
}

function sarifSignals(output: string, tool: string, root: string | undefined, mask = (text: string): string => text): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];
  const seen = new Set<string>();
  for (const run of sarifRuns(output) ?? []) {
    const driver = run.tool?.driver;
    const driverName = (str(driver?.name) ?? '').toLowerCase();
    const kind = SARIF_KINDS.find(([pattern]) => pattern.test(driverName))?.[1] ?? 'static_finding';
    const rules = [
      ...list<SarifRule>(driver?.rules),
      ...list<{ rules?: unknown }>(run.tool?.extensions).flatMap((extension) => list<SarifRule>(extension.rules)),
    ];
    for (const result of list<SarifResult>(run.results)) {
      // The tool itself says a result that is not a failure, or one suppressed
      // in source, is not to be reported (nosemgrep and CodeQL's in-source
      // suppressions arrive with no status).
      if (result.kind !== undefined && result.kind !== 'fail') continue;
      if (list<{ status?: unknown }>(result.suppressions).some((entry) => entry.status === undefined || entry.status === 'accepted')) continue;
      // A result's index points into the driver's rules, or into those of the
      // extension `rule.toolComponent` names. SARIF lets two rules share an id
      // (3.19.23), so the reference decides before the id does.
      const reference = result.rule?.toolComponent;
      const component = reference === undefined || reference === null ? driver : indexed<{ rules?: unknown }>(run.tool?.extensions, reference.index);
      const referenced = indexed<SarifRule>(component?.rules, typeof result.ruleIndex === 'number' ? result.ruleIndex : result.rule?.index);
      const ruleId = str(result.ruleId) ?? str(result.rule?.id) ?? str(referenced?.id);
      if (ruleId === undefined) continue;
      // The id joins the claim, which becomes S08's one-line held reason, so a
      // run of whitespace, control or format characters becomes one space and
      // the id is capped. A rule author's id can carry a secret as a message
      // can, so it is masked and redacted before the cut, since a value changed
      // or cut no longer matches; redacted on both sides of the spacing, since a
      // control character can sit inside a quoted value or stand where a
      // header's space goes. The raw id still finds the rule.
      const spaced = redact(mask(ruleId)).text.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
      const id = [...redact(spaced).text].slice(0, MAX_SARIF_RULE_POINTS).join('').trimEnd();
      if (id === '') continue;
      const rule = referenced ?? rules.find((candidate) => candidate.id === ruleId);
      // The level defaults to the rule's, then to `warning`, the SARIF default.
      // Warnings are kept where the text adapters drop them: most semgrep rules
      // and trivy's MEDIUM arrive as warnings, and a signal is a lead the
      // analyst must still read, not a finding.
      const level = str(result.level) ?? str(rule?.defaultConfiguration?.level) ?? 'warning';
      if (level !== 'error' && level !== 'warning') continue;
      // A rule message may interpolate the matched text, which for a secrets
      // rule is the secret, so the tool's words are redacted before anything
      // keeps them. A passed-through value is masked first and a token
      // redacted before the cut, since a value changed or cut no longer
      // matches; trimmed after it, so claim and evidence carry one message.
      const text = str(result.message?.text) ?? str(rule?.shortDescription?.text);
      const message = text === undefined ? undefined : [...redact(mask(text).replace(/\s+/g, ' ').trim()).text].slice(0, MAX_SARIF_MESSAGE_POINTS).join('').trimEnd();
      const location = list<{ physicalLocation?: { artifactLocation?: { uri?: unknown }; region?: { startLine?: unknown } } }>(result.locations)[0]?.physicalLocation;
      const uri = str(location?.artifactLocation?.uri);
      const path = uri === undefined ? null : sarifPath(uri, root);
      const startLine = location?.region?.startLine;
      // A line means nothing without the file it is in.
      const line = path !== null && typeof startLine === 'number' && Number.isInteger(startLine) && startLine > 0 ? startLine : null;
      const claim = message === undefined || message === '' ? id : `${id}: ${message}`;
      // The same result can be repeated across runs, or within one; it is kept once.
      const key = `${path}\0${line}\0${claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Nothing decides on a signal's confidence today, so the number is informative only.
      signals.push(signal(tool, kind, path, line, claim, message === undefined || message === '' ? id : message, level === 'error' ? 0.95 : 0.8));
    }
  }
  return signals;
}

/** `src/a.ts(12,3): error TS2345: Argument of type ...` and the eslint-ish variant. */
const TSC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/** `a.py:12: error: Incompatible types` (mypy) and `a.py:12:3: F401 ...` (ruff). */
const PYTHON = /^(.+?):(\d+)(?::(\d+))?:\s+(error|warning|note|[A-Z]\d+)\s*:?\s*(.*)$/;

/** `Program.cs(12,3): error CS1002: ; expected [/path/proj.csproj]` */
const DOTNET = /^\s*(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s+(.*?)(?:\s+\[.*\])?$/;

export const ADAPTERS: Adapter[] = [
  {
    // First, because the per-tool adapters match on command text and a `ruff`
    // or `eslint` command may print SARIF; the command plays no part here, so
    // a wrapper script named anything is covered. Snippets, code flows, fixes,
    // fingerprints and properties are never copied, because a snippet is
    // repository content, and for a secrets scanner it is the secret itself.
    name: 'sarif',
    matches: (_command, output) => isSarif(output),
    parse: sarifSignals,
    // shortcut: matches, parse and version each parse the document, slow only for output near the 16 MB cap.
    version: (output) => {
      const driver = sarifRuns(output)?.[0]?.tool?.driver;
      const name = str(driver?.name);
      const version = str(driver?.version) ?? str(driver?.semanticVersion);
      return name === undefined || version === undefined ? undefined : `${name} ${version}`;
    },
  },
  {
    name: 'typescript',
    matches: (command, output) => /tsc|typecheck|tsgo/i.test(command) || TSC.test(output.split('\n')[0] ?? ''),
    parse: (output, tool) =>
      output
        .split('\n')
        .map((line) => TSC.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] === 'error')
        .map((match) =>
          signal(tool, 'type_error', match[1]!, Number(match[2]), `${match[5]}: ${match[6]}`, match[0]),
        ),
  },
  {
    name: 'dotnet',
    matches: (command) => /dotnet|msbuild|csc\b/i.test(command),
    parse: (output, tool) =>
      output
        .split('\n')
        .map((line) => DOTNET.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] === 'error')
        .map((match) =>
          signal(tool, 'compile_error', match[1]!, Number(match[2]), `${match[5]}: ${match[6]}`, match[0]),
        )
        // MSBuild repeats a diagnostic once per target that saw it.
        .filter((current, index, all) => all.findIndex((other) => other.claim === current.claim && other.path === current.path && other.line === current.line) === index),
  },
  {
    name: 'python',
    matches: (command) => /mypy|ruff|flake8|pylint|pytest/i.test(command),
    parse: (output, tool) =>
      output
        .split('\n')
        .map((line) => PYTHON.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] !== 'note')
        .map((match) =>
          signal(tool, 'lint_or_type_error', match[1]!, Number(match[2]), `${match[4]}: ${match[5]}`, match[0]),
        ),
  },
  {
    name: 'eslint',
    matches: (command) => /eslint|biome|oxlint/i.test(command),
    parse: (output, tool) => {
      const signals: EvidenceSignal[] = [];
      let file: string | null = null;
      for (const line of output.split('\n')) {
        // eslint's stylish formatter prints the file on its own line.
        if (/^\S.*\.(ts|tsx|js|jsx|mjs|cjs)$/.test(line.trim())) {
          file = line.trim();
          continue;
        }
        const match = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/.exec(line);
        if (match !== null && match[3] === 'error') {
          signals.push(signal(tool, 'lint_error', file, Number(match[1]), `${match[5]}: ${match[4]}`, line));
        }
      }
      return signals;
    },
  },
];

/**
 * Unrecognised output yields no signals rather than signals made up by
 * guesswork; the command's exit code is still recorded as evidence.
 */
export function parseOutput(
  name: string,
  command: string,
  output: string,
  root?: string,
  mask?: (text: string) => string,
): { signals: EvidenceSignal[]; version?: string } {
  const haystack = `${name} ${command}`;
  const adapter = ADAPTERS.find((candidate) => candidate.matches(haystack, output));
  if (adapter === undefined) return { signals: [] };
  const version = adapter.version?.(output);
  return { signals: adapter.parse(output, name, root, mask), ...(version === undefined ? {} : { version }) };
}
