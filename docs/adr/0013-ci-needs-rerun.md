# 0013 - CI that needs a rerun holds every event

**Status:** Accepted, amended 2026-10-06 · **Date:** 2026-10-02
**Amends:** [0010](0010-review-verdict-posting.md) - the CI guard gains one
state. No GitHub write is added or changed; this only adds a case in which the
one write is not made.

## Context

0010 reads CI as green, pending or red. Two kinds of check fit none of them.

- **Infrastructure failures.** A check that `timed_out`, hit a
  `startup_failure`, or stopped at `action_required` was counted as red. None
  of them says the change is wrong: the runner gave up, could not start, or is
  waiting for someone to allow it. Counting them as red capped an approval at
  COMMENT and posted a review that blamed the change for the runner.
- **Stuck checks.** A cancelled run with nothing after it, or a run left queued
  or in progress, was pending. Pending turns an approval into a wait, and a
  check that will never finish made that wait last forever, while COMMENT and
  REQUEST_CHANGES posted on a head nobody had finished testing.

In both cases the honest answer is "rerun CI", and neither existing state could
say it.

## Decision

**A check that failed for infrastructure reasons, or is stuck, puts CI in a
new state, `needs-rerun`. On that state `verdict` never approves and nothing is
posted, whatever the mapped event.**

- **What counts.** A completed check run concluding `timed_out`,
  `startup_failure` or `action_required`; a `cancelled` run that no later
  completed run of the same app and name replaced; and a check run queued,
  waiting or in progress whose `started_at` is more than 60 minutes before the
  time CI is read. `failure`, and any conclusion not yet classified, stay red.
  A run with no start time is never taken as stuck.
- **Precedence.** Any real failure is red, as before. Otherwise any check that
  needs a rerun makes the state `needs-rerun`, ahead of pending: waiting for
  the other checks will not fix it. Configured gate checks are moved out of the
  way exactly as they are for failures and pending checks.
- **Effect on the verdict.** After the head guard (a moved head is still exit
  3) and before every other guard: `event` is null, `action` is `wait`, there
  is no payload, and the exit code is 6. The reasons name each check and why,
  for example `CI needs a rerun: build (timed_out), e2e (in_progress for 75
  min)`. This holds for APPROVE, COMMENT and REQUEST_CHANGES, and for
  `--recheck`.
- **Effect on posting.** `post` recomputes the verdict, so it refuses with exit
  6 and makes no request. An approval re-reads CI immediately before sending,
  and a `needs-rerun` reading there also refuses with exit 6.
- **The clock.** The live read judges stuck checks against the current time.
  Classifying already-fetched checks without a time judges none as stuck.

## Consequences

- `verdict` and `post` have a new exit code, 6. A caller that only knew 0 to 5
  has to handle it.
- A loop driving reviews must rerun CI and then call `verdict` again; Review
  Voice does not rerun anything, since that would be a second GitHub write.
- A check legitimately running for more than an hour holds the review until it
  finishes or is rerun. The threshold is fixed for now; a repository with long
  checks can list them under `ci.gate_checks`.

## Alternatives considered

**Keep infrastructure failures red.** Simple, and it never approves past them,
but it posts a COMMENT that caps an approval for reasons that have nothing to
do with the change, and a REQUEST_CHANGES review still posts on an untested
head.

**Rerun the checks automatically.** Fixes the cause, but it is a write to
GitHub beyond the one 0010 allows.

## Amendment - 2026-10-06

### Infrastructure failures that conclude `failure`

Most infrastructure failures do not conclude `timed_out` or
`startup_failure`. A lost agent, a runner that stopped answering, a throttled
cloud API and a dropped connection to a package registry all finished as
`failure`, so they were red and capped an approval for reasons that had
nothing to do with the change.

- **What counts.** A check run concluding `failure` whose output title,
  summary or text, or whose failure-level annotations, contain one of the
  rerun signatures, ignoring case, needs a rerun. Warning and notice
  annotations do not count. Any other conclusion is classified as before.
- **The signatures.** A short built-in list of whole phrases: `We stopped
  hearing from agent`, `lost communication with the server`, `The runner has
  received a shutdown signal`, `has exceeded the maximum execution time`, `No
  space left on device`, `ECONNRESET`, `other side closed`, `429 Too Many
  Requests` and `503 Service Unavailable`. Bare status codes are not on it:
  "503" also appears in "503 tests passed". `ci.rerun_signatures` adds phrases
  for a repository, and `ci.builtin_rerun_signatures: false` drops the
  built-in ones.
- **Reading the text.** The check-run list already carries the output. A
  failed run whose output matched nothing and that has annotations gets one
  more GET, `/check-runs/{id}/annotations`, for up to 50 failed runs. A read
  that fails leaves the run red. Job logs are not read. No write is added.
- **Precedence.** Unchanged: a real failure beside one is still red, and the
  reasons name the phrase, for example `CI needs a rerun: deploy (failure,
  matched "ECONNRESET")`.

A signature is evidence about the runner, not proof. A change that breaks a
service its own tests call can print `ECONNRESET` too, and a rerun will fail
the same way; whoever drives the loop should treat a second `needs-rerun` on
the same signature as red, or drop the phrase for that repository.

### The stuck threshold is configurable

A fixed 60 minutes held every review on a repository whose integration suite
routinely runs about an hour: a healthy run read as stuck, and `verdict` and
`post` exited 6. Listing such a check under `ci.gate_checks` was the only way
out, and it also hid the check's real failures.

- `ci.stuck_after_minutes` replaces the default for the repository.
- `ci.stuck_after_overrides` is a list of `{ name, minutes }`, `name` a glob
  over the check name as for gate checks. The first matching entry wins over
  the repository threshold.
- A value that is not a whole number above zero is skipped with a warning and
  the default kept. With nothing configured the threshold is 60 minutes, as
  before.

A threshold derived from the check's own recent durations was considered. It
needs the history of green runs, which is more reads per verdict, and it gives
no answer for a new check; a stated number is easier to reason about.
