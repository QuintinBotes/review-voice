import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { linguistGeneratedPaths } from '../diff/acquire.ts';
import { classify, firstPartyMatcher, type FirstParty } from '../diff/classify.ts';
import { parseHunks, patchRenames, type FileHunks } from '../diff/hunks.ts';
import { terminalSafe } from '../terminal.ts';
import { cleaner } from './parsers.ts';
import type { EvidenceReport, EvidenceSignal } from './types.ts';

type Row = Record<string, unknown>;
const clean = cleaner();
const MAX_ROWS = 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a report object.');
  return value as Row;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new Error('Expected an array of at most 1,000 entries.');
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('Missing or oversized evidence field.');
  return terminalSafe(clean(value));
}
function pathOf(value: unknown): string {
  const path = label(value);
  if (path !== value || /[:\\\x00-\x1f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid repository-relative evidence path.');
  return path;
}

function readArtifact(path: string): unknown {
  if (!isAbsolute(path)) throw new Error('The report path must be absolute.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Expected a regular comparison report of at most 4 MiB.');
    const data = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < data.length) {
      const count = readSync(fd, data, used, data.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used !== stat.size) throw new Error('The report changed while it was read.');
    return JSON.parse(data.toString('utf8', 0, used));
  } finally {
    closeSync(fd);
  }
}

interface Lead {
  kind: string;
  path: string;
  line: number;
  text: string;
  details: string[];
}
interface Context {
  hunks: Map<string, FileHunks>;
  firstParty: FirstParty;
  excluded: Set<string>;
  head: string;
  base: string;
  full: boolean;
  renames: Map<string, string>;
}

function api(change: Row, ctx: Context): Lead | null {
  if (change.level === 0 || change.level === 1) return null;
  if (change.level !== 2 && change.level !== 3) throw new Error('Unknown oasdiff level.');
  const old = !change.revisionSource;
  const source = row(change.revisionSource ?? change.baseSource);
  const ref = old ? ctx.base : ctx.head;
  const file = label(source.file);
  const locationPath = pathOf(file.startsWith(ref + ':') ? file.slice(ref.length + 1) : file);
  const path = old ? ctx.renames.get(locationPath) ?? locationPath : locationPath;
  const hunks = ctx.hunks.get(path);
  const line = old ? (ctx.full && positive(source.line) ? hunks?.removedToHead.get(source.line) : undefined) : source.line;
  if (!positive(line) || !(hunks?.added.has(line) || hunks?.deletionSites.has(line))) throw new Error('No changed head location for the API change.');
  return { kind: 'api_compatibility', path, line, text: label(change.text),
    details: [label(change.id), label(change.operation) + ' ' + label(change.path)] };
}

function clone(pair: Row, ctx: Context): Lead | null {
  if (pair.isNew === false) return null;
  if (pair.isNew !== true) throw new Error('Clone report lacks a baseline classification.');
  const ranges = [row(pair.firstFile), row(pair.secondFile)].map(location => {
    const path = pathOf(location.name);
    if (!positive(location.start) || !positive(location.end) || location.start > location.end) throw new Error('Invalid clone range.');
    return { path, start: location.start, end: location.end };
  });
  if (ranges.some(r => classify(r.path, ctx.firstParty) !== 'source' || ctx.excluded.has(r.path))) return null;
  for (const range of ranges) {
    const file = ctx.hunks.get(range.path);
    const line = file && [...file.added].find(n => n >= range.start && n <= range.end);
    if (line !== undefined) return { kind: 'introduced_clone', path: range.path, line,
      text: 'A new clone pair intersects this change.', details: ranges.map(r => r.path + ':' + r.start + '-' + r.end) };
  }
  return null;
}

function measurement(input: unknown) {
  const m = row(input);
  if (!Array.isArray(m.samples) || m.samples.length < 3 || m.samples.length > 100 || !m.samples.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    throw new Error('Each benchmark side needs 3–100 positive finite samples.');
  }
  const values = (m.samples as number[]).slice().sort((a,b) => a-b);
  const mid = Math.floor(values.length / 2);
  return { name: label(m.name), unit: label(m.unit), runner: label(m.runner), metric: label(m.metric),
    median: values.length % 2 ? values[mid]! : values[mid-1]! / 2 + values[mid]! / 2, values };
}

function benchmark(item: Row, ctx: Context): Lead | null {
  const base = measurement(item.base);
  const head = measurement(item.head);
  if (base.name !== head.name || base.runner !== head.runner || base.unit !== head.unit || base.metric !== head.metric) throw new Error('Benchmark name, metric, runner or units differ.');
  if (item.direction !== 'lower' && item.direction !== 'higher') throw new Error('Unknown benchmark direction.');
  const threshold = item.thresholdPercent;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) throw new Error('A positive regression threshold is required.');
  const lower = item.direction === 'lower';
  const degradation = (head.median / base.median - 1) * (lower ? 100 : -100);
  // A conservative noise screen, with no claim of statistical significance.
  if (degradation < threshold || (lower ? head.values[0]! <= base.values.at(-1)! : head.values.at(-1)! >= base.values[0]!)) return null;
  const text = base.name + ' regressed by ' + degradation.toFixed(2) + '% (' + base.metric + ').';
  if (!item.location) throw new Error(text + ' No source location supplied.');
  const at = row(item.location);
  const path = pathOf(at.path);
  if (!positive(at.line) || !ctx.hunks.get(path)?.added.has(at.line)) throw new Error(text + ' No changed source line at the reported location.');
  return { kind: 'performance_comparison', path, line: at.line, text,
    details: [JSON.stringify({ base: base.values, head: head.values, unit: base.unit, runner: base.runner, direction: item.direction, thresholdPercent: threshold })] };
}

export async function withComparisons(report: EvidenceReport, artifact: string, dir: string, firstPartyPaths: string[] = []) {
  const signals: EvidenceSignal[] = [];
  const notes: string[] = [];
  const provenance = { report: terminalSafe(clean(basename(artifact))).slice(0, 250), base: '', head: '' };
  try {
    const input = row(readArtifact(artifact));
    const files = JSON.parse(readFileSync(join(dir, 'files.json'), 'utf8'));
    const base = files.refs?.mergeBase ?? files.refs?.base?.sha;
    if (!['pull-request','base'].includes(files.mode) || !sha(input.base) || !sha(input.head) || input.base !== base || input.head !== files.head) throw new Error('Report does not match the reviewed base and head commits.');
    provenance.base = input.base;
    provenance.head = input.head;
    const patch = readFileSync(join(dir, 'diff.patch'), 'utf8');
    const ctx: Context = { hunks: parseHunks(patch), renames: patchRenames(patch), head: input.head, base: input.base, full: !files.scope || files.scope.kind === 'full',
      excluded: new Set(files.files.filter((f: Row) => !f.reviewed || f.class !== 'source').map((f: Row) => f.path)),
      firstParty: firstPartyMatcher(firstPartyPaths) };
    for (const value of rows(input.reports)) {
      const r = row(value);
      const format = r.format;
      const adapter = format === 'oasdiff' ? api : format === 'jscpd' ? clone : format === 'benchmark-v1' ? benchmark : null;
      if (!adapter || typeof format !== 'string') throw new Error('Unsupported comparison format.');
      const entries = rows(format === 'jscpd' ? row(r.data).duplicates : r.data);
      if (format === 'jscpd') {
        const paths = new Set<string>();
        for (const pair of entries) {
          const value = row(pair);
          if (value.isNew === true) for (const location of [value.firstFile, value.secondFile]) paths.add(pathOf(row(location).name));
        }
        const marked = await linguistGeneratedPaths(process.cwd(), [...paths], input.base);
        for (const path of marked) ctx.excluded.add(path);
      }
      for (const entry of entries) {
        try {
          const lead = adapter(row(entry), ctx);
          if (lead) signals.push({ kind: lead.kind, path: lead.path, line: lead.line, claim: lead.text,
            confidence: 1, tool: format, evidence: [provenance.report + ' ' + input.base + '..' + input.head, ...lead.details] });
        } catch (error) {
          if (notes.length < 20) notes.push(format + ': ' + (error instanceof Error ? error.message : 'Invalid entry.'));
        }
        if (signals.length >= 100) throw new Error('Comparison evidence stopped at 100 signals.');
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) notes.push('Invalid JSON in the comparison inputs.');
    else if (error instanceof Error && !('code' in error)) notes.push(error.message);
    else notes.push('Comparison report or diff inputs could not be read.');
  }
  return { ...report, signals: [...report.signals, ...signals], comparison: { ...provenance, notes: notes.map(s => terminalSafe(clean(s))) } };
}
