# 0025 - Cost modes choose stages and models

**Status:** Accepted · **Date:** 2026-10-25
**Relates to:** [0012](0012-complex-changes-need-human-approval.md) - `auto`
reads the same complexity assessment.

## Context

The agent files carry no model. Operators picked models per stage by hand: a
cheaper model for documentation-only changes and nits, a stronger one for
complex changes and for checks on important findings. A full review on a large
change runs eight or more agent calls, and the same review on a one-line
configuration change does not need most of them.

## Decision

**A mode resolves to a `StagePlan` that says which stages run and on which
model. `auto` picks the mode from the diff.**

- **Three modes.** `fast`, `standard` and `thorough`, with the table in
  `docs/WATCHER.md`. The plan is a pure function of the mode, the configuration
  overrides and the per-finding severity, so it is tested as a table.
- **`auto`.**
  - `fast` when no production source changed.
  - `thorough` when complexity is `high` or more than 150 production lines
    changed.
  - `standard` otherwise.
  The plan's `reason` names which rule chose it.
- **Overrides.** `review.models` can set the model per stage. `--mode` on
  `review` and `watch` beats `review.mode`.
- **Floors that no mode lowers.** Every mode runs the verifier, `score`,
  `validate-output` and the posting guards. Any finding above a nit gets a
  challenge, even in `fast`.
- **Recorded.** The plan is stored with the run and printed in the report.

## Consequences

- A watcher on a busy queue spends the strong model only where the change
  warrants it.
- Cost per review becomes predictable and visible in `stages_json`.
- Model names are configuration, so a new model needs no release.

## Alternatives considered

**A model per agent in its frontmatter.** Rejected. The right model depends on
the change and the finding, not on the agent.

**A token budget instead of modes.** Rejected. A budget cut mid-stage leaves a
partial review, while a mode decides up front what runs.

## Amendment - 2026-11-08

`auto` gains one rule. A change whose `structure.removedControls` is nonempty
picks `thorough`, and the plan's `reason` says a control was removed. The rule
sits after the no-production-source clause, so a change with no production
source stays `fast`, and after the complexity clause, so a high complexity keeps
its reason. `auto` therefore reads:

  - `fast` when no production source changed.
  - `thorough` when complexity is `high`, when a control was removed, or when
    more than 150 production lines changed.
  - `standard` otherwise.

A removed control changes which models and stages run, never the verdict. An
explicit `--mode` or `review.mode` other than `auto` is not changed by it.

## Amendment - 2026-11-09

The plan gains a `reproduce` stage (S16), between `verify` and `second-pass`,
with no model. It runs only in `thorough`, and only when the configuration's
`reproduction` block is enabled with at least one runner
(`PlanInput.reproductionConfigured`, which `plan` reads from the same
configuration as the rest of the plan). Every other mode, and `thorough`
without the block, records it as off. A reproduction runs pull request code, so
it belongs to the mode that already spends the most to gather evidence, and
nothing in `fast` or `standard` changes. Under `REVIEW_VOICE_NO_COMMANDS=1` the
driver skips the stage with a note, as it does the second pass. The floors are
unchanged, and the stage never turns the verifier, the challenge or the posting
guards off.
