# 0034 - A cross-family runner is configured, never detected into use

**Status:** Accepted · **Date:** 2026-11-10
**Relates to:** [0003](0003-static-analysis-adapters.md) - a configured runner
is a configured command, gated like one (amended 2026-11-09).
[0021](0021-agents-run-in-a-confined-headless-runner.md) - the runner seam and
its command backend (amended 2026-11-09).
**Amends:** [0024](0024-an-independent-challenge-gates-every-posted-finding.md) -
a challenge the configuration required and could not get holds the finding and
keeps the review from approving.

## Context

The second pass exists because a verifier from the same model family shares
the analyst's blind spots, and the challenger exists because the verifier and
the second pass both start from the analyst's framing. Both arguments are
about correlated error, and both were met only by accident of configuration.
The runner seam had one real backend, so the challenger always ran on Claude,
whatever wrote the change. Nothing recorded which family ran a stage, so
`evaluate` could not say whether a second family earned its cost. Nothing read
who wrote the pull request, so a change an agent wrote was challenged by the
same family that may have written it, with no record that this happened.

## Decision

**One runner seam with one external backend. A family runs only where the
operator's own configuration names it; nothing is detected into use.**

- **The runner.** `runners.<family>` (`codex`, `gemini`) names an argv the
  command backend runs without a shell (ADR 0021, amended). It is read only
  from the operator's configuration, never a repository's base commit, and is
  refused under `REVIEW_VOICE_NO_COMMANDS=1`. `doctor` reports whether `codex`
  and `gemini` are on `PATH` and never runs a configured binary.
- **Families are recorded.** Every run records which family ran its second
  pass and its challenge, as a `families` key beside the provenance in
  `provenance_json`. The independence label keeps its two values; a family is
  a separate fact, never a third label value.
- **The challenge family.** `plan` names it with the rule that chose it.
  `runners.use.challenge` is the base family (`claude` by default). When
  `runners.use.agent_authored_challenge` is set and the change was written by
  an agent of the base family, the challenge runs on the configured
  alternative instead. Authorship comes from two deterministic signals, a
  `Co-authored-by` trailer over the commits the change adds and a `Bot` pull
  request author, matched against a closed family table shipped in
  `src/review/authorship.ts`. Both signals are written by the author, so they
  are a lead, never a trust decision. A change from an agent of another family
  already has a cross-family challenge, and an unknown family (`other`) never
  triggers the rule.
- **Fail closed, with an approval cap.** When the named family cannot run,
  every challenged finding is held as `challenge-partly` with a reason
  starting `challenger not run:`. A runner that starts and fails twice on a
  finding holds that finding the same way, and a finding it judged keeps its
  verdict. Any such hold makes the review comment rather than approve (ADR
  0024, amended). Nothing falls back to Claude on its own.
- **Per-family figures.** `evaluate --json` carries `by_family`, per family,
  the second pass's verdicts with drop, downgrade and tie-break rates, and the
  challenger's judged and held counts with a hold rate, plus the count of runs
  recorded before families were stored. The text prints a `by family` block.
  Every figure is reported, never a gate, and an absence reads `no data`.
- **Shown on request.** The scope block names a challenge family other than
  Claude, and its trailer carries `families`, only with
  `verdict.scope_block_models: true`, because a family is a vendor choice and
  the block shows those only on request.

## Consequences

- With no `runners:` block nothing changes. Every stage runs on Claude. A new
  run whose challenge ran records `claude` for it, and a run whose challenge
  did not run records none (`challenge none`).
- A watched review (`watch.run_repository_commands: false`) runs with
  `REVIEW_VOICE_NO_COMMANDS=1`, so a configured challenge family there holds
  every challenged finding and the review cannot approve. The loader warns.
- A configured runner must be installed wherever the review runs, the Action
  included, or its challenges hold.
- A single family's rate on a small sample is a sample. The figures say which
  family a run used; they are not a ranking of vendors.

## Alternatives considered

**A model-name heuristic over `review.models`.** Rejected. A model name is an
opaque string a provider may change, and guessing a family from it would put a
command in use that no one configured.

**Fall back to Claude when the configured family cannot run.** Rejected. It
keeps reviews flowing at the price of a silent loss of the independence the
configuration asked for. A challenge the configuration required and did not
get is a missing gate, and ADR 0024 holds a finding whose gate is missing.

**Stop the review when the family cannot run.** Rejected. It posts nothing at
all, where holding the challenged findings still posts what passed and says
why the rest did not.

**A family per finding.** Rejected. The rule and the figures need one
challenge family per run, and per-finding families would make a run's
independence a mixture no one could read.
