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
- **Reaching `score`.** The verifier rejects a claim it cannot check, and the
  review used to discard every rejection before scoring, so the list could
  never fill. A candidate the verifier rejected with at least one blocking
  entry is now set aside in step 3, skips the second pass and the tie-break,
  and is added to the candidates scored in step 4. The cap rejects it there.
  Defence in depth: `score` also rejects any candidate other than a question
  whose verification says `verified: false`, so a forwarded rejection can
  never become eligible even with its context list emptied.
- **Only the cap.** A candidate is listed only when the cap is the one rule
  that stopped it. The thread-repeat and citation checks still run on it, and
  a failure there, or an untraced stale consumer, is appended to the reason
  and keeps it off the list.
- **The confidence floor.** A candidate the verifier confirmed but rated below
  its own floor (0.8) was in neither list either. It is now listed in
  `belowGate` with `gate: confidence`, beside the final-score case
  (`gate: score`), under the same only-this-gate rule. Local only.
- **Strict input.** An entry that is neither a string nor that object, or has
  an unknown kind, is refused by `check-verification` and `score`, as is a
  `verified` that is not a boolean.
- **Questions.** A `question` is eligible when its premises are verified, even
  if its answer is not. This was already the behaviour - a question skips the
  confidence gates - but was written down nowhere, and it is the one place an
  unverified candidate reaches the editor. The verifier may now report
  `premises_verified` for a question: `false`, a premise wrong or unchecked,
  rejects it; `true` or absent leaves it as before. Amended 2026-10-29 (#219):
  a question the verifier rejects (`verified: false`) with its own confidence
  below 0.5 that the gap is real is held in `belowGate` as more likely moot
  than not; the owner can still promote it.

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

## Amendment - 2026-11-11

A finding held under the confidence floor counts against an approval (#337).
The decision above lists such a finding in `belowGate` with `gate: confidence`
and the review driver holds it as `below-gate` with the reason `below the
confidence gate`. It never reaches the review text, so the posting plan never
counted it, and a review could approve past a concern the verifier had
confirmed while an unverified one kept the same review at COMMENT. Measured on
the recall fixtures, an authorization finding verified at 0.78, with a derived
tier of blocking, was held under the 0.8 floor and the review approved with no
reason recorded.

**The rule.** A held entry of the run counts exactly as an unverified finding
above a nit does when its verdict is `below-gate`, its reason says the
confidence gate stopped it, and its severity is `blocking`, `important` or
`minor`. An approval becomes COMMENT. COMMENT and REQUEST_CHANGES are
unchanged, so a held finding still never requests changes. Nothing new is
posted and no finding becomes more likely to post. A `nit` does not count, and
neither does a `question`, since a question under its gate is one the verifier
judged more likely moot. One predicate, `heldBelowConfidenceGate` beside
`challengeNotRun` in `src/store/runs.ts`, states the rule for the posting plan
and for `record`.

**A hold by the final-score gate never caps.** An entry whose reason is `below
the score gate` was stopped by the final score, which carries the owner's own
precedent. That is preference, and a preference must never block an approval.
The alternative above, which reads `belowGate` as stopped only by preference,
now holds for the score gate alone.

**The reason stays local.** `decide()` and the would-have summary name the
cause beside the others, saying that a finding above a nit was held back,
unverified, below the posting tier or below the confidence gate. The posted
body says what it says for an unverified hold, that this is not an approval
yet, and names no path, line or claim of the held finding
([0012](0012-complex-changes-need-human-approval.md)). The scope block counts
it under `below the gate`, as it already did.

**What ends the hold.** The hold outlives every review narrower than the pull
request, under the rules a hold for a challenger that did not run follows
([0024](0024-an-independent-challenge-gates-every-posted-finding.md)). A carry
to an unchanged scope keeps it, and an incremental or interdiff review
inherits it from the prior run its scope links, following a file the patch
renames. It ends when one of these is true.

- The pull request no longer changes the file. A manifest whose file list is
  present and empty says that of every file. A manifest with no file list
  leaves it to the two scope lists.
- A review that is not narrowed runs. It inherits nothing, reads the whole
  pull request and judges again.
- The owner declines the held finding with `decline`, which sets the entry's
  verdict to `owner-declined` in that run.
- The narrowed review itself holds the same path and line again with a hold
  that keeps a review from approving, which is one under the confidence gate
  above a nit or one for a challenger that did not run. That entry stands and
  the place is recorded once.

Nothing else the narrowed review says about the place ends the hold. A finding
in its review text there, of any severity, is another claim and not a
judgement of the held one, and so is an entry it holds there as `unverified`,
`refuted` or `partly`. Were any of these to end the hold, an unrelated nit or
a refuted claim on the same line would let the review approve past a blocking
finding the verifier confirmed. The same one rule covers an inherited hold for
a challenger that did not run.

The owner can still post the finding with `score --promote`, as before.

This changes a default. Some reviews that approved before now comment.
