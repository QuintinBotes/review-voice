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
}

export interface IntentDocument {
  statements: IntentStatement[];
}

type Parsed<T> = { value: T; problem: null } | { value: null; problem: string };

export const INTENT_KINDS: readonly IntentKind[] = ['goal', 'non-goal', 'deliberate', 'claim', 'qa'];
export const MAX_INTENT_STATEMENTS = 40;
const MAX_TEXT = 300;
const MIN_QUOTE_WORDS = 4;
const ID = /^int_[0-9]{3,}$/;
const LIST_OR_HEADING = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)/u;

const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim();

interface Sentences {
  text: string;
  starts: Set<number>;
  ends: Set<number>;
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
    text += content;
    blank = false;
    previousHeading = /^\s*#/u.test(line);
  }
  ends.add(text.length);
  for (const match of text.matchAll(/[.!?](?= |$)/gu)) {
    ends.add(match.index);
    ends.add(match.index + 1);
    starts.add(match.index + 2);
  }
  return { text, starts, ends };
}

/** Problem with `quote` as a whole-sentence excerpt of the description, or null. */
function excerptProblem(quote: string, sentences: Sentences, name: string): string | null {
  const wanted = collapse(quote.replace(LIST_OR_HEADING, ''));
  if (wanted.split(' ').length < MIN_QUOTE_WORDS) return `${name} must be at least ${MIN_QUOTE_WORDS} words`;
  let at = sentences.text.indexOf(wanted);
  if (at === -1) return `${name} does not occur in the pull request description`;
  for (; at !== -1; at = sentences.text.indexOf(wanted, at + 1)) {
    if (sentences.starts.has(at) && sentences.ends.has(at + wanted.length)) return null;
  }
  return `${name} must be a whole sentence or list item of the description, not part of one`;
}

function text(value: unknown, name: string): Parsed<string> {
  if (typeof value !== 'string' || value.trim().length === 0) return { value: null, problem: `${name} must be non-empty text` };
  if (value.length > MAX_TEXT) return { value: null, problem: `${name} must be at most ${MAX_TEXT} characters` };
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

/** Parses the intent-extractor output; every quote and reason must be a whole sentence of `description`. */
export function parseIntent(value: unknown, description: string): Parsed<IntentDocument> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value: null, problem: 'expected {"statements": [...]}' };
  }
  const document = value as Record<string, unknown>;
  const extra = Object.keys(document).find((key) => key !== 'statements');
  if (extra !== undefined) return { value: null, problem: `has an unexpected ${JSON.stringify(extra)} field` };
  const raw = document['statements'];
  if (!Array.isArray(raw)) return { value: null, problem: 'statements must be an array' };
  if (raw.length > MAX_INTENT_STATEMENTS) {
    return { value: null, problem: `statements must list at most ${MAX_INTENT_STATEMENTS} entries` };
  }

  const sentences = sentencesOf(description);
  const seen = new Set<string>();
  const statements: IntentStatement[] = [];
  for (const [index, rawEntry] of raw.entries()) {
    const at = `statements[${index}]`;
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      return { value: null, problem: `${at} must be an object` };
    }
    const entry = rawEntry as Record<string, unknown>;
    const unexpected = Object.keys(entry).find((key) => !['id', 'kind', 'statement', 'quote', 'reason', 'scope'].includes(key));
    if (unexpected !== undefined) return { value: null, problem: `${at} has an unexpected ${JSON.stringify(unexpected)} field` };

    const id = entry['id'];
    if (typeof id !== 'string' || !ID.test(id)) return { value: null, problem: `${at}.id must match int_NNN` };
    if (seen.has(id)) return { value: null, problem: `${at}.id ${id} is used twice` };
    seen.add(id);

    const kind = entry['kind'];
    if (!INTENT_KINDS.includes(kind as IntentKind)) {
      return { value: null, problem: `${at}.kind must be one of ${INTENT_KINDS.join(', ')}` };
    }
    const statement = text(entry['statement'], `${at}.statement`);
    if (statement.problem !== null) return { value: null, problem: statement.problem };
    const quote = text(entry['quote'], `${at}.quote`);
    if (quote.problem !== null) return { value: null, problem: quote.problem };
    const quoteProblem = excerptProblem(quote.value, sentences, `${at}.quote`);
    if (quoteProblem !== null) return { value: null, problem: quoteProblem };
    if (kind !== 'non-goal') {
      const quoted = significantWords(quote.value);
      if (![...significantWords(statement.value)].some((word) => quoted.has(word))) {
        return { value: null, problem: `${at}.quote shares no significant word with its statement` };
      }
    }

    let reason: string | undefined;
    if (kind === 'deliberate') {
      const parsed = text(entry['reason'], `${at}.reason`);
      if (parsed.problem !== null) return { value: null, problem: `${parsed.problem} on a deliberate statement` };
      const reasonProblem = excerptProblem(parsed.value, sentences, `${at}.reason`);
      if (reasonProblem !== null) return { value: null, problem: reasonProblem };
      reason = parsed.value;
    } else if (entry['reason'] !== undefined) {
      return { value: null, problem: `${at}.reason belongs only on a deliberate statement` };
    }
    if (entry['scope'] !== undefined && (kind !== 'goal' || entry['scope'] !== 'complete')) {
      return { value: null, problem: `${at}.scope may only be "complete", and only on a goal` };
    }

    statements.push({
      id,
      kind: kind as IntentKind,
      statement: statement.value,
      quote: quote.value,
      ...(reason === undefined ? {} : { reason }),
      ...(entry['scope'] === 'complete' ? { scope: 'complete' as const } : {}),
    });
  }
  return { value: { statements }, problem: null };
}
