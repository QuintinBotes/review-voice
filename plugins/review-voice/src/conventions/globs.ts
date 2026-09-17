/**
 * Convention documents declare which paths they govern, in frontmatter:
 *
 *     ---
 *     paths:
 *       - "**\/*.ts"
 *       - "**\/*.tsx"
 *     ---
 *
 * That declaration is the repository stating, in its own words, when a rule
 * applies. Ranking by directory proximity instead sent a 14 KB semaphore guide
 * and a 9.6 KB routing guide to a pull request with neither, while every rule
 * whose glob matched the changed files was dropped for budget.
 */
export function frontmatterPaths(content: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match === null) return [];

  const block = match[1] ?? '';
  const paths: string[] = [];
  let inPaths = false;

  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^paths\s*:/.test(line)) {
      inPaths = true;
      // Inline form: `paths: ["a", "b"]`.
      const inline = line.slice(line.indexOf(':') + 1).trim();
      if (inline.startsWith('[')) {
        for (const item of inline.slice(1, -1).split(',')) paths.push(unquote(item));
        inPaths = false;
      }
      continue;
    }
    if (!inPaths) continue;
    if (/^\s*-\s+/.test(line)) {
      paths.push(unquote(line.replace(/^\s*-\s+/, '')));
      continue;
    }
    // Any other key at the same level ends the list.
    if (/^\S/.test(line)) inPaths = false;
  }

  return paths.filter((glob) => glob.length > 0);
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Compiles a glob to a regular expression.
 *
 * Deliberately small rather than a dependency: the plugin ships one bundle
 * with no runtime dependencies, and this needs `**`, `*` and `?` only.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';

  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;

    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans any number of directories, including none.
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
        continue;
      }
      source += '[^/]*';
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

/**
 * How many changed paths a document's globs govern.
 *
 * Coverage rather than a yes or no, because it decides which rule is read when
 * the budget cannot hold them all. A rule matching the two largest additions in
 * a diff is worth more than one matching a single incidental file, and ranking
 * by size alone dropped a test rule from a change whose biggest additions were
 * test files.
 */
export function governsCount(globs: readonly string[], changedPaths: readonly string[]): number {
  if (globs.length === 0 || changedPaths.length === 0) return 0;

  const normalised = changedPaths.map((path) => path.split('\\').join('/'));
  const compiled = globs.flatMap((glob) => {
    try {
      const exact = globToRegExp(glob);
      // A bare `*.tsx` is meant to match anywhere, the way these files use it.
      return glob.includes('/') ? [exact] : [exact, globToRegExp(`**/${glob}`)];
    } catch {
      return [];
    }
  });

  return normalised.filter((path) => compiled.some((pattern) => pattern.test(path))).length;
}

/** Whether any declared glob governs any changed path. */
export function governsAny(globs: readonly string[], changedPaths: readonly string[]): boolean {
  if (globs.length === 0 || changedPaths.length === 0) return false;

  const normalised = changedPaths.map((path) => path.split('\\').join('/'));
  return globs.some((glob) => {
    let pattern: RegExp;
    try {
      pattern = globToRegExp(glob);
    } catch {
      return false;
    }
    // A bare `*.tsx` is meant to match anywhere, the way these files use it.
    const loose = glob.includes('/') ? null : globToRegExp(`**/${glob}`);
    return normalised.some((path) => pattern.test(path) || (loose !== null && loose.test(path)));
  });
}

/**
 * A stub whose whole content is a reference to the real document.
 *
 * Eight of nineteen documents selected on one pull request were 70-byte files
 * holding frontmatter and `@.agents/rules/routing.md`. Supplying the pointer
 * spends budget to tell the reader where the rule is, instead of what it says.
 */
export function pointerTarget(content: string): string | null {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
  // `\.?\/?` ate the dot of `.agents/rules/...`. Only `./` as a unit is
  // optional punctuation; a bare dot is part of the path.
  const match = /^@(?:\.\/)?([^\s]+\.md)$/.exec(body);
  return match?.[1] ?? null;
}
