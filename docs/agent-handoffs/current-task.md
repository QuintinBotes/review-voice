# Current task - none open

**Milestone:** 1.2.0 released. The queue from the September retests is empty of
code fixes.
**Risk:** low. Nothing is outstanding that can be closed by writing code.
**Baseline:** `main`

## What closed

Twelve queue items, in five releases from 1.1.0 to 1.2.0. Each landed with the
evidence that motivated it in the commit, so the reasoning survives without
this file.

| # | Item | Where |
|---|---|---|
| — | Severity collapsed to minor or nit | #75, ADR 0009 |
| 1 | Convention stubs pointing at two documents resolved neither | #78 |
| 9 | Truncation silent; byte budget counted UTF-16 units | #78 |
| 4 | Editor could not receive findings by path | #79 |
| 5 | Analyst prompt named its schema instead of carrying it | #79 |
| 6 | `RV` as a shell variable fails under zsh | #79 |
| 10 | `--min-score` help advertised a default three releases stale | #79 |
| 10b | Agent tool grants unverified | #80, partially |
| — | Reach measured word popularity; `local` unreachable | #81 |
| 2 | Pull request commits never made available locally | #83 |
| 3a/3b | External verifier judged the working tree | #83 |
| 8 | Empty untracked files bought word budget | #83 |
| 7 | Precedent alignment near-constant | #84, shadowed |

## What remains, and why none of it is a code fix

### 1. Run `evals/confinement`

**Risk:** unknown, which is the point.

#80 pinned every agent's declared tool grant and added an eval that probes
whether the grant binds. **It has never been run.** Until it has,
`docs/THREAT-MODEL.md` says plainly that threat 4's mitigation is asserted
rather than verified.

The observation behind it stands: a verification stage reportedly built a
synthetic workspace with the repository's own pinned yarn and ran its oxlint,
and neither is `git`. Three outcomes, different fixes:

1. The grant does not confine subagents - the mitigation is not implemented as
   documented and every declared grant is decorative.
2. The orchestrator ran those commands - confinement holds, and the threat
   model should say which component its claim covers.
3. Something widened the grant at runtime - then what.

```
claude plugin eval plugins/review-voice --eval-dir evals
```

### 2. Measure the precedent switch

**Risk:** high if guessed, zero if measured.

#84 ships `anchored` on every score breakdown: what the final score would be
with anchor-less precedents excluded, and whether eligibility would flip. The
gate still uses the current computation.

The switch needs runs, not a decision. Excluding moves the score by 0.0527 to
0.1131 against a 0.68 threshold, and `score.ts` already records what happens
when that kind of shift is answered with arithmetic: 0.74 was arithmetic and
was wrong; 0.68 was measured and replaced it.

Collect `anchored.wouldChangeEligibility` across real reviews. When the flips
are visible, move the gate and the exclusion together in one change.

### 3. Label findings in normal use

`owner_accepted_precision` has still never had a data point. This has been the
open item since before 1.0.0 and no amount of code closes it.

Note the distinction that matters for reading the metric: hand-verified labels
record whether a finding was **true**; the metric measures whether it was
**kept**. Related, not identical.

### 4. Derive reach symbols from the diff

**Risk:** medium. The largest remaining design change.

Reach takes its symbols from the claim via `namedSymbols`, an extractor built
to find things to check for absence, where a broad net is cheap. #81 excluded
symbols the changed file does not contain and symbols common enough to describe
the language, which caught `Math.round` and `canEdit`. It does not catch the
symbol a finding exists to say is the **wrong** referent, because that symbol is
genuinely in the file.

The changed hunks name what the pull request actually touched. That is the
thing whose spread matters.

Related, and closed by the same work: reach is computed at the base ref, so a
symbol the change introduces has no spread by construction and falls back to
the category tier. Safe, but it makes the feature inert for most findings,
which are about new code.

### 5. Relevance-scoped convention selection

#78 made truncation visible. It did not make it stop losing content. A 21,441
byte rule governing 728 of 1,073 added lines is still cut at 15,000; the reader
can now see the cut, which is not the same as reading the rule. Selecting the
sections matching changed paths, rather than the head of the file, is the real
answer.

### 6. Reviews cannot complete inside a ten-minute sweep

Measured: analyst 238k tokens across 94 tool calls, roughly ten minutes;
verifier 141k across 59, about five. A review has to become a resumable job
rather than a tick-scoped task, and `store/runs.ts` already has `recordRun`,
`latestRun` and `runDetail` to build on.

**Measure before designing.** #78 fixed the pointer bug that left the analyst
without the controller rules on a run where it made 94 tool calls holding
`Grep` and `Glob`. Re-run that pull request and compare. If the count drops,
part of the cadence problem was a conventions problem.
