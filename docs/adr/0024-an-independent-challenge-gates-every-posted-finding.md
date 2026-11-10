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

## Amendment - 2026-11-08

Under `verdict.evidence_block`
([0028](0028-verdict-policies-are-configurable.md)), the challenger's verdict
and its decisive `path:line` references may be posted beside the finding, in
the collapsed Evidence block after the inline comment. They are read from the
score the challenge stored, and each reference is checked against the same
`path:line` rule again when the block is rendered; one that names an absolute
path or climbs out with `..` is dropped. The challenger's `reason` is never
posted. The challenger's inputs, the rule that only `confirmed` with the line
confirmed or moved passes, and the hold rules are unchanged.

## Amendment - 2026-11-09

The **Input** bullet widens by one fact. When the `reproduce` stage
([0025](0025-cost-modes-choose-stages-and-models.md), S16) ran a reproduction
for the finding, `challenge --emit-prompts --reproductions` adds its record,
which is the runner, the file's path in the worktree, the path of the kept
copy, each run's exit code and the first 40 lines of the first run's redacted
output, or one line saying why it did not run. The reproduction file is the
verifier's work, and the owner decided it may reach the challenger, as an
artefact with its observed output, which is a fact, labelled untrusted. The verifier's `expected` sentence, its reason,
its confidence and its evidence are still never included. A reproduction
settles nothing by itself, and the challenger is told to refute the finding when
the reproduction exercises something other than the claim, fails for an
unrelated reason, or asserts a behaviour the code never promised, and may cite
the copy in `decisive_evidence`, where the evidence block drops it as an
absolute path. Applying the verdicts drops an entry that names the
reproduction file by its worktree path or its basename, since that file exists
only in the copy and the block would otherwise post it. A reproduction that did not fail reaches the challenger only for
a category no suppression may reach, since there it does not hold the finding.

## Amendment - 2026-11-10

The challenger may run on a configured model family
([0034](0034-a-cross-family-runner-is-configured-never-detected-into-use.md)).
`runners.use.challenge` names the family every challenge runs on (`claude` by
default), and `runners.use.agent_authored_challenge` names the family a change
is challenged on when an agent of that same family wrote it, read from its
`Co-authored-by` trailers and a `Bot` author. The challenger's inputs, its
verdict and the rule that only `confirmed` with the line confirmed or moved
passes are unchanged.

A challenge the configuration required and could not get holds the finding.
When the configured family cannot run (`REVIEW_VOICE_NO_COMMANDS=1` or no
`runners.<family>` block), every challenged finding is held as
`challenge-partly` with a reason starting `challenger not run:`. A runner that
starts and fails twice on a finding holds that finding the same way, and a
finding it judged keeps its verdict. Nothing falls back to another family on
its own.
Such a held finding keeps the review from approving, so the event is COMMENT
at most. A carry to an unchanged scope keeps the hold unless the pull request
no longer changes its file, and a later review that drops the finding as a
repeat of the hold keeps the hold as well, since no challenge has run there
either. It is the one held finding that changes the event; every other held
finding still leaves it alone, and a Claude challenger that fails twice keeps
its `challenger failed:` reason and its event as before.
