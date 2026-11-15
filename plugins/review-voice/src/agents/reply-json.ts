import { jsonCandidates } from '../verify/external.ts';

/**
 * The JSON in an agent's reply, read alone when the reply wraps it in prose or
 * a code fence (#385, #417). The coordinator saves each reply as it came,
 * rather than retyping its JSON into a file, and the next command reads it.
 * Tried in order: the whole text, each code fence, then the span from the
 * first bracket to the last. Undefined when none of them parses.
 */
export function jsonInReply(text: string): { value: unknown; wrapped: boolean } | undefined {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const spans = (
    [
      ['[', ']'],
      ['{', '}'],
    ] as const
  )
    .map(([open, close]) => [text.indexOf(open), text.lastIndexOf(close)] as const)
    .filter(([from, to]) => from !== -1 && to > from)
    .sort((a, b) => a[0] - b[0])
    .map(([from, to]) => text.slice(from, to + 1));
  for (const [index, candidate] of [text, ...fences, ...spans].entries()) {
    try {
      return { value: JSON.parse(candidate) as unknown, wrapped: index > 0 };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * One list gathered from several replies saved one after another in a file:
 * every top-level object's `key` array, or each object itself when it has no
 * such key (a tie-break ruling is a bare object). A file that is one JSON
 * document is read as it is. Undefined when no object is found.
 */
export function listFromReplies(text: string, key: string): { value: unknown[]; wrapped: boolean } | undefined {
  try {
    const whole = JSON.parse(text) as unknown;
    if (Array.isArray(whole)) return { value: whole, wrapped: false };
    const list = (whole as Record<string, unknown> | null)?.[key];
    if (Array.isArray(list)) return { value: list, wrapped: false };
  } catch {
    // Not one document: read each reply's objects below.
  }
  const objects = jsonCandidates(text).flatMap((candidate) => {
    try {
      return [JSON.parse(candidate) as unknown];
    } catch {
      return [];
    }
  });
  if (objects.length === 0) return undefined;
  const value = objects.flatMap((object) => {
    const list = (object as Record<string, unknown> | null)?.[key];
    return Array.isArray(list) ? list : [object];
  });
  return { value, wrapped: true };
}
