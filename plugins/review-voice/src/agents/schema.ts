import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { AgentSpecError } from './tools.ts';

interface Context {
  baseDir: string;
  /** The directory a relative file `$ref` resolves against. */
  dir: string;
  /** The document a `#/...` ref points into. */
  document: unknown;
  /** True inside a file pulled in by `$ref`, whose own `#/...` refs would point at the wrong root. */
  inlined: boolean;
  /** The file refs being expanded, to catch a cycle. */
  stack: string[];
}

/**
 * The schema as `claude --json-schema` accepts it (docs/adr/0021): its
 * validator knows no `$schema` meta-schema URL and cannot load sibling files,
 * so `$schema` and `$id` are dropped and each relative file `$ref` is inlined.
 * Anything it could not resolve is refused here rather than by claude.
 */
export function schemaForRunner(schema: object, baseDir: string): object {
  const base = resolve(baseDir);
  const prepared = prepare(schema, { baseDir: base, dir: base, document: schema, inlined: false, stack: [] });
  return prepared as object;
}

function prepare(node: unknown, ctx: Context): unknown {
  if (Array.isArray(node)) return node.map((item) => prepare(item, ctx));
  if (node === null || typeof node !== 'object') return node;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$schema' || key === '$id' || key === '$ref') continue;
    // Defined, not assigned: a `__proto__` key must stay data, not swap the prototype.
    Object.defineProperty(rest, key, { value: prepare(value, ctx), enumerable: true, writable: true, configurable: true });
  }
  const ref = (node as Record<string, unknown>)['$ref'];
  if (ref === undefined) return rest;
  if (typeof ref !== 'string') throw new AgentSpecError('A schema $ref must be a string');
  if (ref.startsWith('#')) {
    checkInternalRef(ref, ctx);
    return { $ref: ref, ...rest };
  }
  const target = resolveFileRef(ref, ctx);
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new AgentSpecError(`Schema $ref ${ref} does not point at a schema object`);
  }
  return { ...(target as Record<string, unknown>), ...rest };
}

function checkInternalRef(ref: string, ctx: Context): void {
  if (ctx.inlined) {
    throw new AgentSpecError(`Schema $ref ${ref} sits in a referenced file and cannot be kept once it is inlined`);
  }
  const match = /^#\/(\$defs|definitions)\/[^/]+$/.exec(ref);
  if (match === null || pointer(ctx.document, ref.slice(1)) === undefined) {
    throw new AgentSpecError(`Schema $ref ${ref} must point into this schema's $defs or definitions`);
  }
}

function resolveFileRef(ref: string, ctx: Context): unknown {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || isAbsolute(ref)) {
    throw new AgentSpecError(`Schema $ref ${ref} is absolute; only a relative file is allowed`);
  }
  const hash = ref.indexOf('#');
  const file = resolve(ctx.dir, hash === -1 ? ref : ref.slice(0, hash));
  const fragment = hash === -1 ? '' : ref.slice(hash + 1);
  const fromBase = relative(ctx.baseDir, file);
  if (fromBase.startsWith('..') || isAbsolute(fromBase)) {
    throw new AgentSpecError(`Schema $ref ${ref} leaves ${ctx.baseDir}`);
  }
  const key = `${file}#${fragment}`;
  if (ctx.stack.includes(key)) throw new AgentSpecError(`Schema $ref ${ref} is part of a cycle`);

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new AgentSpecError(`Schema $ref ${ref} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const target = fragment === '' ? document : fragment.startsWith('/') ? pointer(document, fragment) : undefined;
  if (target === undefined) throw new AgentSpecError(`Schema $ref ${ref} has a fragment that does not resolve`);
  return prepare(target, {
    baseDir: ctx.baseDir,
    dir: dirname(file),
    document,
    inlined: true,
    stack: [...ctx.stack, key],
  });
}

/** RFC 6901 JSON Pointer lookup; undefined when a step is missing. */
function pointer(document: unknown, path: string): unknown {
  let node = document;
  for (const raw of path.split('/').slice(1)) {
    let step: string;
    try {
      step = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, step)) return undefined;
    node = (node as Record<string, unknown>)[step];
  }
  return node;
}
