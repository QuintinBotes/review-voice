# 0029 - Posted findings are followed to an outcome

**Status:** Accepted · **Date:** 2026-10-25
**Amends:** [0004](0004-outcome-inference-limits.md) - the same inference rules
now also apply to findings Review Voice posted. No write is added.

## Context

`evaluate` reports `owner_accepted_precision` from explicit feedback only. In
practice almost nobody records feedback, so the metric is empty, and the
posting gate it feeds is reported but never met. Meanwhile GitHub already holds
the answer for every posted comment. The thread was resolved or not, the author
replied, or the anchored lines changed in a later commit. 0004 decided how to
read those signals honestly for historical comments. Nothing applies them to
Review Voice's own.

## Decision

**`outcomes` follows each posted inline comment to an outcome, with 0004's
strength rules, and `evaluate` reports precision from strong outcomes.**

- **Signals.** The review thread state (the ADR 0018 GraphQL query), replies in
  the thread, and the pull request's later commits matched to the anchored file
  and line range. These are all reads already allowed.
- **Outcomes.**
  - `fixed` (strong): the anchored lines changed after the comment, and the
    thread was resolved or the author agreed.
  - `dismissed` (strong): a reply disagreed, or the owner recorded `dismiss`.
  - `resolved` (weak): resolved with no change.
  - `outdated` (weak): lines changed, thread open.
  - `open` or `unknown`: nothing decides it.
- **Storage.** A `finding_outcomes` table keyed by run and finding id. A newer
  check replaces an older one. Explicit feedback always wins.
- **Metrics.** `evaluate` adds `posted_findings_tracked`, `posted_fixed_rate`
  and `posted_dismissed_rate`, over strong outcomes only. They are broken down
  by lane and severity with `--json`.
- **When.** `watch` checks the pull requests it touched each pass. `outcomes`
  checks on demand.

## Consequences

- An owner sees how often posted findings were acted on, without labelling
  anything.
- The silence rule holds. An unanswered comment is `open`, never `dismissed`.
- Reading threads costs one GraphQL query per pull request with posted
  comments, bounded by the same rate-limit handling as sync.

## Alternatives considered

**Count a merge without a change as dismissal.** Rejected, as in 0004.

**Ask the author to react with an emoji.** Rejected. It adds work for the
author and depends on a convention nobody follows.

## Amendment - 2026-11-08

Strong dismissals are calibration evidence as well as a metric. `calibrate`
uses them to propose suppressions keyed by rule id, scoped to the common
directory of the dismissals or global when that directory is the repository
root. Silence and weak outcomes remain ineligible as policy evidence.

The owner's own reject reply counts even when the review was posted under
the owner's credential. An acknowledgement by the posting account still does
not count, because agreeing with its own finding is not independent evidence.
The deciding login is recorded so only the owner's dismissals count as owner
signals. A dismissal already covered by explicit `dismiss` or `never_flag`
feedback counts once. The evidence bar and owner approval still gate every
activation; collecting an outcome never activates a suppression.

## Amendment - 2026-11-08 (applied suggestions)

[0033](0033-committable-suggestions-are-verified-patches.md) lets a verified
patch post as a suggestion block. An applied suggestion is a new strong `fixed`
outcome, decided before the resolved-or-agreed rule: when the anchored lines
changed and the file at the current head, read through the contents endpoint,
holds the replacement from the patch's `start_line`, for as many lines as the
replacement has, the evidence is "suggestion applied". The author committing
the suggested text is as strong a signal as a reply agreeing with it. An empty
replacement, a deletion, never matches this way, and a file that cannot be
read falls through to the rules above. It is one read per such finding, and
nothing is written.

## Amendment - 2026-11-09 (approvals)

[0036](0036-approvals-are-followed-to-an-outcome.md) follows the verdict as
well as the findings. Each APPROVE Review Voice sent is followed, from the same
`review_post_sent` audit rows `sentRuns` walks, to `reverted`,
`changes_requested` or `survived` (strong), or to `merged_other_head`,
`pending`, `closed`, `open` or `unknown` (weak), in a separate
`approval_outcomes` table with the same replace-on-recheck rule. `sentRuns`
and the finding outcomes above are unchanged, and the silence rule holds: a
merge the window has not closed on is `pending`, never `survived`.

## Amendment - 2026-11-10 (replies)

[0035](0035-one-bounded-reply-per-own-finding.md) lets a person post one reply
under one of this tool's own inline comments, through `reply --pr N --confirm`.
The outcomes check reports the threads awaiting it as `questions` beside the
outcomes, from the comments and thread states it already reads, so finding them
costs no request; `outcomes --json` is still an array of outcomes. The reply is
recorded as a `review_reply_sent` audit row keyed to run and finding, and the
author's next reply under the thread is the outcome signal, read by `decide()`
under the rules above. The tool's own reply classifies as neither a dismissal
nor an acknowledgement, so it never decides an outcome. `evaluate` reports two
goals from the join of those rows to the stored outcomes. `posted_replies`
counts the replied findings, and `replied_fixed_rate` is fixed over fixed or
dismissed among them, strong outcomes only. Both are `no data` with none. Calibration reads
feedback and outcomes, never audit rows, so a reply is not a policy signal by
itself. The watcher never replies.
