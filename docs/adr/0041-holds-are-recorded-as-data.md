# 0041 - Holds are recorded as data

**Status:** Accepted · **Date:** 2026-11-26
**Relates to:** [0032](0032-approved-policies-are-enforced-at-scoring.md) -
the policy hold is one of the gates recorded.
[0037](0037-confidence-is-a-floor-materiality-is-a-verdict.md) - the
materiality and owner-precedent holds are listed in `belowGate` by `gate`.

## Context

Issue #485. A stored score breakdown said why a candidate was held only as a
sentence, `rejectedBecause`, and `gateOf`, the `belowGate` listing and the
store's mapping each recovered the gate by matching that sentence's first
words. #479 added two more prefixes to match. Rewording one message, or adding
a hold that leads a sentence, silently moved a candidate between lists, and the
sentence also stood in for the verifier's verdict, which the breakdown did not
carry.

## Decision

**The verdict and the gate are fields. The sentence is for people.**

- `ScoreBreakdown` gains `verified` and `premisesVerified`, copied from the
  verification entry and null when there is none, and `gate`, a `HoldGate`
  code (null when eligible).
- Every rejection branch in `scoreCandidate` writes a distinct code, and so does
  every later stage that holds a candidate scoring left eligible or rewrites its
  reason: policy suppression, an uncorrectable correction, the absence check, a
  repeat of the thread, a refused anchor, a missing citation, the question cap
  and the challenger's holds. `HOLD_GATES` lists them, and a test fails when a
  code has no branch that writes it.
- A stage that appends `Also:` to an earlier reason, or leads over it, records
  its own code, so a compound hold is never read as one gate alone. That is what
  the `Also:` check in the old prose reader did.
- `gateOf` reads `gate` when present. Only a breakdown stored before this
  change, which has no `gate`, is read from the prose, unchanged. A code is
  listed in `belowGate` or `suppressed` only where the prose reader listed it:
  `confidence-floor` and `question-gap` as `confidence`, `score`, `materiality`,
  `owner-precedent` and `policy`.
- `rejectedBecause` is unchanged, and nothing posted or rendered changes.

## Consequences

- No migration. Old rows keep the prose fallback; new rows carry both.
- A new hold needs a new code, which the coverage test then requires a branch
  to write, rather than a prefix some reader must remember to match.
- `metrics` counts challenge holds from `gate` when present and from the prose
  otherwise.
