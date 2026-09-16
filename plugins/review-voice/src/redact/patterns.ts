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
  pattern: RegExp;
  /** Which capture group holds the secret; 0 means the whole match. */
  group?: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  // Key material is replaced whole: a PEM block's header is not the secret,
  // but leaving it invites someone to reconstruct what was removed.
  {
    label: 'PRIVATE_KEY',
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  },
  { label: 'PEM_BLOCK', pattern: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g },

  { label: 'GITHUB_TOKEN', pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,255})\b/g, group: 1 },
  { label: 'GITHUB_TOKEN', pattern: /\b(github_pat_[A-Za-z0-9_]{20,})\b/g, group: 1 },

  { label: 'AWS_ACCESS_KEY', pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, group: 1 },
  {
    label: 'AWS_SECRET_KEY',
    pattern: /\b(?:aws_secret_access_key|aws_secret)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    group: 1,
  },
  { label: 'GOOGLE_API_KEY', pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1 },
  { label: 'SLACK_TOKEN', pattern: /\b(xox[abposr]-[0-9A-Za-z-]{10,})\b/g, group: 1 },
  { label: 'STRIPE_KEY', pattern: /\b((?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,})\b/g, group: 1 },
  { label: 'NPM_TOKEN', pattern: /\b(npm_[A-Za-z0-9]{36})\b/g, group: 1 },
  { label: 'PYPI_TOKEN', pattern: /\b(pypi-[A-Za-z0-9_-]{16,})\b/g, group: 1 },
  { label: 'OPENAI_KEY', pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { label: 'ANTHROPIC_KEY', pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, group: 1 },

  // JWTs: three base64url segments. The payload is often the sensitive part.
  {
    label: 'JWT',
    pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    group: 1,
  },

  // A connection string's credentials, keeping the scheme and host so the
  // surrounding review comment still makes sense.
  {
    label: 'DB_CREDENTIALS',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    group: 3,
  },

  {
    label: 'AUTHORIZATION_HEADER',
    pattern: /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/gi,
    group: 1,
  },

  // Assignment-shaped secrets. Deliberately last: it is the broadest rule, and
  // a more specific label above is more useful in an audit than "SECRET".
  {
    label: 'SECRET_ASSIGNMENT',
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    group: 1,
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
