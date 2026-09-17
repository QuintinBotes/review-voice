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
 * the next opening line or the end of the output.
 */
export function splitFindings(output: string): { raw: string; startLine: number }[] {
  const lines = output.split('\n');
  const blocks: { raw: string; startLine: number }[] = [];
  let current: { raw: string[]; startLine: number } | null = null;

  lines.forEach((line, index) => {
    if (OPENS_FINDING.test(line)) {
      if (current) blocks.push({ raw: current.raw.join('\n').trim(), startLine: current.startLine });
      current = { raw: [line], startLine: index + 1 };
    } else if (current) {
      current.raw.push(line);
    }
  });

  if (current) {
    const last = current as { raw: string[]; startLine: number };
    blocks.push({ raw: last.raw.join('\n').trim(), startLine: last.startLine });
  }
  return blocks;
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
