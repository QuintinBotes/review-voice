# 0024 - An independent challenge gates every posted finding

**Status:** Accepted · **Date:** 2026-10-25
**Relates to:** [0014](0014-verifier-tie-break.md),
[0019](0019-cross-check-may-raise-through-tie-break.md) - the second pass and
tie-break are unchanged. The challenge comes after scoring and can only hold a
finding or move its anchor.

## Context

The evidence-verifier and the second pass both start from the analyst's framing.
Operators who post on Review Voice's behalf added one more gate by hand. A fresh
agent is given the claim and the code, but not the verifier's reasoning, and is
asked to refute it and to confirm the exact line. Over several weeks of daily
use that gate caught an off-by-one anchor and several claims whose decisive
lines the verifier had not read. It also cost one finding when a smaller model
contradicted its own explanation, which is why the challenger names its
decisive lines.

## Decision

**After `score`, every eligible finding goes to a challenger that never sees
the verifier's output. Only a `confirmed` verdict with the line confirmed lets
the finding through.**

- **Input.** The finding's claim, failure mode, path and line, the diff, the
  clone, and the intent statements it rests on. Not the verifier's reasoning,
  confidence or evidence.
- **Output.** A `ChallengeVerdict` (`docs/WATCHER.md`). A verdict whose label
  contradicts its fields is refused, as 0019 refuses a second-pass verdict. One
  example is `confirmed` with no `decisive_evidence`.
- **Effects.**
  - `confirmed` with `line_ok` passes.
  - `confirmed` with `corrected_line` moves the anchor through the 0017 rules,
    and the editor renders it at the new line.
  - `partly` holds the finding as `challenge-partly`, and `refuted` holds it as
    `challenge-refuted`, each with the challenger's reason.
  - Held findings never change the verdict, as with every held finding.
- **Model.** The challenger runs on the stronger model for important or above
  findings, and in thorough mode (ADR 0025). It is on in `standard` and
  `thorough`. In `fast`, it still runs for any finding above a nit.
- **No raising.** A challenger cannot raise a tier. A worse impact it traces is
  recorded as a note, and the existing 0019 path is how a tier rises.

## Consequences

- Posted precision should rise, at the cost of one agent call per eligible
  finding. Most reviews have zero to two.
- The hand-run gate becomes part of the recorded run. Its verdicts are stored
  beside the verifier's, so `evaluate` can show how often it held a finding.
- `/review-voice:review` gains the same step, through the `challenge` command.

## Alternatives considered

**Show the challenger the verifier's reasoning.** Rejected. It anchors the
challenger on the same framing, which is what the gate exists to break.

**Let a refuted challenge drop the finding entirely.** Rejected. A held finding
stays in the record, so the owner can still promote it on review.
