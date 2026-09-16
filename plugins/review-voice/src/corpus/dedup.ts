import { createHash } from 'node:crypto';

/**
 * Rebases and copied discussion produce the same comment under different ids.
 * Identity is therefore content plus location, not the GitHub id alone.
 */
export function contentKey(parts: {
  repository: string;
  reviewerLogin: string;
  body: string;
  filePath?: string | undefined;
  lineStart?: number | undefined;
}): string {
  const normalised = parts.body.replace(/\s+/g, ' ').trim().toLowerCase();
  // A separator that cannot occur in any of the fields, so two different
  // splits cannot hash to the same key.
  const SEPARATOR = String.fromCharCode(31);
  return createHash('sha256')
    .update(
      [
        parts.repository.toLowerCase(),
        parts.reviewerLogin.toLowerCase(),
        parts.filePath ?? '',
        String(parts.lineStart ?? ''),
        normalised,
      ].join(SEPARATOR),
    )
    .digest('hex')
    .slice(0, 32);
}
