# 0019 - A cross-check may raise a severity only through the tie-break

**Status:** Accepted · **Date:** 2026-10-06
**Amends:** [0014](0014-verifier-tie-break.md) - the tie-break also settles the
other direction, which 0014 left open. **Relates to:**
[0011](0011-severity-escalation-needs-traced-impact.md) - the bar a raised tier
must clear is the one an escalation clears. No GitHub write is added or
changed.

## Context

0014 settles one kind of disagreement: the evidence-verifier traced an impact
and the second pass lowered or dropped it. It left the reverse open on purpose,
since a verifier's job is to doubt: a second pass that traced a worse outcome
than the evidence-verifier could not raise a tier, and its `suggested_severity`
above the current tier was ignored.

That cost a proven claim. Twice an independent cross-check traced a concrete
input that reached a worse outcome than the one the evidence-verifier had
narrowed the finding to, and the only safe course was to post the common ground.

Two more failures came from the cross-check's own verdicts. A cross-check that
read excerpts refuted two findings the evidence-verifier had confirmed; it had
missed the decisive lines, an instruction at the top of one file and the only
two writers of a value in another, and a second cross-check pointed at those
lines confirmed both. And a smaller model answered "REFUTED" while its own
explanation confirmed the claim.

## Decision

**A second pass may propose a stronger tier, and the tier rises only when the
tie-breaker upholds that worse impact, traced, at the escalation confidence. A
second-pass verdict names the lines it turns on, and one whose fields contradict
its label is refused.**

- **A proposal, not a change.** A `confirmed` verdict whose
  `suggested_severity` is above the finding's tier, with a reason and at least
  one `decisive_evidence` entry, is recorded as `kept` at the same tier with
  `proposedSeverity`. Without lines to trace it is ignored, as before.
- **The same tie-break.** `reconcile` lists the proposal as a dispute of kind
  `upgrade`, beside 0014's `downgrade` disputes, whatever the evidence-verifier
  traced. The tie-breaker traces the worse impact from the changed line to the
  outcome and returns `impact_traced` and a `confidence` (or an
  `evidence_quality` tier) with its ruling.
- **The bar is 0011's.** The tier rises to `proposedSeverity` only when the
  ruling is upheld, `impact_traced` is true, and its confidence, read by the
  shared `verifierConfidence`, is at least `ESCALATION_CONFIDENCE` (0.85). An
  upheld ruling below that, or untraced, leaves the tier where it was and is
  reported as `upheld without traced impact`. A raised tier reaches scoring as
  the requested tier and is derived and bounded like any other; scoring is
  unchanged.
- **Recorded like other rulings.** Every ruling under `tieBreaks` is marked
  `applied` as 0014's amendment provides, and one that raised a tier also
  carries `raised` with the new tier, recomputed by `reconcile` whatever its
  input said. `explain` shows it.
- **Decisive evidence.** A second-pass verdict may carry
  `decisiveEvidence: [{path, line, why}]`, at most ten, malformed entries
  dropped by `verify`. Every dispute hands it to the tie-breaker as places to
  look, never as conclusions to accept.
- **A verdict counts only when its fields agree with its label.** At parse
  time `reconcile` refuses, exiting 2 and naming the verdict, a verdict whose
  label is not `confirmed`, `rejected` or `uncertain`; a `kept` that is not
  `confirmed` or that moves the tier; a `dropped` that is not `rejected`; an
  `unverified` that is not `uncertain`; a `downgraded` without a known
  `finalSeverity` below the original (a `nit` or a `question`, with nothing
  weaker, may stay put); a proposal that is not above the tier, not on a `kept`
  verdict, or has no reason or decisive evidence; and malformed decisive
  evidence. `verify` itself reads a label outside the three as no verdict, so
  the finding stands unverified rather than kept, and no longer turns a doubted
  question into a nit.

## Consequences

- A review with the second pass on makes one more agent run per upgrade
  proposal, as it does per downgrade dispute, and none when the passes agree.
- A worse impact the second pass proves can post. A wrong "yes" from the
  tie-breaker would overstate a claim, so it needs the same traced, confident
  evidence an escalation needs; a wrong "no" posts the tier the
  evidence-verifier established, as before.
- A free-text reason is still not read for meaning. Only the structured fields
  that state the same thing are checked, so a verdict whose prose alone
  contradicts a consistent label still counts; the decisive lines are what the
  tie-breaker checks it against.
- A second-pass command that emitted contradictory fields by hand now stops
  `reconcile` instead of being applied by whichever field was read.

## Alternatives considered

**Let the second pass raise the tier directly.** Its traced example may be
right, but a verifier that can escalate on its own word is the stronger-claim
rule 0014 rejected.

**Raise when both passes agree on a worse tier.** The evidence-verifier
narrowed the claim in exactly these cases; agreement is what is missing.

**Read the reason for its meaning.** Deciding whether prose confirms or refutes
a claim is a model's judgment; the parse check stays deterministic, and the
tie-breaker reads the code.
