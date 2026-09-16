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

/** Everything but `source` is noise unless the user asked for it. */
export function isReviewable(path: string, includeGenerated: boolean): boolean {
  return includeGenerated || classify(path) === 'source';
}
