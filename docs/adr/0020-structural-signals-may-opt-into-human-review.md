# 0020 - Structural signals may opt into human review

**Status:** Accepted · **Date:** 2026-10-10
**Amends:** [0012](0012-complex-changes-need-human-approval.md) - two existing
structural signals may join its APPROVE cap when a repository enables them.

## Context

`diff --out` already records two facts that can make a change harder for a
person to read: a production file crossing the configured line limit, and an
existing function gaining configured branching. They are useful leads for a
maintainability finding, but a measurement alone is not a defect. ADR 0012
therefore did not let either signal change a verdict.

Some repositories nevertheless want an otherwise clean change with either
shape to receive a human approval. That is a decision about review coverage,
not proof that the change is wrong.

## Decision

**A repository may opt either structural signal into the existing ADR 0012
human-review cap; both remain off by default.**

- `review.human_review.structure.file_line_crossing: true` applies when
  `structure.sizeCrossings` is nonempty.
- `review.human_review.structure.branch_growth: true` applies when
  `structure.branchGrowth` is nonempty.
- The assessment records a reason naming the enabled signal. It follows the
  same stored, sticky path as every other ADR 0012 reason, and the existing
  local `humanReviewNote` names it for the person running the review.
- The cap only changes an otherwise APPROVE event to COMMENT. COMMENT and
  REQUEST_CHANGES stay as they were; no maintainability finding changes tier.
- The note, reason and would-have fields stay local. The posted body, inline
  comments, preview and GitHub write set do not mention the cap or add a write.

## Consequences

- A repository that leaves both settings absent gets the same structural
  evidence, assessment, note and verdict it had before this record.
- Teams can require human approval for a locally meaningful regression without
  turning a lexical measurement into a merge-blocking defect.
- The threshold and attribution rules stay with the structural signals; this
  record only decides whether their already-computed results cap approval.

## Alternatives considered

**No change.** Keeping structural signals as analyst evidence only avoids more
caps, but gives repositories no way to treat a locally important regression as
a reason for a human to approve an otherwise clean change.

**Raise the maintainability tier when a CLI signal backs it.** Rejected: that
would derive severity from a measurement, contrary to the traced-impact rules
in ADR 0009 and ADR 0011, and could turn a review-coverage choice into
REQUEST_CHANGES.
