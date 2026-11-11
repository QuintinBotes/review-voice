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
   * `clean` masks and redacts (issue 279), for an adapter that reads or changes the tool's text before returning it.
   */
  parse: (output: string, tool: string, root?: string, clean?: (text: string) => string) => EvidenceSignal[];
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
  messageStrings?: unknown;
}
interface SarifResult {
  ruleId?: unknown;
  ruleIndex?: unknown;
  rule?: { id?: unknown; index?: unknown; toolComponent?: { index?: unknown; guid?: unknown } | null };
  level?: unknown;
  kind?: unknown;
  message?: { text?: unknown; id?: unknown; arguments?: unknown };
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
  artifacts?: unknown;
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
/** As many UTF-16 units as one stream of a command's output can hold in bytes (`spawnInGroup`). */
const MAX_COMPOSED_UNITS = 16 * 1024 * 1024;
/** How many times its own length an output may compose from referenced messages. */
const COMPOSED_PER_UNIT = 8;

/**
 * The first `points` code points of `text`, so a surrogate pair is never
 * split. Text that may hold a secret is cut only once masked and redacted
 * whole, since a secret the cut splits no longer matches its pattern.
 */
export function cut(text: string, points: number): string {
  // Cut by UTF-16 unit first so a long output is never spread whole; the points kept fit in twice as many units.
  return [...text.slice(0, 2 * points)].slice(0, points).join('');
}

/**
 * `fn` computed once for each distinct text, since many results can share one
 * rule or file, whose text would otherwise be redacted whole for each.
 * shortcut: V8 hashes a string past 16383 characters by its length alone, so some thousand distinct texts that long and of one length, which only a document near the output cap can hold, are each compared with the others and take seconds; key them by a digest if that is ever seen.
 */
export function memo<T>(fn: (text: string) => T): (text: string) => T {
  const done = new Map<string, T>();
  return (text) => {
    if (!done.has(text)) done.set(text, fn(text));
    return done.get(text) as T;
  };
}

/** What masking or redaction leaves where it replaced text. */
const MARKER = /\[(?:REDACTED|redacted):\w*\]/g;

/** A part of a text that cleaning replaced, and the marker that stands for it. */
export interface Replaced {
  start: number;
  end: number;
  marker: string;
}

/**
 * Where `needle` first starts in `text` at or after `from`, or -1, in linear
 * time (Knuth, Morris and Pratt), since `indexOf` compares a repetitive needle
 * again at each position and the text is the pull request's to shape.
 */
function found(text: string, needle: string, from: number): number {
  if (needle === '') return from;
  // Entry i is the length of the longest start of the needle that also ends its first i characters.
  const borders = new Int32Array(needle.length + 1);
  borders[0] = -1;
  for (let index = 0, border = -1; index < needle.length; ) {
    while (border >= 0 && needle.charCodeAt(index) !== needle.charCodeAt(border)) border = borders[border]!;
    index += 1;
    border += 1;
    borders[index] = border;
  }
  for (let index = from, matched = 0; index < text.length; index += 1) {
    while (matched >= 0 && text.charCodeAt(index) !== needle.charCodeAt(matched)) matched = borders[matched]!;
    matched += 1;
    if (matched === needle.length) return index + 1 - matched;
  }
  return -1;
}

/**
 * The parts of `text` that `version` replaced with a marker, where `version`
 * is the text as masking or redaction left it. What the version keeps between
 * two markers is placed where it first fits, which need not be where it
 * stood. Any placement that accounts for the version replaces all the version
 * did not keep, and that is what a caller relies on. A version that is not the
 * text with parts replaced, which neither makes, loses the rest of the text.
 */
export function replaced(text: string, version: string): Replaced[] {
  if (version === text) return [];
  const spans: Replaced[] = [];
  let end = 0;
  let read = 0;
  let marker = '';
  for (const next of [...version.matchAll(MARKER), undefined]) {
    const kept = version.slice(read, next?.index);
    // The first stretch kept starts the text and the last ends it; one between them is searched for.
    const start = next === undefined ? Math.max(end, text.length - kept.length) : read === 0 ? 0 : found(text, kept, end);
    const fits = start !== -1 && (read > 0 || start === 0) && text.startsWith(kept, start);
    if (read > 0 || !fits) spans.push({ start: end, end: fits ? start : text.length, marker });
    if (!fits || next === undefined) break;
    end = start + kept.length;
    marker = next[0];
    read = next.index + marker.length;
  }
  return spans;
}

/**
 * The text with every part replaced that masking or redaction replaces in it
 * as printed (issue 279). One after the other loses a secret either way. A
 * mask takes the scheme or keyword a pattern needs, so the password beside
 * it stays, and a redaction splits a listed value, so the rest of it stays.
 * Parts that overlap become one, under the marker of the one that starts first.
 */
export function cleaner(mask: (text: string) => string = (text) => text): (text: string) => string {
  return (text) => {
    const masked = mask(text);
    const redacted = redact(text).text;
    if (masked === text) return redacted;
    if (redacted === text) return masked;
    let cleaned = '';
    let copied = 0;
    // The sort is stable, so of two parts starting together the mask names the value.
    for (const part of [...replaced(text, masked), ...replaced(text, redacted)].sort((a, b) => a.start - b.start)) {
      if (part.start >= copied) cleaned += text.slice(copied, part.start) + part.marker;
      copied = Math.max(copied, part.end);
    }
    return cleaned + text.slice(copied);
  };
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
 * A URI names none either when masking or redaction would change any form the
 * path is built from, which are the URI and the pathname URL parsing leaves
 * of it (dropping a query and a fragment, stripping tabs and newlines and
 * turning a backslash into a slash), each as printed and decoded. They are
 * checked before normalising, which can split what a mask or a pattern finds.
 * Such a URI gives `undefined`, not `null`: its file is one the tool named, so
 * its results are not those of another file, which results with no path are.
 */
function sarifPath(uri: string, root: string | undefined, changes: (text: string) => boolean): string | null | undefined {
  let path = uri;
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    const url = URL.canParse(uri) ? new URL(uri) : undefined;
    if (url?.protocol !== 'file:' || url.host !== '') return null;
    path = url.pathname;
  }
  const plain = decoded(path);
  // A relative uri is its own pathname, so it is decoded and checked once.
  if ([...new Set(path === uri ? [uri, plain] : [uri, decoded(uri), path, plain])].some(changes)) return undefined;
  // Normalised after decoding, so an encoded dot segment is resolved, not kept.
  path = normalised(plain);
  if (root === undefined) return path;
  const relative = posix.relative(root, posix.resolve(root, path));
  return relative === '' || relative === '..' || relative.startsWith('../') ? null : relative;
}

/**
 * What `posix.normalize` returns, in one pass over the segments, since that
 * takes quadratic time on a run of dot-dot segments and a uri can be as long
 * as the output.
 */
function normalised(path: string): string {
  const absolute = path.startsWith('/');
  const kept: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') kept.push(segment);
    else if (kept.length > 0 && kept.at(-1) !== '..') kept.pop();
    else if (!absolute) kept.push('..');
  }
  const joined = kept.join('/');
  const slash = path.endsWith('/') ? '/' : '';
  if (absolute) return joined === '' ? '/' : `/${joined}${slash}`;
  return `${joined === '' ? '.' : joined}${slash}`;
}

/**
 * Each run of escapes decoded on its own, and in a run that is not UTF-8 each
 * ASCII escape, so one malformed escape leaves the rest decoded rather than
 * keeping what they spell from the check. What is left stays as printed,
 * which the analyst can still read.
 */
function decoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    // Bytes that are UTF-8 are the ones their text encodes back to. Not decodeURIComponent, whose throw for each run that is not UTF-8 took seconds over a uri of many.
    const bytes = Buffer.from(run.replaceAll('%', ''), 'hex');
    const utf8 = bytes.toString('utf8');
    return Buffer.from(utf8, 'utf8').equals(bytes) ? utf8 : run.replace(/%[0-7][0-9a-f]/gi, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
  });
}

function sarifSignals(output: string, tool: string, root: string | undefined, cleaned = cleaner()): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];
  const seen = new Set<string>();
  // The id joins the claim, which becomes S08's one-line held reason, so a
  // run of whitespace, control or format characters becomes one space and
  // the id is capped. A rule author's id can carry a secret as a message
  // can, so it is masked and redacted whole before the cut, since a value
  // changed or cut no longer matches; on both sides of the spacing, since a
  // control character can sit inside a quoted value or stand where a
  // header's space goes. Once for each distinct id, since many results name
  // one rule.
  const sanitisedId = memo((ruleId) => cut(cleaned(cleaned(ruleId).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()), MAX_SARIF_RULE_POINTS).trimEnd());
  // A rule message may interpolate the matched text, which for a secrets
  // rule is the secret, so the tool's words are masked and redacted before
  // anything keeps them: whole and before the cut, since a value changed or
  // cut no longer matches, and on both sides of the collapsing, since a tool
  // can wrap a value across lines; text the collapsing leaves as it was is
  // not cleaned twice. Trimmed after the cut, so claim and evidence carry
  // one message.
  const sanitisedMessage = (text: string, first = cleaned(text)): string => {
    const spaced = first.replace(/\s+/g, ' ').trim();
    return cut(spaced === first ? first : cleaned(spaced), MAX_SARIF_MESSAGE_POINTS).trimEnd();
  };
  // Once for each rule description and each uri, which many results share.
  const described = memo((text) => sanitisedMessage(text));
  // The key that tells repeated results apart holds a place's number, not its
  // path, since results that share an artifact share a path of any length,
  // and a set of long keys of one length compares each with the others in full.
  // Results with no path share a place, as the same result repeated does. A
  // uri dropped for what it carries is a place of its own, since dropping the
  // paths of results in different files must not make them one result.
  const numbers = new Map<string | null, number>([[null, 0]]);
  let dropped = 0;
  const placeOf = memo((uri): { path: string | null; place: number } => {
    const path = sarifPath(uri, root, (text) => cleaned(text) !== text);
    if (path === undefined) return { path: null, place: (dropped -= 1) };
    if (!numbers.has(path)) numbers.set(path, numbers.size);
    return { path, place: numbers.get(path) as number };
  });
  // A referenced message is composed and cleaned whole, once for each message
  // string and the arguments given it, since results often share both. What
  // one output composes is held to a few times its own length, and to the
  // most one stream of a command's output can hold, so referenced messages
  // cost about what inline ones in an output of that length do, and a short
  // document cannot repeat a placeholder into a long one; a reference past
  // that falls back as one that does not resolve. What redaction adds to a
  // message counts too, since the longer text is then cleaned again.
  // shortcut: a document whose distinct referenced messages compose to more than eight times its length loses the later ones to the rule description; raise the factor if a real tool writes one.
  let room = Math.min(MAX_COMPOSED_UNITS, COMPOSED_PER_UNIT * output.length);
  const composed = (parts: string[], length: number, values: unknown): string | undefined => {
    if (length > room) return undefined;
    // Charged before it is joined, since joining it is work even when its text does not fit.
    room -= length;
    let text = '';
    for (const [index, part] of parts.entries()) {
      if (index % 2 === 0) text += part;
      else if (part === '{{' || part === '}}') text += part.charAt(0);
      else {
        const value: unknown = Array.isArray(values) ? values[Number(part.slice(1, -1))] : undefined;
        text += typeof value === 'string' ? value : part;
      }
      if (text.length - length > room) return undefined;
    }
    const first = cleaned(text);
    room -= Math.max(0, text.length - length) + Math.max(0, first.length - text.length);
    return sanitisedMessage(text, first);
  };
  // By the message string object, not its text, so a long template is neither hashed nor compared.
  const strings = new Map<object, { parts: string[]; messages: Map<string, string | undefined> }>();
  const composedFrom = (entry: { text?: unknown }, values: unknown): string | undefined => {
    const template = str(entry.text);
    if (template === undefined) return undefined;
    let known = strings.get(entry);
    if (known === undefined) {
      // {n} takes the nth argument when it is a string; {{ and }} are literal braces (3.11.5).
      known = { parts: template.split(/(\{\{|\}\}|\{\d+\})/), messages: new Map() };
      strings.set(entry, known);
    }
    // Keyed by the arguments that are strings, the only ones a placeholder takes, so one nested however deep is not walked.
    const key = Array.isArray(values) ? JSON.stringify(values.map(str)) : '';
    if (!known.messages.has(key)) known.messages.set(key, composed(known.parts, template.length, values));
    return known.messages.get(key);
  };
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
      // The raw id still finds the rule.
      const id = sanitisedId(ruleId);
      if (id === '') continue;
      // An id the reference gives is looked up in the component it names, then anywhere.
      const rule = referenced ?? idsOf.get(component)?.get(ruleId) ?? byId.get(ruleId);
      // The level defaults to the rule's, then to `warning`, the SARIF default.
      // Warnings are kept where the text adapters drop them: most semgrep rules
      // and trivy's MEDIUM arrive as warnings, and a signal is a lead the
      // analyst must still read, not a finding.
      const level = str(result.level) ?? str(rule?.defaultConfiguration?.level) ?? 'warning';
      if (level !== 'error' && level !== 'warning') continue;
      // The message is the result's text, else the rule's message string its
      // id names, filled with its arguments (3.11), else the rule description.
      const messageId = result.message?.id;
      const messageStrings = rule?.messageStrings;
      const entry: unknown = typeof messageId === 'string' && typeof messageStrings === 'object' && messageStrings !== null && Object.hasOwn(messageStrings, messageId)
        ? (messageStrings as Record<string, unknown>)[messageId]
        : undefined;
      const text = str(result.message?.text);
      const description = str(rule?.shortDescription?.text);
      const message = text !== undefined
        ? sanitisedMessage(text)
        : (typeof entry === 'object' && entry !== null ? composedFrom(entry, result.message?.arguments) : undefined) ?? (description === undefined ? undefined : described(description));
      const location = list<{ physicalLocation?: { artifactLocation?: { uri?: unknown; index?: unknown }; region?: { startLine?: unknown } } }>(result.locations)[0]?.physicalLocation;
      const artifact = location?.artifactLocation;
      // A location may give only the index of the run's artifact that names the file (3.4.5).
      const uri = str(artifact?.uri === undefined ? indexed<{ location?: { uri?: unknown } }>(run.artifacts, artifact?.index)?.location?.uri : artifact.uri);
      const { path, place } = uri === undefined ? { path: null, place: 0 } : placeOf(uri);
      const startLine = location?.region?.startLine;
      // A line means nothing without the file it is in.
      const line = path !== null && typeof startLine === 'number' && Number.isInteger(startLine) && startLine > 0 ? startLine : null;
      const claim = message === undefined || message === '' ? id : `${id}: ${message}`;
      // The same result can be repeated across runs, or within one; it is kept once.
      const key = `${place}\0${line}\0${claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Nothing decides on a signal's confidence today, so the number is informative only.
      signals.push(signal(tool, kind, path, line, claim, message === undefined || message === '' ? id : message, level === 'error' ? 0.95 : 0.8));
    }
  }
  return signals;
}

/** `src/a.ts(12,3): error TS2345: Argument of type ...` and the eslint-ish variant. */
const TSC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/d;

/** `a.py:12: error: Incompatible types` (mypy) and `a.py:12:3: F401 ...` (ruff). */
const PYTHON = /^(.+?):(\d+)(?::(\d+))?:\s+(error|warning|note|[A-Z]\d+)\s*:?\s*(.*)$/d;

/**
 * `Program.cs(12,3): error CS1002: ; expected [/path/proj.csproj]`. A mask or
 * redaction marker is bracketed as the project suffix is, and a claim is read
 * from the line once cleaned, so the suffix is a bracket that opens no marker.
 */
const DOTNET = /^\s*(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s+(.*?)(?:\s+\[(?!REDACTED:|redacted:).*\])?$/d;

/** `  12:3  error  'x' is defined but never used  no-unused-vars`, under a line naming the file. */
const ESLINT = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/d;

/**
 * A text adapter's claim, and whether its position holds, read from its line
 * once masked and redacted. The claim joins the line's parts in another order
 * or with another separator, which can split a secret so that cleaning the
 * claim finds nothing. A cleaned line that no longer parses is the claim as
 * it reads. The position is the pattern's first two groups, and it holds only
 * when cleaning leaves the line as printed up to the end of the second, since
 * a secret or a listed value can run from the path into the line number or
 * the text after it, and the path alone then shows nothing to drop it for.
 * `match` is the pattern's match of the whole line; a line that cleaning
 * leaves as printed is not matched again, which would double a slow pattern.
 */
function reads(pattern: RegExp, claim: (match: RegExpExecArray) => string, clean = cleaner()): (match: RegExpExecArray) => { claim: string; holds: boolean } {
  return (match) => {
    const cleaned = clean(match[0]);
    const again = cleaned === match[0] ? match : pattern.exec(cleaned);
    return { claim: again === null ? cleaned.trim() : claim(again), holds: cleaned.startsWith(match[0].slice(0, match.indices?.[2]?.[1])) };
  };
}

/** The signal of a line that starts with a path and a line number, which go together when the position does not hold. */
function positioned(tool: string, kind: string, read: ReturnType<typeof reads>): (match: RegExpExecArray) => EvidenceSignal {
  return (match) => {
    const { claim, holds } = read(match);
    return signal(tool, kind, holds ? match[1]! : null, holds ? Number(match[2]) : null, claim, match[0]);
  };
}

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
    parse: (output, tool, _root, clean) => {
      const toSignal = positioned(tool, 'type_error', reads(TSC, (match) => `${match[5]}: ${match[6]}`, clean));
      return output
        .split('\n')
        .map((line) => TSC.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] === 'error')
        .map(toSignal);
    },
  },
  {
    name: 'dotnet',
    matches: (command) => /dotnet|msbuild|csc\b/i.test(command),
    parse: (output, tool, _root, clean) => {
      const toSignal = positioned(tool, 'compile_error', reads(DOTNET, (match) => `${match[5]}: ${match[6]}`, clean));
      return output
        .split('\n')
        .map((line) => DOTNET.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] === 'error')
        .map((match) => ({ match, kept: toSignal(match) }))
        // MSBuild repeats a diagnostic once per target that saw it. The position is compared as printed, since two that lost theirs are not one repeated.
        .filter((current, index, all) => all.findIndex((other) => other.kept.claim === current.kept.claim && other.match[1] === current.match[1] && other.match[2] === current.match[2]) === index)
        .map(({ kept }) => kept);
    },
  },
  {
    name: 'python',
    matches: (command) => /mypy|ruff|flake8|pylint|pytest/i.test(command),
    parse: (output, tool, _root, clean) => {
      const toSignal = positioned(tool, 'lint_or_type_error', reads(PYTHON, (match) => `${match[4]}: ${match[5]}`, clean));
      return output
        .split('\n')
        .map((line) => PYTHON.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] !== 'note')
        .map(toSignal);
    },
  },
  {
    name: 'eslint',
    matches: (command) => /eslint|biome|oxlint/i.test(command),
    parse: (output, tool, _root, clean) => {
      const read = reads(ESLINT, (match) => `${match[5]}: ${match[4]}`, clean);
      const signals: EvidenceSignal[] = [];
      let file: string | null = null;
      for (const line of output.split('\n')) {
        // eslint's stylish formatter prints the file on its own line.
        if (/^\S.*\.(ts|tsx|js|jsx|mjs|cjs)$/.test(line.trim())) {
          file = line.trim();
          continue;
        }
        const match = ESLINT.exec(line);
        if (match !== null && match[3] === 'error') {
          // The position here is the line and column; the file was printed on a line of its own.
          const { claim, holds } = read(match);
          signals.push(signal(tool, 'lint_error', file, holds ? Number(match[1]) : null, claim, line));
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
  clean?: (text: string) => string,
): { signals: EvidenceSignal[]; version?: string } {
  const haystack = `${name} ${command}`;
  const adapter = ADAPTERS.find((candidate) => candidate.matches(haystack, output));
  if (adapter === undefined) return { signals: [] };
  const version = adapter.version?.(output);
  return { signals: adapter.parse(output, name, root, clean), ...(version === undefined ? {} : { version }) };
}
