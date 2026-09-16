import { createHash } from 'node:crypto';
import { SECRET_PATTERNS, PLACEHOLDERS } from './patterns.ts';

/** Bumped whenever the patterns change, so stored events record what cleaned them. */
export const REDACTION_VERSION = '1';

export interface RedactionResult {
  text: string;
  /** Count per label, for the audit log. Never the values themselves. */
  counts: Record<string, number>;
  /** Hash of the input, so a redaction can be audited without keeping the secret. */
  sourceHash: string;
  redactedHash: string;
  version: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function isPlaceholder(value: string): boolean {
  const normalised = value.toLowerCase().replace(/[<>{}[\]]/g, '');
  if (PLACEHOLDERS.has(normalised)) return true;
  // A single repeated character is a mask, not a credential.
  return /^(.)\1{3,}$/.test(value);
}

/**
 * Redacts before anything is persisted, indexed, logged, or put in a prompt.
 *
 * Review Voice never stores the original text, so this runs once at the
 * boundary and its output is all that survives. That makes the function's
 * conservatism the whole safety margin: when a match is ambiguous it redacts,
 * because an over-redacted review comment is merely less useful, while an
 * under-redacted one is a credential on disk.
 */
export function redact(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;

  for (const { label, pattern, group } of SECRET_PATTERNS) {
    // Patterns are global and reused across calls, so lastIndex must not leak
    // between inputs.
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match, ...groups) => {
      const captured = group === undefined || group === 0 ? match : (groups[group - 1] as string | undefined);
      if (captured === undefined || captured.length === 0) return match;
      if (isPlaceholder(captured)) return match;

      counts[label] = (counts[label] ?? 0) + 1;
      const replacement = `[REDACTED:${label}]`;
      // Replacing only the captured group keeps the surrounding context —
      // "postgres://user:[REDACTED:DB_CREDENTIALS]@host" still reads as a
      // comment about a connection string.
      return group === undefined || group === 0 ? replacement : match.replace(captured, replacement);
    });
  }

  return {
    text,
    counts,
    sourceHash: hash(input),
    redactedHash: hash(text),
    version: REDACTION_VERSION,
  };
}

/** True when anything was removed, for audit and reporting. */
export function wasRedacted(result: RedactionResult): boolean {
  return Object.keys(result.counts).length > 0;
}
