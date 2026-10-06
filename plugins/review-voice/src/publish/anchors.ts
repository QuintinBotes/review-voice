import { splitFindings, parseFinding } from '../contract/parse.ts';
import type { Severity } from '../contract/limits.ts';
import { classifyAnchor, type FileHunks } from '../diff/hunks.ts';
import { isStaleConsumer, scoresAtLocation } from './verdict.ts';

export interface InlineAnchor {
  findingId: string;
  severity: Severity | null;
  path: string | null;
  line: number | null;
  body: string;
}

/**
 * Inline anchors, taken from the validated review rather than the candidates.
 *
 * The candidate's `path` is free text from the analyst and the rendered finding
 * carries what the verifier actually read, so the two can legitimately
 * disagree - on one pull request the analyst cited
 * `InvoicePaymentRequest/InvoicePaymentRequestDetail.tsx` and the finding that
 * shipped, correctly, cited `bankTransfer/BankTransferCard.tsx`. Building
 * inline anchors from candidate records would have posted two comments against
 * the wrong file.
 *
 * The validated output is the only artefact that passed the contract, so it is
 * the only correct source for an anchor. Shared by `anchors` and by the review
 * payload, so the two cannot drift apart.
 */
export interface UnanchoredFinding {
  findingId: string;
  severity: Severity | null;
  path: string;
  line: number;
  body: string;
  /** Why it cannot be inline: `stale-consumer`, `outside-hunk` or `file-not-in-diff`. */
  reason: 'stale-consumer' | 'outside-hunk' | 'file-not-in-diff';
}

export interface AnchorChecks {
  /** Parsed diff; absent when no `--diff-file` was given, so hunks are not checked. */
  hunks?: Map<string, FileHunks> | null;
  /** Scores of the run, to tell a stale consumer apart; absent means none are known. */
  scores?: readonly unknown[] | null;
}

/**
 * A finding with a line is inline only when GitHub can take it: the line is
 * inside a hunk of the file on the RIGHT side, and it is not a stale consumer.
 * Both checks are the ones the posting path uses (`isStaleConsumer` and
 * `classifyAnchor`), so `anchors` and the review payload cannot disagree.
 * What fails them goes in the review body, not an inline comment that
 * GitHub would refuse.
 */
export function extractAnchors(
  output: string,
  checks: AnchorChecks = {},
): {
  anchors: InlineAnchor[];
  unanchorable: number;
  unanchored: UnanchoredFinding[];
  hunkChecks: 'checked' | 'skipped';
} {
  const hunks = checks.hunks ?? null;
  const scores = checks.scores ?? [];
  const anchors: InlineAnchor[] = [];
  const unanchored: UnanchoredFinding[] = [];
  const blocks = splitFindings(output);
  let index = 0;
  for (const block of blocks) {
    const finding = parseFinding(block.raw, block.startLine);
    if (finding.severity === null || finding.path === null || finding.line === null) continue;
    index += 1;
    const findingId = `rv_${String(index).padStart(2, '0')}`;
    const stale = scoresAtLocation(scores, finding.path, finding.line).some(isStaleConsumer);
    const check = hunks === null ? null : classifyAnchor(hunks, finding.path, finding.line);
    const reason = stale
      ? 'stale-consumer'
      : check !== null && (check.kind === 'outside-hunk' || check.kind === 'file-not-in-diff')
        ? check.kind
        : null;
    if (reason !== null) {
      unanchored.push({ findingId, severity: finding.severity, path: finding.path, line: finding.line, body: finding.raw, reason });
      continue;
    }
    anchors.push({ findingId, severity: finding.severity, path: finding.path, line: finding.line, body: finding.raw });
  }

  // A finding the contract accepted but that carries no line cannot be
  // anchored, nor can one routed to the body above. Counted, because the
  // alternative is an inline comment silently going missing.
  return {
    anchors,
    unanchorable: blocks.length - anchors.length,
    unanchored,
    hunkChecks: hunks === null ? 'skipped' : 'checked',
  };
}
