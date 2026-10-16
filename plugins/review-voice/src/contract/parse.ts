import { SEVERITIES, type Severity } from './limits.ts';

export interface ParsedFinding {
  /** 1-indexed line in the submitted output where this finding starts. */
  startLine: number;
  raw: string;
  severity: Severity | null;
  path: string | null;
  line: number | null;
  /** Everything after the em dash separator. */
  prose: string;
}

const SEVERITY_ALTERNATION = SEVERITIES.join('|');

/** A line that opens a finding, whatever follows it. */
const OPENS_FINDING = new RegExp(`^\\[(?:${SEVERITY_ALTERNATION}|[a-z_]+)\\]`, 'i');

/**
 * The contract's shape: [severity] `path:line` - prose
 *
 * A plain hyphen, not an em dash. Em and en dashes read as machine-written and
 * the owner does not use them; banning the character outright is simpler to
 * enforce than asking for restraint, and the separator has to match what the
 * prose is allowed to contain.
 */
const FINDING = new RegExp(`^\\[([a-z_]+)\\]\\s+\`([^\`]+):(\\d+)\`\\s+-\\s*([\\s\\S]*)$`, 'i');

/**
 * Findings wrap across lines, so a finding runs from its opening line until
 * the next opening line, a blank line, or the end of the output. The blank
 * line matters: without it, a paragraph after the last finding was joined to
 * that finding, counted against its word limit and posted inside its comment.
 */
export function splitFindings(output: string): { raw: string; startLine: number }[] {
  return scanFindings(output).blocks;
}

/** 1-indexed lines after the first finding that belong to no finding. */
export function strayLines(output: string): number[] {
  return scanFindings(output).stray;
}

function scanFindings(output: string): { blocks: { raw: string; startLine: number }[]; stray: number[] } {
  const blocks: { raw: string; startLine: number }[] = [];
  const stray: number[] = [];
  let current: { raw: string[]; startLine: number } | null = null;
  const flush = (): void => {
    if (current) blocks.push({ raw: current.raw.join('\n').trim(), startLine: current.startLine });
    current = null;
  };

  output.split('\n').forEach((line, index) => {
    if (OPENS_FINDING.test(line)) {
      flush();
      current = { raw: [line], startLine: index + 1 };
    } else if (line.trim() === '') {
      flush();
    } else if (current) {
      current.raw.push(line);
    } else if (blocks.length > 0) {
      stray.push(index + 1);
    }
  });
  flush();
  return { blocks, stray };
}

export function parseFinding(raw: string, startLine: number): ParsedFinding {
  // Wrapped findings are joined before matching: the line breaks are a
  // rendering artifact, not part of the content.
  const joined = raw.replace(/\s*\n\s*/g, ' ').trim();
  const match = FINDING.exec(joined);

  if (!match) {
    return { startLine, raw, severity: null, path: null, line: null, prose: '' };
  }

  const [, severityRaw, path, lineRaw, prose] = match;
  const severity = (SEVERITIES as readonly string[]).includes(severityRaw!.toLowerCase())
    ? (severityRaw!.toLowerCase() as Severity)
    : null;

  return {
    startLine,
    raw,
    severity,
    path: path ?? null,
    line: Number(lineRaw),
    prose: (prose ?? '').trim(),
  };
}
