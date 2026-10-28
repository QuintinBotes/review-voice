import type { OutcomeStatus } from '../retrieval/weights.ts';
import type { ReplyStance } from '../store/outcomes.ts';

export type OutcomeCertainty = 'strong' | 'weak';

export interface EventOutcome {
  status: OutcomeStatus;
  certainty: OutcomeCertainty;
}

export interface OutcomeSignals {
  /** The latest reply from someone other than the commenter that agreed or turned it down. */
  reply: Exclude<ReplyStance, 'other'> | null;
  /** Null when the thread state was not read. */
  resolved: boolean | null;
  /** A later commit in the same pull request changed the anchored lines. */
  changed: boolean;
}

/**
 * The outcome of a historical comment from signals already fetched (docs/adr/0004),
 * on the strength rules 0029 applies to posted findings: a reply turning it down,
 * or a change the author made that someone confirmed, is strong. A resolution or
 * a change alone, and agreement with no change, are weak. Silence is unknown,
 * never a dismissal.
 */
export function inferOutcome(signals: OutcomeSignals): EventOutcome {
  if (signals.reply === 'reject') return { status: 'dismissed', certainty: 'strong' };
  if (signals.changed && (signals.resolved === true || signals.reply === 'acknowledge')) {
    return { status: 'accepted', certainty: 'strong' };
  }
  if (signals.changed || signals.resolved === true || signals.reply === 'acknowledge') {
    return { status: 'accepted', certainty: 'weak' };
  }
  return { status: 'unknown', certainty: 'weak' };
}
