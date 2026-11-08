import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Everything convention discovery asks of a tree, with repository-relative
 * paths. Discovery reads through this so the same ranking can run on the
 * checkout or on a commit the review trusts (issue 275).
 */
export interface TreeReader {
  /** Whether a file or a directory is at the path. */
  exists(path: string): boolean;
  /** Whether a regular file is at the path. */
  isFile(path: string): boolean;
  /** The file's size in bytes. Throws when there is none. */
  size(path: string): number;
  /** The names in a directory, unsorted. Throws when there is none. */
  list(path: string): string[];
  /** The file's bytes. Throws when there is none. */
  read(path: string): Buffer;
}

/** The checkout as it is on disk, which is what discovery always read. */
export function filesystemReader(root: string): TreeReader {
  return {
    exists: (path) => existsSync(join(root, path)),
    isFile: (path) => {
      try {
        return statSync(join(root, path)).isFile();
      } catch {
        return false;
      }
    },
    size: (path) => statSync(join(root, path)).size,
    list: (path) => readdirSync(join(root, path)),
    read: (path) => readFileSync(join(root, path)),
  };
}

const GIT_BUFFER = 512 * 1024 * 1024;

/**
 * One commit's tree, listed once and read blob by blob.
 *
 * In the GitHub Action the checkout is the pull request's head, so reading the
 * disk handed the review the author's own CLAUDE.md and AGENTS.md, and a head
 * that weakens a convention would have the review weigh the weaker one. That is
 * the problem ADR 0031 solved for configuration. The caller checks that the ref
 * resolves.
 */
export function gitTreeReader(root: string, ref: string): TreeReader {
  const listing = execFileSync('git', ['ls-tree', '-r', '-l', '--full-tree', '-z', ref], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_BUFFER,
  });
  const files = new Map<string, { object: string; size: number }>();
  const directories = new Map<string, Set<string>>();

  for (const record of listing.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, object, size] = record.slice(0, tab).split(/ +/);
    // A link names a path that is resolved in whatever tree it is read from,
    // which is the checkout this reader exists to avoid, or anywhere on disk.
    // It is left out, as the filesystem reader leaves out a broken link; a
    // submodule has no files in this tree to read.
    if (type !== 'blob' || mode === '120000' || object === undefined) continue;
    const path = record.slice(tab + 1);
    files.set(path, { object, size: Number(size) });
    const parts = path.split('/');
    for (let depth = 0; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join('/');
      const names = directories.get(directory) ?? new Set<string>();
      names.add(parts[depth] as string);
      directories.set(directory, names);
    }
  }

  // Discovery builds paths with the platform separator; git's always use `/`.
  const key = (path: string): string => {
    const posix = path.split(sep).join('/');
    return posix === '.' ? '' : posix;
  };
  const file = (path: string): { object: string; size: number } => {
    const entry = files.get(key(path));
    if (entry === undefined) throw new Error(`${path} is not a file at ${ref}.`);
    return entry;
  };
  // readHead and readBounded both read a document, so a blob is fetched once.
  const blobs = new Map<string, Buffer>();

  return {
    exists: (path) => files.has(key(path)) || directories.has(key(path)),
    isFile: (path) => files.has(key(path)),
    size: (path) => file(path).size,
    list: (path) => {
      const names = directories.get(key(path));
      if (names === undefined) throw new Error(`${path} is not a directory at ${ref}.`);
      return [...names];
    },
    read: (path) => {
      const { object } = file(path);
      let blob = blobs.get(object);
      if (blob === undefined) {
        blob = execFileSync('git', ['cat-file', 'blob', object], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: GIT_BUFFER,
        });
        blobs.set(object, blob);
      }
      return blob;
    },
  };
}
