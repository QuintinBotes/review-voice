# 0028 - Verdict policies for CI and complexity are configurable

**Status:** Accepted · **Date:** 2026-10-25
**Amends:** [0010](0010-review-verdict-posting.md),
[0012](0012-complex-changes-need-human-approval.md) and
[0013](0013-ci-needs-rerun.md) - each fixed rule becomes the default of a
setting. No write is added.

## Context

`verdict` holds an approval while CI is pending. It caps an approval at COMMENT
when CI is red or the change is complex. It posts nothing when CI needs a
rerun. Each rule is safe, and each was right for some owners. Owners who ran
Review Voice every day asked for a different trade on every one:

- Approve without waiting on CI, because CI gates the merge anyway.
- Post the code verdict on red CI with a note naming the failing checks, rather
  than downgrade it.
- Approve a clean complex change and flag it to the owner locally.
- Not post again when a merge-only push left the owner's approval standing.

Operators met these wishes by bypassing `verdict` with their own posting
scripts, which also bypassed the guards that are not negotiable.

## Decision

**Five verdict behaviours become settings. The defaults are today's rules, and
the head, writer and idempotency guards stay fixed.**

| Setting | Default | Alternative |
|---|---|---|
| `verdict.ci_pending` | `wait` | `proceed`: approve now |
| `verdict.ci_red` | `cap` | `annotate`: keep the event, add `Heads up: <checks> failing on this head.` |
| `verdict.ci_needs_rerun` | `hold` | `annotate`: post the code verdict, add `Heads up: <checks> need a rerun.` |
| `review.human_review.cap_approval` | `true` | `false`: approve; the local note and flag stay |
| `verdict.carry_approval_on_unchanged` | `false` | `true`: an unchanged scope whose owner approval stands records `carried` and posts nothing |

- **Named checks.** An annotation lists at most five failing checks by name,
  newest run per name.
- **Thread re-check.** `verdict.recheck_thread_before_post` (default `true`
  under `watch`, `false` otherwise) re-reads the thread before `post` and holds
  any finding someone else raised during the run. It uses `check-candidates`'
  repeat rule.
- **Fixed guards.** A moved head is still exit 3. The writer still has one
  endpoint. The idempotency key and the approval's immediate CI re-read still
  apply. `annotate` changes the body, never the guard order.

## Consequences

- Operators drop their posting scripts and keep every fixed guard.
- An owner who chooses `annotate` or `proceed` accepts that an approval can
  land on a head CI has not cleared. The setting's name says so.
- Tests cover each setting against each CI state as a table.

## Alternatives considered

**Leave the rules fixed.** Rejected. Owners route around them, and the routing
loses guards the rules never meant to give up.

**One "strict / relaxed" switch.** Rejected. Owners chose different
combinations, and each setting is independent.
