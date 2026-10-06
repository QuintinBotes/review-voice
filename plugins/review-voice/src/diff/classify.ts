/**
 * File classification for diff acquisition.
 *
 * Reviewing a lock file, a minified bundle or a vendored dependency wastes the
 * finding budget on code nobody wrote and nobody will change in this pull
 * request. These are excluded by default and recoverable with
 * --include-generated, because occasionally a lock file change IS the review.
 */
export type FileClass = 'source' | 'generated' | 'vendored' | 'lockfile' | 'binary';

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock',
  'Gemfile.lock', 'go.sum', 'gradle.lockfile', 'packages.lock.json',
]);

const VENDOR_SEGMENTS = new Set([
  'node_modules', 'vendor', 'third_party', 'thirdparty', 'bower_components', '.yarn',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'avif',
  'pdf', 'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg',
  'so', 'dylib', 'dll', 'exe', 'bin', 'class', 'jar', 'wasm', 'pyc',
  'sqlite', 'db', 'parquet',
]);

const GENERATED_PATTERNS: RegExp[] = [
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)coverage\//,
  /(^|\/)__generated__\//,
  /(^|\/)generated\//,
  /\.min\.(js|css|mjs|cjs)$/,
  /\.bundle\.(js|mjs|cjs)$/,
  /\.(pb|pb2)\.(go|py|ts|js)$/,
  /_pb2?\.py$/,
  /\.g\.(dart|cs|ts)$/,
  /\.generated\.[a-z]+$/,
  /\.d\.ts$/,
  /(^|\/)\.next\//,
  /(^|\/)\.nuxt\//,
];

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', scala: 'scala', ex: 'elixir', exs: 'elixir',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', json: 'json', toml: 'toml',
  md: 'markdown', html: 'html', css: 'css', scss: 'scss', tf: 'terraform',
  dockerfile: 'dockerfile',
};

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function languageOf(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile') return 'make';
  return LANGUAGES[extensionOf(path)] ?? null;
}

export function classify(path: string): FileClass {
  const name = path.split('/').pop() ?? '';
  if (LOCKFILES.has(name)) return 'lockfile';

  const segments = path.split('/');
  // Only directory segments count: a file literally named "vendor.ts" is source.
  if (segments.slice(0, -1).some((segment) => VENDOR_SEGMENTS.has(segment))) return 'vendored';

  if (BINARY_EXTENSIONS.has(extensionOf(path))) return 'binary';
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(path))) return 'generated';
  return 'source';
}

/**
 * Prose and plain-text data: reviewed like any other file, but not code, so
 * its words are not branches. A Markdown hunk once read as 26 decision points
 * because prose is full of `if`, `when` and `or` (docs/adr/0012).
 */
const DOCUMENTATION_EXTENSIONS = new Set([
  'md', 'markdown', 'mdown', 'mkd', 'mdx', 'rst', 'adoc', 'asciidoc',
  'txt', 'text', 'org', 'rtf', 'tex', 'csv', 'tsv',
]);

const DOCUMENTATION_NAMES = new Set([
  'readme', 'license', 'licence', 'changelog', 'changes', 'notice', 'authors', 'contributors', 'copying',
]);

export function isDocumentation(path: string): boolean {
  const extension = extensionOf(path);
  if (DOCUMENTATION_EXTENSIONS.has(extension)) return true;
  return extension === '' && DOCUMENTATION_NAMES.has((path.split('/').pop() ?? '').toLowerCase());
}

/** Everything but `source` is noise unless the user asked for it. */
export function isReviewable(path: string, includeGenerated: boolean): boolean {
  return includeGenerated || classify(path) === 'source';
}

/**
 * Hand-edited generated files.
 *
 * A generated file is normally noise, but a generated file edited by hand is a
 * real change that nobody will regenerate away: on a live run a manual edit to
 * a generated SDK file was the main change of a pull request and went
 * unreviewed because the file counted as generated. The signal is a header
 * that says not to edit the file, on a file that changed while its generated
 * neighbours did not. A regeneration touches many files in one directory, so
 * a lone change there is the edit nobody meant to make.
 */
const DO_NOT_EDIT = /@generated|do not edit|don'?t edit|auto-?generated|automatically generated/i;
const HEADER_LINES = 20;

/** Whether the first lines of a file say it must not be edited by hand. */
export function hasDoNotEditHeader(content: string): boolean {
  return DO_NOT_EDIT.test(content.split('\n', HEADER_LINES).join('\n'));
}

/**
 * The top generated directory a path sits in, or its own directory for a file
 * that is generated by name alone. Two files share a regeneration when they
 * share this root.
 */
export function generatedRoot(path: string): string {
  const dirPattern = /(^|\/)(dist|build|out|coverage|__generated__|generated|\.next|\.nuxt)\//;
  const match = dirPattern.exec(path);
  if (match !== null) return path.slice(0, match.index + match[0].length);
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

/**
 * Picks the generated files that look hand edited.
 *
 * `readHeader` returns the text to inspect for a path (head content, or the
 * added lines of its patch) or null when none is available, in which case the
 * file stays excluded.
 */
export function findHandEdited(
  changedPaths: string[],
  readHeader: (path: string) => string | null,
): Set<string> {
  const generated = changedPaths.filter((path) => classify(path) === 'generated');
  const perRoot = new Map<string, number>();
  for (const path of generated) {
    const root = generatedRoot(path);
    perRoot.set(root, (perRoot.get(root) ?? 0) + 1);
  }
  const suspected = new Set<string>();
  for (const path of generated) {
    if (perRoot.get(generatedRoot(path)) !== 1) continue;
    const header = readHeader(path);
    if (header !== null && hasDoNotEditHeader(header)) suspected.add(path);
  }
  return suspected;
}
