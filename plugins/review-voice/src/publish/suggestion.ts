import type { GitHubClient } from '../github/client.ts';

/**
 * A file's text at `ref`, from `GET /repos/{r}/contents/{path}`, or null when
 * it cannot be read as one text file: an error, a directory, or a file too
 * large for the endpoint to inline. A suggestion is checked against this
 * before it posts and an applied one is recognised by it (docs/adr/0033), so
 * an unread file always means "not shown to match", never "matches".
 */
export async function fileAtRef(client: GitHubClient, repository: string, path: string, ref: string): Promise<string | null> {
  // Each segment encoded on its own: the client refuses an encoded slash.
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  try {
    const { data } = await client.get<{ type?: unknown; encoding?: unknown; content?: unknown }>(
      `/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    );
    if (data?.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * `count` lines of `text` from the 1-based line `start`, joined by newlines,
 * or null when the file is shorter. A carriage return is dropped, as the diff
 * parser drops it from an added line.
 */
export function linesAt(text: string, start: number, count: number): string | null {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (start < 1 || start - 1 + count > lines.length) return null;
  return lines.slice(start - 1, start - 1 + count).join('\n');
}

/**
 * Whether the replacement now stands exactly where the original stood: the
 * reviewed head had the original at the range, and the current head has the
 * replacement there between the same neighbouring lines. Matching the
 * replacement alone is not enough, since a shorter one can equal an
 * untouched first line of the original.
 */
export function suggestionApplied(reviewed: string, current: string, patch: SuggestedPatchLike): boolean {
  const before = reviewed.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const after = current.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const start = patch.start_line - 1;
  const original = unixLines(patch.original);
  const replacement = unixLines(patch.replacement);
  const replaced = replacement.split('\n');
  // A patch that changes nothing, or a file that did not change, proves no
  // application; nor does a range that still reads the original, which a
  // repeated neighbouring line can otherwise make look replaced.
  if (original === replacement || before.join('\n') === after.join('\n')) return false;
  if (after.slice(start, patch.end_line).join('\n') === original) return false;
  if (before.slice(start, patch.end_line).join('\n') !== original) return false;
  if (after.slice(start, start + replaced.length).join('\n') !== replacement) return false;
  // Every line above the range unchanged, so nothing shifted a matching line
  // into place; edits below it are allowed, as an author often makes them.
  if (before.slice(0, start).join('\n') !== after.slice(0, start).join('\n')) return false;
  return after[start + replaced.length] === before[patch.end_line];
}

/** Text with any carriage return before a line break dropped, as the file's lines are read. */
export function unixLines(text: string): string {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).join('\n');
}

interface SuggestedPatchLike {
  start_line: number;
  end_line: number;
  original: string;
  replacement: string;
}
