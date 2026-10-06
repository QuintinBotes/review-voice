# 0016 - What the verifier could not check

**Status:** Accepted · **Date:** 2026-10-06
**Relates to:** the unverifiable cap described under "Whose confidence the gate
reads" in `docs/ARCHITECTURE.md`. No GitHub write is added or changed, and
nothing listed here is ever posted.

## Context

A candidate whose verifier listed anything in `required_context_missing` was
capped at 0.6 and rejected: "the claim states it could not be verified, so it
cannot ship whatever it scores". Two things went wrong with that.

- **The cap fired on context the claim did not need.** A verified behavioural
  finding, also confirmed by an independent cross-check, was rejected because
  the only missing entry was the display text of a localisation key it quoted.
  The defect - the wrong message branch being shown - did not depend on that
  wording. With the text fetched and the verifier re-run, the same finding was
  eligible as important.
- **The rejection was silent.** The candidate was neither eligible nor in
  `belowGate`, so the owner never saw it. One such claim, rated 0.72 with a
  scope question it could not settle, was later confirmed end to end and was
  the most useful observation of its review.

## Decision

**The verifier marks each missing piece of context as `blocking` or
`cosmetic`, and only blocking context caps the claim. A claim held back by
blocking context alone is listed for the owner as `unverified`, and never
posted.**

- **Kinds.** An entry is a string, or `{"context": string, "kind": "blocking"
  | "cosmetic"}`. A string, or an object without `kind`, is blocking, so every
  verification written before this reads exactly as it did. `cosmetic` means
  the claim holds without the context and it would only sharpen the wording;
  the claim must then not state that wording as fact. When in doubt the
  verifier marks it blocking.
- **The cap.** Applies when any blocking entry is present, as before. Cosmetic
  entries alone leave the verifier's confidence to the usual gates.
- **`unverified[]`.** `score` lists each candidate whose only rejection is the
  cap from blocking context, with its tier, claim, the verifier's confidence
  and the blocking entries. The review prints it after the validated review
  under `Unverified (not posted)` and records it with `record --held` as
  `unverified`. A later review's `--held-from` does not drop candidates on
  account of it, since nothing was concluded about them.
- **Strict input.** An entry that is neither a string nor that object, or has
  an unknown kind, is refused by `check-verification` and `score`.

## Consequences

- A finding that quotes text the verifier could not read can ship when the
  defect does not depend on that text. The cost of a wrong `cosmetic` mark is a
  claim whose quoted wording is off, not a claim whose mechanism is unchecked.
- The owner sees every claim the cap held back, with what was missing, and can
  supply the context and re-run.

## Alternatives considered

**Cap confidence instead of rejecting.** A claim nobody in the pipeline could
check would then ship whenever the other terms carried it, which is how a
review comment ends up retracted.

**List capped claims in `belowGate`.** `belowGate` means verified and stopped
only by preference; these were not verified, and the owner should be able to
tell the two apart.
