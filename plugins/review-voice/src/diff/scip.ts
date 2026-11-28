import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHunks } from './hunks.ts';
import { safeRepoPath } from './co-change.ts';
import { redact } from '../redact/redact.ts';

interface Location { path: string; line: number }
interface Definition extends Location { symbol: string; references: Location[] }
type Obj = Record<string, unknown>;
function object(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Malformed index.');
  return v as Obj;
}
function collection(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error('Malformed index collection.');
  return v;
}
function load(path: string) {
  if (!isAbsolute(path)) throw new Error('The index envelope must have an absolute path.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('SCIP input must be a regular file of at most 16 MiB.');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size) throw new Error('Index changed during the read.');
    return object(JSON.parse(bytes.toString('utf8', 0, offset)));
  } finally { closeSync(fd); }
}

function reversePatch(diff: string) {
  return diff.split('\n').map(line => {
    if (line.startsWith('--- ')) return '+++' + line.slice(3);
    if (line.startsWith('+++ ')) return '---' + line.slice(3);
    if (line.startsWith('+')) return '-' + line.slice(1);
    if (line.startsWith('-')) return '+' + line.slice(1);
    return line.replace(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/, '@@ -$2 +$1 @@');
  }).join('\n');
}

function startLine(o: Obj): number {
  // Go's encoding/json exposes the generated oneof wrapper. Also accept the
  // canonical protobuf JSON spelling used by other producers.
  const typed = o.TypedRange ? object(o.TypedRange) : o;
  const selected = typed.SingleLineRange ?? typed.MultiLineRange ?? typed.singleLineRange ?? typed.multiLineRange;
  const value = selected ? (object(selected).start_line ?? object(selected).startLine ?? 0) : Array.isArray(o.range) ? o.range[0] : undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid SCIP source range.');
  return value + 1;
}

export function scipContext(path: string, repository: string | null, base: string | null, head: string | null, diff: string, deadline: number) {
  const notes: string[] = [];
  const indexes: { revision: string; side: string; documents: number; definitions: Definition[] }[] = [];
  const checkTime = () => { if (Date.now() >= deadline) throw new Error('SCIP time budget exhausted.'); };
  try {
    checkTime();
    const envelope = load(path);
    if (!repository || typeof envelope.repository !== 'string' || envelope.repository.toLowerCase() !== repository.toLowerCase()) throw new Error('Index repository does not match the review.');
    const index = object(envelope.index);
    const metadata = object(index.metadata);
    const root = metadata.project_root ?? metadata.projectRoot;
    if (typeof root !== 'string' || typeof envelope.repositoryRoot !== 'string') throw new Error('Missing producer root metadata.');
    const prefix = posix.relative(fileURLToPath(envelope.repositoryRoot), fileURLToPath(root));
    if (prefix && !safeRepoPath(prefix)) throw new Error('SCIP project root is outside the producer repository.');
    const revision = envelope.revision;
    if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision) || (revision !== head && revision !== base)) throw new Error('Index revision does not match a reviewed side.');
    const side = revision === head ? 'head' : 'base';
    const hunks = parseHunks(side === 'head' ? diff : reversePatch(diff));
    const docs = collection(index.documents);
    const wanted = new Map<string, Definition[]>();
    const seen = new Set<string>();
    let total = 0;
    for (const definitions of [true, false]) {
      for (const raw of docs) {
        checkTime();
        const d = object(raw);
        const relative = d.relative_path ?? d.relativePath;
        if (typeof relative !== 'string' || !safeRepoPath(relative)) throw new Error('Invalid SCIP document path.');
        const file = prefix ? prefix + '/' + relative : relative;
        seen.add(file);
        const added = hunks.get(file)?.added;
        if (definitions && !added?.size) continue;
        for (const rawOccurrence of collection(d.occurrences ?? [])) {
          checkTime();
          const o = object(rawOccurrence);
          const roles = o.symbol_roles ?? o.symbolRoles ?? 0;
          if (typeof roles !== 'number' || !Number.isSafeInteger(roles)) throw new Error('Invalid SCIP symbol roles.');
          if (((roles & 1) !== 0) !== definitions || typeof o.symbol !== 'string' || !o.symbol) continue;
          const key = o.symbol.startsWith('local ') ? file + '\0' + o.symbol : o.symbol;
          if (!definitions && !wanted.has(key)) continue;
          const line = startLine(o);
          if (definitions && added!.has(line)) {
            if (++total > 100 || o.symbol.length > 2048) throw new Error('SCIP definition budget exhausted.');
            const list = wanted.get(key) ?? [];
            list.push({ path: file, line, symbol: redact(o.symbol).text, references: [] });
            wanted.set(key, list);
          } else if (!definitions) {
            for (const def of wanted.get(key)!) {
              if (def.references.length === 20) { if (!notes.includes('Reference list truncated.')) notes.push('Reference list truncated.'); continue; }
              def.references.push({ path: file, line });
            }
          }
        }
      }
    }
    if ([...hunks].some(([file,h]) => h.added.size && !seen.has(file))) notes.push('Some changed files are outside the index.');
    if (!wanted.size) notes.push('No indexed definition matched a changed line.');
    indexes.push({ revision, side, documents: seen.size, definitions: [...wanted.values()].flat() });
  } catch (error) {
    const systemError = error instanceof Error && 'code' in error;
    notes.push(systemError ? 'The local index could not be read.' : error instanceof SyntaxError ? 'Invalid index JSON.' : error instanceof Error ? error.message : 'Index unavailable.');
  }
  return { source: 'SCIP', coverage: 'indexed documents only', indexes, notes };
}
