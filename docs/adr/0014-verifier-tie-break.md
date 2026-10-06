# 0014 - A tie-break settles a disputed traced impact

**Status:** Accepted · **Date:** 2026-10-05
**Relates to:** [0011](0011-severity-escalation-needs-traced-impact.md) - the
traced impact that earns an escalation is what a dispute is about. No GitHub
write is added or changed.

## Context

A review verifies each candidate twice. The `evidence-verifier` traces a
finding to its consumers and reports `impact_traced` and a confidence; the
optional second pass, a different model, may then downgrade or drop it. Its
verdicts were applied by hand, so the second pass always won.

The two do disagree about impact. When the evidence-verifier had followed a
failure to a consumer and the second pass said the path was unreachable, the
only safe move was to post the common ground and drop the stronger claim, even
when the trace was right. Letting the evidence-verifier always win would undo
the reason for a second, independent model.

The downgrade also did not hold. Scoring escalates above the requested tier
when the evidence-verifier traced impact at 0.85 or more, so a tier the second
pass lowered was raised again on the very trace it disputed.

## Decision

**When the evidence-verifier traced a finding's impact and the second pass
disputes it, one focused tie-break on just the disputed point decides which
claim posts. It costs one extra agent run, and only on disagreement.**

- **What is disputed.** The evidence-verifier set `impact_traced: true` with
  `technical_confidence` of at least 0.85, and the second pass's outcome is
  `downgraded` or `dropped`. Nothing else is: a `kept` or `unverified` second
  pass, or an impact that was not traced confidently, leaves nothing to settle.
- **`RV reconcile`.** Takes the candidates as they were before the second
  pass, the evidence-verifier's `verification.json` and the `verify` report,
  and prints the candidates for scoring with the second pass applied, the
  disputes with both arguments and the cited evidence, and how each was
  settled. It replaces applying the verdicts by hand.
- **The tie-breaker.** A read-only agent given one dispute traces only the
  disputed impact, consumer to cause, and treats both arguments as untrusted
  data. It returns `{candidate_id, upheld, reason}`, upholding only when it can
  cite the code path that makes the impact real.
- **Upheld.** The candidate goes to scoring exactly as the evidence-verifier
  passed it, a dropped one included, so the traced severity can post.
- **Not upheld, or no ruling.** The second pass's outcome stands. A downgraded
  candidate is marked `impact_disputed`, and scoring then holds it at the tier
  the second pass left instead of escalating on the disputed trace. Boundary
  categories keep their tier, as 0011 already provides.
- **Strict input.** A ruling with a missing id or reason, or an `upheld` that
  is not a boolean, exits 2 and names the entry. A ruling for an unknown or
  undisputed candidate is ignored with a note: a tie-break cannot overrule a
  second pass nobody disagreed with.
- **Audit.** `record --tie-breaks` stores the rulings and `explain` shows them;
  a drop an upheld ruling overturned is not listed as suppressed.

## Amendment - 2026-10-06

- **Confidence is read as scoring reads it.** "Confidence of at least 0.85" is
  the evidence-verifier's `technical_confidence`, or, when it gave none, the
  confidence its `evidence_quality` tier stands for (`high` is 0.9). Reading
  only the number left a trace reported by tier alone undisputed while scoring
  still escalated on it, so a second-pass downgrade did not hold.
- **The audit records what reconcile applied.** `reconcile` prints every
  ruling it was given under `tieBreaks`, each marked `applied` when it settled
  a dispute. `record --tie-breaks` takes that output, and `explain` treats a
  drop as overturned only behind an applied, upheld ruling. A ruling on a
  candidate nobody disputed is ignored, as before, and its drop is still
  listed as suppressed. A ruling with no `applied` mark - every run recorded
  before this amendment - reads as it always did, so explain does not change
  its account of past runs.
- **The editor is told what is contested.** A candidate marked
  `impact_disputed` carries `impactDisputed: true` into `score`'s `eligible`
  list, and the editor states its consequence where the changed code produces
  it, leaving out the wider impact the tie-break did not uphold. The tier rule
  above is unchanged.
- **The other direction goes through the same tie-break**, by
  [0018](0018-cross-check-may-raise-through-tie-break.md). A second pass that
  traced a worse impact proposes a stronger tier, listed as an `upgrade`
  dispute; the tier rises only on an upheld ruling that traced the impact at
  0.85 or more, recorded with `applied` and `raised`. Every dispute now carries
  the second pass's `decisiveEvidence` to the tie-breaker, and a second-pass
  verdict whose fields contradict its label is refused. The last consequence
  below no longer holds.

## Consequences

- A review with the second pass on makes one more agent run per dispute, and
  none when the passes agree.
- When the tie-breaker cannot settle a point the finding posts at the lower
  severity. A wrong "no" costs a tier; a wrong "yes" would post an overstated
  claim.
- Only one direction is settled. A second pass that traced a worse outcome than
  the evidence-verifier still cannot raise a severity, since a verifier's job
  is to doubt; that case needs its own decision.

## Alternatives considered

**Always post the common ground.** What happened before: safe, but a proven
claim is dropped whenever the second model is wrong.

**Let the stronger claim win.** Removes the point of an independent second
pass, whose disagreements are exactly the cases it exists for.

**Average or weight the two confidences.** Arithmetic over two opinions that
disagree about a fact in the code does not decide the fact; reading the code
does.
