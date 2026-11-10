# 0034 - Approvals are followed to an outcome

**Status:** Accepted · **Date:** 2026-11-09
**Amends:** [0029](0029-posted-findings-are-followed-to-an-outcome.md) - the
verdict is followed as well as the findings. [0026](0026-the-queue-reads-github-search-inside-the-allowlist.md) -
the search route gains one typed source, a revert of one allowlisted pull
request. No write is added.

## Context

0029 follows every posted finding to `fixed` or `dismissed`. Nothing follows an
approval. `review_post_sent` already records `event`, `head` and `reviewId`,
and `sentRuns` already walks that audit trail, but it drops the event.
`evaluate` has no approval figure at all. So the one write that can unblock a
merge (0010) is the one write whose results are never read, and "nothing found"
is weak evidence: key-bug recall measured 0.55 on 1.22.0.

## Decision

**`outcomes` follows each APPROVE Review Voice sent to what the pull request and
the default branch later show, with 0004's strength rules, and `evaluate`
reports an approval escape rate with a confidence bound.**

- **Source.** `approvedRuns` beside `sentRuns`: runs whose `review_post_sent`
  metadata has `event: 'APPROVE'`, with the head the approval read, the review
  id and the sent time. `sentRuns` is unchanged.
- **Reads, all GET inside the allowlist.** The pull request (state, merged,
  `merged_at`, current head), its reviews, its commits when it merged at
  another head, and for each merged pull request one search through the
  0026 route, `reverts:<owner>/<repo>#<n>`, for a merged pull request of the
  same repository whose body holds `Reverts owner/repo#n`, the text GitHub's
  revert button writes. Each hit's body is read and matched before it counts;
  the search's own match is not trusted. A search GitHub reports incomplete,
  with no confirmed revert, leaves the row unchanged rather than settle a
  survival on it. A run for a repository outside the allowlist is skipped with
  no request.
- **Outcomes.**

  | Outcome | Strength | When |
  |---|---|---|
  | `reverted` | strong | a merged pull request in the same repository reverts this one inside the window |
  | `changes_requested` | strong | a person who is not a bot and not the poster requested changes on the approved head after the approval |
  | `survived` | strong | merged at the approved head, the window has passed, neither of the above |
  | `merged_other_head` | weak | merged at a head the approval did not read |
  | `pending` | weak | merged, window not over yet |
  | `closed`, `open`, `unknown` | weak | not merged, or unreadable |

  The window is `outcomes.approval_window_days`, default 14, from the merge.
  Silence before the window ends is `pending`, never `survived`. A merge whose
  head or merge time cannot be read is `unknown`, since it has no window to
  have passed. The rows are
  read top down, as the table orders them: a revert or a request for changes
  on the approved head counts whichever head merged, and only then does a merge
  at another head make the outcome `merged_other_head`. A review with no user
  (GitHub's user is null for a deleted account) cannot be shown to come from a
  person who is not a bot and not the poster, so it requests nothing.
- **Storage.** An `approval_outcomes` table, one row per run, a newer check
  replacing an older one as `finding_outcomes` does. A pull request that cannot
  be read leaves its stored row unchanged. A row is settled when no later
  check can change it: a strong outcome, or `merged_other_head` or `closed`
  once the window has passed (from the merge, or from the close, since a closed
  pull request can be reopened and merged). An approval whose row is not
  settled (none stored yet, `pending`, `open`, `unknown`, or a merge at another
  head or a close inside its window) is checked whatever its age, so a merge
  late in a pull request's life still reaches `survived`, a revert late in the
  window still counts, and an approval older than a caller's `since` is still
  followed. A settled row is checked again only while its approval is at or
  after `since`.
- **Metrics**, reported and never gated: `approvals_tracked`, and

  ```
  approval_escape_rate = (reverted + changes_requested) / (reverted + changes_requested + survived)
  ```

  with a Wilson 95% upper bound and the basis `E escaped / N settled approvals;
  P pending, W weak excluded`. `--json` adds `approval_breakdown` by provenance
  mode, complexity level, independence label and origin; a group with nothing
  settled reports null.
- **When.** `watch` follows approvals in the step that follows findings, and a
  failure there does not fail the pass. `outcomes --approvals` checks on demand.
  `status` prints one line when the upper bound is above
  `outcomes.approval_escape_warn` (default 0.05) and at least 30 approvals are
  settled. Nothing is sent anywhere.

## Consequences

- An owner sees what an approval is worth, from the pull request's own record,
  without labelling anything. No verdict changes; the figure is a reading.
- The silence rule holds for approvals too: a quiet fortnight is a survival, a
  quiet day is pending, and a pull request nobody merged says nothing.
- One more search per merged pull request in each check, however many
  approvals it has, shares the user's rate limit; like the queue's, each search
  stops at five pages. The number of searches in a check is not capped.
- The two settings form a new `outcomes` section read through `CONFIG_KEYS`,
  so a misspelt key is named like any other.

## Alternatives considered

**Count a merge as a survival at once.** Rejected. A revert lands days later;
counting the merge first would report an escape rate that only ever rises.

**Read the default branch's history for a revert commit.** Rejected. The
revert button opens a pull request whose body names the original, and that is
one search inside the allowlist; walking the branch reads far more of the
repository for a weaker match.

**Look for a revert only on a merge at the approved head.** Rejected. The
table orders `reverted` above `merged_other_head` and names no head for it, so
a pull request reverted inside the window counts as an escape whichever head
merged. The commits after the approved head are recorded on the weak row, so a
reader can still tell the two cases apart.
