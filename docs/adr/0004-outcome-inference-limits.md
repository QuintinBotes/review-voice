# 0004 — Outcome inference limits

**Status:** Accepted · **Date:** 2026-09-16

## Context

Labelling a historical comment as accepted or dismissed requires knowing what
happened after it. The strongest evidence is a follow-up commit that fixes the
flagged code — which means fetching and diffing commits, potentially many per
comment, across a 250-event corpus. That is expensive in API calls, rate limit
budget, and time, and it reads more repository content than the user may expect.

## Decision

**Infer outcomes from data already fetched during ingestion. Deep history walks
are opt-in and bounded.**

Default inference uses, at no additional cost:

- Thread resolution metadata
- Replies in the thread — acknowledgement, rejection, clarification
- Commits already attached to the pull request, matched by file and line range
- Explicit plugin feedback, which is always the strongest signal available

Opt-in deep inference (`bootstrap.deep_outcome_inference: true`) fetches
follow-up commit diffs, bounded to commits within the same pull request, within
30 days of the comment, and at most 10 per comment.

Strength is assigned honestly. A merge with no visible fix, a thread resolved
without explanation, and no reply at all are **weak** signals, and a weak signal
can never create or suppress a policy rule on its own.

## Consequences

- Bootstrap stays within a reasonable API budget and finishes in reasonable time.
- Many events are labelled `unknown`. That is correct — an unknown outcome
  carries a 0.45 weight for owner comments, not zero and not one.
- **Silence is never a negative label.** A comment nobody answered tells us
  nothing.
- Explicit feedback matters more early, when the corpus is thin. `init` says so.

## Alternatives considered

**Always walk follow-up commits.** Rejected: cost and rate limits, for a signal
that is often ambiguous — a later commit touching the same lines may be
unrelated.

**Treat merge-without-change as dismissal.** Rejected explicitly by the
specification, and correctly: pull requests merge for deadline reasons that have
nothing to do with whether a comment was right.
