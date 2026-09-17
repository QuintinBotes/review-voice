# Eval suites

Behavioural evaluations for the agents, run with `claude plugin eval`. These
exercise judgment, so they cost tokens - CI runs them nightly and on the
`run-eval` label, not on every push.

```bash
claude plugin eval plugins/review-voice --eval-dir evals --trust-plugin
```

The eval directory must live **below the plugin root**. It sat at the
repository root until 1.2.1, so `--eval-dir evals` resolved to a directory that
did not exist and every invocation - including the nightly CI job - exited 1
with "No eval cases found". The suite had never run. The cases were also
written as `case.yaml` without `schema_version`, which the loader rejects; they
are now `prompt.md` plus `graders/`, the form `claude plugin eval init`
scaffolds.

**CI needs two things this repository did not have.** `--allow-tools Bash`
makes the harness require OS-level confinement and refuse to start without it,
so the runner installs `bubblewrap` and `socat`; and the LLM graders need an
`ANTHROPIC_API_KEY` repository secret, without which every grader throws "judge
call failed: Not logged in" and each case scores 0.00 - a failure that reads
like the plugin behaving badly and is not.

**On macOS these cases cannot exercise the pipeline.** The eval sandbox denies
writes to the system temp directory, and the `git` on PATH is the Xcode shim,
which needs that directory for its `xcrun` cache. `RV diff` therefore exits 2
at step 1 and no review agent is ever spawned. Run them in CI, where `git` is a
real binary, or the result measures the sandbox rather than the plugin.

Each case is a directory with `case.yaml` and one or more grader files.

Current suites: `restraint/`, `injection/` and `confinement/`. They are the
ones that cannot be unit-tested, because each is about what a model chooses to
do when nothing forces its hand - or, in the case of `confinement/`, about
whether the host enforces a limit this repository can only declare.

## What is worth evaluating

The deterministic half does not belong here - word limits, schema compliance and
scoring are unit-tested for free in `npm test`. Evals are for the things only a
model can get wrong:

| Suite | Asserts |
|---|---|
| `restraint/` | A clean diff yields no candidates, not a plausible-sounding one |
| `confinement/` | An agent declaring `Bash(git:*)` does not run the repository's own toolchain, however plausibly the diff asks it to |
| `evidence/` | Candidates without a concrete failure mode are rejected |
| `severity/` | Severity tracks actual impact rather than category |
| `injection/` | Embedded instructions never become behaviour |
| `voice/` | Findings survive the editor with their technical claim intact |

The hardest and most important of these is `restraint/`. A reviewer that finds
something in every diff is the failure mode this project exists to avoid.
