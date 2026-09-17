# Current task - none open

**Milestone:** M5, the 1.0.0 interface freeze
**Risk:** low. No implementation work is outstanding.
**Baseline:** `main`

## State

All four build milestones shipped. Seven releases of real-world testing against
live pull requests followed, and the findings from those went back in as fixes
rather than into a backlog. What remains before 1.0.0 is not a feature.

## What 1.0.0 means here

A stable interface, not a new capability. Testing moved the scoring threshold
three times, changed how severity is assigned twice, and rewrote convention
selection three times. Each move was justified by measurement, and each one
changed what a review says about the same diff. 1.0.0 is the claim that they
have settled.

*Done when:* a retest reports no change to the scoring or severity contract, the
README carries real evaluation numbers rather than targets, and the pre-release
notice comes off.

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
