import type { Database } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import { runDetail, type StoredFinding } from '../store/runs.ts';
import { classifyReply, type PendingQuestion } from '../store/outcomes.ts';
import { AuthError } from '../github/auth.ts';
import { GitHubError, NotAllowlisted, type GitHubClient } from '../github/client.ts';
import { REPLY_MAX_LENGTH, WriteViolation, type ReviewWriter } from '../github/writer.ts';
import { CITATION } from '../scoring/score.ts';
import { DEFAULT_LIMITS } from '../contract/limits.ts';
import { findForbiddenPhrases } from '../contract/validate.ts';
import { redact } from '../redact/redact.ts';
import { flatten, MACHINE_PATH } from './evidence-block.ts';
import { claimKey, keyBlocked, recordedCandidates } from './post.ts';
import { planFindings } from './verdict.ts';

/**
 * One bounded reply under one of this tool's own inline comments
 * (docs/adr/0035). The text is rendered by code from the recorded run alone:
 * the head reviewed and the `path:line` references the challenger confirmed or
 * the analyst cited, in a fixed template that adds no claim. No model runs.
 */

const MAX_REFERENCES = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A `path:line` reference that may go into a comment body as inline code: no
 * whitespace, backtick or second colon, not absolute, no `~`, no dot segment.
 * An absolute one can name the reviewer's home (S16's reproduction copy), as
 * the evidence block also drops. Format characters are removed first so none
 * can hide a `/` or split a `..`, and a control character (ESC, NEL) drops the
 * reference, since it can do the same and rewrite the terminal preview.
 */
function safeReference(raw: string): string | null {
  const reference = raw.replace(/\p{Cf}/gu, '').trim();
  if (/\p{Cc}/u.test(reference) || !/^\S+:\d+(?:-\d+)?$/.test(reference)) return null;
  const path = reference.replace(/:\d+(?:-\d+)?$/, '');
  if (/[\s`:]/.test(path) || path.startsWith('~')) return null;
  if (!path.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..')) return null;
  return reference;
}

/** The three properties every posted body holds; a reference is held to them alone as well. */
function obeys(text: string): boolean {
  return (
    text.length <= REPLY_MAX_LENGTH &&
    findForbiddenPhrases(text, DEFAULT_LIMITS.forbiddenPhrases).length === 0 &&
    classifyReply(text) === 'other'
  );
}

function joined(references: string[]): string {
  const code = references.map((reference) => `\`${reference}\``);
  if (code.length === 1) return code[0]!;
  return `${code.slice(0, -1).join(', ')} and ${code[code.length - 1]!}`;
}

/**
 * The reply for one finding, or null when nothing can be quoted: a reply that
 * cannot name a recorded line would be a new claim. References are the
 * challenger's `decisive_evidence` when its verdict is `confirmed`, else the
 * `path:line` citations in the candidate's evidence; recorded order,
 * duplicates dropped, at most four, each one safe on its own.
 */
export function renderReply(input: {
  head: string | null;
  finding: StoredFinding;
  /** The score that backed the posted finding, as the evidence block finds it. */
  score: { challenge?: unknown } | undefined;
  /** The recorded candidate that score is for, from `recordedCandidates`. */
  candidate: { evidence: string[] } | undefined;
}): { body: string; references: string[]; challengeConfirmed: boolean } | null {
  const challenge = isRecord(input.score?.challenge) ? input.score.challenge : null;
  const challengeConfirmed = challenge?.['verdict'] === 'confirmed';
  const cited: string[] = challengeConfirmed
    ? (Array.isArray(challenge?.['decisive_evidence']) ? challenge['decisive_evidence'] : []).filter((entry): entry is string => typeof entry === 'string')
    : (input.candidate?.evidence ?? [])
        // A space in an absolute path (macOS keeps the data directory under
        // `Application Support`) starts a new, relative-looking citation on its
        // tail, so a line that names the machine anywhere quotes nothing.
        .filter((entry) => !MACHINE_PATH.test(flatten(entry, Number.POSITIVE_INFINITY)))
        .flatMap((entry) => [...entry.matchAll(CITATION)].map((match) => match[0].replace(/`/g, '')));
  const references: string[] = [];
  for (const entry of cited) {
    const reference = safeReference(entry);
    if (reference !== null && obeys(reference) && !references.includes(reference)) references.push(reference);
    if (references.length === MAX_REFERENCES) break;
  }
  if (references.length === 0) return null;

  const head = typeof input.head === 'string' && input.head.length >= 7 ? input.head.slice(0, 7) : 'the head it reviewed';
  // Redacted here, as thread text is on the way in, so the preview is the text
  // sent and the three properties hold on it; a label can lengthen the body.
  const body = redact(
    `Review Voice checked this at ${head}. The claim rests on ${joined(references)}.` +
      (challengeConfirmed ? ' An independent challenge confirmed it at those lines.' : '') +
      ' This reply is built from the recorded review and is not repeated.',
  ).text;
  return obeys(body) ? { body, references, challengeConfirmed } : null;
}

export interface ReplyOptions {
  db: Database;
  client: GitHubClient;
  repository: string;
  pullNumber: number;
  questions: PendingQuestion[];
  /** Built from the recorded run's repository, as `postReview` builds it. */
  writerFor: (allowlist: string[]) => ReviewWriter;
  confirm: boolean;
  postingEnabled: boolean;
}

export interface ReplyResult {
  question: PendingQuestion;
  status: 'previewed' | 'sent' | 'refused' | 'failed';
  reasons: string[];
  key: string;
  body: string | null;
  reply?: { id: number | null; url: string | null };
}

/** The key names the thread, not the text: a reworded reply to the same thread is the same reply. */
const replyKey = (question: PendingQuestion): string => `reply:${question.repository.toLowerCase()}#${question.pullNumber}:${question.rootCommentId}`;

/**
 * Posts at most one reply per pending question, under the guards a review
 * has: the posting switch, the per-thread key, a confirmation, the attempt row
 * before the request and the sent or failed row after it. Exit 0 when every
 * question was sent, previewed or refused, 1 when a send failed, 2 when
 * posting is off, with the switch's reason in `refused` so the report says
 * so even with no question to carry it.
 */
export async function postReplies(options: ReplyOptions): Promise<{ exitCode: number; replies: ReplyResult[]; refused: string[] }> {
  const subject = { type: 'pull_request', id: `${options.repository.toLowerCase()}#${options.pullNumber}` };
  if (!options.postingEnabled) {
    const reasons = ['writes.github_posting_enabled is false in .review-voice/config.yaml'];
    recordAudit(options.db, 'review_reply_refused', subject, { reasons, questions: options.questions.length });
    return { exitCode: 2, refused: reasons, replies: options.questions.map((question) => ({ question, status: 'refused', reasons, key: replyKey(question), body: null })) };
  }

  const replies: ReplyResult[] = [];
  let failed = false;
  for (const question of options.questions) {
    const key = replyKey(question);
    const refuse = (reasons: string[], body: string | null = null, status: 'refused' | 'previewed' = 'refused'): void => {
      recordAudit(options.db, 'review_reply_refused', subject, { reasons, key, run: question.reviewRunId, finding: question.findingId, rootCommentId: question.rootCommentId });
      replies.push({ question, status, reasons, key, body });
    };

    const run = runDetail(options.db, question.reviewRunId);
    if (run === null || run.repository === null || run.repository.toLowerCase() !== question.repository.toLowerCase()) {
      refuse([`run ${question.reviewRunId} is not a recorded review of ${question.repository}`]);
      continue;
    }
    const finding = run.findings.find((entry) => entry.findingId === question.findingId);
    if (finding === undefined) {
      refuse([`run ${question.reviewRunId} has no finding ${question.findingId}`]);
      continue;
    }
    // The score the posted review used (same severity, the verifier's, eligible,
    // followed through a carry) and the candidate it scored, never another
    // candidate at the same line, so the reply claims what the evidence block does.
    const planned = planFindings(run.output, run, (id) => runDetail(options.db, id));
    const posted = planned.inline.find((entry) => entry.findingId === finding.findingId);
    const backing = posted === undefined ? undefined : planned.backing.get(posted);
    const rendered = renderReply({
      head: run.headRef,
      finding,
      score: backing?.score,
      candidate:
        backing === undefined ? undefined : recordedCandidates(options.db, backing.runId).find((candidate) => candidate.candidateId === backing.score.candidateId),
    });
    if (rendered === null) {
      refuse(['no recorded path:line evidence to quote']);
      continue;
    }
    const blocked = keyBlocked(options.db, key, 'review_reply_');
    if (blocked !== null) {
      refuse([blocked], rendered.body);
      continue;
    }
    if (!options.confirm) {
      refuse(['no --confirm: nothing is posted without one, per reply'], rendered.body, 'previewed');
      continue;
    }
    const claimed = claimKey(
      options.db,
      key,
      subject,
      { run: run.reviewRunId, finding: finding.findingId, rootCommentId: question.rootCommentId, askedBy: question.askedBy, stance: question.stance },
      'review_reply_attempted',
    );
    if (typeof claimed !== 'string') {
      refuse([claimed.blocked], rendered.body);
      continue;
    }
    const { body } = rendered;
    try {
      const reply = await options.writerFor([run.repository]).replyToComment(options.repository, options.pullNumber, question.rootCommentId, body);
      recordAudit(options.db, 'review_reply_sent', subject, {
        key,
        attempt: claimed,
        run: run.reviewRunId,
        finding: finding.findingId,
        rootCommentId: question.rootCommentId,
        replyId: reply.id,
        url: reply.htmlUrl,
        askedBy: question.askedBy,
        stance: question.stance,
        head: run.headRef,
      });
      replies.push({ question, status: 'sent', reasons: [], key, body, reply: { id: reply.id, url: reply.htmlUrl } });
    } catch (error) {
      const status = error instanceof GitHubError ? error.status : null;
      const message = error instanceof Error ? error.message : String(error);
      recordAudit(options.db, 'review_reply_failed', subject, {
        key,
        attempt: claimed,
        status,
        message: message.slice(0, 300),
        // Refused in code before any request, or GitHub answered with a 4xx:
        // not sent, so a retry is safe. Anything else may have been.
        uncertain: !(error instanceof WriteViolation || error instanceof NotAllowlisted || error instanceof AuthError || (status !== null && status < 500)),
      });
      replies.push({ question, status: 'failed', reasons: [message], key, body });
      failed = true;
    }
  }
  return { exitCode: failed ? 1 : 0, replies, refused: [] };
}
