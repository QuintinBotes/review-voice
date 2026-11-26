# 0037 - Confidence is a floor, materiality is a verdict

**Status:** Accepted · **Date:** 2026-11-24
**Amends:** [0016](0016-what-the-verifier-could-not-check.md) - the verifier
confidence floors it set, 0.8 at blocking and important and 0.7 at minor and
nit, become one floor of 0.7, and a claim the verifier verified is no longer
gated on the numeric final score.
**Relates to:** [0032](0032-approved-policies-are-enforced-at-scoring.md) -
a materiality hold never reaches a category no suppression may reach.
[0033](0033-committable-suggestions-are-verified-patches.md) - the verified
fix gate keeps its own 0.8, decoupled from the finding floor.

## Context

Issue #479 measured the evidence-verifier's `technical_confidence` above
verification and found it does not separate true from false finely enough to
act as a truth gate at 0.8. Two gates were spending that number as though it
could. The tiered floors (#343) already recorded the cost in one direction:
of the recall runs that missed a seeded defect, half lost it to a verified
finding held under 0.8. And a verified claim still had to clear the numeric
final score, 0.35 of which is confidence, so the same number was counted
twice - the argument scoring already made when it stopped gating a question
that way, and when it moved off 0.8 for the analyst's self-report after the
labelled sample showed true findings at 0.70 and the only false one at 0.80.

What neither number asks is whether the true thing is worth saying. That
judgement had nowhere to go, so it travelled inside confidence, where it
blurred the one measurement that number does make.

## Decision

**Verifier confidence is one low floor, not a fine-grained truth gate. The
question of worth is a separate verdict the verifier returns beside it.**

- **One low floor.** `review.confidence_threshold` and
  `review.minor_confidence_threshold` both default to 0.7, one floor at every tier. Both keys keep
  working, the minor floor is still clamped to at most the main one, and
  setting 0.8 and 0.7 reproduces the old floors. A category no suppression
  may reach (0032) keeps 0.8 at every tier - `max(0.8, the configured main
  floor)` - because a wrong comment there costs most. The analyst-only floor
  stays 0.7, where its labelled data puts it. The verified-fix gate reads
  its own constant, 0.8, raised to the configured main floor when that is
  higher, so lowering the finding floor does not loosen what repair text may
  be stated as verified.
- **No numeric final-score gate for a verified claim.** A non-question
  candidate gated on the verifier's confidence with `verified: true` is held
  back only by owner precedent against it, as a question already was. That
  hold is listed in `belowGate` as `gate: owner-precedent` and stays
  promotable, as the score gate it replaces was. The
  final and anchored scores are still computed and reported, and the
  anchored shadow is read through the gate the candidate was actually held
  to. A candidate with no such verdict, an analyst-only one above all, keeps
  the numeric gate.
- **Materiality is a verdict.** The verifier may add `material`,
  `material_reason` (at most 300 characters) and `severity_fit` (`right` or
  `too_high`), answered after `verified` and never by lowering confidence;
  absent fields mean material at a fitting tier. On a verified claim,
  `material: false` at minor or nit holds the finding in `belowGate`,
  promotable by the owner as the other entries are. At important or
  blocking, `material: false` or `severity_fit: too_high` lowers the reported
  tier exactly one and never holds; `too_high` alone leaves a minor or nit as
  it is. A suppression-exempt category is never held for materiality
  and may only be lowered that one tier.

A cross-family relabel found two false findings in the 0.50 to 0.70 band, so
the floor sits at 0.7 rather than 0.5; below it the number still carries.
The new defaults are not released by this record alone. They ship only after
an external label check, as #479 states.

## Consequences

- A verified finding at 0.72 now reaches the author at any tier, blocking
  included, and one at 0.65 still does not. What holds a true but trivial claim back is the
  verifier saying so, in words the owner can read and promote past.
- Precision now rests on verification, the materiality verdict and the
  challenge, rather than on where a noisy number landed against 0.8. If the
  label check disagrees, the two config keys restore the old floors without
  a code change.
- `explain` still shows the final score of a shipped verified finding,
  including scores under the old gate; the distribution block in `score`
  output keeps that measurable.

## Alternatives considered

**Keep 0.8 and add the materiality verdict anyway.** Rejected. It would
leave the measured loss in place: verified true findings held by a number
that does not discriminate, now with a second verdict saying they matter.

**Drop the confidence floor entirely.** Rejected. Below even odds the
number does carry - that is where the question gap already sits - and the
0.8 carve-out for a breach or a trust boundary is the one place a wrong
comment costs enough to keep a real bar.
