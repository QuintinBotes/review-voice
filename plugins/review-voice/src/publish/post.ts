import type { Database } from '../store/db.ts';
import { recordAudit } from '../store/audit.ts';
import { latestRunForPull, runDetail, type RunDetail } from '../store/runs.ts';
import { humanReviewNote, type ComplexityAssessment } from '../diff/complexity.ts';
import { AuthError } from '../github/auth.ts';
import { GitHubError, NotAllowlisted, type GitHubClient } from '../github/client.ts';
import { REVIEW_EVENTS, WriteViolation, type ReviewWriter } from '../github/writer.ts';
import { readThread } from '../diff/thread.ts';
import {
  alreadySaidOnThread,
  citedLocations,
  normaliseCandidate,
  suggestedPatchOf,
  type Candidate,
  type RawCandidate,
  type SuggestedPatch,
} from '../scoring/score.ts';
import { readCi, type CiRules, type CiState, type GateCheck } from './ci.ts';
import { evaluatePostingGate, type GateResult } from './gate.ts';
import {
  buildPayload,
  ciAllowsApproval,
  ciAnnotations,
  commentSignature,
  decide,
  idempotencyKey,
  planFindings,
  renderPreview,
  replaceAnnotations,
  scopeBlock,
  withAnnotations,
  withScopeBlock,
  verdictPolicy,
  type Action,
  type HeldBack,
  type PlannedFindings,
  type ReviewEvent,
  type ReviewFinding,
  type ReviewPayload,
  type VerdictPolicy,
  type WithheldSuggestion,
  wouldHaveSummary,
} from './verdict.ts';
import { fileAtRef, linesAt, unixLines } from './suggestion.ts';
import { withEvidenceBlocks } from './evidence-block.ts';

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
  /** Stuck thresholds and the like from `ci:` in the repository config. */
  ciRules?: CiRules | undefined;
  /** The time a stuck check is judged against, in epoch milliseconds; default now. */
  now?: number | undefined;
  /** `identity.owner_reviewer`: whose earlier request for changes may be left standing, and whose approval may be carried. */
  owner?: string | null | undefined;
  /** `verdict:` and `review.human_review.cap_approval` from the config; unset keys keep the defaults (docs/adr/0028). */
  policy?: Partial<VerdictPolicy> | undefined;
}

/** An earlier request for changes by the owner that a COMMENT will not replace. */
export interface StaleRequestChanges {
  reviewId: number;
  submittedAt: string | null;
  url: string | null;
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
  /**
   * The event the findings map to without the complexity cap, and that
   * verdict in one line: where the human reviewer starts. Shown to the user
   * beside `humanReviewNote`, never posted. Null unless high-complexity.
   */
  wouldHaveEvent: ReviewEvent | null;
  wouldHaveSummary: string | null;
  /**
   * The owner's request for changes still standing on a high-complexity pull
   * request whose new review found nothing blocking. Nothing dismisses it: the
   * agent tells the user to dismiss it by hand. Null otherwise.
   */
  staleRequestChanges: StaleRequestChanges | null;
  /** Lines an `annotate` policy appends to the posted body; empty under the defaults. */
  annotations: string[];
  /** The owner's approval that still stands, when the action is `carry`; nothing is posted then. */
  carriedReviewUrl: string | null;
  /**
   * True when `never_approve` capped an approval at COMMENT, so a caller can
   * tell a policy refusal apart from any other refusal without reading the reasons.
   */
  cappedByPolicy: boolean;
  /** What would be sent: inline comments already posted on this head are left out. */
  payload: ReviewPayload | null;
  /** Inline comments an earlier post of this head already sent. */
  alreadyInline: number;
  /** Repository, pull request, head and a hash of the full review; null when nothing would be sent. */
  key: string | null;
  preview: string | null;
  /** With `review.suggestions`, the suggestion blocks left out of their comments, and why (docs/adr/0033). */
  withheldSuggestions: WithheldSuggestion[];
  /** With `verdict.evidence_block`, how many comments in the payload carry the evidence block; 0 otherwise. */
  evidenceBlocks: number;
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
      wouldHaveEvent: null,
      wouldHaveSummary: null,
      staleRequestChanges: null,
      annotations: [],
      carriedReviewUrl: null,
      cappedByPolicy: false,
      payload: null,
      alreadyInline: 0,
      key: null,
      preview: null,
      withheldSuggestions: [],
      evidenceBlocks: 0,
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

interface RawReview {
  id?: unknown;
  user?: { login?: unknown } | null;
  state?: unknown;
  submitted_at?: unknown;
  html_url?: unknown;
  commit_id?: unknown;
}

const MAX_REVIEWS = 300;

/**
 * Where the owner currently stands on the pull request. Read only. A
 * COMMENTED review replaces neither an approval nor a request for changes on
 * GitHub, so only approvals, requests for changes and dismissals decide it;
 * the list is chronological. GitHub marks a dismissed review DISMISSED, so an
 * approval that was dismissed is not APPROVED here.
 */
async function standingOwnerReview(
  client: GitHubClient,
  repository: string,
  pullNumber: number,
  owner: string,
): Promise<{ id: number; state: string; submittedAt: string | null; url: string | null; commitId: string | null } | null> {
  const reviews = await client.paginate<RawReview>(`/repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`, MAX_REVIEWS);
  const deciding = reviews.filter(
    (review) =>
      typeof review.user?.login === 'string' &&
      review.user.login.toLowerCase() === owner.toLowerCase() &&
      (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED'),
  );
  const latest = deciding[deciding.length - 1];
  if (latest === undefined || typeof latest.id !== 'number') return null;
  return {
    id: latest.id,
    state: String(latest.state),
    submittedAt: typeof latest.submitted_at === 'string' ? latest.submitted_at : null,
    url: typeof latest.html_url === 'string' ? latest.html_url : null,
    commitId: typeof latest.commit_id === 'string' ? latest.commit_id.toLowerCase() : null,
  };
}

/** The owner's request for changes, when it is where the owner currently stands. */
async function standingRequestChanges(
  client: GitHubClient,
  repository: string,
  pullNumber: number,
  owner: string,
): Promise<StaleRequestChanges | null> {
  const latest = await standingOwnerReview(client, repository, pullNumber, owner);
  if (latest === null || latest.state !== 'CHANGES_REQUESTED') return null;
  return { reviewId: latest.id, submittedAt: latest.submittedAt, url: latest.url };
}

/**
 * The owner's approval to carry when the run's scope is unchanged and
 * `carry_approval_on_unchanged` is on (docs/adr/0028), or null. Never fatal:
 * without an answer the verdict is computed as usual, and the reason says so.
 */
async function carriedApproval(options: VerdictOptions, run: RunDetail, reasons: string[]): Promise<string | null> {
  if (run.scope?.kind !== 'unchanged') return null;
  const since = run.scope.since.toLowerCase();
  const owner = options.owner ?? null;
  if (owner === null || owner.length === 0) {
    reasons.push('identity.owner_reviewer is not set, so a standing approval to carry was not looked for');
    return null;
  }
  try {
    const latest = await standingOwnerReview(options.client, options.repository, options.pullNumber, owner);
    if (latest?.state !== 'APPROVED') return null;
    // The scope is unchanged since `since`; an approval of any other commit
    // approved code this run did not compare against.
    if (latest.commitId !== since) {
      reasons.push(`${owner}'s standing approval is of ${latest.commitId ?? 'an unknown commit'}, not ${since}, so it is not carried`);
      return null;
    }
    if (latest.url === null) {
      reasons.push(`${owner}'s standing approval has no link, so it is not carried`);
      return null;
    }
    return latest.url;
  } catch (error) {
    reasons.push(`could not read the pull request's reviews for a standing approval: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Looks for the owner's request for changes that a high-complexity verdict
 * leaves blocking (docs/adr/0012). Only when this review found nothing
 * blocking: a finding that is, or might be, blocking keeps the request fair.
 * Adds its reason to `reasons`; never writes to GitHub.
 */
async function staleRequest(
  options: VerdictOptions,
  planned: PlannedFindings,
  reasons: string[],
): Promise<StaleRequestChanges | null> {
  const severities = [
    ...[...planned.inline, ...planned.unanchored].map((finding) => finding.severity),
    ...planned.held.map((held) => held.severity),
  ];
  if (severities.some((severity) => severity === null || severity === 'blocking' || severity === 'important')) return null;

  const owner = options.owner ?? null;
  if (owner === null || owner.length === 0) {
    reasons.push('identity.owner_reviewer is not set, so an earlier request for changes was not looked for');
    return null;
  }
  try {
    const stale = await standingRequestChanges(options.client, options.repository, options.pullNumber, owner);
    if (stale !== null) {
      reasons.push(
        `${owner}'s earlier REQUEST_CHANGES (review ${stale.reviewId}) still blocks the pull request and this review found nothing blocking; a COMMENT does not replace it, so dismiss it by hand`,
      );
    }
    return stale;
  } catch (error) {
    reasons.push(`could not read the pull request's reviews: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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
 * The suggestion blocks that may post, by inline finding, and those withheld
 * (docs/adr/0033). A block posts only where the backing score verified the
 * fix, the finding still sits on the line the patch ends at, and the head's
 * lines still read the patch's `original`. Anything else keeps the prose and
 * says why. The patch comes from the recorded finding, never from candidates.
 */
async function checkedSuggestions(
  options: VerdictOptions,
  run: RunDetail,
  planned: PlannedFindings,
  head: string,
): Promise<{ suggestions: Map<ReviewFinding, SuggestedPatch>; withheld: WithheldSuggestion[] }> {
  const suggestions = new Map<ReviewFinding, SuggestedPatch>();
  const withheld: WithheldSuggestion[] = [];
  const files = new Map<string, Promise<string | null>>();
  for (const finding of planned.inline) {
    const stored = run.findings.find((candidate) => candidate.findingId === finding.findingId);
    if (stored?.suggestedPatch === undefined) continue;
    const path = finding.path as string;
    const withhold = (reason: string): void => {
      withheld.push({ findingId: finding.findingId, path, line: finding.line as number, reason });
    };
    const patch = suggestedPatchOf(stored.suggestedPatch);
    if (patch === null) {
      withhold('the recorded patch is malformed');
      continue;
    }
    if (unixLines(patch.replacement) === unixLines(patch.original)) {
      withhold('the replacement does not change the lines');
      continue;
    }
    const backing = planned.fixVerified.get(finding);
    if (backing === undefined) {
      withhold('the fix was not verified');
      continue;
    }
    // The challenge step and `reanchor` move a confirmed finding to a corrected
    // line, or another file; the patch range does not move with it.
    const source = stored.suggestedPatchSource;
    if (source === undefined || source.path !== path) {
      withhold(`anchor moved: the patch was written for ${source?.path ?? 'another location'}`);
      continue;
    }
    // Two candidates at one location: the block must come from the candidate
    // whose own fix the verifier verified, in this run.
    if (backing.runId !== run.reviewRunId || source.candidateId === null || backing.candidateId !== source.candidateId) {
      withhold('the verified fix belongs to another candidate');
      continue;
    }
    if (patch.end_line !== stored.line) {
      withhold(`anchor moved: the finding is on line ${stored.line} and the patch ends on line ${patch.end_line}`);
      continue;
    }
    let file = files.get(path);
    if (file === undefined) {
      file = fileAtRef(options.client, options.repository, path, head);
      files.set(path, file);
    }
    const text = await file;
    if (text === null) {
      withhold('the file could not be read at the head');
      continue;
    }
    if (linesAt(text, patch.start_line, patch.end_line - patch.start_line + 1) !== unixLines(patch.original)) {
      withhold('the lines at the head are not the patch original');
      continue;
    }
    suggestions.set(finding, patch);
  }
  return { suggestions, withheld };
}

/**
 * Computes the verdict, read-only (`RV verdict`, and the first half of `RV post`).
 *
 * Head and CI are read live, never taken from an earlier preview.
 */
export async function computeVerdict(
  options: VerdictOptions,
): Promise<{
  exitCode: number;
  output: VerdictOutput;
  run: RunDetail | null;
  /** For `post`: the findings, and whether CI capped the event, which the sent audit row records. */
  planned?: PlannedFindings;
  cappedByCi?: boolean;
}> {
  const head = options.head.toLowerCase();
  if (!SHA.test(head)) return refusal(options.head, '--head must be the full commit sha the review read');

  const run = recordedRun(options, head);
  if (typeof run === 'string') return refusal(head, run);

  const planned = planFindings(options.review, run, (id) => runDetail(options.db, id));

  const actual = await readHead(options.client, options.repository, options.pullNumber);
  const headMoved = actual !== head;
  const ci = headMoved
    ? null
    : await readCi(options.client, options.repository, head, options.gateChecks ?? [], options.now ?? Date.now(), options.ciRules ?? {});

  const complexity = pullRequestComplexity(run, (id) => runDetail(options.db, id));
  const needsHuman = complexity?.level === 'high';
  const policy = verdictPolicy(options.policy);

  const lookupReasons: string[] = [];
  const carriedReviewUrl =
    !headMoved && policy.carryApprovalOnUnchanged ? await carriedApproval(options, run, lookupReasons) : null;

  const decision = decide({
    mapped: planned.mapped,
    headMoved,
    ci: ci?.state ?? null,
    rerun: ci?.rerun,
    failed: ci?.failed,
    recheck: options.recheck === true,
    heldBackApproval: planned.heldBackApproval,
    needsHuman,
    uncoveredCarry: run.carry?.covered === false,
    carriedReviewUrl,
    policy,
  });
  decision.reasons.push(...lookupReasons);
  // Only a missing assessment is worth saying: a normal one changes nothing.
  if (complexity === null) decision.reasons.push('no complexity assessment was recorded for this run');
  // An approval replaces a request for changes, so only an approval that is
  // going ahead leaves none standing.
  const staleRequestChanges =
    needsHuman && !(decision.event === 'APPROVE' && decision.action !== 'refuse')
      ? await staleRequest(options, planned, decision.reasons)
      : null;

  let payload: ReviewPayload | null = null;
  let preview: string | null = null;
  let key: string | null = null;
  let alreadyInline = 0;
  let withheldSuggestions: WithheldSuggestion[] = [];
  let evidenceBlocks = 0;
  if (decision.action === 'post' && decision.event !== null) {
    const checked = policy.suggestions ? await checkedSuggestions(options, run, planned, head) : null;
    withheldSuggestions = checked?.withheld ?? [];
    const full = buildPayload({
      head,
      event: decision.event,
      planned,
      bodyFindings: run.bodyFindings,
      ...(checked === null ? {} : { suggestions: checked.suggestions }),
      // One plain summary line whichever cap applies: CI first, then a held
      // finding or an uncovered carry, then complexity. None of them names
      // human review or the carry in the posted body.
      cappedBy: decision.cappedByCi
        ? 'ci'
        : planned.heldBackApproval || (run.carry?.covered === false && planned.mapped === 'APPROVE')
          ? 'held'
          : policy.neverApprove && planned.mapped === 'APPROVE'
            ? 'policy'
            : needsHuman && policy.capApproval && planned.mapped === 'APPROVE'
              ? 'complexity'
              : null,
    });
    // Keyed on the whole review, so the same review is refused a second time
    // even once its comments are all on the pull request. Annotations are left
    // out: they follow CI, and a CI change must not make the same review of
    // the same head a second post.
    key = idempotencyKey(options.repository, options.pullNumber, full);
    // A comment already posted on this head, by an earlier COMMENT while CI
    // was red, is not posted again when the approval follows.
    const sent = sentInline(options.db, options.repository, options.pullNumber, head);
    const unsent = full.comments.filter((comment) => !sent.has(commentSignature(comment)));
    alreadyInline = full.comments.length - unsent.length;
    // After the key and the filter, so a run keys and signs the same with the
    // block on and off, as the scope block and annotations do.
    const evidence = policy.evidenceBlock ? withEvidenceBlocks(unsent, planned, policy) : { comments: unsent, blocks: 0 };
    evidenceBlocks = evidence.blocks;
    const body = policy.scopeBlock ? withScopeBlock(full.body, scopeBlock(run, planned, policy)) : full.body;
    payload = { ...full, body: withAnnotations(body, decision.annotations), comments: evidence.comments };
    preview = renderPreview({
      repository: options.repository,
      pullNumber: options.pullNumber,
      payload,
      held: planned.held,
      alreadyInline,
      withheldSuggestions,
    });
  }

  return {
    exitCode: decision.exitCode,
    run,
    planned,
    cappedByCi: decision.cappedByCi,
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
      wouldHaveEvent: needsHuman ? planned.mapped : null,
      wouldHaveSummary: needsHuman ? wouldHaveSummary(planned) : null,
      staleRequestChanges,
      annotations: decision.annotations,
      carriedReviewUrl: decision.carriedReviewUrl,
      cappedByPolicy: decision.cappedByPolicy,
      payload,
      alreadyInline,
      key,
      preview,
      withheldSuggestions,
      evidenceBlocks,
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
  /** `--recheck-thread`; `verdict.recheck_thread_before_post` turns it on too. */
  recheckThread?: boolean | undefined;
}

/** A finding in the payload that someone else raised on the thread while the review ran. */
export interface RaisedFinding {
  path: string | null;
  line: number | null;
  raisedBy: string;
  commentUrl: string | null;
}

export interface PostOutput {
  status: 'sent' | 'refused' | 'failed' | 'carried';
  reasons: string[];
  key: string | null;
  verdict: VerdictOutput | null;
  /** The measured-precision gate: reported with every post, binding on none (docs/adr/0010). */
  postCheck: GateResult;
  review?: { id: number | null; url: string | null; state: string | null };
  error?: { status: number | null; message: string };
  /** The scope is unchanged and the owner's approval stands: nothing was sent (docs/adr/0028). */
  carried?: true;
  reviewUrl?: string;
  /** Set with exit 8, when the thread re-read just before sending found a finding someone else raised. */
  refused?: 'thread-changed';
  findings?: RaisedFinding[];
}

/** The candidates the run was recorded with, as `check-candidates` read them; malformed ones are skipped. */
export function recordedCandidates(db: Database, runId: string): Candidate[] {
  const row = db.prepare('SELECT candidates_json FROM review_runs WHERE review_run_id = ?').get(runId) as
    | { candidates_json: string | null }
    | undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(row?.candidates_json ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    try {
      // Only the claim is compared here. A re-anchored candidate's patch no
      // longer ends at its line, which must not cost it the comparison.
      const { suggested_patch: _patch, ...rest } = entry as RawCandidate;
      return [normaliseCandidate(rest, index)];
    } catch {
      return [];
    }
  });
}

/** Shortest colleague text that counts as pasted from this tool's own review. */
const PASTED_TEXT_MIN = 40;

/**
 * The payload's findings that someone other than the token's user raised on
 * the pull request after the run was recorded, read fresh just before sending
 * (docs/adr/0028). The thread is read as `thread` reads it, and a finding is
 * matched on its candidate's claim and failure mode with the rule
 * `check-candidates --thread` drops a repeat by, so a point is a repeat here
 * exactly when it would have been one there. GET only.
 */
async function raisedByOthers(
  options: { client: GitHubClient; repository: string; pullNumber: number; db: Database },
  run: RunDetail,
  findings: readonly ReviewFinding[],
): Promise<RaisedFinding[]> {
  if (findings.length === 0) return [];
  const { data: viewer } = await options.client.get<{ login?: unknown }>('/user');
  if (typeof viewer?.login !== 'string') throw new Error('GitHub did not say whose token this is');
  const me = viewer.login.toLowerCase();

  const { comments } = await readThread({ repository: options.repository, pullNumber: options.pullNumber, client: options.client });
  const mine = new Set(comments.filter((c) => c.author.toLowerCase() === me && c.id !== undefined).map((c) => c.id));
  const started = Date.parse(run.createdAt);
  // A comment quoting this tool's own text is not a point someone else raised.
  const squash = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const ownTexts = comments.filter((c) => c.author.toLowerCase() === me).map((c) => squash(c.body));
  const thread = comments
    .filter((comment) => comment.author.toLowerCase() !== me)
    .map((comment) => ({ ...comment, body: comment.body.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n') }))
    .filter((comment) => {
      const text = squash(comment.body);
      // A short comment can occur inside the tool's text by chance, so only a pasted passage counts.
      return text !== '' && !(text.length >= PASTED_TEXT_MIN && ownTexts.some((own) => own.includes(text)));
    })
    // Earlier comments were in front of `check-candidates` already.
    .filter((comment) => comment.createdAt === undefined || !(Date.parse(comment.createdAt) <= started))
    // A reply in a thread this tool started answers it, often by quoting it.
    .filter((comment) => comment.inReplyTo === undefined || !mine.has(comment.inReplyTo))
    // Each citation in a review body or conversation comment stands for that
    // comment, so it is expanded one comment at a time to keep its link.
    .flatMap((comment) => citedLocations([comment]).map((located) => ({ comment: located, url: comment.url ?? null })));
  if (thread.length === 0) return [];

  const candidates = recordedCandidates(options.db, run.reviewRunId);
  const raised: RaisedFinding[] = [];
  for (const finding of findings) {
    if (finding.path === null || finding.severity === null) continue;
    // shortcut: a finding whose candidate was not recorded is matched on its
    // rendered prose; record --candidates always supplies one in the pipeline.
    const candidate: Candidate = candidates.find((c) => c.path === finding.path && c.line === finding.line) ?? {
      candidateId: finding.findingId ?? `${finding.path}:${finding.line ?? ''}`,
      path: finding.path,
      // A finding with no line is compared with every comment on its file:
      // no comment line is ever within the window of NaN, nor outside it.
      line: finding.line ?? Number.NaN,
      category: 'posted',
      severity: finding.severity,
      claim: finding.prose,
      failureMode: '',
      evidence: [],
      suggestedFix: null,
      fixConfidence: null,
      technicalConfidence: 0,
    };
    const match = thread.find((entry) => alreadySaidOnThread(candidate, [entry.comment]) !== null);
    if (match !== undefined) {
      raised.push({ path: finding.path, line: finding.line, raisedBy: match.comment.author, commentUrl: match.url });
    }
  }
  return raised;
}

/**
 * Why a key may not be sent again, or null when it may.
 *
 * Sent is final. So is an attempt whose outcome is unknown: no outcome was
 * recorded, or the request failed without a definite answer from GitHub (a
 * network error or a 5xx), because the review may have been created anyway and
 * a retry is then a second review. A 4xx is GitHub saying no, so another
 * attempt is safe.
 *
 * The prefix names the write: `review_post_` for a review, `review_reply_`
 * for a reply under one of its comments (docs/adr/0035). Both keep the rows
 * `<prefix>attempted`, `<prefix>sent` and `<prefix>failed`.
 */
export function keyBlocked(db: Database, key: string, prefix = 'review_post_'): string | null {
  const rows = db
    .prepare(
      `SELECT audit_id, action, metadata_json FROM audit_events
       WHERE action LIKE ? AND json_extract(metadata_json, '$.key') = ?`,
    )
    .all(`${prefix}%`, key) as { audit_id: string; action: string; metadata_json: string }[];

  const parsed = rows.map((row) => ({ id: row.audit_id, action: row.action, meta: JSON.parse(row.metadata_json) as Record<string, unknown> }));
  if (parsed.some((row) => row.action === `${prefix}sent`)) {
    return prefix === 'review_post_' ? 'this exact review of this head was already sent' : 'a reply on this thread was already sent';
  }
  for (const attempt of parsed.filter((row) => row.action === `${prefix}attempted`)) {
    const outcome = parsed.find(
      (row) => (row.action === `${prefix}sent` || row.action === `${prefix}failed`) && row.meta['attempt'] === attempt.id,
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
 * wrote its attempt. The action names the write, as `keyBlocked`'s prefix does.
 */
export function claimKey(
  db: Database,
  key: string,
  subject: { type: string; id: string },
  metadata: Record<string, unknown>,
  action: 'review_post_attempted' | 'review_reply_attempted' = 'review_post_attempted',
): string | { blocked: string } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const blocked = keyBlocked(db, key, action.slice(0, -'attempted'.length));
    if (blocked !== null) {
      db.exec('ROLLBACK');
      return { blocked };
    }
    const attempt = recordAudit(db, action, subject, { key, ...metadata });
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
    extra: Pick<PostOutput, 'refused' | 'findings'> = {},
  ): { exitCode: number; output: PostOutput } => {
    recordAudit(options.db, 'review_post_refused', subject, {
      reasons,
      key,
      head: options.head,
      event: verdict?.event ?? null,
      ...extra,
    });
    return { exitCode, output: { status: 'refused', reasons, key, verdict, postCheck, ...extra } };
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
  const { exitCode, run } = computed;
  let verdict = computed.output;
  if (verdict.action === 'carry' && verdict.carriedReviewUrl !== null && run !== null) {
    if (run.repository === null || run.repository.toLowerCase() !== options.repository.toLowerCase()) {
      return refuse(2, [`run ${run.reviewRunId} reviewed ${run.repository ?? 'no repository'}, not ${options.repository}`], verdict, null);
    }
    // Only a confirmed post is an outcome worth recording; without one this is a preview.
    if (options.confirm) {
      recordAudit(options.db, 'review_carried', subject, {
        repository: options.repository,
        pull: options.pullNumber,
        head: verdict.head.expected,
        reviewUrl: verdict.carriedReviewUrl,
      });
    }
    return {
      exitCode: 0,
      output: { status: 'carried', carried: true, reviewUrl: verdict.carriedReviewUrl, reasons: verdict.reasons, key: null, verdict, postCheck },
    };
  }
  if (verdict.action !== 'post' || verdict.payload === null || verdict.key === null || run === null) {
    return refuse(exitCode === 0 ? 2 : exitCode, verdict.reasons, verdict, null);
  }

  const policy = verdictPolicy(options.policy);
  let payload = verdict.payload;
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

  // Someone may have made one of these points while the review ran; posting
  // it again would talk over them. Before the approval's re-read, so that
  // re-read stays the last thing between confirmation and sending.
  if (options.recheckThread === true || policy.recheckThreadBeforePost) {
    const inPayload = (finding: ReviewFinding): boolean =>
      payload.comments.some((comment) => comment.path === finding.path && comment.line === finding.line);
    const findings = computed.planned === undefined
      ? []
      : [...computed.planned.inline.filter(inPayload), ...computed.planned.unanchored];
    let raised: RaisedFinding[];
    try {
      raised = await raisedByOthers(options, run, findings);
    } catch (error) {
      return refuse(1, [`could not re-read the thread before sending: ${error instanceof Error ? error.message : String(error)}`], verdict, key);
    }
    if (raised.length > 0) {
      return refuse(
        8,
        [`${raised.length} finding${raised.length === 1 ? ' was' : 's were'} raised on the thread by someone else during the review; nothing was sent`],
        verdict,
        key,
        { refused: 'thread-changed', findings: raised },
      );
    }
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
        ci: await readCi(options.client, options.repository, payload.commit_id, options.gateChecks ?? [], options.now ?? Date.now(), options.ciRules ?? {}),
      };
    } catch (error) {
      return refuse(1, [`could not re-read head and CI before approving: ${error instanceof Error ? error.message : String(error)}`], verdict, key);
    }
    if (reread.head !== payload.commit_id) {
      return refuse(3, ['the pull request head moved before sending; review the new head'], verdict, key);
    }
    if (!ciAllowsApproval(reread.ci.state, policy)) {
      return refuse(
        reread.ci.state === 'pending' ? 4 : reread.ci.state === 'needs-rerun' ? 6 : 5,
        [`CI turned ${reread.ci.state} before sending; not approving`],
        { ...verdict, ci: reread.ci },
        key,
      );
    }
    // The note has to describe the CI the approval is sent on. The key does
    // not cover it, so it stays the same.
    const annotations = ciAnnotations(reread.ci, policy);
    if (annotations.join('\n') !== verdict.annotations.join('\n')) {
      payload = { ...payload, body: replaceAnnotations(payload.body, verdict.annotations, annotations) };
      verdict = {
        ...verdict,
        ci: reread.ci,
        annotations,
        payload,
        preview: renderPreview({
          repository: options.repository,
          pullNumber: options.pullNumber,
          payload,
          held: verdict.held,
          alreadyInline: verdict.alreadyInline,
          withheldSuggestions: verdict.withheldSuggestions,
        }),
      };
    }
  }

  const claimed = claimKey(options.db, key, subject, {
    head: payload.commit_id,
    event: payload.event,
    comments: payload.comments.length,
    run: run.reviewRunId,
    // Whether the posted comments carried the evidence block, so outcomes can be split by it.
    evidenceBlocks: verdict.evidenceBlocks,
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
      // The queue finds a COMMENT posted only because CI was red by this.
      cappedByCi: computed.cappedByCi === true,
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
