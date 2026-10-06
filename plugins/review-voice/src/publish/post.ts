import type { Database } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import { latestRunForPull, runDetail, type RunDetail } from '../store/runs.ts';
import { humanReviewNote, type ComplexityAssessment } from '../diff/complexity.ts';
import { AuthError } from '../github/auth.ts';
import { GitHubError, NotAllowlisted, type GitHubClient } from '../github/client.ts';
import { REVIEW_EVENTS, WriteViolation, type ReviewWriter } from '../github/writer.ts';
import { readCi, type CiState, type GateCheck } from './ci.ts';
import { evaluatePostingGate, type GateResult } from './gate.ts';
import {
  buildPayload,
  commentSignature,
  decide,
  idempotencyKey,
  planFindings,
  renderPreview,
  type Action,
  type HeldBack,
  type ReviewEvent,
  type ReviewPayload,
} from './verdict.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface VerdictOptions {
  db: Database;
  client: GitHubClient;
  repository: string;
  pullNumber: number;
  /** The head the review read. */
  head: string;
  /** The validated review text. */
  review: string;
  /** The recorded run whose verification decides what posts; default the newest for this pull request. */
  runId?: string | undefined;
  recheck?: boolean | undefined;
  gateChecks?: readonly GateCheck[] | undefined;
  /** The time a stuck check is judged against, in epoch milliseconds; default now. */
  now?: number | undefined;
}

export interface VerdictOutput {
  event: ReviewEvent | null;
  action: Action;
  reasons: string[];
  head: { expected: string; actual: string | null };
  ci: CiState | null;
  run: string | null;
  held: HeldBack[];
  /** The recorded assessment, the pull request's own or a prior run's; null when none was recorded. */
  complexity: ComplexityAssessment | null;
  /** For the agent to tell the user; never in the posted review. Null unless the change is high-complexity. */
  humanReviewNote: string | null;
  /** What would be sent: inline comments already posted on this head are left out. */
  payload: ReviewPayload | null;
  /** Inline comments an earlier post of this head already sent. */
  alreadyInline: number;
  /** Repository, pull request, head and a hash of the full review; null when nothing would be sent. */
  key: string | null;
  preview: string | null;
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/** The audit subject for one pull request. Lower case, so spelling cannot split its history. */
function subjectId(repository: string, pullNumber: number): string {
  return `${repository.toLowerCase()}#${pullNumber}`;
}

/** The pull request's current head, read fresh. */
export async function readHead(client: GitHubClient, repository: string, pullNumber: number): Promise<string | null> {
  const { data } = await client.get<{ head?: { sha?: unknown } }>(`/repos/${repository}/pulls/${pullNumber}`);
  const sha = data?.head?.sha;
  return typeof sha === 'string' ? sha.toLowerCase() : null;
}

function refusal(head: string, reason: string): { exitCode: number; output: VerdictOutput; run: null } {
  return {
    exitCode: 2,
    run: null,
    output: {
      event: null,
      action: 'refuse',
      reasons: [reason],
      head: { expected: head, actual: null },
      ci: null,
      run: null,
      held: [],
      complexity: null,
      humanReviewNote: null,
      payload: null,
      alreadyInline: 0,
      key: null,
      preview: null,
    },
  };
}

/** How far back a narrower run's history is followed for an earlier assessment. */
const MAX_PRIOR_DEPTH = 8;

/**
 * The complexity assessment that applies to the pull request.
 *
 * A narrower later run (incremental, interdiff, unchanged) only saw part of
 * the change, so it follows its prior runs and a high assessment anywhere
 * along the chain stands; otherwise easy commits after a complex one would
 * earn the whole change an approval. A full run stands alone. The first high
 * run found supplies the reasons, and null means none recorded an assessment.
 */
function pullRequestComplexity(run: RunDetail, loadRun: (id: string) => RunDetail | null): ComplexityAssessment | null {
  let found: ComplexityAssessment | null = run.complexity;
  if (found?.level === 'high') return found;

  const seen = new Set<string>([run.reviewRunId]);
  let current: RunDetail = run;
  for (let depth = 0; depth < MAX_PRIOR_DEPTH; depth += 1) {
    if (current.scope === null || current.scope.kind === 'full') break;
    const priorId = current.scope.priorRunId;
    if (priorId === null || seen.has(priorId)) break;
    seen.add(priorId);
    const prior = loadRun(priorId);
    if (prior === null) break;
    if (prior.complexity?.level === 'high') return prior.complexity;
    found = found ?? prior.complexity;
    current = prior;
  }
  return found;
}

/** Picks the recorded run and checks it is the review on stdin, for this head. */
function recordedRun(options: VerdictOptions, head: string): RunDetail | string {
  const runId =
    options.runId ?? latestRunForPull(options.db, options.repository, options.pullNumber)?.reviewRunId ?? null;
  if (runId === null) {
    return `no review of ${options.repository}#${options.pullNumber} is recorded; record it first, so what posts is what was verified`;
  }
  const run = runDetail(options.db, runId);
  if (run === null) return `run ${runId} is not recorded`;
  if (run.repository?.toLowerCase() !== options.repository.toLowerCase() || run.pullNumber !== options.pullNumber) {
    return `run ${runId} is not a review of ${options.repository}#${options.pullNumber}`;
  }
  const recordedHead = run.headRef?.toLowerCase() ?? null;
  if (recordedHead === null || !(recordedHead === head || (recordedHead.length >= 7 && head.startsWith(recordedHead)))) {
    return `run ${runId} reviewed ${recordedHead ?? 'no recorded head'}, not ${head}`;
  }
  // The text posted has to be the text that was recorded and verified. A
  // review edited after recording would be matched to scores it never earned.
  if (normalise(run.output) !== normalise(options.review)) {
    return `the review on stdin is not the review recorded as run ${runId}`;
  }
  return run;
}

/** Signatures of inline comments already sent to this pull request at this head. */
function sentInline(db: Database, repository: string, pullNumber: number, head: string): Set<string> {
  const rows = db
    .prepare(`SELECT metadata_json FROM audit_events WHERE action = 'review_post_sent' AND subject_id = ?`)
    .all(subjectId(repository, pullNumber)) as { metadata_json: string }[];
  const sent = new Set<string>();
  for (const row of rows) {
    const meta = JSON.parse(row.metadata_json) as { head?: unknown; inline?: unknown };
    if (meta.head !== head || !Array.isArray(meta.inline)) continue;
    for (const signature of meta.inline) if (typeof signature === 'string') sent.add(signature);
  }
  return sent;
}

/**
 * Computes the verdict, read-only (`RV verdict`, and the first half of `RV post`).
 *
 * Head and CI are read live, never taken from an earlier preview.
 */
export async function computeVerdict(
  options: VerdictOptions,
): Promise<{ exitCode: number; output: VerdictOutput; run: RunDetail | null }> {
  const head = options.head.toLowerCase();
  if (!SHA.test(head)) return refusal(options.head, '--head must be the full commit sha the review read');

  const run = recordedRun(options, head);
  if (typeof run === 'string') return refusal(head, run);

  const planned = planFindings(options.review, run, (id) => runDetail(options.db, id));

  const actual = await readHead(options.client, options.repository, options.pullNumber);
  const headMoved = actual !== head;
  const ci = headMoved
    ? null
    : await readCi(options.client, options.repository, head, options.gateChecks ?? [], options.now ?? Date.now());

  const complexity = pullRequestComplexity(run, (id) => runDetail(options.db, id));
  const needsHuman = complexity?.level === 'high';

  const decision = decide({
    mapped: planned.mapped,
    headMoved,
    ci: ci?.state ?? null,
    rerun: ci?.rerun,
    recheck: options.recheck === true,
    heldBackApproval: planned.heldBackApproval,
    needsHuman,
  });
  // Only a missing assessment is worth saying: a normal one changes nothing.
  if (complexity === null) decision.reasons.push('no complexity assessment was recorded for this run');

  let payload: ReviewPayload | null = null;
  let preview: string | null = null;
  let key: string | null = null;
  let alreadyInline = 0;
  if (decision.action === 'post' && decision.event !== null) {
    const full = buildPayload({
      head,
      event: decision.event,
      planned,
      cappedBy: decision.cappedByCi
        ? 'ci'
        : planned.heldBackApproval
          ? 'held'
          : needsHuman && planned.mapped === 'APPROVE'
            ? 'complexity'
            : null,
    });
    // Keyed on the whole review, so the same review is refused a second time
    // even once its comments are all on the pull request.
    key = idempotencyKey(options.repository, options.pullNumber, full);
    // A comment already posted on this head, by an earlier COMMENT while CI
    // was red, is not posted again when the approval follows.
    const sent = sentInline(options.db, options.repository, options.pullNumber, head);
    const comments = full.comments.filter((comment) => !sent.has(commentSignature(comment)));
    alreadyInline = full.comments.length - comments.length;
    payload = { ...full, comments };
    preview = renderPreview({
      repository: options.repository,
      pullNumber: options.pullNumber,
      payload,
      held: planned.held,
      alreadyInline,
    });
  }

  return {
    exitCode: decision.exitCode,
    run,
    output: {
      event: decision.event,
      action: decision.action,
      reasons: decision.reasons,
      head: { expected: head, actual },
      ci,
      run: run.reviewRunId,
      held: planned.held,
      complexity,
      humanReviewNote: humanReviewNote(complexity),
      payload,
      alreadyInline,
      key,
      preview,
    },
  };
}

export interface PostOptions extends VerdictOptions {
  /**
   * Builds the writer from an allowlist. The allowlist is the recorded run's
   * repository: having reviewed that pull request is the consent to post to
   * it, and a flag on the command line is not.
   */
  writerFor: (allowlist: string[]) => ReviewWriter;
  /** Given per invocation. There is no setting that implies it. */
  confirm: boolean;
  /** The event the user saw in the preview and confirmed. */
  event?: string | undefined;
  /** `writes.github_posting_enabled`. */
  postingEnabled: boolean;
}

export interface PostOutput {
  status: 'sent' | 'refused' | 'failed';
  reasons: string[];
  key: string | null;
  verdict: VerdictOutput | null;
  /** The measured-precision gate: reported with every post, binding on none (docs/adr/0010). */
  postCheck: GateResult;
  review?: { id: number | null; url: string | null; state: string | null };
  error?: { status: number | null; message: string };
}

/**
 * Why a key may not be sent again, or null when it may.
 *
 * Sent is final. So is an attempt whose outcome is unknown: no outcome was
 * recorded, or the request failed without a definite answer from GitHub (a
 * network error or a 5xx), because the review may have been created anyway and
 * a retry is then a second review. A 4xx is GitHub saying no, so another
 * attempt is safe.
 */
export function keyBlocked(db: Database, key: string): string | null {
  const rows = db
    .prepare(
      `SELECT audit_id, action, metadata_json FROM audit_events
       WHERE action LIKE 'review_post_%' AND json_extract(metadata_json, '$.key') = ?`,
    )
    .all(key) as { audit_id: string; action: string; metadata_json: string }[];

  const parsed = rows.map((row) => ({ id: row.audit_id, action: row.action, meta: JSON.parse(row.metadata_json) as Record<string, unknown> }));
  if (parsed.some((row) => row.action === 'review_post_sent')) {
    return 'this exact review of this head was already sent';
  }
  for (const attempt of parsed.filter((row) => row.action === 'review_post_attempted')) {
    const outcome = parsed.find(
      (row) => (row.action === 'review_post_sent' || row.action === 'review_post_failed') && row.meta['attempt'] === attempt.id,
    );
    if (outcome === undefined || outcome.meta['uncertain'] === true) {
      return 'an earlier attempt with this key got no definite answer from GitHub and may have posted; check the pull request';
    }
  }
  return null;
}

/**
 * Checks the key and records the attempt as one step. Two posts of the same
 * review started together would otherwise both pass the check before either
 * wrote its attempt.
 */
function claimKey(db: Database, key: string, subject: { type: string; id: string }, metadata: Record<string, unknown>): string | { blocked: string } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const blocked = keyBlocked(db, key);
    if (blocked !== null) {
      db.exec('ROLLBACK');
      return { blocked };
    }
    const attempt = recordAudit(db, 'review_post_attempted', subject, { key, ...metadata });
    db.exec('COMMIT');
    return attempt;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Submits the review (`RV post`).
 *
 * Every refusal happens before the request and is audited; nothing here
 * retries. The idempotency key is written as attempted before the request, so
 * a crash or timeout leaves a record that blocks a blind second send.
 */
export async function postReview(options: PostOptions): Promise<{ exitCode: number; output: PostOutput }> {
  const subject = { type: 'pull_request', id: subjectId(options.repository, options.pullNumber) };
  // Reported, not enforced: verification is the gate for a finding, and the
  // measurement stays visible on every post.
  const postCheck = evaluatePostingGate(options.db, options.postingEnabled);

  const refuse = (
    exitCode: number,
    reasons: string[],
    verdict: VerdictOutput | null,
    key: string | null,
  ): { exitCode: number; output: PostOutput } => {
    recordAudit(options.db, 'review_post_refused', subject, {
      reasons,
      key,
      head: options.head,
      event: verdict?.event ?? null,
    });
    return { exitCode, output: { status: 'refused', reasons, key, verdict, postCheck } };
  };

  if (!options.postingEnabled) {
    return refuse(2, ['writes.github_posting_enabled is false in .review-voice/config.yaml'], null, null);
  }
  if (options.confirm && !REVIEW_EVENTS.includes(options.event as ReviewEvent)) {
    return refuse(
      2,
      [`--confirm needs --event ${REVIEW_EVENTS.join('|')}, the event shown in the preview`],
      null,
      null,
    );
  }

  let computed: Awaited<ReturnType<typeof computeVerdict>>;
  try {
    computed = await computeVerdict({ ...options, recheck: false });
  } catch (error) {
    return refuse(1, [`could not read the pull request or its CI: ${error instanceof Error ? error.message : String(error)}`], null, null);
  }
  const { exitCode, output: verdict, run } = computed;
  if (verdict.action !== 'post' || verdict.payload === null || verdict.key === null || run === null) {
    return refuse(exitCode === 0 ? 2 : exitCode, verdict.reasons, verdict, null);
  }

  const payload = verdict.payload;
  const key = verdict.key;
  const blocked = keyBlocked(options.db, key);
  if (blocked !== null) return refuse(2, [blocked], verdict, key);

  if (!options.confirm) {
    return refuse(2, ['no --confirm: nothing is posted without one, per post'], verdict, key);
  }
  // The confirmation was given for one event. CI or the head can change it
  // between the preview and the send, and an approval nobody saw is not one
  // anybody gave.
  if (payload.event !== options.event) {
    return refuse(
      3,
      [`the event is now ${payload.event}, not the ${String(options.event)} that was confirmed; preview it again`],
      verdict,
      key,
    );
  }
  if (run.repository === null || run.repository.toLowerCase() !== options.repository.toLowerCase()) {
    return refuse(2, [`run ${run.reviewRunId} reviewed ${run.repository ?? 'no repository'}, not ${options.repository}`], verdict, key);
  }

  // An approval is the one event that can unblock a merge, so its two guards
  // are read again at the moment of sending rather than trusted from above.
  // Before the attempt is recorded, so a failed re-read leaves no attempt
  // without an outcome behind it.
  if (payload.event === 'APPROVE') {
    let reread: { head: string | null; ci: CiState };
    try {
      reread = {
        head: await readHead(options.client, options.repository, options.pullNumber),
        ci: await readCi(options.client, options.repository, payload.commit_id, options.gateChecks ?? [], options.now ?? Date.now()),
      };
    } catch (error) {
      return refuse(1, [`could not re-read head and CI before approving: ${error instanceof Error ? error.message : String(error)}`], verdict, key);
    }
    if (reread.head !== payload.commit_id) {
      return refuse(3, ['the pull request head moved before sending; review the new head'], verdict, key);
    }
    if (reread.ci.state !== 'green') {
      return refuse(
        reread.ci.state === 'pending' ? 4 : reread.ci.state === 'needs-rerun' ? 6 : 5,
        [`CI turned ${reread.ci.state} before sending; not approving`],
        { ...verdict, ci: reread.ci },
        key,
      );
    }
  }

  const claimed = claimKey(options.db, key, subject, {
    head: payload.commit_id,
    event: payload.event,
    comments: payload.comments.length,
    run: run.reviewRunId,
  });
  if (typeof claimed !== 'string') return refuse(2, [claimed.blocked], verdict, key);
  const attempt = claimed;

  try {
    const writer = options.writerFor([run.repository]);
    const review = await writer.submitReview(options.repository, options.pullNumber, payload);
    recordAudit(options.db, 'review_post_sent', subject, {
      key,
      attempt,
      head: payload.commit_id,
      event: payload.event,
      inline: payload.comments.map(commentSignature),
      reviewId: review.id,
      url: review.htmlUrl,
    });
    return {
      exitCode: 0,
      output: { status: 'sent', reasons: verdict.reasons, key, verdict, postCheck, review: { id: review.id, url: review.htmlUrl, state: review.state } },
    };
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : null;
    const message = error instanceof Error ? error.message : String(error);
    recordAudit(options.db, 'review_post_failed', subject, {
      key,
      attempt,
      status,
      message: message.slice(0, 300),
      // Refused in code before any request, or GitHub answered with a 4xx: not
      // sent. Anything else may have been.
      uncertain: !(
        error instanceof WriteViolation ||
        error instanceof NotAllowlisted ||
        error instanceof AuthError ||
        (status !== null && status < 500)
      ),
    });
    return {
      exitCode: 1,
      output: { status: 'failed', reasons: [message], key, verdict, postCheck, error: { status, message } },
    };
  }
}
