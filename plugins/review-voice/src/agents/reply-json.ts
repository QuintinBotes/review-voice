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
 * The document a command reads, from a file that may hold several replies
 * saved one after another (one challenger or tie-breaker per finding). A text
 * that is one JSON document is returned as it is, so every shape the command
 * already accepts, and every refusal it already gives, stays the same.
 * Otherwise every top-level object is read, and the `key` arrays they carry
 * (or the objects themselves, for a ruling that is a bare object) are gathered
 * into `{[key]: [...]}`. Undefined when the text holds no JSON object.
 */
export function gatherReplies(text: string, key: string): { value: unknown; wrapped: boolean } | undefined {
  try {
    return { value: JSON.parse(text) as unknown, wrapped: false };
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
  const list = objects.flatMap((object) => {
    const inner = (object as Record<string, unknown> | null)?.[key];
    return Array.isArray(inner) ? inner : [object];
  });
  // A reply's other top-level keys stay beside the list, so a command can name
  // a field that was put outside the entry it belongs in (#421).
  const beside = Object.assign(
    {},
    ...objects.map((object) => {
      const record = (typeof object === 'object' && object !== null && !Array.isArray(object) ? object : {}) as Record<string, unknown>;
      if (!Array.isArray(record[key])) return {};
      const { [key]: _list, ...rest } = record;
      return rest;
    }),
  ) as Record<string, unknown>;
  return { value: { ...beside, [key]: list }, wrapped: true };
}
