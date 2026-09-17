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

/**
 * Approval language, stripped before judging whether anything substantive is
 * left. Matching the whole body missed the common shape: a review summary that
 * opens "Approving." and then says nothing - which is how three unrelated
 * "Approving." comments ended up as the top precedents for a code finding.
 */
const APPROVAL_PHRASES =
  /\b(lgtm|looks good(?: to me)?|ship it|approv(?:ed|ing|al)|sgtm|ack(?:nowledged)?|thanks|thank you|ty|nice work|nice one|great|\+1|done|no comments?|nothing from me|all good|fine by me)\b/gi;

const DECORATION = /[\s.!?,;:\u2013\u2014-]|👍|🚀|✅|🎉|💯|🙏|😄/gu;

/** Automation status posts, which carry no judgement whatever their length. */
const AUTOMATION_STATUS = [
  /\bcodecov\b.*\breport\b/i,
  /\bdeploy(ed|ment) (preview|succeeded|failed)\b/i,
  /\bbuild (succeeded|failed)\b/i,
];

const STRUCTURE_LINE = /^\s*(?:-\s*\[[ x]\]\s|#{1,3}\s|\|.*\||-{3,}\s*$)/i;
const TEMPLATE_HEADING =
  /^\s*#{1,3}\s*(description|checklist|type of change|how has this been tested)/im;

/**
 * A pull-request template is mostly structure. A review that happens to
 * include a checklist is not.
 *
 * Measured against a real repository, the earlier rule - exclude anything
 * containing a checkbox - discarded fourteen review summaries with a median
 * length of 2,400 characters. Those are substantive reviews with a checklist
 * in them, and throwing them away was losing most of the corpus.
 */
function isTemplate(body: string): boolean {
  const lines = body.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return true;

  const structural = lines.filter((line) => STRUCTURE_LINE.test(line)).length;
  const structureRatio = structural / lines.length;

  // A template opens with its heading and is dominated by structure. Prose
  // that merely contains a checklist is not.
  if (TEMPLATE_HEADING.test(body) && structureRatio >= 0.4) return true;
  return structureRatio >= 0.6;
}

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

  // What remains once approval language and decoration are removed. A comment
  // that is only approval has nothing to teach; one that approves and then
  // raises something does.
  const substantive = body.replace(APPROVAL_PHRASES, '').replace(DECORATION, '');
  if (substantive.length < 15) return 'approval_only';

  // Below roughly a sentence there is no failure mode to extract.
  if (body.length < 15) return 'too_short';
  if (AUTOMATION_STATUS.some((pattern) => pattern.test(body))) return 'template_or_status';
  if (isTemplate(body)) return 'template_or_status';

  const filePath = input.filePath;
  if (filePath !== undefined && GENERATED_PATH.some((pattern) => pattern.test(filePath))) {
    return 'generated_file';
  }

  if (!input.hasCodeContext && filePath !== undefined) return 'no_code_context';

  return null;
}
