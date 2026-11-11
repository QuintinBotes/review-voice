/**
 * Secret patterns, ordered most-specific first so a GitHub token is labelled
 * as one rather than caught by a generic high-entropy rule.
 *
 * This list is defence in depth, not a guarantee. Pattern matching cannot
 * recognise a credential that does not look like one, and SECURITY.md says so
 * plainly rather than implying protection that does not exist.
 */
export interface SecretPattern {
  label: string;
  /** Global, with the d flag, as the secret is replaced by its captured position. */
  pattern: RegExp;
  /** Which capture group holds the secret; 0 means the whole match. */
  group?: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  // Key material is replaced whole: a PEM block's header is not the secret,
  // but leaving it invites someone to reconstruct what was removed. When a
  // header has no footer after it, no later header has one either, so the
  // second branch takes the rest of the text with group 1 unset, which
  // replaces nothing, instead of every later header searching it again.
  {
    label: 'PRIVATE_KEY',
    pattern:
      /(-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----)|-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*/gd,
    group: 1,
  },
  {
    label: 'PEM_BLOCK',
    pattern: /(-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----)|-----BEGIN [A-Z ]+-----[\s\S]*/gd,
    group: 1,
  },

  { label: 'GITHUB_TOKEN', pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,255})\b/gd, group: 1 },
  { label: 'GITHUB_TOKEN', pattern: /\b(github_pat_[A-Za-z0-9_]{20}[A-Za-z0-9_]*)\b/gd, group: 1 },

  { label: 'AWS_ACCESS_KEY', pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/gd, group: 1 },
  {
    label: 'AWS_SECRET_KEY',
    pattern: /\b(?:aws_secret_access_key|aws_secret)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gid,
    group: 1,
  },
  { label: 'GOOGLE_API_KEY', pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/gd, group: 1 },
  { label: 'SLACK_TOKEN', pattern: /\b(xox[abposr]-[0-9A-Za-z-]{10}[0-9A-Za-z-]*)\b/gd, group: 1 },
  { label: 'STRIPE_KEY', pattern: /\b((?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16}[0-9A-Za-z]*)\b/gd, group: 1 },
  { label: 'NPM_TOKEN', pattern: /\b(npm_[A-Za-z0-9]{36})\b/gd, group: 1 },
  { label: 'PYPI_TOKEN', pattern: /\b(pypi-[A-Za-z0-9_-]{16}[A-Za-z0-9_-]*)\b/gd, group: 1 },
  { label: 'OPENAI_KEY', pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*)\b/gd, group: 1 },
  { label: 'ANTHROPIC_KEY', pattern: /\b(sk-ant-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*)\b/gd, group: 1 },

  // JWTs: three base64url segments. The payload is often the sensitive part.
  // A segment cannot contain '.', so the first always ends where its run of
  // base64url characters ends, and the leftmost eyJ that may start a token
  // (at the run's start or after a '-') succeeds wherever a later one in the
  // same run would. Each run is tried once, from that eyJ, with the first two
  // segments taken whole: trying every '-eyJ' rescanned the run each time. The
  // last segment can still give back a trailing '-' to meet the closing \b.
  {
    label: 'JWT',
    pattern:
      /(?<![A-Za-z0-9_-])(?=((?:[A-Za-z0-9_-]*?-)??)eyJ)\1(eyJ(?=([A-Za-z0-9_-]{8}[A-Za-z0-9_-]*))\3\.(?=([A-Za-z0-9_-]{8}[A-Za-z0-9_-]*))\4\.[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*)\b/gd,
    group: 2,
  },

  // A connection string's credentials, keeping the scheme and host so the
  // surrounding review comment still makes sense. A scheme cannot contain ':',
  // so it always ends where its run of scheme characters ends, and where in the
  // run it starts changes nothing that follows. Each run is therefore tried
  // once, from its start, and taken whole by a lookahead and backreference, as
  // JavaScript has no possessive quantifier. Trying every word boundary in the
  // run rescanned it each time, and pull request text could stall a review for
  // minutes. The run must still hold a scheme's start at a word boundary: a
  // letter first with no '_' before it, or a letter after '+', '.' or '-'.
  {
    label: 'DB_CREDENTIALS',
    pattern: /(?<![a-z0-9+.-])(?=(?<!_)[a-z]|[a-z0-9+.-]*?[+.-][a-z])(?=([a-z0-9+.-]+))\1:\/\/([^\s:@/]+):([^\s@/]+)@/gid,
    group: 3,
  },

  {
    label: 'AUTHORIZATION_HEADER',
    pattern: /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12}[A-Za-z0-9._~+/=-]*)/gid,
    group: 1,
  },

  // Assignment-shaped secrets. Deliberately after the specific rules: it is the
  // broadest one, and a more specific label above is more useful in an audit
  // than "SECRET".
  {
    label: 'SECRET_ASSIGNMENT',
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']([^"'\s]{8}[^"'\s]*)["']/gid,
    group: 1,
  },

  // A connection string with no user, as in `redis://:password@host`. It runs
  // last because its password reaches the first '@': run earlier, it took the
  // keyword or closing quote of an assignment, and the rest of that secret
  // stayed in clear text. Nothing runs after it, so it has no assignment to
  // protect and takes a scheme that follows '_' as well.
  {
    label: 'DB_CREDENTIALS',
    pattern: /(?<![a-z0-9+.-])(?=[a-z]|[a-z0-9+.-]*?[+.-][a-z])(?=([a-z0-9+.-]+))\1:\/\/:([^\s@/]+)@/gid,
    group: 2,
  },
];

/**
 * Values that look like secrets but are not, and which appear constantly in
 * review comments about secrets. Redacting them makes the corpus less
 * readable for no gain.
 */
export const PLACEHOLDERS = new Set([
  'xxxxxxxx', 'changeme', 'password', 'redacted', 'your_token_here', 'example',
  'placeholder', 'dummy', 'notarealsecret', 'test', 'password123', '<token>',
  'secret', 'todo', 'fixme', 'null', 'undefined', 'none',
]);
