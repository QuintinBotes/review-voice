import { createHash } from 'node:crypto';
import { splitFindings, parseFinding } from '../contract/parse.ts';
import { SEVERITIES, type Severity } from '../contract/limits.ts';
import type { RunDetail, StoredFinding } from '../store/runs.ts';
import type { ReviewComment, ReviewEvent, ReviewPayload } from '../github/writer.ts';
import type { CiEntry, CiState } from './ci.ts';
import { renderSimplification, type VerifiedSimplification } from '../simplification.ts';
import type { SuggestedPatch } from '../scoring/score.ts';
import { stripEvidenceBlock } from './evidence-block.ts';

export type { ReviewEvent, ReviewPayload };

/**
 * The review event, from the severities in the validated review text.
 *
 * Fixed in code (docs/adr/0010), never read from model prose: a diff that
 * talks the analyst into silence must not also be able to talk it into an
 * approval. A question-framed claim is already capped at `minor` before this
 * point, so an unanswered question can never block a merge.
 */
export function eventFor(severities: readonly Severity[]): ReviewEvent {
  if (severities.some((severity) => severity === 'blocking' || severity === 'important')) return 'REQUEST_CHANGES';
  if (severities.some((severity) => severity === 'minor' || severity === 'question')) return 'COMMENT';
  return 'APPROVE';
}

const RANK: Record<Severity, number> = { blocking: 0, important: 1, minor: 2, question: 3, nit: 4 };

export interface ReviewFinding {
  /** Positional, as `record` assigns it; null for a block that did not parse. */
  findingId: string | null;
  severity: Severity | null;
  path: string | null;
  line: number | null;
  raw: string;
  prose: string;
}

/**
 * A finding that names a file but no line: `[severity] \`path\` - prose`.
 * The contract asks for a line, so this is rare, but when one is verified it
 * still posts, in the body, since there is no line to put it on.
 */
const NO_LINE = /^\[([a-z_]+)\]\s+`([^`]+)`\s+-\s*([\s\S]*)$/i;

export function reviewFindings(output: string): ReviewFinding[] {
  let index = 0;
  return splitFindings(output).map((block) => {
    const finding = parseFinding(block.raw, block.startLine);
    // Numbered exactly as `record` numbers them, so a held finding is named by
    // the id `explain` and `feedback` already use.
    const numbered = finding.severity !== null && finding.path !== null;
    if (numbered) index += 1;
    if (finding.path === null) {
      const match = NO_LINE.exec(block.raw.replace(/\s*\n\s*/g, ' ').trim());
      const severity = match?.[1]?.toLowerCase();
      if (match !== null && (SEVERITIES as readonly string[]).includes(severity ?? '')) {
        return {
          findingId: null,
          severity: severity as Severity,
          path: match[2]!,
          line: null,
          raw: finding.raw,
          prose: (match[3] ?? '').trim(),
        };
      }
    }
    return {
      findingId: numbered ? `rv_${String(index).padStart(2, '0')}` : null,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      raw: finding.raw,
      prose: finding.prose,
    };
  });
}

export type RunLoader = (runId: string) => RunDetail | null;

export interface ScoreLike {
  path?: unknown;
  line?: unknown;
  confidenceSource?: unknown;
  eligible?: unknown;
  severity?: { severity?: unknown } | null;
  anchor?: unknown;
  anchorCheck?: { kind?: unknown } | null;
  /** Set by `score --files` for a finding about a file the change deletes (#265). */
  deletedFile?: unknown;
  /** The repair decision; only `render: 'fix'` lets a suggestion block post (docs/adr/0033). */
  fix?: { render?: unknown } | null;
  candidateId?: unknown;
  /** The challenger's verdict, as `challenge` stored it (docs/adr/0024). */
  challenge?: { verdict?: unknown; line_ok?: unknown; corrected_line?: unknown; decisive_evidence?: unknown } | null;
  /** Where `reanchor` or the challenge moved the finding from. */
  reanchoredFrom?: { line?: unknown } | null;
  /** The precedents retrieved for the candidate, each with `role` and `polarity`. */
  precedents?: unknown;
}

/**
 * Whether a score is for a finding about unchanged code the change made
 * wrong. Read from either field, so a score taken without `--diff-file` still
 * says so.
 */
export function isStaleConsumer(score: ScoreLike): boolean {
  return score.anchor === 'stale-consumer' || score.anchorCheck?.kind === 'stale-consumer';
}

/**
 * The scores recorded at a location. Shared by the post-time matcher and the
 * render-time severity check so the two cannot disagree about what "the score
 * for this finding" means. A null line matches any line in the file.
 */
export function scoresAtLocation(scores: readonly unknown[], path: string, line: number | null): ScoreLike[] {
  return (scores as ScoreLike[]).filter(
    (score) => typeof score === 'object' && score !== null && score.path === path && (line === null || score.line === line),
  );
}

/** How far a carried finding's history is followed back. Carries do not chain deeper in practice. */
const MAX_CARRY_DEPTH = 8;

/**
 * Whether the verifier established this finding in the recorded run.
 *
 * Matched one to one: a score backs a finding only when path, line and the
 * severity it derived all agree, and each score backs one finding at most.
 * Matching on location alone let an unverified `important` at the same line
 * as a verified nit post on the nit's score. Only a score whose confidence
 * came from the verifier and that cleared every gate counts: the analyst's own
 * confidence is what it feels about its output, not a check of it. A finding
 * carried unchanged from an earlier run was verified there, so its history is
 * followed back to the run that scored it.
 *
 * `used` is shared across one review's findings, and `loadRun` must return
 * the same object for the same run, or a score could be used twice.
 */
/** The run and candidate whose score verified a fix. */
export interface FixBacking {
  runId: string;
  candidateId: string | null;
}

export function verification(
  finding: { path: string | null; line: number | null; severity: Severity | null },
  run: RunDetail,
  loadRun: RunLoader,
  used: Set<object> = new Set(),
): {
  verified: boolean;
  reason: string;
  runId: string;
  staleConsumer?: boolean;
  deletedFile?: boolean;
  fixVerified?: FixBacking;
  /** The score that verified it, in the run `runId` names; null when unverified. */
  score: ScoreLike | null;
  /** The finding as that run stored it, which is the origin finding when it was carried. */
  stored?: StoredFinding;
} {
  if (finding.path === null || finding.severity === null) {
    return { verified: false, reason: 'it names no file, so no score can be matched to it', runId: run.reviewRunId, score: null };
  }

  let current: RunDetail = run;
  let path = finding.path;
  let line = finding.line;
  const severity = finding.severity;
  let reason = 'no score was recorded for it';

  for (let depth = 0; depth <= MAX_CARRY_DEPTH; depth += 1) {
    const scores = Array.isArray(current.scores) ? current.scores : [];
    const here = scoresAtLocation(scores, path, line);
    const same = here.filter((score) => score.severity?.severity === severity && !used.has(score));
    const backing = same.find((score) => score.confidenceSource === 'verifier' && score.eligible === true);
    const stored =
      line === null
        ? undefined
        : current.findings.find((candidate) => candidate.path === path && candidate.line === line && candidate.severity === severity);
    if (backing !== undefined) {
      used.add(backing);
      return {
        verified: true,
        reason: 'established by the verifier',
        runId: current.reviewRunId,
        score: backing,
        ...(stored === undefined ? {} : { stored }),
        ...(isStaleConsumer(backing) ? { staleConsumer: true } : {}),
        ...(backing.deletedFile === true ? { deletedFile: true } : {}),
        ...(backing.fix?.render === 'fix'
          ? { fixVerified: { runId: current.reviewRunId, candidateId: typeof backing.candidateId === 'string' ? backing.candidateId : null } }
          : {}),
      };
    }
    if (same.some((score) => score.confidenceSource === 'verifier')) {
      reason = 'the verifier scored it, but it did not clear the gates';
    } else if (same.length > 0) {
      reason = 'its confidence is the analyst\'s own, not the verifier\'s';
    } else if (here.length > 0) {
      reason = `no unused score at ${line === null ? path : `${path}:${line}`} was derived at ${severity}`;
    }

    if (line === null) break;
    if (stored?.carriedFrom === undefined) break;
    const from = stored.carriedFrom;
    const source = loadRun(from.runId);
    const origin = source?.findings.find((candidate) => candidate.findingId === from.findingId);
    if (source === null || origin === undefined) {
      reason = `it was carried from run ${from.runId}, which is no longer stored`;
      break;
    }
    current = source;
    path = origin.path;
    line = origin.line;
  }

  return { verified: false, reason, runId: current.reviewRunId, score: null };
}

export interface HeldBack {
  findingId: string | null;
  severity: Severity | null;
  path: string | null;
  line: number | null;
  reason: string;
}

export interface PlannedFindings {
  /** Verified and anchored: each becomes an inline comment. */
  inline: ReviewFinding[];
  /**
   * Verified but with no line to comment on: a finding that names none, or a
   * stale consumer, whose line is unchanged code GitHub cannot anchor on.
   */
  unanchored: ReviewFinding[];
  held: HeldBack[];
  /** The event the posted findings call for, before CI is considered. */
  mapped: ReviewEvent;
  /** True when an unverified finding above a nit kept an approval at COMMENT. */
  heldBackApproval: boolean;
  /** Inline findings whose backing score verified the repair, so a suggestion may render on them. */
  /** The score that verified each finding's fix, so a patch posts only from its own candidate. */
  fixVerified: ReadonlyMap<ReviewFinding, FixBacking>;
  /**
   * The score and stored finding that verified each inline finding, from the
   * run that scored it, so the evidence block is read from that run and is
   * never looked up a second time.
   */
  backing: ReadonlyMap<ReviewFinding, EvidenceBacking>;
}

/** What verified one inline finding, in the run that scored it. */
export interface EvidenceBacking {
  score: ScoreLike;
  stored: StoredFinding | undefined;
  runId: string;
}

/**
 * Splits a validated review into what posts and what is held back.
 *
 * Only verified findings post. The event follows the findings that post,
 * because a review that requests changes has to say which, and an unverified
 * claim must not block someone's merge. Held findings still count in one
 * direction: an unverified concern above a nit keeps the review from
 * approving, since approving past a concern nobody has checked is the false
 * APPROVE this design exists to prevent.
 */
export function planFindings(output: string, run: RunDetail, loadRun: RunLoader): PlannedFindings {
  const inline: ReviewFinding[] = [];
  const unanchored: ReviewFinding[] = [];
  const held: HeldBack[] = [];
  const heldSeverities: Severity[] = [];
  const fixVerified = new Map<ReviewFinding, FixBacking>();
  const backing = new Map<ReviewFinding, EvidenceBacking>();

  // One object per run, so a score marked used stays used across findings.
  const loaded = new Map<string, RunDetail | null>([[run.reviewRunId, run]]);
  const cachedLoad: RunLoader = (id) => {
    if (!loaded.has(id)) loaded.set(id, loadRun(id));
    return loaded.get(id) ?? null;
  };
  const used = new Set<object>();

  // Anchored findings claim their scores first, so a line-less finding can
  // never take the score an anchored one at the same file needed.
  const findings = reviewFindings(output);
  const ordered = [...findings.filter((f) => f.line !== null), ...findings.filter((f) => f.line === null)];
  const outcome = new Map<ReviewFinding, ReturnType<typeof verification>>();
  for (const finding of ordered) outcome.set(finding, verification(finding, run, cachedLoad, used));

  for (const finding of findings) {
    const result = outcome.get(finding)!;
    if (!result.verified || finding.severity === null) {
      held.push({
        findingId: finding.findingId,
        severity: finding.severity,
        path: finding.path,
        line: finding.line,
        reason: result.reason,
      });
      // A block with no recognisable severity is treated as a concern: it
      // cannot be shown to be only a nit.
      heldSeverities.push(finding.severity ?? 'minor');
      continue;
    }
    // A stale consumer keeps its `path:line` in the body text: the reader still
    // needs to know where, and an inline comment there would be refused. So
    // does a finding about a file the change deletes, which has no new side.
    const anchorable = finding.path !== null && finding.line !== null && result.staleConsumer !== true && result.deletedFile !== true;
    (anchorable ? inline : unanchored).push(finding);
    if (anchorable && result.fixVerified !== undefined) fixVerified.set(finding, result.fixVerified);
    if (anchorable && result.score !== null) backing.set(finding, { score: result.score, stored: result.stored, runId: result.runId });
  }

  const posted = [...inline, ...unanchored].map((finding) => finding.severity as Severity);
  let mapped = eventFor(posted);
  const heldBackApproval = mapped === 'APPROVE' && eventFor(heldSeverities) !== 'APPROVE';
  if (heldBackApproval) mapped = 'COMMENT';

  return { inline, unanchored, held, mapped, heldBackApproval, fixVerified, backing };
}

export type Action = 'post' | 'wait' | 'refuse' | 'carry';

/**
 * The verdict behaviours an owner may choose (docs/adr/0028). The defaults are
 * the fixed rules of 0010, 0012 and 0013; the head, writer and idempotency
 * guards are not here because they are not negotiable.
 */
export interface VerdictPolicy {
  ciPending: 'wait' | 'proceed';
  ciRed: 'cap' | 'annotate';
  ciNeedsRerun: 'hold' | 'annotate';
  /** `review.human_review.cap_approval`. */
  capApproval: boolean;
  carryApprovalOnUnchanged: boolean;
  recheckThreadBeforePost: boolean;
  /** `verdict.never_approve`: every review is advisory, so approval is left to a person. */
  neverApprove: boolean;
  /** `verdict.scope_block`: end the posted body with the collapsed review scope block (docs/adr/0028). */
  scopeBlock: boolean;
  /** `verdict.scope_block_models`: name the models of the stages in that block; a public repository need not advertise them. */
  scopeBlockModels: boolean;
  /** `review.suggestions`: render a verified patch as a committable suggestion block (docs/adr/0033). */
  suggestions: boolean;
  /** `verdict.evidence_block`: end each inline comment with the collapsed evidence block (docs/adr/0028). */
  evidenceBlock: boolean;
  /** `verdict.evidence_block_precedents`: count the owner precedents in that block; it reveals that a precedent store exists. */
  evidenceBlockPrecedents: boolean;
}

export const DEFAULT_VERDICT_POLICY: Readonly<VerdictPolicy> = Object.freeze({
  ciPending: 'wait',
  ciRed: 'cap',
  ciNeedsRerun: 'hold',
  capApproval: true,
  carryApprovalOnUnchanged: false,
  recheckThreadBeforePost: false,
  neverApprove: false,
  scopeBlock: false,
  scopeBlockModels: false,
  suggestions: false,
  evidenceBlock: false,
  evidenceBlockPrecedents: false,
});

export function verdictPolicy(policy: Partial<VerdictPolicy> | undefined): VerdictPolicy {
  return { ...DEFAULT_VERDICT_POLICY, ...policy };
}

/** How many checks an annotation names; past it the line stops being read. */
export const MAX_ANNOTATED_CHECKS = 5;

/** Longest check name an annotation shows, ellipsis included. */
const MAX_CHECK_NAME = 60;

/**
 * A check name is whatever the CI integration chose, so it goes into the posted
 * body as inline code on one line: no markdown, link or mention can render.
 * `max` lets the same rule serve the longer recorded facts of the evidence block.
 */
export function safeCheckName(name: string, max: number = MAX_CHECK_NAME): string {
  const flat = name
    // Bidi controls and zero-width characters can reorder or hide text.
    .replace(/[\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff`]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // By code point, so a surrogate pair is never split.
  const points = [...flat];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : flat;
}

function checkNames(entries: readonly CiEntry[]): string {
  // `readCi` already keeps only the newest run of each check, so a name seen
  // twice is a check run and a status sharing it. Sorted, so the note, and the
  // body it is in, does not change with the order GitHub lists checks in.
  const names = [...new Set(entries.map((entry) => safeCheckName(entry.name)).filter((name) => name.length > 0))].sort();
  return names.length === 0 ? 'some checks' : names.slice(0, MAX_ANNOTATED_CHECKS).map((name) => `\`${name}\``).join(', ');
}

/**
 * The lines an `annotate` policy adds to a posted review for this CI state.
 * Empty under the defaults, and for green or pending CI.
 */
export function ciAnnotations(
  ci: Pick<CiState, 'state' | 'failed' | 'rerun'> | null,
  policy: Pick<VerdictPolicy, 'ciRed' | 'ciNeedsRerun'>,
): string[] {
  if (ci?.state === 'red' && policy.ciRed === 'annotate') {
    return [`Heads up: ${checkNames(ci.failed)} failing on this head.`];
  }
  if (ci?.state === 'needs-rerun' && policy.ciNeedsRerun === 'annotate') {
    return [`Heads up: ${checkNames(ci.rerun)} need a rerun.`];
  }
  return [];
}

/** Whether an approval may be sent on CI in this state, under the policy. */
export function ciAllowsApproval(
  state: CiState['state'],
  policy: Pick<VerdictPolicy, 'ciPending' | 'ciRed' | 'ciNeedsRerun'>,
): boolean {
  if (state === 'green') return true;
  if (state === 'pending') return policy.ciPending === 'proceed';
  if (state === 'red') return policy.ciRed === 'annotate';
  return policy.ciNeedsRerun === 'annotate';
}

export interface Decision {
  /** Null when no event may be sent at all until CI is rerun, or when a standing approval is carried. */
  event: ReviewEvent | null;
  action: Action;
  reasons: string[];
  /**
   * 0 ready or carried, 2 nothing to recheck, 3 head moved, 4 CI still
   * running, 5 CI red on a recheck, 6 CI needs a rerun.
   */
  exitCode: number;
  cappedByCi: boolean;
  /**
   * True when `never_approve` capped an approval at COMMENT, so a caller can
   * tell a policy refusal apart from any other refusal without reading the reasons.
   */
  cappedByPolicy: boolean;
  /** Lines appended to the posted body; only ever set on a `post`. */
  annotations: string[];
  /** The owner's standing approval, on a `carry`. */
  carriedReviewUrl: string | null;
}

/**
 * Applies the head and CI guards to the mapped event.
 *
 * Red CI caps an approval at COMMENT: the findings still post, and a review
 * that approves a failing head is not one anybody meant. Pending CI turns an
 * approval into a wait, because the approval is the only part that depends on
 * it. COMMENT and REQUEST_CHANGES never wait on CI. Each of these is the
 * default of a setting (docs/adr/0028); a moved head is not, and `--recheck`
 * still asks only whether CI is green now.
 */
export function decide(input: {
  mapped: ReviewEvent;
  headMoved: boolean;
  ci: CiState['state'] | null;
  /** The checks behind a needs-rerun state, named in the reasons. */
  rerun?: readonly CiEntry[] | undefined;
  /** The failing checks behind a red state, named in an `annotate` line. */
  failed?: readonly CiEntry[] | undefined;
  recheck: boolean;
  heldBackApproval?: boolean;
  /** The change was assessed high-complexity, so a person, not this tool, approves it. */
  needsHuman?: boolean;
  /**
   * The run carried candidates to this head without a review of the commits
   * in between, or with a candidate refused (docs/adr/0017).
   */
  uncoveredCarry?: boolean;
  /**
   * The owner's approval that still stands on an unchanged scope, when
   * `carry_approval_on_unchanged` is on and one was found.
   */
  carriedReviewUrl?: string | null | undefined;
  policy?: Partial<VerdictPolicy> | undefined;
}): Decision {
  const policy = verdictPolicy(input.policy);
  const reasons: string[] = [];
  const done = (
    decision: Omit<Decision, 'annotations' | 'carriedReviewUrl' | 'cappedByPolicy'> & { cappedByPolicy?: boolean },
    annotations: string[] = [],
  ): Decision => ({
    ...decision,
    cappedByPolicy: decision.cappedByPolicy ?? false,
    annotations: decision.action === 'post' ? annotations : [],
    carriedReviewUrl: null,
  });
  if (input.heldBackApproval === true) {
    reasons.push('an unverified finding above a nit was held back, so this comments rather than approves');
  }
  if (input.headMoved) {
    return done({
      event: input.mapped,
      action: 'refuse',
      reasons: [...reasons, 'the pull request head moved since the review read it; review the new head'],
      exitCode: 3,
      cappedByCi: false,
    });
  }

  // Nothing is sent, so no CI state can make it unsafe. Only a clean approval
  // carries: a held finding, an uncovered carry or a request for changes is
  // news the standing approval does not cover.
  if (
    typeof input.carriedReviewUrl === 'string' &&
    input.mapped === 'APPROVE' &&
    input.heldBackApproval !== true &&
    input.uncoveredCarry !== true
  ) {
    return {
      event: null,
      action: 'carry',
      reasons: [...reasons, 'the scope is unchanged and the owner\'s approval still stands, so nothing is posted'],
      exitCode: 0,
      cappedByCi: false,
      cappedByPolicy: false,
      annotations: [],
      carriedReviewUrl: input.carriedReviewUrl,
    };
  }

  // A re-check asks whether CI is green now, whatever the policy says.
  const annotations = input.recheck
    ? []
    : ciAnnotations({ state: input.ci ?? 'green', failed: [...(input.failed ?? [])], rerun: [...(input.rerun ?? [])] }, policy);

  // A check CI never finished says nothing about the change, so no event is
  // fair: an approval would skip it and a comment or request for changes
  // would be posted on a head nobody has tested. Before every other guard, so
  // it holds for every mapped event and for a re-check (docs/adr/0013).
  if (input.ci === 'needs-rerun') {
    const named = (input.rerun ?? []).map((entry) => `${entry.name} (${entry.detail})`);
    const why = `CI needs a rerun${named.length > 0 ? `: ${named.join(', ')}` : ''}`;
    if (input.recheck || policy.ciNeedsRerun === 'hold') {
      return done({ event: null, action: 'wait', reasons: [...reasons, why], exitCode: 6, cappedByCi: false });
    }
    reasons.push(`${why}; posting the code verdict with a note, as verdict.ci_needs_rerun is annotate`);
  }

  // Code nobody analysed is not approved. The reason stays local: the posted
  // body says only that this is not an approval yet (docs/adr/0017).
  if (input.uncoveredCarry === true && input.mapped === 'APPROVE') {
    const why = 'candidates were carried to this head without a review of the commits since, so this comments rather than approves';
    if (input.recheck) {
      return done({ event: 'COMMENT', action: 'refuse', reasons: [...reasons, why], exitCode: 2, cappedByCi: false });
    }
    return done({ event: 'COMMENT', action: 'post', reasons: [...reasons, why], exitCode: 0, cappedByCi: false }, annotations);
  }

  // An advisory posture leaves every approval to a person. It sits after the
  // carry, needs-rerun and uncovered-carry guards, so those still win, and
  // before the complexity cap, so this reason is the one recorded when both
  // apply. Before the CI guard too, so pending CI cannot make the head wait
  // for an approval that will never be sent.
  if (policy.neverApprove && input.mapped === 'APPROVE') {
    if (input.recheck) {
      return done({
        event: 'COMMENT',
        action: 'refuse',
        reasons: [...reasons, 'there is no approval to re-check under never_approve'],
        exitCode: 2,
        cappedByCi: false,
        cappedByPolicy: true,
      });
    }
    return done(
      {
        event: 'COMMENT',
        action: 'post',
        reasons: [...reasons, 'approval is left to a person by policy'],
        exitCode: 0,
        cappedByCi: false,
        cappedByPolicy: true,
      },
      annotations,
    );
  }

  // Before the CI guard, so pending CI cannot turn a capped approval into a
  // wait for an approval that will never be sent (docs/adr/0012).
  if (input.needsHuman === true && input.mapped === 'APPROVE') {
    if (!policy.capApproval) {
      reasons.push('the change was raised for human review; approving anyway, as review.human_review.cap_approval is false');
    } else if (input.recheck) {
      return done({
        event: 'COMMENT',
        action: 'refuse',
        reasons: [...reasons, 'the change was raised for human review, so there is no approval to re-check'],
        exitCode: 2,
        cappedByCi: false,
      });
    } else {
      return done(
        {
          event: 'COMMENT',
          action: 'post',
          reasons: [...reasons, 'the change was raised for human review, so this comments rather than approves'],
          exitCode: 0,
          cappedByCi: false,
        },
        annotations,
      );
    }
  }

  if (input.recheck) {
    if (input.mapped !== 'APPROVE') {
      return done({
        event: input.mapped,
        action: 'refuse',
        reasons: [...reasons, `the review maps to ${input.mapped}, so there is no approval to re-check`],
        exitCode: 2,
        cappedByCi: false,
      });
    }
    if (input.ci === 'pending') {
      return done({ event: 'APPROVE', action: 'wait', reasons: [...reasons, 'CI is still running'], exitCode: 4, cappedByCi: false });
    }
    if (input.ci !== 'green') {
      return done({
        event: 'COMMENT',
        action: 'refuse',
        reasons: [...reasons, 'CI is red, so there is no approval to send'],
        exitCode: 5,
        cappedByCi: true,
      });
    }
    return done({ event: 'APPROVE', action: 'post', reasons: [...reasons, 'head unchanged and CI green'], exitCode: 0, cappedByCi: false });
  }

  if (input.mapped === 'APPROVE' && input.ci === 'red') {
    if (policy.ciRed === 'annotate') {
      return done(
        {
          event: 'APPROVE',
          action: 'post',
          reasons: [...reasons, 'CI is red; approving with a note, as verdict.ci_red is annotate'],
          exitCode: 0,
          cappedByCi: false,
        },
        annotations,
      );
    }
    return done({
      event: 'COMMENT',
      action: 'post',
      reasons: [...reasons, 'CI is red, so the approval is capped at COMMENT'],
      exitCode: 0,
      cappedByCi: true,
    });
  }
  // Needs-rerun reaches here only under `annotate`; anything else unsettled waits.
  if (input.mapped === 'APPROVE' && input.ci !== 'green' && input.ci !== 'needs-rerun') {
    if (policy.ciPending === 'proceed') {
      return done({
        event: 'APPROVE',
        action: 'post',
        reasons: [...reasons, 'CI is still running; approving now, as verdict.ci_pending is proceed'],
        exitCode: 0,
        cappedByCi: false,
      });
    }
    return done({
      event: 'APPROVE',
      action: 'wait',
      reasons: [...reasons, 'CI is still running; approve once it is green with verdict --recheck'],
      exitCode: 4,
      cappedByCi: false,
    });
  }
  return done({ event: input.mapped, action: 'post', reasons, exitCode: 0, cappedByCi: false }, annotations);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** One line, stating the verdict. Everything else is on its line. */
export function summaryLine(
  event: ReviewEvent,
  posted: readonly ReviewFinding[],
  cappedBy: 'ci' | 'held' | 'complexity' | 'policy' | null,
): string {
  const count = posted.length;
  const highest = [...posted]
    .map((finding) => finding.severity as Severity)
    .sort((a, b) => RANK[a] - RANK[b])[0];

  if (cappedBy === 'ci') {
    return count === 0
      ? 'No problems found, but not approving while CI is red.'
      : `${plural(count, 'nit')}; not approving while CI is red.`;
  }
  if (cappedBy === 'held') {
    return count === 0 ? 'Not approving yet.' : `${plural(count, 'nit')}; not approving yet.`;
  }
  if (cappedBy === 'complexity' || cappedBy === 'policy') {
    return count === 0 ? 'No problems found.' : `${plural(count, 'nit')}.`;
  }
  if (event === 'APPROVE') {
    return count === 0 ? 'No problems found.' : `Approved, with ${plural(count, 'nit')}.`;
  }
  if (event === 'REQUEST_CHANGES') {
    return `Changes requested: ${plural(count, 'comment')}, the highest ${highest}.`;
  }
  return `${plural(count, 'comment')}, the highest ${highest}.`;
}

/**
 * The verdict the findings call for without the complexity cap, in one line,
 * so the person who now has to approve has somewhere to start. For the agent
 * only: never in the posted review (docs/adr/0012).
 */
export function wouldHaveSummary(planned: PlannedFindings): string {
  const posted = [...planned.inline, ...planned.unanchored];
  const count = posted.length;
  const highest = posted.map((finding) => finding.severity as Severity).sort((a, b) => RANK[a] - RANK[b])[0];
  if (planned.mapped === 'APPROVE') {
    return count === 0 ? 'Would have approved: no problems found.' : `Would have approved, with ${plural(count, 'nit')}.`;
  }
  if (planned.mapped === 'REQUEST_CHANGES') {
    return `Would have requested changes: ${plural(count, 'comment')}, the highest ${highest}.`;
  }
  if (planned.heldBackApproval) {
    const nits = count === 0 ? '' : `, with ${plural(count, 'nit')}`;
    return `Would have commented: an unverified finding above a nit was held back${nits}.`;
  }
  return `Would have commented: ${plural(count, 'comment')}, the highest ${highest}.`;
}

/**
 * A GitHub suggestion block replacing the commented lines with `replacement`.
 * An empty replacement deletes them, which GitHub reads from an empty block,
 * not from one holding a blank line.
 */
export function suggestionBlock(replacement: string): string {
  return replacement === '' ? '```suggestion\n```' : `\`\`\`suggestion\n${replacement}\n\`\`\``;
}

function inlineComment(finding: ReviewFinding, patch: SuggestedPatch | undefined): ReviewComment {
  // The same rendering `draft` uses. The location is the comment's anchor,
  // so repeating it in the text would only be noise.
  const prose = `**${finding.severity}** - ${finding.prose}`;
  const comment: ReviewComment = { path: finding.path as string, line: finding.line as number, side: 'RIGHT', body: prose };
  if (patch === undefined) return comment;
  return {
    ...comment,
    body: `${prose}\n\n${suggestionBlock(patch.replacement)}`,
    // A one-line block needs no range: GitHub replaces the commented line.
    ...(patch.start_line < patch.end_line ? { start_line: patch.start_line, start_side: 'RIGHT' as const } : {}),
  };
}

/**
 * The create-review request body. Every anchored finding is an inline comment
 * on its line; the body is the one-line verdict plus only the findings with no
 * line to sit on, which includes a stale consumer on unchanged code. Never one
 * global block of findings.
 */
export function buildPayload(input: {
  head: string;
  event: ReviewEvent;
  planned: PlannedFindings;
  cappedBy: 'ci' | 'held' | 'complexity' | 'policy' | null;
  /** Optional advice that was separately verified but never enters the verdict. */
  bodyFindings?: readonly VerifiedSimplification[];
  /** The patches checked against the head, by inline finding; each renders as a suggestion block. */
  suggestions?: ReadonlyMap<ReviewFinding, SuggestedPatch>;
}): ReviewPayload {
  const posted = [...input.planned.inline, ...input.planned.unanchored];
  const body = [
    summaryLine(input.event, posted, input.cappedBy),
    ...input.planned.unanchored.map((finding) => finding.raw),
    ...(input.bodyFindings ?? []).map(renderSimplification),
  ].join('\n\n');
  return {
    commit_id: input.head,
    event: input.event,
    body,
    comments: input.planned.inline.map((finding) => inlineComment(finding, input.suggestions?.get(finding))),
  };
}

/**
 * Policy notes (docs/adr/0028), each on its own line at the end of the body.
 * Appended after the idempotency key is taken: they follow CI, and the same
 * review of the same head must stay one post whatever CI said.
 */
export function withAnnotations(body: string, annotations: readonly string[]): string {
  return [body, ...annotations].join('\n\n');
}

/** How many held claims there are of each kind, by the reason that held them. */
export interface HeldCounts {
  unverified: number;
  belowGate: number;
  challenge: number;
  restatesTool: number;
  policySuppressed: number;
  other: number;
}

/**
 * Counts the held entries of a recorded run by reason. A verdict this code does
 * not know (one added later) lands in `other`, so no held claim is ever left out
 * of the total.
 */
export function heldCounts(held: readonly { verdict: string }[]): HeldCounts {
  const counts: HeldCounts = { unverified: 0, belowGate: 0, challenge: 0, restatesTool: 0, policySuppressed: 0, other: 0 };
  for (const entry of held) {
    switch (entry.verdict) {
      case 'unverified':
        counts.unverified += 1;
        break;
      case 'below-gate':
        counts.belowGate += 1;
        break;
      case 'challenge-refuted':
      case 'challenge-partly':
        counts.challenge += 1;
        break;
      case 'restates-tool':
        counts.restatesTool += 1;
        break;
      case 'policy-suppressed':
        counts.policySuppressed += 1;
        break;
      default:
        counts.other += 1;
    }
  }
  return counts;
}

const NOT_RECORDED = 'not recorded';
/** A hex commit id; anything else in a recorded head is not put in the machine-readable trailer. */
const FULL_SHA = /^[0-9a-f]{40,64}$/i;
/** Fixed: no stage of Review Voice examines these, so the block says so on every review. */
const NEVER_CHECKED = ['UI behaviour', 'product policy', 'load behaviour'];


/**
 * The collapsed "Review scope" block, then a trailing HTML comment with the same
 * facts as JSON for scripts (docs/adr/0028, `verdict.scope_block`).
 *
 * Pure and built from the recorded run alone, so two renders of one run are
 * identical and the block cannot drift from what was reviewed. A fact the run
 * did not record reads `not recorded`; it is never left out, because a missing
 * line would read as "nothing to say". Only counts of held claims appear: the
 * lists stay local (docs/adr/0016). The human-review note, the would-have
 * verdict and a carry reason are never inputs here (docs/adr/0012, 0017).
 * Every name that came from configuration or the store goes through
 * `safeCheckName`, so none can break the markup or the comment.
 */
export function scopeBlock(
  run: RunDetail,
  planned: PlannedFindings,
  policy: Pick<VerdictPolicy, 'scopeBlockModels'>,
): string {
  const head = run.headRef;
  const fullHead = head !== null && FULL_SHA.test(head) ? head.toLowerCase() : null;
  const provenance = run.provenance;
  const checks = run.checks;

  const headPart = head === null || safeCheckName(head) === '' ? `Head ${NOT_RECORDED}` : `Head \`${safeCheckName(head).slice(0, 7)}\``;
  const scopePart = run.scope === null ? `scope ${NOT_RECORDED}` : `${run.scope.kind} scope`;
  const modePart = provenance?.mode == null ? `mode ${NOT_RECORDED}` : `${provenance.mode} mode`;
  const originPart =
    provenance === null ? `Origin: ${NOT_RECORDED}.` : `Origin: ${safeCheckName(provenance.origin)} (${safeCheckName(provenance.independence)}).`;

  // A name from configuration or the store is rendered as inline code, as the
  // CI annotations render check names: `safeCheckName` has removed backticks,
  // so nothing in it can close the code span, and inside one no markup
  // renders, so a check named `</details><h1>...` cannot escape the block.
  const code = (name: string): string => `\`${name}\``;
  const stageNames = run.stages.flatMap((stage) => {
    if (typeof stage.name !== 'string' || safeCheckName(stage.name) === '') return [];
    const name = code(safeCheckName(stage.name));
    if (!policy.scopeBlockModels) return [name];
    const models = [...new Set([...(Array.isArray(stage.models) ? stage.models : []), ...(typeof stage.model === 'string' ? [stage.model] : [])])]
      .filter((model): model is string => typeof model === 'string')
      // Not point-free, since `map` would pass the index as the cap.
      .map((model) => safeCheckName(model))
      .filter((model) => model !== '');
    return [models.length === 0 ? name : `${name} (${[...new Set(models)].map(code).join(', ')})`];
  });
  const stagesLine = `Stages: ${stageNames.length === 0 ? NOT_RECORDED : stageNames.join(', ')}.`;

  let staticLine = `Static checks: ${NOT_RECORDED}.`;
  let symbolLine = `Symbol context: ${NOT_RECORDED}.`;
  const notChecked = [...NEVER_CHECKED];
  if (checks !== null) {
    const parts = [
      ...checks.staticRan.map(
        (check) => `${code(safeCheckName(check.name))} ran (exit ${check.exitCode ?? 'none'}, ${plural(check.signals, 'signal')})`,
      ),
      ...checks.staticDidNotRun.map((check) => `${code(safeCheckName(check.name))} did not run (${code(safeCheckName(check.reason))})`),
    ];
    staticLine = `Static checks: ${parts.length === 0 ? 'none configured' : parts.join('; ')}.`;
    symbolLine =
      checks.symbolsInconclusive === 0
        ? 'Symbol context: every changed file finished.'
        : `Symbol context: ${plural(checks.symbolsInconclusive, 'file')} not finished${checks.symbolsBudgetExhausted ? ' (time budget)' : ''}.`;
    if (checks.symbolsInconclusive > 0) notChecked.push('files the symbol search did not finish');
  }

  const held = heldCounts(run.held);
  // A recorded finding the posting step withheld (no score for it, say) was
  // not posted either, and a block that said "nothing held back" over it
  // would be false. It has no held verdict of its own, so it counts as other.
  held.other += planned.held.length;
  const notPosted = [
    held.unverified > 0 ? plural(held.unverified, 'unverified claim') : null,
    held.belowGate > 0 ? `${held.belowGate} below the gate` : null,
    held.challenge > 0 ? `${held.challenge} held by the challenger` : null,
    held.restatesTool > 0 ? `${held.restatesTool} restating a static check` : null,
    held.policySuppressed > 0 ? `${held.policySuppressed} suppressed by policy` : null,
    held.other > 0 ? `${held.other} held for other reasons` : null,
  ].filter((part): part is string => part !== null);

  const posted = [...planned.inline, ...planned.unanchored];
  const findings = Object.fromEntries(
    (['blocking', 'important', 'minor', 'nit', 'question'] as const).map((severity) => [
      severity,
      posted.filter((finding) => finding.severity === severity).length,
    ]),
  );
  const facts = {
    head: fullHead,
    origin: provenance?.origin ?? null,
    independence: provenance?.independence ?? null,
    findings,
    held,
    checks: checks === null ? null : { ran: checks.staticRan.length, didNotRun: checks.staticDidNotRun.length },
  };
  // Escaped, so no value can close the comment early or open markup inside it.
  const trailer = JSON.stringify(facts).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

  return [
    '<details><summary>Review scope</summary>',
    '',
    `${headPart}, ${scopePart}, ${modePart}. ${originPart}`,
    stagesLine,
    staticLine,
    symbolLine,
    `Not posted: ${notPosted.length === 0 ? 'nothing held back' : notPosted.join(', ')}.`,
    `Not checked: ${notChecked.join(', ')}.`,
    '',
    '</details>',
    `<!-- review-voice ${trailer} -->`,
  ].join('\n');
}

/** The body with the scope block after the findings; CI annotations are added after this, never before. */
export function withScopeBlock(body: string, block: string): string {
  return `${body}\n\n${block}`;
}

/**
 * The same body with `previous` annotations swapped for `next`, for when CI
 * read again just before sending has changed what the note should say.
 */
export function replaceAnnotations(body: string, previous: readonly string[], next: readonly string[]): string {
  const suffix = previous.map((line) => `\n\n${line}`).join('');
  const base = suffix.length > 0 && body.endsWith(suffix) ? body.slice(0, body.length - suffix.length) : body;
  return withAnnotations(base, next);
}

/** A suggestion block left out of an inline comment, and why; the comment's prose still posts. */
export interface WithheldSuggestion {
  findingId: string | null;
  path: string;
  line: number;
  reason: string;
}

/**
 * The preview, generated from the payload that will be sent. A preview built
 * separately from the request is a mock-up, not a preview.
 */
export function renderPreview(input: {
  repository: string;
  pullNumber: number;
  payload: ReviewPayload;
  held: readonly HeldBack[];
  /** Comments already on this head from an earlier post, so not sent again. */
  alreadyInline?: number | undefined;
  /** Suggestion blocks left out of their comments, whose prose still posts. */
  withheldSuggestions?: readonly WithheldSuggestion[] | undefined;
}): string {
  const { payload } = input;
  const lines = [
    payload.event,
    `Repository: ${input.repository}`,
    `Pull request: #${input.pullNumber}`,
    `Head: ${payload.commit_id}`,
    `Body: ${payload.body}`,
    `Comments: ${payload.comments.length}`,
    ...payload.comments.map(
      (comment) => `${comment.path}:${comment.start_line === undefined ? '' : `${comment.start_line}-`}${comment.line}\n  ${comment.body}`,
    ),
  ];
  if ((input.alreadyInline ?? 0) > 0) {
    lines.push(`Already inline from an earlier post of this head, not sent again: ${input.alreadyInline}`);
  }
  for (const withheld of input.withheldSuggestions ?? []) {
    lines.push(`${withheld.findingId ?? '-'} ${withheld.path}:${withheld.line} suggestion withheld (${withheld.reason})`);
  }
  if (input.held.length > 0) {
    lines.push(`Held back, not verified: ${input.held.length}`);
    for (const held of input.held) {
      const where = held.path === null ? 'no anchor' : `${held.path}:${held.line ?? '?'}`;
      lines.push(`  ${held.findingId ?? '-'} ${where} (${held.reason})`);
    }
  }
  return lines.join('\n');
}

/** Identifies one inline comment, so the same comment on the same head is sent once. */
export function commentSignature(comment: ReviewComment): string {
  // The suggestion block is left out, so a finding posted without its block
  // (a contents read that failed) is not sent again with it once the read
  // succeeds on a later post of the same head (S14). The evidence block comes
  // after it and is derived text, so it is removed first, and a comment posted
  // under any combination of the two settings keeps one signature.
  const body = stripEvidenceBlock(comment.body);
  const block = body.lastIndexOf('\n\n```suggestion\n');
  const prose = block >= 0 && body.endsWith('```') ? body.slice(0, block) : body;
  return `${comment.path}:${comment.line}:${createHash('sha256').update(prose).digest('hex').slice(0, 32)}`;
}

/**
 * Repository, pull request, head and a hash of the exact payload. The same
 * review of the same head is the same post, so a second send is refused; a
 * different head or a different review is correctly a different post.
 */
export function idempotencyKey(repository: string, pullNumber: number, payload: ReviewPayload): string {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `${repository.toLowerCase()}#${pullNumber}@${payload.commit_id}:${digest}`;
}
