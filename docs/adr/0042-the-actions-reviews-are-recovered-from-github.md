# 0042 - The Action's reviews are recovered from GitHub

**Status:** Accepted · **Date:** 2026-11-27
**Relates to:** [0029](0029-posted-findings-are-followed-to-an-outcome.md) -
posted findings are followed to an outcome; [0031](0031-a-github-action-runs-one-review-per-pull-request-event.md) -
the Action. Closes #529.

## Context

`outcomes` follows only runs in the local store. The Action keeps its store in
the runner's data directory, restored from the Actions cache, so nothing it
posts ever reached a developer's store: `outcomes` tracked 0 findings, no
precedent was learned from them (0039), `evaluate` never saw them, and a tool
reading Review Voice's decisions got nothing. Found end to end on a real pull
request where the Action posted a finding and the owner answered it.

## Decision

**`outcomes --recover` records the Action's posted reviews as runs, read from
GitHub, before the ordinary outcome check.**

- **Recognition.** A review by a login in `outcomes.recover_from` (default
  `github-actions[bot]`, who a GitHub App installation token acts as), on a
  pull request of an allowlisted repository updated inside `--since`. Its
  inline comments that read as findings as `post` renders them
  (`**severity** - text`, one of the five severities, a path and a line, the
  evidence and suggestion blocks left off) are its findings. A review with none
  is left alone. A pull request is read at most 100 deep, newest update first.
- **What is written.** One run per review with those findings, and the
  `review_post_attempted` and `review_post_sent` rows that name the review,
  marked `recovered: true`, which is all `outcomes` follows. A review already
  named by any sent row, posted from here or recovered, is skipped, so a second
  run records nothing twice. The run has no provenance, candidates, scores or
  category: the posted text does not carry them, and nothing is guessed.
- **Opt in.** The flag, not the config, turns it on: it reads GitHub for
  reviews nobody here wrote, and writes rows a later command reads as outcomes.
  Reads only GitHub; writes only the local store.
- **No reply under a recovered thread.** The tool's one reply per thread (0035)
  is for comments it posted from here. A recovered thread is a bot's, so
  `outcomes` and `reply` offer no question on it.

## Rejected

- **The Action uploads its run.** Exact data, but it needs `actions: read` and
  an import command, and covers only reviews posted after the change.
- **A marker in the posted comment.** It would be exact, but it changes every
  posted body and every reader that compares or hashes one (0028).

## Consequences

- A login that posts reviews in this exact shape that this tool did not write
  would be recorded. The login list is the control; the default is the one
  login the Action posts as.
- Recovered runs teach retrieval through their outcomes (0039) but carry no
  category, so a precedent derived from one matches on path and text only.
