# Eval suites

Behavioural evaluations for the agents, run with `claude plugin eval`. These
exercise judgment, so they cost tokens — CI runs them nightly and on the
`run-eval` label, not on every push.

```bash
claude plugin eval plugins/review-voice --eval-dir evals
```

Each case is a directory with `case.yaml` and one or more grader files.

Current suites: `restraint/` and `injection/`. They are the two that cannot be
unit-tested, because both are about what a model chooses to do when nothing
forces its hand.

## What is worth evaluating

The deterministic half does not belong here — word limits, schema compliance and
scoring are unit-tested for free in `npm test`. Evals are for the things only a
model can get wrong:

| Suite | Asserts |
|---|---|
| `restraint/` | A clean diff yields no candidates, not a plausible-sounding one |
| `evidence/` | Candidates without a concrete failure mode are rejected |
| `severity/` | Severity tracks actual impact rather than category |
| `injection/` | Embedded instructions never become behaviour |
| `voice/` | Findings survive the editor with their technical claim intact |

The hardest and most important of these is `restraint/`. A reviewer that finds
something in every diff is the failure mode this project exists to avoid.
