# 0022 - One command drives a review

**Status:** Accepted · **Date:** 2026-10-25
**Relates to:** [0021](0021-agents-run-in-a-confined-headless-runner.md),
[0010](0010-review-verdict-posting.md) - posting still goes through `post` and
its guards.

## Context

A full review is about fifteen CLI calls and five kinds of agent. The order,
the files passed between them, and the recovery rules (relaunch an analyst once
on a shape error, send only failing anchors back, hold findings a check drops)
live in a 963-line command file and in each operator's own scripts. Every
operator rebuilds the same glue, and every rebuild drifts. One drift posted a
finding without its held siblings recorded. Another recorded three runs with
the wrong held shape.

## Decision

**`review-voice review --pr <n>` runs the whole pipeline as a fixed stage graph
in the CLI, and every stage reuses the existing command's function and check.**

- **The graph is data.** A table of stages (name, kind, inputs, outputs, check,
  failure rule) in `src/review/stages.ts`. The driver walks it in order.
  `docs/WATCHER.md` lists the stages.
- **No new review logic.** Each stage calls the same function the matching
  command calls (`emitDiff`, `checkCandidates`, `scoreCandidates`,
  `validateOutput`, `recordRun`, `computeVerdict`, `postReview`). The driver
  only moves files between them and applies the failure rules.
- **Failure rules are the documented ones.** A refused agent output is
  relaunched once with the refusal text. A second refusal stops the run with
  exit 7 and records nothing. An intent failure carries on without intent. A
  challenge failure holds the finding.
- **Everything is on disk.** Each stage writes its input and output under the
  run directory. A person can stop after any stage and continue with the
  existing commands, as before.
- **Head checks bracket the run.** The head is read at the start and again
  before `record`. A moved head stops the run with exit 3, and `watch` retries
  on the next pass. The run directory stays on disk for `carry-candidates`.
- **The slash command reads the same table.** `/review-voice:review` keeps its
  prose, and a test fails if its step list and the stage table disagree.

## Consequences

- A clean review is one command. The operator scripts that wrapped the
  pipeline can be deleted.
- The driver is the place to add a stage. A new stage is a table row plus its
  function.
- A run takes as long as its slowest agent per stage. Lanes and challenges run
  in parallel within their stage, up to the runner's cap.

## Alternatives considered

**A shell or Node script shipped beside the CLI.** Rejected. It would duplicate
argument parsing and file conventions, and it could not share the stage table
with tests.

**Let the agents call the CLI themselves.** Rejected. Agents read untrusted
input, and the commands that record and post must not be reachable from them.
