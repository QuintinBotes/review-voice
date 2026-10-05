/** A right-side span named by one unified-diff hunk. */
export interface HunkRange {
  start: number;
  end: number;
}

/**
 * The anchorable locations a textual diff establishes for one right-side file.
 *
 * Context is retained even though it is not valid. Saying that an anchor is on
 * context rather than merely outside a hunk gives the analyst a useful route
 * back to the changed line that supports the same finding.
 */
export interface FileHunks {
  added: Set<number>;
  context: Set<number>;
  deletionSites: Set<number>;
  ranges: HunkRange[];
  patchLines: Map<number, number>;
}

export type AnchorKind =
  | 'added'
  | 'deletion-site'
  | 'context'
  | 'outside-hunk'
  | 'file-not-in-diff'
  | 'stale-consumer';

/** The changed line a stale-consumer finding says made its consumer wrong. */
export interface AnchorCause {
  path: string;
  line: number;
  /** How the cause itself classifies: only an added line or deletion site is a cause. */
  kind: AnchorKind;
}

export interface AnchorCheck {
  /** The location classified, normalised, so a reason can name it. */
  path: string;
  line: number;
  kind: AnchorKind;
  ok: boolean;
  nearest: number[];
  patchLine: { path: string; line: number } | null;
  beyondHunks: boolean;
  /**
   * Only on a stale-consumer anchor: the changed line named as the cause, or
   * null when the candidate named none.
   */
  causedBy?: AnchorCause | null;
}

interface ActiveHunk {
  file: FileHunks;
  nextRightLine: number;
  lastRightLine: number | null;
  deleting: boolean;
  remainingOld: number;
  remainingRight: number;
}

function normalisePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function blankFileHunks(): FileHunks {
  return {
    added: new Set<number>(),
    context: new Set<number>(),
    deletionSites: new Set<number>(),
    ranges: [],
    patchLines: new Map<number, number>(),
  };
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * Decodes a path git wrote in C-quoted form.
 *
 * With `core.quotePath` at its default, git quotes any path holding non-ASCII
 * bytes, a double quote, a backslash or a control character: `café.ts` arrives
 * as `"b/caf\303\251.ts"`. Read literally, that never matches the path a
 * candidate cites, and every finding in the file would be rejected as being in
 * a file the diff does not touch. Octal escapes are bytes, so the result is
 * decoded as UTF-8 only once every escape is resolved.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[index + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]!);
      index += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Reads a `---` or `+++` header path, including the usual git prefixes. */
function headerPath(raw: string): string | null {
  // A path git did not quote ends at the tab git appends after a name holding
  // a space; a quoted one ends at its closing quote.
  const field = raw.startsWith('"') ? raw : (raw.split('\t', 1)[0] ?? raw);
  const path = unquoteGitPath(field.trimEnd());
  if (path === '/dev/null') return null;
  // Not `normalisePath`: a backslash in a header is part of the file name, not
  // a Windows separator, once the quoting is undone.
  return path.replace(/^[ab]\//, '').replace(/^\.\/+/, '');
}

/** The right-side path in a `diff --git` header, used until `+++` confirms it. */
function diffGitPath(line: string): string | null {
  const quoted = /^diff --git (?:"(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/.exec(line);
  if (quoted !== null) return headerPath(quoted[1]!);
  const match = /^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/.exec(line);
  return match === null ? null : headerPath(match[2]!);
}

function hunkHeader(line: string): { oldCount: number; start: number; count: number } | null {
  const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match === null) return null;

  const oldCount = match[1] === undefined ? 1 : Number(match[1]);
  const start = Number(match[2]);
  const count = match[3] === undefined ? 1 : Number(match[3]);
  if (
    !Number.isSafeInteger(oldCount) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(count) ||
    oldCount < 0 ||
    start < 0 ||
    count < 0
  ) return null;
  return { oldCount, start, count };
}

/** Marks a run of removed lines at its surviving right-side location. */
function settleDeletion(hunk: ActiveHunk, nextRightLine: number | null): void {
  if (!hunk.deleting) return;
  const site = nextRightLine ?? hunk.lastRightLine;
  // An existing file can be emptied by a hunk with no right-side line at all.
  // There is no head-side line to anchor in that shape, so it deliberately has
  // no deletion site rather than inventing a line number the file does not own.
  if (site !== null && site > 0) hunk.file.deletionSites.add(site);
  hunk.deleting = false;
}

/**
 * Parses the parts of a unified diff that identify head-side locations.
 *
 * The parser is intentionally not a source parser. A patch's line prefixes
 * are the only authority needed for this guard, and retaining physical patch
 * lines makes the common "line in diff.patch" mistake diagnosable.
 */
export function parseHunks(diff: string): Map<string, FileHunks> {
  const files = new Map<string, FileHunks>();
  let current: FileHunks | null = null;
  let provisionalPath: string | null = null;
  let active: ActiveHunk | null = null;

  const finishHunk = () => {
    if (active === null) return;
    settleDeletion(active, null);
    active = null;
  };

  const finishWhenCounted = () => {
    if (active?.remainingOld === 0 && active.remainingRight === 0) finishHunk();
  };

  const selectPath = (path: string | null, provisional: boolean) => {
    finishHunk();
    if (provisionalPath !== null && provisionalPath !== path) files.delete(provisionalPath);
    provisionalPath = provisional ? path : null;
    current = path === null ? null : blankFileHunks();
    if (path !== null && current !== null) files.set(path, current);
  };

  for (const [index, raw] of diff.split('\n').entries()) {
    // CRLF patches have the same physical line count. Strip only the marker so
    // a line's prefix remains comparable to an ordinary LF patch.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const patchLine = index + 1;

    if (line.startsWith('diff --git ')) {
      selectPath(diffGitPath(line), true);
      continue;
    }

    const header = hunkHeader(line);
    if (header !== null) {
      finishHunk();
      // `selectPath` assigns this through a local closure. Keep the declared
      // union here rather than letting control-flow analysis freeze it at the
      // initializer seen above the loop.
      const file = current as FileHunks | null;
      if (file !== null) {
        file.ranges.push({ start: header.start, end: header.start + header.count - 1 });
        active = {
          file,
          nextRightLine: header.start,
          lastRightLine: null,
          deleting: false,
          remainingOld: header.oldCount,
          remainingRight: header.count,
        };
      }
      continue;
    }

    if (active !== null) {
      // This marker belongs to the preceding source line and changes neither
      // side's position.
      if (line === '\\ No newline at end of file') continue;

      if (line.startsWith('+')) {
        settleDeletion(active, active.nextRightLine);
        active.file.added.add(active.nextRightLine);
        active.file.patchLines.set(patchLine, active.nextRightLine);
        active.lastRightLine = active.nextRightLine;
        active.nextRightLine += 1;
        active.remainingRight -= 1;
        finishWhenCounted();
        continue;
      }
      if (line.startsWith('-')) {
        active.deleting = true;
        active.remainingOld -= 1;
        finishWhenCounted();
        continue;
      }
      // A blank context line whose single leading space was stripped by an
      // editor or a mail client. Ending the hunk there would silently lose
      // every line after it, so while the header says right-side lines remain
      // it is read as the context line it was.
      if (line.startsWith(' ') || (line === '' && active.remainingRight > 0 && active.remainingOld > 0)) {
        settleDeletion(active, active.nextRightLine);
        active.file.context.add(active.nextRightLine);
        active.file.patchLines.set(patchLine, active.nextRightLine);
        active.lastRightLine = active.nextRightLine;
        active.nextRightLine += 1;
        active.remainingOld -= 1;
        active.remainingRight -= 1;
        finishWhenCounted();
        continue;
      }

      finishHunk();
    }

    // `+++` is only a header outside a hunk. Inside one it can be an added
    // source line whose content itself begins with `++ `.
    if (line.startsWith('+++ ')) {
      selectPath(headerPath(line.slice(4)), false);
      continue;
    }

    // `---` is deliberately read but does not select a path. The right-side
    // `+++` header is authoritative for a rename and for a newly added file.
    if (line.startsWith('--- ')) continue;
  }

  finishHunk();
  // A deleted file can have a provisional `diff --git` path before its
  // `+++ /dev/null` header. `selectPath` removes it there, so no extra cleanup
  // is needed after the final file.
  return files;
}

/**
 * The changed lines closest to an anchor: every one within 3 lines, or the
 * single closest when none is that near, so a reason can always name where
 * the change actually is, however far the anchor drifted.
 */
function changedLines(file: FileHunks, line: number): number[] {
  const byDistance = [...new Set([...file.added, ...file.deletionSites])].sort(
    (left, right) => Math.abs(left - line) - Math.abs(right - line) || left - right,
  );
  const near = byDistance.filter((changed) => Math.abs(changed - line) <= 3);
  return near.length > 0 ? near : byDistance.slice(0, 1);
}

function patchLineFor(hunks: Map<string, FileHunks>, line: number): { path: string; line: number } | null {
  for (const [path, file] of hunks) {
    const fileLine = file.patchLines.get(line);
    if (fileLine !== undefined && file.added.has(fileLine)) return { path, line: fileLine };
  }
  return null;
}

/** Classifies a candidate's file location against the right side of a diff. */
export function classifyAnchor(hunks: Map<string, FileHunks>, path: string, line: number): AnchorCheck {
  // A backslash is a separator in a Windows-style citation, but part of the
  // name in a file git reported with one, so the literal path is tried first.
  const literal = path.replace(/^\.\/+/, '');
  const normalised = hunks.has(literal) ? literal : normalisePath(path);
  const file = hunks.get(normalised);
  const patchLine = patchLineFor(hunks, line);

  if (file === undefined) {
    return { path: normalised, line, kind: 'file-not-in-diff', ok: false, nearest: [], patchLine, beyondHunks: false };
  }

  const kind: AnchorKind = file.added.has(line)
    ? 'added'
    : file.deletionSites.has(line)
      ? 'deletion-site'
      : file.context.has(line)
        ? 'context'
        : 'outside-hunk';

  return {
    path: normalised,
    line,
    kind,
    ok: kind === 'added' || kind === 'deletion-site',
    nearest: changedLines(file, line),
    patchLine,
    beyondHunks: file.ranges.length > 0 && file.ranges.every((range) => line > range.end),
  };
}

/**
 * Classifies a finding about unchanged code the change made wrong.
 *
 * The consumer - a caller, a document, a config elsewhere - is on a line the
 * diff did not touch, so it can never be an inline comment. What makes it a
 * finding about this change is the cause, so the cause is what has to be an
 * added line or a deletion site. The consumer's own line is reported, never
 * judged: it is meant to be outside the diff.
 */
export function classifyStaleConsumer(
  hunks: Map<string, FileHunks>,
  path: string,
  line: number,
  causedBy: { path: string; line: number } | null,
): AnchorCheck {
  const consumer = path.replace(/^\.\/+/, '');
  if (causedBy === null) {
    return {
      path: consumer,
      line,
      kind: 'stale-consumer',
      ok: false,
      nearest: [],
      patchLine: null,
      beyondHunks: false,
      causedBy: null,
    };
  }
  const cause = classifyAnchor(hunks, causedBy.path, causedBy.line);
  return {
    path: consumer,
    line,
    kind: 'stale-consumer',
    ok: cause.ok,
    nearest: cause.nearest,
    patchLine: cause.patchLine,
    beyondHunks: cause.beyondHunks,
    causedBy: { path: cause.path, line: cause.line, kind: cause.kind },
  };
}

/** Renders the correction a failed anchor needs without guessing a replacement. */
export function reason(anchor: AnchorCheck): string {
  const { path, line } = anchor;

  if (anchor.kind === 'stale-consumer') return staleConsumerReason(anchor);

  let detail: string;
  switch (anchor.kind) {
    case 'added':
      detail = 'an added line';
      break;
    case 'deletion-site':
      detail = 'the right-side location of removed code';
      break;
    case 'context':
      detail = 'an unchanged context line';
      break;
    case 'outside-hunk':
      detail = anchor.beyondHunks ? 'past every hunk in that file' : 'outside every hunk in that file';
      break;
    case 'file-not-in-diff':
      detail = 'in a file the diff does not touch';
      break;
  }

  let rendered = `anchors on ${path}:${line}, ${detail}`;
  if (!anchor.ok && anchor.nearest.length > 0) {
    rendered += anchor.nearest.length === 1
      ? `; the nearest changed line is ${anchor.nearest[0]}`
      : `; the nearest changed lines are ${anchor.nearest.join(', ')}`;
  }
  if (!anchor.ok && anchor.patchLine !== null) {
    return `${rendered}; line ${line} of diff.patch is ${anchor.patchLine.path}:${anchor.patchLine.line} - was that the line meant?`;
  }
  return `${rendered}.`;
}


/** The stale-consumer half of `reason`, which judges the cause rather than the consumer. */
function staleConsumerReason(anchor: AnchorCheck): string {
  const consumer = `${anchor.path}:${anchor.line}`;
  const cause = anchor.causedBy ?? null;
  if (cause === null) {
    return (
      `anchors on ${consumer} as a stale consumer but names no caused_by; ` +
      'name the added line or deletion site that made it wrong.'
    );
  }
  const at = `${cause.path}:${cause.line}`;
  if (anchor.ok) {
    return `anchors on ${consumer}, an unchanged consumer made wrong by the change at ${at}; it is posted in the review body.`;
  }
  let detail = 'not a changed line';
  if (cause.kind === 'context') detail = 'an unchanged context line';
  else if (cause.kind === 'outside-hunk') detail = 'outside every hunk in that file';
  else if (cause.kind === 'file-not-in-diff') detail = 'in a file the diff does not touch';
  let rendered =
    `anchors on ${consumer} as a stale consumer, but its caused_by ${at} is ${detail}; ` +
    'the cause must be an added line or deletion site';
  if (anchor.nearest.length > 0) {
    rendered += anchor.nearest.length === 1
      ? `; the nearest changed line is ${anchor.nearest[0]}`
      : `; the nearest changed lines are ${anchor.nearest.join(', ')}`;
  }
  return `${rendered}.`;
}
