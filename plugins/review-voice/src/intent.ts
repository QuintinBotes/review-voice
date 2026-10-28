/**
 * What the pull request description says the change is for, as statements the
 * analyst and verifier can check one by one. Extracted by an agent, validated
 * here: every statement must quote a whole sentence or list item of the
 * description, so intent cannot be invented or have its negation cut off.
 */

import { significantWords } from './scoring/score.ts';

export type IntentKind = 'goal' | 'non-goal' | 'deliberate' | 'claim' | 'qa';

export interface IntentStatement {
  id: string;
  kind: IntentKind;
  statement: string;
  /** A whole sentence or list item of the description, verbatim. */
  quote: string;
  /** The author's stated reason, quoted like `quote`; present exactly when `kind` is `deliberate`. */
  reason?: string;
  /** Only on a goal that asserts something about a whole set. */
  scope?: 'complete';
  /** The heading a short `quote` answers, when the quote is that section's whole body (#164). Set by the CLI. */
  heading?: string;
}

export interface IntentDocument {
  statements: IntentStatement[];
}

type Parsed<T> = { value: T; problem: null } | { value: null; problem: string };

export const INTENT_KINDS: readonly IntentKind[] = ['goal', 'non-goal', 'deliberate', 'claim', 'qa'];
export const MAX_INTENT_STATEMENTS = 40;
const MAX_TEXT = 300;
// A quote is one whole sentence, so its own cap is looser than a statement's:
// a long technical sentence has no shorter quote that keeps its conditions (#164).
const MAX_QUOTE = 600;
const MIN_QUOTE_WORDS = 4;
const HEADING = /^\s*#{1,6}\s+/u;
const ID = /^int_[0-9]{3,}$/;
const LIST_OR_HEADING = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)/u;
// A leading `[label](url): `, bare URL and `: `, `**Label.**` or `**Label:**` reads as a label, not part of the sentence after it.
const LEAD_LABEL = /^(?:(?:\[[^\]]*\]\([^)\s]+\)|https?:\/\/\S+):|\*\*[^*]+?[.:]\*\*)(?= |$)/u;
// ...unless the label negates or scopes that sentence ("**Not in this change:**"), which a quote must keep.
const QUALIFYING_LABEL = /\b(?:not|no|out of scope|non-goals?|won't|without|except|unless|only if|later|follow-ups?)\b|n't\b/iu;

const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim();

interface Sentences {
  text: string;
  starts: Set<number>;
  ends: Set<number>;
  /** Each heading and the offsets of the body under it, up to the next heading. */
  sections: { heading: string; from: number; to: number }[];
  /** The offsets of each line that is not a heading. */
  lines: { from: number; to: number }[];
}

/**
 * The description as one line, with the offsets where a sentence or list item
 * starts and ends. A single line break is not a boundary, because descriptions
 * are often hard-wrapped mid-sentence: a quote starting after "We do not" on the
 * line above would drop the negation.
 */
function sentencesOf(description: string): Sentences {
  let text = '';
  const starts = new Set<number>([0]);
  const ends = new Set<number>();
  let blank = false;
  let previousHeading = false;
  const sections: Sentences['sections'] = [];
  const lines: Sentences['lines'] = [];
  let open: Sentences['sections'][number] | null = null;
  let contentEnd = 0;
  for (const line of description.split(/\r?\n/u)) {
    const marked = LIST_OR_HEADING.test(line);
    const content = collapse(line.replace(LIST_OR_HEADING, ''));
    if (content === '') {
      blank = true;
      continue;
    }
    if (text !== '') {
      if (blank || marked || previousHeading) {
        ends.add(text.length);
        starts.add(text.length + 1);
      }
      text += ' ';
    }
    const label = LEAD_LABEL.exec(content);
    if (label !== null && !QUALIFYING_LABEL.test(label[0])) {
      ends.add(text.length + label[0].length);
      starts.add(text.length + label[0].length + 1);
    }
    const heading = HEADING.test(line);
    if (heading) {
      if (open !== null && open.from !== -1) sections.push({ ...open, to: contentEnd });
      open = { heading: content, from: -1, to: -1 };
    } else if (open !== null && open.from === -1) {
      open.from = text.length;
    }
    if (!heading) lines.push({ from: text.length, to: text.length + content.length });
    text += content;
    contentEnd = text.length;
    blank = false;
    previousHeading = heading;
  }
  if (open !== null && open.from !== -1) sections.push({ ...open, to: contentEnd });
  ends.add(text.length);
  for (const match of text.matchAll(/[.!?](?= |$)/gu)) {
    ends.add(match.index);
    ends.add(match.index + 1);
    starts.add(match.index + 2);
  }
  return { text, starts, ends, sections, lines };
}

/**
 * Whether `wanted` fills one line of the description and that line is whole
 * sentences or a whole list item, so a short quote stands on its own (#208).
 */
function isWholeLine(wanted: string, sentences: Sentences): boolean {
  return sentences.lines.some(
    ({ from, to }) => sentences.starts.has(from) && sentences.ends.has(to) && sentences.text.slice(from, to) === wanted,
  );
}

const isShort = (quote: string): boolean => collapse(quote.replace(LIST_OR_HEADING, '')).split(' ').length < MIN_QUOTE_WORDS;

/** Problem with `quote` as a whole-sentence excerpt of the description, or null. */
function excerptProblem(quote: string, sentences: Sentences, name: string): string | null {
  const wanted = collapse(quote.replace(LIST_OR_HEADING, ''));
  if (isShort(wanted) && !isWholeLine(wanted, sentences)) return `${name} must be at least ${MIN_QUOTE_WORDS} words`;
  let at = sentences.text.indexOf(wanted);
  if (at === -1) return `${name} does not occur in the pull request description`;
  for (; at !== -1; at = sentences.text.indexOf(wanted, at + 1)) {
    if (sentences.starts.has(at) && sentences.ends.has(at + wanted.length)) return null;
  }
  return `${name} must be a whole sentence or list item of the description, not part of one`;
}

/**
 * The whole sentence or list item a clause quote sits in, when that is a valid
 * quote (#164). The whole-sentence rule exists so a quote never loses a
 * negation or condition; widening keeps that guarantee and saves a statement
 * the extractor quoted too narrowly. Null when the clause spans a boundary or
 * the sentence is over the length cap.
 */
function widenToSentence(quote: string, sentences: Sentences): string | null {
  const wanted = collapse(quote.replace(LIST_OR_HEADING, ''));
  const at = sentences.text.indexOf(wanted);
  if (at === -1) return null;
  const end = at + wanted.length;
  if ([...sentences.starts].some((start) => start > at && start < end)) return null;
  const from = Math.max(...[...sentences.starts].filter((start) => start <= at));
  let to = Math.min(...[...sentences.ends].filter((stop) => stop >= end && stop > from));
  if (!Number.isFinite(to)) return null;
  // A sentence end is recorded on both sides of its full stop; keep the stop.
  if (/[.!?]/u.test(sentences.text[to] ?? '') && sentences.ends.has(to + 1)) to += 1;
  const sentence = sentences.text.slice(from, to);
  return sentence.length <= MAX_QUOTE ? sentence : null;
}

/**
 * The heading a short quote answers, or null. Under four words a quote rarely
 * carries its own subject ("None."), so it is kept only when it is the whole
 * body of a section and the heading supplies the question it answers (#164).
 */
function answeredHeading(quote: string, sentences: Sentences): string | null {
  const wanted = collapse(quote.replace(LIST_OR_HEADING, ''));
  if (wanted === '' || wanted.split(' ').length >= MIN_QUOTE_WORDS) return null;
  const section = sentences.sections.find(({ from, to }) => {
    const body = sentences.text.slice(from, to);
    return body === wanted || body === `${wanted}.`;
  });
  return section?.heading ?? null;
}

/** A valid excerpt for `value`: as given, or widened to its sentence, with a note when widened. */
function excerptOf(value: string, sentences: Sentences, name: string, id: string, notes: string[]): Parsed<string> {
  const problem = excerptProblem(value, sentences, name);
  if (problem === null) {
    if (isShort(value)) notes.push(`Kept ${name.split('.').pop()} of ${id} under ${MIN_QUOTE_WORDS} words: it is a whole line of the description`);
    return { value, problem: null };
  }
  if (!problem.endsWith('not part of one')) return { value: null, problem };
  const widened = widenToSentence(value, sentences);
  if (widened === null || excerptProblem(widened, sentences, name) !== null) return { value: null, problem };
  notes.push(`Widened ${name.split('.').pop()} of ${id} to its whole sentence`);
  return { value: widened, problem: null };
}

function text(value: unknown, name: string, max = MAX_TEXT): Parsed<string> {
  if (typeof value !== 'string' || value.trim().length === 0) return { value: null, problem: `${name} must be non-empty text` };
  if (value.length > max) return { value: null, problem: `${name} must be at most ${max} characters` };
  return { value: value.trim(), problem: null };
}

/** The description body from a thread.json, or null when the thread carries none. */
export function descriptionOf(thread: unknown): string | null {
  const comments = (thread as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(comments)) return null;
  const bodies = comments
    .filter((comment) => (comment as { kind?: unknown })?.kind === 'description')
    .map((comment) => (comment as { body?: unknown }).body)
    .filter((body): body is string => typeof body === 'string');
  return bodies.length === 0 ? null : bodies.join('\n');
}

/**
 * One statement of the extractor output, or the first rule it breaks. A
 * misplaced optional `scope` or `reason` is stripped and named in `removed`
 * instead: the statement itself is still a valid author statement.
 */
function statementOf(rawEntry: unknown, at: string, sentences: Sentences, removed: string[]): Parsed<IntentStatement> {
  if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
    return { value: null, problem: `${at} must be an object` };
  }
  // A model writes null for "not applicable"; read it as the key left out.
  const entry = Object.fromEntries(
    Object.entries(rawEntry as Record<string, unknown>).filter(([key, value]) => !(value === null && (key === 'reason' || key === 'scope'))),
  );
  const unexpected = Object.keys(entry).find((key) => !['id', 'kind', 'statement', 'quote', 'reason', 'scope', 'heading'].includes(key));
  if (unexpected !== undefined) return { value: null, problem: `${at} has an unexpected ${JSON.stringify(unexpected)} field` };

  const id = entry['id'];
  if (typeof id !== 'string' || !ID.test(id)) return { value: null, problem: `${at}.id must match int_NNN` };

  const kind = entry['kind'];
  if (!INTENT_KINDS.includes(kind as IntentKind)) {
    return { value: null, problem: `${at}.kind must be one of ${INTENT_KINDS.join(', ')}` };
  }
  const statement = text(entry['statement'], `${at}.statement`);
  if (statement.problem !== null) return { value: null, problem: statement.problem };
  const rawQuote = text(entry['quote'], `${at}.quote`, MAX_QUOTE);
  if (rawQuote.problem !== null) return { value: null, problem: rawQuote.problem };
  // A supplied heading is recomputed, so re-checking this command's output passes and a made-up one never does.
  const heading = answeredHeading(rawQuote.value, sentences);
  const quote: Parsed<string> = heading === null ? excerptOf(rawQuote.value, sentences, `${at}.quote`, id, removed) : rawQuote;
  if (quote.problem !== null) return { value: null, problem: quote.problem };
  if (kind !== 'non-goal') {
    const quoted = significantWords(heading === null ? quote.value : `${heading} ${quote.value}`);
    if (![...significantWords(statement.value)].some((word) => quoted.has(word))) {
      return { value: null, problem: `${at}.quote shares no significant word with its statement` };
    }
  }

  let reason: string | undefined;
  if (kind === 'deliberate') {
    const parsed = text(entry['reason'], `${at}.reason`, MAX_QUOTE);
    if (parsed.problem !== null) return { value: null, problem: `${parsed.problem} on a deliberate statement` };
    const excerpt = excerptOf(parsed.value, sentences, `${at}.reason`, id, removed);
    if (excerpt.problem !== null) return { value: null, problem: excerpt.problem };
    reason = excerpt.value;
  } else if (entry['reason'] !== undefined) {
    removed.push(`Removed reason from ${id} (only a deliberate statement takes reason)`);
  }
  const complete = kind === 'goal' && entry['scope'] === 'complete';
  if (entry['scope'] !== undefined && !complete) removed.push(`Removed scope from ${id} (only a goal takes scope, and only "complete")`);

  return {
    value: {
      id,
      kind: kind as IntentKind,
      statement: statement.value,
      quote: quote.value,
      ...(reason === undefined ? {} : { reason }),
      ...(complete ? { scope: 'complete' as const } : {}),
      ...(heading === null ? {} : { heading }),
    },
    problem: null,
  };
}

/**
 * Parses the intent-extractor output; every quote and reason must be a whole
 * sentence of `description`. A statement that breaks a rule is dropped and
 * named in `dropped`, so one bad entry does not cost the rest of the table;
 * a misplaced optional key is stripped and named in `removed`. The whole
 * output is refused only when its shape is broken, two kept statements share
 * an id, or none survives.
 */
export function parseIntent(value: unknown, description: string): Parsed<IntentDocument> & { dropped: string[]; removed: string[] } {
  const removed: string[] = [];
  const refuse = (problem: string, dropped: string[] = []) => ({ value: null, problem, dropped, removed });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('expected {"statements": [...]}');
  const document = value as Record<string, unknown>;
  const extra = Object.keys(document).find((key) => key !== 'statements');
  if (extra !== undefined) return refuse(`has an unexpected ${JSON.stringify(extra)} field`);
  const raw = document['statements'];
  if (!Array.isArray(raw)) return refuse('statements must be an array');
  if (raw.length > MAX_INTENT_STATEMENTS) return refuse(`statements must list at most ${MAX_INTENT_STATEMENTS} entries`);

  const sentences = sentencesOf(description);
  const statements: IntentStatement[] = [];
  const dropped: string[] = [];
  for (const [index, rawEntry] of raw.entries()) {
    const removedHere: string[] = [];
    const parsed = statementOf(rawEntry, `statements[${index}]`, sentences, removedHere);
    // A dropped statement's stripped keys are moot; only report kept ones.
    if (parsed.problem === null) removed.push(...removedHere);
    if (parsed.problem === null) statements.push(parsed.value);
    else {
      const id = (rawEntry as { id?: unknown } | null)?.id;
      dropped.push(typeof id === 'string' ? `${id} (${parsed.problem})` : parsed.problem);
    }
  }
  // Two kept statements with one id would make an intent_ref ambiguous.
  const ids = statements.map(({ id }) => id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice !== undefined) return refuse(`id ${twice} is used by two statements`, dropped);
  if (raw.length > 0 && statements.length === 0) return refuse('no statement survives validation', dropped);
  return { value: { statements }, problem: null, dropped, removed };
}
