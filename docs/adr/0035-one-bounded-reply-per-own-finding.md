# 0035 - One bounded reply per own finding

**Status:** Accepted · **Date:** 2026-11-09
**Amends:** [0010](0010-review-verdict-posting.md) - the writer gains a second
checked path, a reply under one of this tool's own inline comments; the review
write is unchanged. [0029](0029-posted-findings-are-followed-to-an-outcome.md) -
the outcomes reader also reports the threads awaiting a reply, from the reads it
already makes.
**Relates to:** [0007](0007-comment-posting.md) - decisions 1, 2, 3 and 5
apply to each reply as they apply to a review. [0018](0018-read-only-graphql-thread-state.md) -
the GraphQL query set is unchanged, so resolving a thread stays impossible.

## Context

An author who replies to a Review Voice inline comment with "why?" or "this is
intentional, isn't it?" got silence. An unanswered question is the cheapest way
for a real finding to be dismissed. The same market survey that found every
other reviewer answers questions also set the bound: no chat agent acting on
mentions from any contributor, and no resolving of threads on the tool's own
judgement.

The evidence a reply could quote was already recorded and shown nowhere but
`explain`: the analyst's `evidence` lines on each stored candidate, and the
challenger's `decisive_evidence`, the `path:line` references an independent
challenge confirmed (0024). The thread reader already read every reply under
every comment this tool posted.

## Decision

**When a reply under one of this tool's own inline comments asks a question,
`outcomes` reports the thread and a person may post one reply under that
comment with `reply --pr N --confirm`, rendered by code from the recorded run
alone, behind every guard a review has. At most one reply is ever posted per
thread.**

### The trigger

`replyWanted` in `store/outcomes.ts`, from the root comment, the pull request's
inline comments and the thread state the outcomes check already holds. It is
asked only when the root is in a review whose id this tool recorded when it
posted, and holds exactly the finding's text as `post` rendered it. A review
found by commit and author alone may hold a person's comment at the same line,
and two findings may share a line, so such a thread gets no reply, although
its outcome is still followed. Each rule returns nothing when it fails:

1. The thread state is known and the thread is not resolved. An unreadable
   state is not an open thread, and neither is one on a pull request whose
   inline comments reached the read limit, since a newer answer may be past it.
2. No reply under the root is by the poster. One reply per thread, whoever
   wrote it, so a person answering from the posting account counts too.
3. The newest reply whose author is not a bot, not the poster and not the
   configured owner decides. The owner can run `explain`; a bot asked nothing.
4. The reply asks something: a line that is not a blockquote contains `?`. A
   disagreement that asks a question gets the reply, as a question does; a
   disagreement that asks nothing is recorded as an outcome and gets no reply.
   An acknowledgement never does. Silence and agreement are not questions (0004).

### The text

`renderReply` in `publish/reply.ts` is pure. It reads the score that backed the
posted finding, as the evidence block does (same severity, the verifier's,
eligible, followed through a carry), and the candidate that score is for, never
another one at the same line. The references are the challenger's
`decisive_evidence` when its verdict is `confirmed`, else the `path:line`
citations in the candidate's evidence, in recorded order, duplicates dropped,
at most four. A reference whose path holds whitespace, a control character, a
backtick or a dot segment, or is absolute, is dropped, because it goes into a comment body as
inline code and an absolute one names the reviewer's machine. A reference that
alone breaks one of the properties below is dropped too. With no reference
left, nothing is posted: a reply that cannot quote a recorded line would be a
new claim. The body is one fixed template:

```
Review Voice checked this at a1b2c3d. The claim rests on `src/cart.ts:12` and `src/cart.ts:40`. An independent challenge confirmed it at those lines. This reply is built from the recorded review and is not repeated.
```

The head is the first seven characters of the run's head, or "the head it
reviewed". The third sentence appears only on a confirmed challenge. Three
properties hold for every body, and a test pins each. It is at most 600
characters, it holds none of the validator's forbidden phrases, and
`classifyReply` reads it as `other`, so the outcomes reader and calibration can
never read this tool's own reply as a dismissal or an acknowledgement. The body
is redacted before the three are checked, so the preview is the text sent.

### The guards, as 0007 and 0010 apply to a review

- **Preview** (0007 decision 1): without `--confirm` the rendered body is
  shown and nothing is sent.
- **Confirmation** (decision 2): `--confirm` per invocation, and
  `writes.github_posting_enabled` must be true. Nothing replies by default.
  The GitHub Action and the watcher never reply. The watcher has no reply
  setting and no code path to the reply write, so nothing replies unattended.
- **Exactly once** (decision 3): the key is `reply:<repository>#<pr>:<root
  comment id>`, the thread and not the text, so a reworded reply to the same
  thread is the same reply. It is claimed as a `review_reply_attempted` row in
  one transaction before the request; a key already sent, or attempted with no
  definite answer, is refused. A 4xx does not block a retry; anything else does.
- **Audit** (decision 5): `review_reply_attempted`, `review_reply_sent`,
  `review_reply_refused` and `review_reply_failed`, under the pull request as
  subject, kept by retention like the review rows.
- **One writer, two paths checked in code.** `ReviewWriter.replyToComment`
  sends exactly `{ body }` to `POST /repos/{r}/pulls/{n}/comments/{id}/replies`.
  `request` admits that path and the review path and refuses every other
  method and path before the network; the body is refused empty, over 600
  characters or with any other field. The writer's allowlist is the recorded
  run's repository, as for a review.

### What is never done

No reply to a reply, and no second reply on a thread, even after a new head,
since a new head gets a new review. No reply without a recorded reference. No reply to
a bot or to the owner. No model anywhere in the path, and no prose beyond the
template; the finding's text and the verifiers' reasons are never repeated. No
resolving, editing, deleting or reacting to any comment. No reply under a
review body, a conversation comment or an unanchored finding.

## Consequences

- An author's question gets the recorded evidence, not silence, and still not
  a conversation. The bound is one message, built from what the run recorded.
- The reply is posted under the owner's credential, and `decide()` reads the
  owner's replies before the poster filter, so the `other` property above is
  the lock that keeps the tool's own reply out of the outcome signals.
- An injected comment can at most provoke one templated reply quoting
  recorded references on a thread this tool started (THREAT-MODEL.md, 3).
- The reply row keyed to run and finding is the signal; the author's next
  reply is read by `decide()` as today.

## Alternatives considered

**Answer with the finding's reasoning, or let a model write the reply.**
Rejected. A model in the reply path is a chat agent acting on text any
contributor can write, the anti-feature the bound exists to rule out, and a
reason nobody verified is a new claim.

**Resolve the thread once the question is answered.** Rejected, as in 0018:
whether a point is closed is the author's call.

**Reply on the next review instead.** Rejected. A new head gets a new review
already; a question on the old one deserves its own answer, once.
