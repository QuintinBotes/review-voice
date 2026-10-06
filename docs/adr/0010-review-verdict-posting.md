# 0010 - Posting a review with its verdict

**Status:** Accepted · **Date:** 2026-10-01
**Supersedes:** [0007](0007-comment-posting.md) decision 4 ("Comments only"),
and makes its measured-precision gate advisory for verified findings.
Decisions 1, 2, 3 and 5 of 0007 stand.
**Amends:** [0002](0002-github-auth-model.md) - one write, through a separate
client. The read-only client and its test are untouched.
**Amended:** 2026-10-06 by [0018](0018-read-only-graphql-thread-state.md) - the
read-only client also sends GraphQL queries; see the end.

## Context

0007 allowed posting, when it ships, only as comments: "Never approve, never
request changes." That kept the first write small, and it assumed the verdict
was a separate human act.

In practice the verdict is not separate. A day of use across roughly thirty
real reviews ran every one through a hand-written wrapper that did the same
five things after the review validated:

1. refuse if the pull request's head had moved since the review read it;
2. map the review to a verdict - clean or nits to APPROVE, minor or a question
   to COMMENT, important or blocking to REQUEST_CHANGES;
3. refuse to approve while CI was red or still running;
4. attach the inline anchors to the payload;
5. post it, and approve later once CI went green.

Each step is mechanical, and the wrapper got several of them wrong at first in
ways only a fresh reader would repeat:

- Check runs read with `filter=all` never settle, because a CI provider can
  leave orphaned queued or in-progress runs beside a newer completed run of the
  same name. `filter=latest` is the reading that means "current".
- Check runs must be paginated. A monorepo pull request carried more than 100.
- A cancelled run superseded by a newer one is not a failure.
- Some failing checks are gates, not failures: a "ready to merge" marker, an
  approval requirement, a contract check that "has not yet run".

A comments-only rule does not remove this work from the user. It moves the
work into a script with no tests, no audit and no idempotency, which is the
outcome 0007 existed to prevent.

## Decision

**Review Voice may submit a pull request review whose event is APPROVE,
COMMENT or REQUEST_CHANGES, one explicit confirmation per post, through a
single narrow write path.**

### What is computed, read-only (`RV verdict`)

- **Head guard.** The payload carries `commit_id` equal to the head the review
  read. If the pull request's head is different, it refuses.
- **Verdict mapping**, from the severities in the validated review text, never
  from candidate records:

  | Highest severity present | Event |
  |---|---|
  | none, or only `nit` | APPROVE |
  | `minor` or `question` | COMMENT |
  | `important` or `blocking` | REQUEST_CHANGES |

  Fixed in code. A question-framed claim is capped at `minor` before this
  point, so an unanswered question can never block a merge.
- **CI guard.** Check runs read with `filter=latest` and paginated; combined
  commit statuses read as well; the newest run per name kept as a second
  defence. `cancelled`, `stale`, `skipped` and `neutral` do not count against
  the head. Gate checks come from configuration (`ci.gate_checks`) and none are
  built in. Red CI caps the event at COMMENT; pending CI turns APPROVE into
  "wait".
- **Payload** in the shape of the create-review API: `commit_id`, `event`,
  `comments` and `body`. **Every anchored finding is an inline comment** on its
  line, from the validated text; the body is a one-line summary of the verdict,
  plus only the findings that carry no line. Findings are never posted as one
  global block.
- **Only verified findings post.** A finding posts when the recorded run's
  score for it shows the verifier established it (`confidenceSource:
  verifier`, eligible). An unverified one is held back and named.

### What is sent (`RV post`)

- **Exact preview.** The preview is generated from the payload that will be
  sent. Its first line is the event, then the repository, pull request, head
  and every anchored comment.
- **One confirmation per post.** `--confirm` is required per invocation. No
  "always allow", no session-wide approval, no configuration that implies one.
- **Submitted, not left as a draft.** The review is created with its event in
  one request, never as a pending review the user must find and submit.
- **Verification is the gate for findings.** A verified finding posts without
  waiting for the measured-precision gate; `post-check` is still reported with
  every post so the measurement stays visible, but it does not hold a verified
  finding back. `writes.github_posting_enabled` must still be true.
- **APPROVE needs more than verification.** It is refused unless, at the moment of
  sending, the head equals `commit_id` and the CI guard is green. Both are
  re-read immediately before the request, not taken from the preview.
- **Exactly once.** The idempotency key is derived from repository, pull
  request, head and a hash of the payload. It is written to the audit log
  before the request; a key already recorded as sent is refused.
- **Audit** for every attempt: sent, refused (with the reason) and failed
  (with GitHub's status).
- **One write path.** A separate writer permits exactly one request: `POST
  /repos/{owner}/{repo}/pulls/{number}/reviews`. The existing `GitHubClient`
  keeps rejecting every non-GET request, and its test keeps passing.
- **Re-check.** `RV verdict --recheck` re-reads head and CI once and emits an
  APPROVE payload only when both hold. It never posts; sending it is another
  `RV post --confirm`.

### What is still never done

Merge, dismiss another review, resolve threads, set a commit status, re-run
CI, or post under any identity other than the user's own `gh` credential.

## Consequences

- **An approval is a new kind of harm.** A false APPROVE can unblock a merge; a
  false comment only wastes a reader's time. The mitigations are the ones
  above, and the ordering matters: the precision gate says the reviewer has
  earned trust, the CI and head guards say this head is the one that was read,
  and the confirmation says a person saw the event.
- **Prompt injection reaches further** (threat 1 in `THREAT-MODEL.md`). Text in
  a diff that steers the analyst toward silence could now yield APPROVE rather
  than an empty comment. The verdict is computed from validated severities,
  never from model prose, and a human confirms each post; the threat model
  gains this as an explicit consequence.
- **Scopes.** Posting needs pull-request write access, which the user's `gh`
  credential normally already has. Reading still needs only read access, and a
  user who never posts never exercises the write.
- **GitHub rejects approving your own pull request.** The writer reports that
  response plainly rather than retrying or downgrading the event.
- **REQUEST_CHANGES blocks until dismissed or superseded.** A later clean
  review of a new head posts APPROVE, which supersedes it; the tool does not
  dismiss reviews.

## Alternatives considered

**Keep comments only, and print the verdict for the user to submit.** The
state before this record. It leaves the CI and head guards to the user's own
script, which is where the pitfalls above were found.

**Post as a pending (draft) review the user submits.** Still a write, and it
moves the verdict back into the GitHub UI, where neither guard is re-checked
at submission time.

**Keep the measured-precision gate binding.** The owner's decision on
2026-10-01: a finding the verifier traced against real inputs is the trust
signal that matters per post, and holding verified findings back until twenty
were labelled left real defects unposted. The gate's measurement is still
printed with every post.

**Approve automatically once CI goes green.** Rejected. 0007's objection still
holds: a threshold is a number, and a review on someone's pull request is a
social act. `--recheck` prepares the approval and a person sends it.

## Amendment - 2026-10-06

"The existing `GitHubClient` keeps rejecting every non-GET request" now reads:
it keeps rejecting every non-GET REST request, and sends one kind of POST, a
GraphQL `query`, checked in code to be nothing else
([ADR 0018](0018-read-only-graphql-thread-state.md)). It reads whether review
threads are resolved. The writer above is still the only write, and resolving
a thread is still never done.
