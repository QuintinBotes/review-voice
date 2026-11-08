import type { ReviewComment } from '../github/writer.ts';
import type { StoredFinding } from '../store/runs.ts';
import { safeCheckName, type EvidenceBacking, type PlannedFindings, type ScoreLike, type VerdictPolicy } from './verdict.ts';

/**
 * The collapsed block of recorded facts posted after an inline comment under
 * `verdict.evidence_block` (docs/adr/0028, 0024). The validated finding is the
 * prose before it; the block is derived text, so every reader of a posted
 * comment cuts it off at this marker before comparing words or hashing.
 */
export const EVIDENCE_MARKER = '<!-- review-voice evidence -->';

/**
 * The body before the evidence block, or the body unchanged when it has none.
 * The block is always last and ends the body, so a marker a suggestion's
 * replacement happens to hold is neither the last one nor followed only by
 * the block, and the suggestion stays for `commentSignature` to strip (S14).
 */
export function stripEvidenceBlock(body: string): string {
  const at = body.lastIndexOf(`\n\n${EVIDENCE_MARKER}`);
  return at < 0 || !body.trimEnd().endsWith('</details>') ? body : body.slice(0, at);
}

// The challenger's own `path:line` rule (src/verify/challenge.ts), checked
// again at render time because a stored row can be edited by hand.
const DECISIVE = /^\S(?:.*\S)?:\d+(?:-\d+)?$/u;
const MAX_DECISIVE = 6;
const DECISIVE_CAP = 120;
const PATH_CAP = 120;
const TEXT_CAP = 160;
const MAX_QUOTES = 2;

/**
 * An absolute, home, drive, network or climbing path anywhere in a line. Two
 * components for an absolute one, so `'/'` in a message is not a path.
 * `record` keeps such text out of the store, and the block checks again,
 * since a stored row can be edited by hand.
 */
export const MACHINE_PATH = /(?<![\w.~-])[\\/][^\s\\/'"]+[\\/]|(?<![\w.-])(?:~|\.\.)[\\/]|(?<!\w)[A-Za-z]:[\\/]/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `safeCheckName` with every other format character (the marks, the word
 * joiner, the soft hyphen, tag characters) removed first. Only the block's
 * recorded facts and the checks `record` makes on them take the wider strip,
 * so CI annotations and the scope block keep the bytes they posted before.
 */
export function flatten(text: string, max?: number): string {
  return safeCheckName(text.replace(/\p{Cf}/gu, ''), max);
}

/** Inline code, after `flatten` has removed backticks, so nothing can close the span or render inside it. */
const code = (text: string): string => `\`${text}\``;

/**
 * A reference into the repository. An absolute path, one climbing out with
 * `..`, a home directory, a drive or a URL would post the reviewer's machine
 * (a run directory, a reproduction copy) on the pull request. One token, so
 * prose around a path, which could carry any of those or a model or a
 * confidence, is never posted.
 */
function repositoryRelative(reference: string): boolean {
  const path = reference.replace(/:\d+(?:-\d+)?$/, '');
  return !path.startsWith('~') && !/[\s:]/.test(path) && path.split(/[\\/]/).every((part) => part !== '' && part !== '..');
}

/** What the challenger decided about a finding, as both the block and `explain` show it. */
export interface ChallengeFacts {
  verdict: 'confirmed' | 'partly' | 'refuted';
  /** `line confirmed`, `anchor moved from line N`, or null when the record says neither. */
  line: string | null;
  /** The decisive `path:line` references that are safe to show, flattened and capped. */
  decisive: string[];
}

/** Null when the challenger did not run on the score, or its record is not one. */
export function challengeFacts(score: ScoreLike | null): ChallengeFacts | null {
  const challenge = score?.challenge;
  if (!isRecord(challenge)) return null;
  const verdict = challenge['verdict'];
  if (verdict !== 'confirmed' && verdict !== 'partly' && verdict !== 'refuted') return null;
  // `corrected_line` is where the finding moved to, which is the comment's own
  // anchor; the line it moved from is the one `reanchor` kept.
  const from = score?.reanchoredFrom?.line;
  const line =
    challenge['line_ok'] === true
      ? 'line confirmed'
      : typeof from === 'number' && Number.isInteger(from) && from > 0
        ? `anchor moved from line ${from}`
        : null;
  const evidence = Array.isArray(challenge['decisive_evidence']) ? challenge['decisive_evidence'] : [];
  const decisive = evidence
    .filter((entry): entry is string => typeof entry === 'string')
    // Flattened before the checks, since a backtick or an invisible character
    // could otherwise hide a leading `/` or split a `..` that flattening restores.
    .map((entry) => flatten(entry, Number.POSITIVE_INFINITY))
    .filter((entry) => DECISIVE.test(entry) && repositoryRelative(entry))
    .map((entry) => flatten(entry, DECISIVE_CAP))
    .slice(0, MAX_DECISIVE);
  return { verdict, line, decisive };
}

/**
 * The evidence block for one inline finding, from its stored finding and the
 * score that verified it, both from the run that scored it.
 *
 * Pure, so two renders of one run are identical. Every line is a recorded
 * fact, so nothing is re-derived and no agent runs. A line whose source is absent
 * is left out; the first line is the only fixed one. It never carries a reason any
 * agent wrote, a confidence, a model, a held or unverified claim, a precedent's
 * excerpt, id or login, or anything the human-review note says (docs/adr/0012,
 * 0016). Empty when there is no verifier's score to describe.
 */
export function evidenceBlock(
  finding: StoredFinding | undefined,
  backing: ScoreLike | null,
  policy: Pick<VerdictPolicy, 'evidenceBlockPrecedents'>,
): string {
  if (backing === null || backing.confidenceSource !== 'verifier') return '';
  const challenge = challengeFacts(backing);
  const verdict = challenge === null ? 'not run' : [challenge.verdict, challenge.line].filter((part) => part !== null).join(', ');
  const lines = [`Verified by the evidence verifier. Challenger: ${verdict}.`];
  if (challenge !== null && challenge.decisive.length > 0) {
    lines.push(`Decisive lines: ${challenge.decisive.map(code).join(', ')}.`);
  }

  const signal: unknown = finding?.toolSignal;
  if (isRecord(signal) && typeof signal['tool'] === 'string' && typeof signal['text'] === 'string') {
    const tool = flatten(signal['tool']);
    const text = flatten(signal['text'], TEXT_CAP);
    if (tool !== '' && text !== '' && !MACHINE_PATH.test(tool) && !MACHINE_PATH.test(text)) {
      lines.push(`Static check ${code(tool)} also flagged this line: ${code(text)}`);
    }
  }

  // The quote is inline code because the document can come from the pull
  // request's head, so a mention, a link or `</details>` in it must not render.
  // Only the quotes the backing candidate itself cited: two candidates can
  // share an anchor, and one's quote must not stand beside the other's facts.
  const quotesOwner = finding?.conventionQuotesCandidate;
  const ownQuotes = typeof quotesOwner === 'string' && typeof backing.candidateId === 'string' && quotesOwner === backing.candidateId;
  const quotes: unknown = ownQuotes ? finding?.conventionQuotes : undefined;
  const conventions = (Array.isArray(quotes) ? quotes : [])
    .filter((entry): entry is { path: string; quote: string } => isRecord(entry) && typeof entry['path'] === 'string' && typeof entry['quote'] === 'string')
    .map((entry) => ({ path: flatten(entry.path, PATH_CAP), quote: flatten(entry.quote, TEXT_CAP) }))
    .filter((entry) => entry.path !== '' && entry.quote !== '')
    .slice(0, MAX_QUOTES);
  for (const entry of conventions) lines.push(`Convention ${code(entry.path)} says ${code(entry.quote)}.`);

  // A count only. Zero is a fact about the precedents retrieved, never an
  // absence of them, so the line needs at least one.
  if (policy.evidenceBlockPrecedents && Array.isArray(backing.precedents) && backing.precedents.length > 0) {
    const favour = backing.precedents.filter(
      (precedent) => isRecord(precedent) && precedent['role'] === 'owner' && precedent['polarity'] === 'positive',
    ).length;
    lines.push(`Owner precedents in favour: ${favour} of ${backing.precedents.length} retrieved.`);
  }

  return [EVIDENCE_MARKER, '<details><summary>Evidence</summary>', '', ...lines, '', '</details>'].join('\n');
}

/**
 * What backs the inline finding at this anchor, found as the block for the
 * comment posted there finds it. `explain` reads its challenge line from here,
 * so a held candidate at the same anchor cannot make the two disagree.
 */
export function backingAt(planned: Pick<PlannedFindings, 'inline' | 'backing'>, path: string, line: number): EvidenceBacking | undefined {
  const finding = planned.inline.find((candidate) => candidate.path === path && candidate.line === line);
  return finding === undefined ? undefined : planned.backing.get(finding);
}

/**
 * The comments with the evidence block after each body, and how many carry one.
 * Each comment's finding is found by its anchor among the inline findings, and
 * its score and stored finding come from `planned.backing`, so nothing is
 * looked up a second time. Applied after the idempotency key is taken and the
 * comments already sent are filtered out, so neither moves with the setting.
 */
export function withEvidenceBlocks(
  comments: readonly ReviewComment[],
  planned: Pick<PlannedFindings, 'inline' | 'backing'>,
  policy: Pick<VerdictPolicy, 'evidenceBlockPrecedents'>,
): { comments: ReviewComment[]; blocks: number } {
  let blocks = 0;
  const out = comments.map((comment) => {
    const backing = backingAt(planned, comment.path, comment.line);
    const block = backing === undefined ? '' : evidenceBlock(backing.stored, backing.score, policy);
    if (block === '') return comment;
    blocks += 1;
    return { ...comment, body: `${comment.body}\n\n${block}` };
  });
  return { comments: out, blocks };
}
