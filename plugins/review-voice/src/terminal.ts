/**
 * Text from a pull request, a reproduction, a tool or a model can carry
 * terminal control sequences: an OSC 52 write sets the clipboard of whoever
 * prints it, and CSI and OSC sequences can rewrite or hide what a command
 * shows (docs/THREAT-MODEL.md).
 */

/**
 * What a terminal executes or ignores without leaving the sequence it is in:
 * the C0 and C1 controls that neither start, end nor cancel a sequence, DEL,
 * the format characters (bidi, zero-width), and a lone carriage return, which
 * lets a later line print over an earlier one. Removed first, so one placed
 * inside a sequence cannot leave that sequence's bytes behind as text.
 */
const TRANSPARENT = /[\u0000-\u0006\u0008\u000b\u000c\u000e-\u0017\u0019\u001c-\u001f\u007f-\u008f\u0091-\u0097\u0099\u009a\p{Cf}]|\r(?!\n)/gu;

// A tab or a BEL inside an ESC or CSI sequence is executed and the sequence
// goes on, so it is taken with the sequence: a tab left behind would split a
// value past a mask, and a later cut of whitespace would join it again. CAN, SUB, another ESC and the end of the line or the text cut a
// sequence short, and what it had taken goes with it. A sequence never runs
// past its line: one a tool echoed from a source file must not take the
// diagnostics after it, so what follows a newline inside one stays as text.
/** CSI: every parameter and intermediate byte, in any order as a terminal skips a malformed one, to the final byte. */
const CSI = /(?:\u001b[\t\u0007]*\[|\u009b)[\t\u0007 -?]*[@-~]?/;
/** The string forms (OSC, DCS, SOS, PM, APC), up to the BEL or ST that ends one; that goes as a short form or with ENDS. */
const STRING = /(?:\u001b[\t\u0007]*[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u0018\u001a\u001b\u009c\r\n]*/;
/** Every other ESC, with its intermediates and final byte. */
const SHORT = /\u001b[\t\u0007 -/]*[0-~]?/;
const SEQUENCE = new RegExp([CSI, STRING, SHORT].map((form) => form.source).join('|'), 'g');

/** What ends or cancels a sequence, which is all that is left of one: BEL, CAN, SUB and the C1 string terminator. */
const ENDS = /[\u0007\u0018\u001a\u009c]/g;

/**
 * The text with every terminal sequence, control and format character
 * removed, keeping tabs, newlines and a carriage return that ends a line.
 */
export function terminalSafe(text: string): string {
  return text
    .replace(TRANSPARENT, '')
    .replace(SEQUENCE, '')
    .replace(ENDS, '');
}

/** A copy of parsed JSON with every string, keys included, made terminal safe. */
export function terminalSafeDeep<T>(value: T): T {
  if (typeof value === 'string') return terminalSafe(value) as T;
  if (Array.isArray(value)) return value.map((entry: unknown) => terminalSafeDeep(entry)) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [terminalSafe(key), terminalSafeDeep(entry)])) as T;
}

/**
 * Text for a stream a later stage may parse: what `JSON.stringify` leaves raw
 * (DEL, the C1 controls and the format characters) written as a JSON escape,
 * so a parser reads the same data and a terminal acts on none of it.
 */
export function terminalInert(text: string): string {
  return text.replace(/[\u007f-\u009f\p{Cf}]/gu, (character) =>
    // By code unit, so a character outside the basic plane is written as its surrogate pair.
    character.split('').map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  );
}

/**
 * Text for the CLI's own output stream. A JSON document, which a later stage
 * may parse, keeps its data and is made inert. Anything else is a line for a
 * person and is made terminal safe, so a sequence in it goes whole, where an
 * escape would leave the sequence's parameters beside it as text.
 */
export function outputSafe(text: string): string {
  try {
    JSON.parse(text);
  } catch {
    return terminalSafe(text);
  }
  return terminalInert(text);
}
