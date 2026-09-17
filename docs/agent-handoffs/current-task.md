# Current task - none open

**Milestone:** M5 shipped. 1.0.0 is released.
**Risk:** low. No implementation work is outstanding.
**Baseline:** `main`

## State

All five milestones shipped. Eleven releases of real-world testing against live
pull requests preceded 1.0.0, and the findings from those went back in as fixes
rather than into a backlog.

1.0.0 is a claim about the interface. The scoring and severity contracts held
four consecutive releases, each comparison over identical batches, at a maximum
difference of 1.7e-10, which is the retrieval's floating-point noise rather than
anything moving.

It is not a claim about measured precision. See below.

## The next piece of work, and it is not a fix

`owner_accepted_precision` has no data. Nothing has ever been labelled through
`/review-voice:feedback`, so the gate the whole tool rests on reports nothing,
and `candidate_set_agreement` has a single pair.

Everything published in `docs/EVALUATION.md` was established by hand, one pull
request at a time, by a reader who read the code. That does not scale, and a
release that cannot tell you whether the next one reviews better or worse is a
real exposure. `status` now counts unlabelled findings so the gap is visible
rather than silent.

**Label findings in normal use.** That is the instrument.

## Still open, and deliberately

- **Category drift.** Severity is stable given the category, and the category is
  a judgement that can still move. The analyst prompt now settles the confusable
  pairs; whether that holds needs measuring. The next lever, unbuilt, is having
  the verifier return a category that supersedes the analyst's, the way its
  confidence already does.
- **Self-authored precedent at ingestion.** `--exclude-pull` removes the harm
  where it does damage. A review rewritten into prose before posting still
  enters the corpus. The detector that would catch it correlates ingested events
  against recorded emissions, and a wrongly dropped owner comment is invisible
  and permanent, so if it is ever built it should mark rather than drop.

## How to pick work up from here

There is no handoff to execute. Work arrives as a retest report against a real
repository. Read the report, verify the material findings against the code
before acting on them, and treat a number in it as evidence rather than as an
instruction: two of the most useful changes in this project came from disputing
a report's diagnosis while accepting its measurement.
