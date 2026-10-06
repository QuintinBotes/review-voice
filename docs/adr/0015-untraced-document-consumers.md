# 0015 - A stale document may be reported untraced at nit

**Status:** Accepted · **Date:** 2026-10-06
**Relates to:** [0011](0011-severity-escalation-needs-traced-impact.md) - the
same `impact_traced` field, read for eligibility rather than escalation. No
GitHub write is added or changed.

## Context

A candidate may declare `anchor: "stale-consumer"` for unchanged code the
change made wrong. `score` made it eligible only when the verifier set
`impact_traced`, because nothing in the diff shows an unchanged consumer
breaking; only a trace from the consumer back to its cause does.

The most common stale consumer is not code. A guide or skill that still tells
authors to copy a pipeline the change moved into a base class is wrong, and the
verifier confirmed exactly that at 0.85. It also, correctly, left
`impact_traced` false: a misleading document is not a demonstrated runtime
break. The finding was rejected, and since the final score did not stop it, it
was not in `belowGate` either. A correct, verified nit was lost silently, and
the anchor type was unusable for its most common case.

## Decision

**A stale consumer whose path is a document (`.md`, `.mdx`, `.markdown`,
`.rst`, `.adoc`, `.asciidoc` or `.txt`) is eligible without `impact_traced`
when it is reported at `nit`. Anything above `nit`, and any consumer that is
not a document, still needs the trace.**

- The tier is the one `score` reports, after derivation and the evidence
  bound, not the one the analyst asked for.
- Every other gate still applies: the cause must be an added line or deletion
  site, and the verifier's confidence and the final score gate as usual.
- A document consumer rejected above `nit` says so in `rejectedBecause`, so the
  analyst can refile it at the tier it can have.
- A comment inside a source file keeps the stricter rule. It sits beside code
  the finding could break, and the extension cannot tell the two apart.

## Consequences

- A stale guide, skill or README can reach the author as a nit, in the review
  body like every stale consumer.
- A nit costs the author nothing to decline, so the cost of a wrong one is
  small; a louder claim about a document still has to be traced.

## Alternatives considered

**List untraced stale consumers in `belowGate`.** Keeps them visible to the
owner but never lets a correct one reach the author, which is the loss the
issue reported.

**Accept any untraced stale consumer at nit.** A caller left wrong by a changed
signature is a runtime break, and the trace is how the verifier shows it.
