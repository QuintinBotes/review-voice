import { splitFindings, parseFinding } from '../contract/parse.ts';
import type { Severity } from '../contract/limits.ts';

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
export function extractAnchors(output: string): { anchors: InlineAnchor[]; unanchorable: number } {
  const blocks = splitFindings(output);
  const anchors = blocks
    .map((block) => parseFinding(block.raw, block.startLine))
    .filter((finding) => finding.severity !== null && finding.path !== null && finding.line !== null)
    .map((finding, index) => ({
      findingId: `rv_${String(index + 1).padStart(2, '0')}`,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      body: finding.raw,
    }));

  // A finding the contract accepted but that carries no line cannot be
  // anchored. Counted, because the alternative is an inline comment silently
  // going missing.
  return { anchors, unanchorable: blocks.length - anchors.length };
}
