# 0017 - Moving a verified candidate's anchor

**Status:** Accepted · **Date:** 2026-10-06
**Amends:** [0010](0010-review-verdict-posting.md) - the verdict mapping gains
one cap, on a run carried without a review of the commits in between. The head
guard is unchanged: a run still posts only at the head it was recorded for. No
GitHub write is added or changed.

## Context

A verified candidate is a claim plus a location. Two things moved the location
without changing the claim, and each forced the whole claim back through the
analyst, the anchor check, verification and scoring.

- A cross-check found a finding anchored one line off, on a declaration rather
  than the comment above it. The editor could not render the corrected line:
  `validate-output --scores` found no scored candidate there.
- The author pushed while findings were in verification. Posting refuses a
  moved head, so the candidates and verifications were copied to the new head
  by hand, a step no stage checked.

## Decision

**A verified candidate's location may move without re-verification only when
the code it is anchored on is provably the same code, and the new location
passes the same anchor check the original did.**

- **`RV reanchor`** moves one candidate the score made eligible to a line that
  is an added line or deletion site of the reviewed diff, optionally in another
  file of that diff. The score output and candidates file are rewritten in
  place, keeping the verification and score, and the old location is kept as
  `reanchoredFrom`. A rejected candidate is refused, because re-anchoring keeps
  a score and does not make one; so is a stale consumer, whose own line is on
  unchanged code nothing can check, and a location another finding holds.
- **`RV carry-candidates`** carries verified candidates from the head they were
  verified at to a later head. A candidate carries only when nothing its
  verification read changed between the two heads: its own file, a stale
  consumer's cause, and every file its claim, evidence or verifier entry names.
  Unchanged lines around the anchor are not enough: a guard added a few lines
  above a null dereference makes the claim false without touching its line.
  Its line must also pass the anchor check against the new head's diff.
  Everything else is refused by name, as is a candidate with no verification.
  Held findings passed with `--held` are moved to the new head, and dropped
  when their line or its neighbours changed. The carry is written to
  `carry.json` and the audit log.
- **The commits in between are reviewed.** A carry says nothing about the code
  pushed since the old head. The review command runs the normal analyst and
  verifier steps on the interdiff from the old head to the new one and passes
  the result with `--interdiff`, which is merged in; its manifest must read the
  new head and cover everything since the old one, and its candidates must sit
  on its patch. `record --carry` stores whether that happened. A run whose
  carry lacked the interdiff review, or refused a candidate, is never approved:
  `verdict` and `post` cap it at COMMENT with the reason in their local output
  only, the posted body saying no more than "Not approving yet". A run carried
  from it with `record --carried-from` inherits the cap, and the next review of
  the pull request does not use it as its boundary, so it reads the whole pull
  request.
- **Serious findings are not dropped by `carry`.** When a blocking or important
  finding of the earlier run does not carry, `carry --text` prints nothing and
  exits 1, and `record --carried-from` refuses, so the rest cannot be recorded
  and approved without it.
- **No partial post.** When any candidate is refused, the review command
  re-reviews the new head rather than scoring only what carried. A refused
  candidate's code changed: it may have been fixed, or made worse, and a review
  missing it could approve.

## Consequences

- A one-line anchor correction no longer costs an analyst, verifier and scoring
  pass, and a push that does not touch anchored code no longer costs a manual
  copy.
- The comparison is between the two heads and by whole file, so a base merge
  in between, or an unrelated edit in the same file, refuses more than strictly
  needed. That errs towards re-verifying.
- Posting a carried review costs an analyst and verifier pass over the
  interdiff, which is the code nobody had read.
- Text inside a claim or its evidence that cites a line number is not
  rewritten when the anchor moves; only the anchor is.

## Alternatives considered

**A line tolerance in `validate-output --scores`.** Matches a finding to a
score near it when the wording matches, but then the posted anchor is one no
stage checked against the diff.

**Carry every candidate whose file still exists.** The verification was of
specific code; a change on or next to the anchored line can invalidate it.

**Carry by the lines around the anchor.** What `carry` does for recorded
findings. It misses a change elsewhere in the file, or in a file the evidence
read, that makes the claim false.
