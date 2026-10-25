# 0023 - Analyst lanes are configured, each with its own severity rule

**Status:** Accepted · **Date:** 2026-10-25
**Relates to:** [0009](0009-severity-from-computed-reach.md),
[0011](0011-severity-escalation-needs-traced-impact.md) - lane rules only cap or
gate a tier that scoring already derived.

## Context

One analyst reads the diff. Operators who wanted a second view, such as a strict
structural review for duplicated helpers, tangled conditionals or files crossing
a size limit, ran a second analyst by hand. They merged its candidates in, gave
them an id prefix and applied their own severity rule afterwards: structural
findings capped at minor unless the verifier confirmed a concrete blocker. That
rule lived in a shell script outside Review Voice, and scoring could not see it.

## Decision

**A lane is a configured analyst with a prompt, an eligibility rule, a
candidate id prefix and a severity rule. The built-in `diff` lane is always on,
and a `structure` lane ships with its agent.**

- **Configuration.** `review.lanes[]` takes `name`, `agent`, `prefix`, `when`
  and `severity`. `when` takes `min_changed_source_lines`, `paths` and
  `exclude_kinds`. The changed-line count excludes tests, documentation,
  configuration and generated files, using the same rules as complexity.
- **Merging.** Lane candidates are merged before `check-candidates`. A
  candidate whose id does not carry its lane's prefix is refused. Candidates
  that share an anchor are kept, and `check-candidates` marks them
  (`sharesAnchorWith`, `possibleDuplicateOf`) for the verifier to settle.
- **Severity.** After `score` derives a tier, the lane rule may only lower it to
  `cap`, or raise it to `escalate.to` when the verifier set
  `blocker_confirmed: true`. An escalation still needs 0011's traced impact and
  confidence. A lane cannot raise a tier past what 0011 allows.
- **The structure lane.** `agents/structure-analyst.md` looks for a measured
  file-size crossing, a named existing helper doing the same job, a conditional
  tangling a shared flow, or the same edit scattered across sites. The verifier
  sets `blocker_confirmed` only when that evidence holds exactly. Taste is
  rejected.
- **Recorded.** Each candidate carries `lane`. `record` stores it, and
  `evaluate` can report precision per lane.

## Consequences

- A team adds a review perspective with a prompt file and four lines of
  configuration.
- Severity rules that lived in operator scripts become visible to `score` and
  `validate-output --scores`, so a rendered tag cannot disagree with them.
- More lanes means more cost. Modes (ADR 0025) decide which lanes run.

## Alternatives considered

**One analyst prompt with every checklist.** Rejected. Long prompts dilute both
reviews, and the severity rule differs per perspective.

**Lane severity as a free-form expression.** Rejected. Cap and escalate cover
every rule in use. An expression language would be a new trust surface in
repository configuration.
