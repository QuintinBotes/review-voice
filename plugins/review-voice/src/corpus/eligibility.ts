import type { ReviewerRole } from '../github/roles.ts';

export interface EligibilityInput {
  body: string;
  role: ReviewerRole;
  filePath?: string | undefined;
  hasCodeContext: boolean;
}

export type Ineligible =
  | 'bot'
  | 'external_reviewer'
  | 'approval_only'
  | 'too_short'
  | 'generated_file'
  | 'no_code_context'
  | 'template_or_status';

/** Approval-only text carries no judgement to learn from. */
const APPROVAL_ONLY =
  /^\s*(lgtm|looks good(?: to me)?|ship it|👍|🚀|\+1|nice|thanks|ty|done|ack|acknowledged|sgtm|✅)[\s.!]*$/i;

/** Checklists and automation status posts are not review judgement. */
const TEMPLATE_OR_STATUS = [
  /^\s*#{1,3}\s*(description|checklist|type of change|how has this been tested)/im,
  /^\s*-\s*\[[ x]\]\s/m,
  /\bcodecov\b.*\breport\b/i,
  /\bdeploy(ed|ment) (preview|succeeded|failed)\b/i,
  /\bbuild (succeeded|failed)\b/i,
];

const GENERATED_PATH = [
  /(^|\/)(dist|build|out|coverage|node_modules|vendor|third_party)\//,
  /\.min\.(js|css)$/,
  /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$/,
];

/**
 * Decides whether a historical comment is worth learning from.
 *
 * The bar is "does this carry review judgement", not "is this a comment". A
 * corpus padded with LGTMs and checklist templates teaches the reviewer
 * nothing while making every retrieval noisier.
 */
export function ineligibleReason(input: EligibilityInput): Ineligible | null {
  if (input.role === 'bot') return 'bot';

  // The owner chose to learn from themselves and teammates only. External
  // contributors' comments are other people's words, and their judgement was
  // never the thing being modelled.
  if (input.role === 'external') return 'external_reviewer';

  const body = input.body.trim();
  if (body.length === 0) return 'too_short';
  if (APPROVAL_ONLY.test(body)) return 'approval_only';
  // Below roughly a sentence there is no failure mode to extract.
  if (body.length < 15) return 'too_short';
  if (TEMPLATE_OR_STATUS.some((pattern) => pattern.test(body))) return 'template_or_status';

  const filePath = input.filePath;
  if (filePath !== undefined && GENERATED_PATH.some((pattern) => pattern.test(filePath))) {
    return 'generated_file';
  }

  if (!input.hasCodeContext && filePath !== undefined) return 'no_code_context';

  return null;
}
