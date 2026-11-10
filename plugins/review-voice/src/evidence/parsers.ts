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
  rule?: { id?: unknown; index?: unknown; toolComponent?: { index?: unknown; guid?: unknown } | null };
  level?: unknown;
  kind?: unknown;
  message?: { text?: unknown };
  locations?: unknown;
  suppressions?: unknown;
}
interface SarifComponent {
  guid?: unknown;
  rules?: unknown;
}
interface SarifRun {
  tool?: {
    driver?: SarifComponent & { name?: unknown; version?: unknown; semanticVersion?: unknown };
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
 * Far above every later cut and a PEM-encoded 4096-bit key, so a secret a
 * later cut would split is still redacted whole, while one secret pattern,
 * which backtracks quadratically over a long run of URL-scheme characters,
 * stays fast on output a pull request controls.
 */
const MAX_REDACTED_POINTS = 4096;

/** The text cut to MAX_REDACTED_POINTS code points, then redacted. */
export function redactBounded(text: string): string {
  // Cut by UTF-16 unit first so a long output is never spread whole; the points kept fit in twice as many units.
  return redact([...text.slice(0, 2 * MAX_REDACTED_POINTS)].slice(0, MAX_REDACTED_POINTS).join('')).text;
}

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

const SARIF_SCHEMA = /"\$schema"\s*:\s*"[^"]*sarif/i;
const SARIF_VERSION = /"version"\s*:\s*"2\.1\.0"/;
const SARIF_RUNS = /"runs"\s*:/;

/**
 * Output is claimed when it is a SARIF document, decoded or in its text,
 * which means a SARIF `$schema`, or a 2.1.0 version beside a `runs` key. A version string
 * alone is not one, so a text diagnostic printed beside it keeps its adapter.
 * The text is read with its `\u00XX` escapes decoded, since a writer may
 * escape any character of a key, and it is read as well as the parse because
 * noise around a document can defeat the slice.
 * shortcut: a mangled document that neither test recognises reaches a text adapter, which may invent a diagnostic from one of its lines (redacted where signals enter the report, so a false lead, not a leak); upgrade if a real tool's output is seen doing it.
 */
function isSarif(output: string): boolean {
  const document = sarifDocument(output);
  if (document !== undefined && ((document.version === '2.1.0' && 'runs' in document) || /sarif/i.test(str(document.$schema) ?? ''))) return true;
  const text = output.replace(/\\u00([0-7][0-9a-f])/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return SARIF_SCHEMA.test(text) || (SARIF_VERSION.test(text) && SARIF_RUNS.test(text));
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
    const extensions = list<SarifComponent>(run.tool?.extensions);
    // Built once per run, since a scan per result is quadratic in a large
    // document; the first entry with a key wins, as a scan in order finds it.
    // Each component's rules by id, and every rule by id, driver first.
    const byGuid = new Map<unknown, SarifComponent | undefined>();
    const idsOf = new Map<SarifComponent | undefined, Map<unknown, SarifRule>>();
    const byId = new Map<unknown, SarifRule>();
    for (const component of [driver, ...extensions]) {
      if (!byGuid.has(component?.guid)) byGuid.set(component?.guid, component);
      const ids = new Map<unknown, SarifRule>();
      for (const rule of list<SarifRule>(component?.rules)) {
        if (!ids.has(rule.id)) ids.set(rule.id, rule);
        if (!byId.has(rule.id)) byId.set(rule.id, rule);
      }
      idsOf.set(component, ids);
    }
    for (const result of list<SarifResult>(run.results)) {
      // The tool itself says a result that is not a failure, or one suppressed
      // in source, is not to be reported (nosemgrep and CodeQL's in-source
      // suppressions arrive with no status).
      if (result.kind !== undefined && result.kind !== 'fail') continue;
      if (list<{ status?: unknown }>(result.suppressions).some((entry) => entry.status === undefined || entry.status === 'accepted')) continue;
      // A result's index points into the rules of the component its reference
      // names, which is an extension by index, else the driver or extension
      // with the given guid, else the driver (3.54). SARIF lets two rules share an id
      // (3.19.23), so the reference decides before the id does.
      const reference = result.rule?.toolComponent;
      const componentIndex = reference?.index;
      const guid = str(reference?.guid);
      const component = typeof componentIndex === 'number' && Number.isInteger(componentIndex) && componentIndex >= 0
        ? indexed<SarifComponent>(run.tool?.extensions, componentIndex)
        : guid === undefined ? driver : byGuid.get(guid);
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
      const spaced = redactBounded(mask(ruleId)).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
      const id = [...redactBounded(spaced)].slice(0, MAX_SARIF_RULE_POINTS).join('').trimEnd();
      if (id === '') continue;
      // An id the reference gives is looked up in the component it names, then anywhere.
      const rule = referenced ?? idsOf.get(component)?.get(ruleId) ?? byId.get(ruleId);
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
      const message = text === undefined ? undefined : [...redactBounded(mask(text).replace(/\s+/g, ' ').trim())].slice(0, MAX_SARIF_MESSAGE_POINTS).join('').trimEnd();
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
