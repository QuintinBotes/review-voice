import { splitFindings, parseFinding } from '../contract/parse.ts';

export interface DraftComment {
  path: string;
  line: number;
  body: string;
}

export interface DraftReview {
  repository: string;
  pullNumber: number;
  /** Deterministic from the content, so a retry cannot double-post. */
  idempotencyKey: string;
  comments: DraftComment[];
  /** Exactly what would be sent, for the user to read before confirming. */
  preview: string;
}

/**
 * Renders a validated review as a GitHub draft review.
 *
 * Nothing here posts. The draft exists so a user can read the precise text
 * that would be sent - a preview that is generated separately from what gets
 * posted is not a preview, it is a mock-up.
 */
export function buildDraft(input: {
  repository: string;
  pullNumber: number;
  output: string;
  diffHash: string;
}): DraftReview {
  const comments = splitFindings(input.output)
    .map((block) => parseFinding(block.raw, block.startLine))
    .filter((finding) => finding.severity !== null && finding.path !== null)
    .map((finding) => ({
      path: finding.path!,
      line: finding.line ?? 1,
      // Posted as written. Re-wording here would mean the reviewed text and
      // the sent text were different things.
      body: `**${finding.severity}** - ${finding.prose}`,
    }));

  const preview = [
    `Repository: ${input.repository}`,
    `Pull request: #${input.pullNumber}`,
    `Comments: ${comments.length}`,
    '',
    ...comments.map((comment) => `${comment.path}:${comment.line}\n  ${comment.body}`),
  ].join('\n');

  return {
    repository: input.repository,
    pullNumber: input.pullNumber,
    // Diff hash plus content: the same review of the same diff is the same
    // post, so a retry after a timeout cannot duplicate it.
    idempotencyKey: `${input.repository}#${input.pullNumber}@${input.diffHash}`,
    comments,
    preview,
  };
}
