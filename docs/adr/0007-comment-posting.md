# 0007 - GitHub comment posting

**Status:** Accepted · **Date:** 2026-09-16
**Implementation note added:** 2026-09-16 - the gate is now enforced in code;
see `plugins/review-voice/src/publish/gate.ts`.

## Context

The natural next step after a review is posting it to the pull request. It is
also the step where a false positive stops being a private annoyance and becomes
a public comment on a colleague's work, and where a prompt injection stops being
contained.

## Decision

**No GitHub writes through v1.** Enforced in code: the GitHub client rejects any
non-`GET` request, covered by test. Not a documentation promise.

If posting ships in Phase 4, it ships with all of the following:

1. **Exact preview.** The user sees the precise text, target repository, pull
   request and line anchors before anything is sent.
2. **Explicit confirmation**, per post. No "always allow", no session-wide
   approval.
3. **Exactly-once semantics.** An idempotency key derived from the diff hash and
   finding id is recorded in the audit log before the request, so a retry after
   a timeout cannot double-post.
4. **Comments only.** Never approve, never request changes, never merge, never
   set a status. An automated approval is a different product with a different
   risk profile.
5. **Audit entry** for every attempt, including failures and refusals.

Quality gates first: posting does not ship until the precision targets in
[EVALUATION.md](../EVALUATION.md) hold in practice. A reviewer that is not yet
right should not be publishing.

**How this is enforced.** `evaluatePostingGate` reads what has actually been
measured - owner-accepted precision at 0.80 or better over at least 20 labelled
findings, with full contract compliance - rather than a setting. A boolean in a
config file is a promise the user makes to themselves; the point of this gate is
that it holds when they would rather it did not.

The minimum sample matters as much as the threshold. Five keeps and no
dismissals is 100% precision and tells you nothing.

The function takes the config flag and the database, and nothing else. There is
no override parameter, because a gate with a bypass is a suggestion.

## Consequences

- v1 users copy findings manually. This is a real friction cost, accepted, and
  it keeps a false positive private while the calibration loop is still young.
- The read-only guarantee is simple to state and simple to verify, which makes
  the security posture easy to trust.
- The exactly-once design has to exist before the first post, not after the first
  duplicate.

## Alternatives considered

**Post as a draft review the user submits manually.** Genuinely attractive, and
still a write. Reconsider in Phase 4 - it may be the right first write.

**Post automatically above a confidence threshold.** Rejected. A threshold is a
number; a comment on someone's pull request is a social act.
