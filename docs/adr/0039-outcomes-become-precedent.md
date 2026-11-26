# 0039 - Outcomes become precedent

**Status:** Accepted · **Date:** 2026-11-25
**Relates to:** [0029](0029-posted-findings-are-followed-to-an-outcome.md) -
posted findings are followed to an outcome; those outcomes now also teach
retrieval. Closes #480.

## Context

Precedent came only from synced history in `review_events`. The tool's own
posted findings, followed by `outcomes` to `fixed` or `dismissed`, taught it
nothing. Measured across 1,882 stored breakdowns, owner alignment never fell
below 0.5, so the owner-precedent gate for questions could never fire and a
kind of finding the owner kept dismissing was said again at the same weight.

## Decision

**Strong outcomes of the tool's own findings are derived into precedents at
retrieval time. No new precedent rows are written.**

- **Source.** `finding_outcomes` joined to the recorded finding in
  `review_runs` (`review_run_id`, `finding_id`) for repository, path, line,
  category and claim text. Deleting the outcome rows, or no longer deriving
  them, removes what was learned.
- **Mapping.** A `strong` `dismissed` becomes `dismissed`; a `fixed` becomes
  `accepted`. Weak outcomes, `resolved` without a fix, `outdated`, `open`
  and `unknown` contribute nothing. Silence is never a dismissal.
- **Role and weight.** `owner` when `decidedBy` is `identity.owner_reviewer`,
  `bot` for a Bot login or a `queue.skip.author_patterns` match, else `team`.
  A reply that only echoes a fix counts at most as `team`. Weights reuse
  `baseWeight` and `eventWeight`; recency is from `checked_at`.
- **Matching.** Derived precedents join `retrievePrecedents` beside corpus
  hits, matched on claim wording with the same `relevance` and
  `matchStrength` meaning, under the same repository scope and
  `--exclude-pull`, and under the same positive and negative caps. Each
  carries `source: 'outcome'`.
- **Visibility.** `explain` marks the source where precedents are listed.
  `status` prints the learned accepted and dismissed counts and each
  category with net negative learned precedent.

## Consequences

- An owner dismissal of the like of a candidate can take its owner or
  repository alignment below the neutral 0.5, so the precedent gates can
  fire on the tool's own record as well as on synced history.
- Retrieval stays read-only and offline. No scoring weight, threshold or
  gate changes; only what retrieval can find does.

## Alternatives considered

**Write derived precedents into `review_events`.** Rejected. A stored copy
would outlive the outcome it came from and could not be unlearned by
deleting that outcome.

**Count silence or a bare resolve as a dismissal.** Rejected, as in 0004.
Only a strong outcome is evidence either way.
