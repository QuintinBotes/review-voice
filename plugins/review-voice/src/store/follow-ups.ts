import type { Database } from './db.ts';
import type { StoredFinding } from './runs.ts';
import { parseFinding } from '../contract/parse.ts';
import { overlap, significantWords, DUPLICATE_OVERLAP, type ThreadComment } from '../scoring/score.ts';

/**
 * A partly-addressed follow-up, tracked across the runs of one pull request.
 *
 * A finding recorded as `partlyAddressed` says what of the owner's earlier
 * comment was still open at that run. It stays open until a later run of the
 * same pull request sees it settled, and only on positive evidence:
 *
 *   - the follow-up's own comment thread is resolved on the pull request; or
 *   - the verifier, given the open follow-up, found every remaining point
 *     addressed in the code at the head.
 *
 * Absence is not evidence. A later review that did not raise the points again,
 * or whose interdiff did not include the file, leaves it open. All of this is
 * local: nothing about a follow-up's state is posted.
 */
export interface OpenFollowUp {
  /** `<runId>:<findingId>` of the run that recorded the finding. */
  id: string;
  runId: string;
  findingId: string;
  path: string;
  line: number;
  prior: { author: string; path: string; line: number };
  remaining: string[];
  /** The finding as rendered, to find its posted comment on the thread. */
  text: string;
}

export interface FollowUpState {
  id: string;
  runId: string;
  findingId: string;
  path: string;
  line: number;
  status: 'open' | 'resolved';
  /** Only when resolved. */
  resolvedBy?: 'thread' | 'verifier' | undefined;
  /** What was still open when this state was recorded; the last open list once resolved. */
  remaining: string[];
  reason: string;
}

/** The verifier's ruling on one open follow-up, as the review hands it to `record`. */
export interface FollowUpRuling {
  id: string;
  remaining: string[];
  addressed: string[];
  reason?: string | undefined;
}

export class FollowUpRulingError extends Error {}

interface StoredRun {
  runId: string;
  findings: StoredFinding[];
  followUps: FollowUpState[];
}

/** Every run of one pull request, oldest first, with what the follow-ups need. */
function runsForPull(db: Database, repository: string, pullNumber: number): StoredRun[] {
  const rows = db
    .prepare(
      `SELECT review_run_id, output_json
       FROM review_runs
       WHERE LOWER(repository) = LOWER(?) AND pull_number = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(repository, pullNumber) as { review_run_id: string; output_json: string }[];
  return rows.map((row) => {
    let parsed: { findings?: unknown; followUps?: unknown } = {};
    try {
      parsed = JSON.parse(row.output_json) as typeof parsed;
    } catch {
      // A damaged row contributes nothing rather than stopping the review.
    }
    return {
      runId: row.review_run_id,
      findings: Array.isArray(parsed.findings) ? (parsed.findings as StoredFinding[]) : [],
      followUps: Array.isArray(parsed.followUps) ? (parsed.followUps as FollowUpState[]) : [],
    };
  });
}

/**
 * Each follow-up of the pull request with its latest state, and the run that
 * recorded that state. A follow-up no later run has looked at is open as
 * recorded.
 */
export function followUpHistory(
  db: Database,
  repository: string,
  pullNumber: number,
): Map<string, { followUp: OpenFollowUp; state: FollowUpState | null; stateRunId: string | null }> {
  const history = new Map<string, { followUp: OpenFollowUp; state: FollowUpState | null; stateRunId: string | null }>();
  for (const run of runsForPull(db, repository, pullNumber)) {
    for (const finding of run.findings) {
      const partly = finding.partlyAddressed;
      if (partly === undefined) continue;
      const id = `${run.runId}:${finding.findingId}`;
      history.set(id, {
        followUp: {
          id,
          runId: run.runId,
          findingId: finding.findingId,
          path: finding.path,
          line: finding.line,
          prior: partly.prior,
          remaining: partly.remaining,
          text: finding.text,
        },
        state: null,
        stateRunId: null,
      });
    }
    for (const state of run.followUps) {
      const entry = history.get(state.id);
      // A resolved follow-up stays resolved: nothing reopens it.
      if (entry === undefined || entry.state?.status === 'resolved') continue;
      entry.state = state;
      entry.stateRunId = run.runId;
      if (state.status === 'open' && Array.isArray(state.remaining) && state.remaining.length > 0) {
        entry.followUp = { ...entry.followUp, remaining: state.remaining };
      }
    }
  }
  return history;
}

/** The follow-ups of a pull request that no recorded run has seen resolved. */
export function openFollowUps(db: Database, repository: string, pullNumber: number): OpenFollowUp[] {
  return [...followUpHistory(db, repository, pullNumber).values()]
    .filter((entry) => entry.state?.status !== 'resolved')
    .map((entry) => entry.followUp);
}

/**
 * The verifier's rulings, from an array or an object carrying `follow_ups`
 * (or `followUps`), such as the verifier's whole output. A malformed ruling
 * throws: a ruling quietly dropped would leave a settled follow-up open, and
 * one misread could close an open one.
 */
export function parseFollowUpRulings(parsed: unknown): FollowUpRuling[] {
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? ((parsed as Record<string, unknown>)['follow_ups'] ?? (parsed as Record<string, unknown>)['followUps'])
      : undefined;
  if (!Array.isArray(list)) throw new FollowUpRulingError('expected an array, or an object with follow_ups');
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
  return list.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new FollowUpRulingError(`entry ${index}: not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['id'] !== 'string' || e['id'].length === 0) throw new FollowUpRulingError(`entry ${index}: id must be a non-empty string`);
    if (!strings(e['remaining']) || !strings(e['addressed'])) {
      throw new FollowUpRulingError(`entry ${index}: remaining and addressed must be lists of points`);
    }
    if (e['remaining'].length === 0 && e['addressed'].length === 0) {
      throw new FollowUpRulingError(`entry ${index}: remaining and addressed cannot both be empty`);
    }
    if (e['reason'] !== undefined && typeof e['reason'] !== 'string') {
      throw new FollowUpRulingError(`entry ${index}: reason must be a string when present`);
    }
    return {
      id: e['id'],
      remaining: e['remaining'],
      addressed: e['addressed'],
      ...(typeof e['reason'] === 'string' ? { reason: e['reason'] } : {}),
    };
  });
}

/**
 * The follow-up's own inline comment on the thread: posted by the owner whose
 * comment it follows up, on its file, in the form `post` sends a finding
 * (`**<severity>** - <prose>`), at its line or saying what it said. GitHub
 * moves a comment's line as code is inserted above it, so the wording finds it
 * when the line no longer does. The form is what keeps the owner's original
 * comment out: it makes the same points, and its thread being resolved says
 * nothing about the follow-up.
 */
function postedComment(followUp: OpenFollowUp, thread: ThreadComment[]): ThreadComment[] {
  const author = followUp.prior.author.toLowerCase();
  const finding = parseFinding(followUp.text, 1);
  if (finding.severity === null || finding.prose.length === 0) return [];
  const opening = `**${finding.severity}** - `;
  const mine = significantWords(finding.prose);
  return thread.filter(
    (comment) =>
      (comment.kind === undefined || comment.kind === 'review-comment') &&
      comment.path === followUp.path &&
      comment.author.toLowerCase() === author &&
      comment.body.startsWith(opening) &&
      (comment.line === followUp.line || overlap(mine, significantWords(comment.body)) >= DUPLICATE_OVERLAP),
  );
}

/**
 * Settles each open follow-up against this run's evidence. Returns one state
 * per open follow-up, and the ids of rulings that named none, which the
 * caller reports rather than silently ignoring.
 */
export function settleFollowUps(
  open: OpenFollowUp[],
  evidence: {
    /** The thread as `RV thread` read it for this run, or null when not given. */
    thread: ThreadComment[] | null;
    rulings: FollowUpRuling[];
    /** The files this run reviewed, when its scope listed them. */
    scopeFiles: string[] | null;
  },
): { states: FollowUpState[]; unmatched: string[] } {
  const rulings = new Map(evidence.rulings.map((ruling) => [ruling.id, ruling]));
  const states = open.map((followUp): FollowUpState => {
    const base = { id: followUp.id, runId: followUp.runId, findingId: followUp.findingId, path: followUp.path, line: followUp.line };
    const posted = evidence.thread === null ? [] : postedComment(followUp, evidence.thread);
    if (posted.some((comment) => comment.resolved === true)) {
      return {
        ...base,
        status: 'resolved',
        resolvedBy: 'thread',
        remaining: followUp.remaining,
        reason: 'its comment thread is resolved on the pull request',
      };
    }
    const ruling = rulings.get(followUp.id);
    if (ruling !== undefined && ruling.remaining.length === 0) {
      return {
        ...base,
        status: 'resolved',
        resolvedBy: 'verifier',
        remaining: followUp.remaining,
        reason: `the verifier found every remaining point addressed${ruling.reason === undefined ? '' : `: ${ruling.reason}`}`,
      };
    }
    if (ruling !== undefined) {
      return {
        ...base,
        status: 'open',
        remaining: ruling.remaining,
        reason: `the verifier found ${ruling.remaining.length} point${ruling.remaining.length === 1 ? '' : 's'} still open`,
      };
    }
    const outOfScope = evidence.scopeFiles !== null && !evidence.scopeFiles.includes(followUp.path);
    return {
      ...base,
      status: 'open',
      remaining: followUp.remaining,
      reason: outOfScope
        ? 'its file was not in this review, which is no sign it was addressed'
        : 'nothing in this review settled it',
    };
  });
  const known = new Set(open.map((followUp) => followUp.id));
  return { states, unmatched: evidence.rulings.map((ruling) => ruling.id).filter((id) => !known.has(id)) };
}
