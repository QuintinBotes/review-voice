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

## Amendment - 2026-11-07

`verdict.never_approve` (default `false`) adds an advisory posture: when it is
`true`, every APPROVE becomes COMMENT and approval is left to a person. The
default stays as [0010](0010-review-verdict-posting.md) decided, so nothing
changes until an owner turns it on. REQUEST_CHANGES is unchanged. The branch
sits in `decide()` after the standing-approval carry, the needs-rerun hold of
[0013](0013-ci-needs-rerun.md) and the uncovered-carry guard, and before the
complexity cap, so the carry and the needs-rerun hold still win and pending
CI never makes such a head wait. `verdict --recheck` under it refuses with
exit 2, because there is no approval to re-check. A head queued for a CI
recheck before the policy was turned on is settled by the watcher under the
new policy, not retried as a failure.

## Amendment - 2026-11-08

`verdict.scope_block` (default `false`) appends a collapsed Review scope block
and an HTML comment containing JSON to the review body. It uses the recorded
run to show the reviewed head, scope, cost mode, origin and independence,
stages, static checks, unfinished symbol searches and held-claim counts.
Missing facts read `not recorded`. ADR 0016's `unverified` and `belowGate`
lists stay local; only their counts post. The human-review note, would-have
verdict, stale request for changes and carry reasons also stay local.

`verdict.scope_block_models` (default `false`) includes model ids beside the
stages when the block is enabled. Both settings are opt-in. The block is
appended after the idempotency key is taken and before CI annotations, so
`verdict`, `post` and the watcher share the same preview, a CI annotation can
still be replaced, and toggling the block cannot make the same review a
second post. The existing review write carries it; no GitHub write is added.

## Amendment - 2026-11-08

`verdict.evidence_block` (default `false`) ends each inline comment with a
collapsed Evidence block of recorded facts. The inline comment body is then
the validated finding, any committable suggestion block
([0033](0033-committable-suggestions-are-verified-patches.md)), and, under
`evidence_block`, the block. It says that the evidence verifier established
the finding, and gives the challenger's verdict and the `path:line`
references it turned on, a static check that flagged the same line, and a
convention quote the cited document holds. Every string is flattened to inline code and capped. A
decisive reference with an absolute path or `..` is dropped, so nothing from
the reviewer's machine posts.

`verdict.evidence_block_precedents` (default `false`) adds how many of the
retrieved owner precedents favoured the finding, as a count and never an
excerpt, id or login. It has its own key because the line reveals that a
precedent store exists, which a public repository may not want to say.

The block is appended after the idempotency key is taken and after comments
already sent on the head are filtered out, and the comment signature hashes
the body with the block removed. Turning either key on or off therefore never
makes the same review, or the same comment, a second post. The block never
carries a reason any agent wrote, a confidence, a model, a held or unverified
claim, or anything the human-review note says. The existing review write
carries it; no GitHub write or read is added. No verified repair is offered
as a prompt to copy. The committable suggestion is the only repair surface.

## Amendment - 2026-11-09

`verdict.never_approve_paths` and `verdict.only_approve_paths` (both default
empty) leave approval to a person by path. An APPROVE becomes COMMENT when a
path the pull request changes matches a `never_approve_paths` glob, or when
one falls outside every `only_approve_paths` glob. The globs are the
sensitive-paths matcher's (`**`, `*`, `?`, anchored, case-sensitive). The hold
takes `never_approve`'s slot in `decide()`, after the standing-approval carry,
the needs-rerun hold of [0013](0013-ci-needs-rerun.md) and the uncovered-carry
guard, and before the complexity cap, so the carry and the needs-rerun hold
still win, pending CI never makes such a head wait, `never_approve`'s own
texts win when both apply, and `verdict --recheck` refuses with exit 2.

The paths are the pull request's, read live from GitHub's file list (renames
by both names, deleted files included) only when a list is set and the answer
could still change the event; under the defaults no request is made. The list
fails closed. 3000 entries, GitHub's own ceiling, hold approval as possibly
cut, as does an entry without a usable name (no filename, or a rename
without its previous one). GitHub lists the pull request as it stands when
each page is read, so a page holds approval too unless an entry names the
head being approved in its `contents_url` and none names another commit. A
deletion names the base, so a page of only deletions holds, and a force push
between the reads cannot lend another commit's paths to the approval. A list
that does not load (not a list of globs, or an entry that is not one) holds
every approval until it is fixed, with a warning naming the key and the
entry. The local reasons name up to
three paths; the posted summary ends with one fixed sentence naming the
setting and never a path, such as
`Approval is held because a changed file is outside only_approve_paths.`
`review.human_review.sensitive_paths` stays the setting for code that needs a
person's eyes and a thorough review; these lists are an approval rule and
cost nothing. No GitHub write is added.

`verdict.min_posted_tier` (default `nit`, which posts every tier) withholds a
verified finding below the chosen tier. It is a tier, not a count. A cap drops
a real finding to hit a number, while a tier withholds by the severity the CLI
derived, keeps the withheld findings in the recorded run, lists them in the
preview and in `belowTier`, and counts them in the scope block as
`belowTier`. The table is closed.

| severity | tier rank |
|---|---|
| `blocking` | 0 |
| `important` | 1 |
| `minor` | 2 |
| `question` | 2, as `eventFor` treats a question as a minor |
| `nit` | 3 |

A withheld finding above a nit keeps an approval at COMMENT, through the same
rule that holds an unverified one, because approving past a known defect is
worse than approving past an unchecked one; a withheld nit changes nothing.
The five categories no suppression may reach (`security`, `authorization`,
`authentication`, `data_integrity`, `trust_boundary`, [0032](0032-approved-policies-are-enforced-at-scoring.md))
post at any tier. The key is read from the base commit
([0031](0031-a-github-action-runs-one-review-per-pull-request-event.md)), so a
pull request cannot raise the tier to hide its own findings.

`verdict.reading_guide` (default `false`) puts a collapsed Reading guide
between the findings and the scope block, built from the recorded per-file
counts of the structural signals alone. It lists the changed files that carry
one, most first, with one fixed caption and no other prose. It follows the idempotency
key, so toggling it keeps the key, and the scope block's trailer stays the
last line before any CI annotation. [0016](0016-what-the-verifier-could-not-check.md)'s
lists stay local, and the reasons [0020](0020-structural-signals-may-opt-into-human-review.md)
lets a signal add to the complexity cap stay off the posted body. Both
settings ride on the existing review write; no GitHub write is added.

## Amendment - 2026-11-11

The scope block's `Not checked` line also names the changed files the review
left out. A pull request changed twelve files, ten of them under a first-party
directory named `vendor`, the diff dropped the ten as vendored and the review
read two, with nothing in the review to say so (issue 351). When the recorded
run holds a count of excluded files, the line ends with it and the count for
each reason, for example
`10 of 12 changed files left out (10 vendored dependency)`.
It is counts and the diff's own reason texts, never a path, and a recorded
reason that is not one of those texts reads `other reason`. The count is over
the files of the scope the run reviewed, so a follow-up counts the files that
changed since the earlier review, and a file that review left out and this one
would read, under the same path or a new one, sends the whole pull request to
be read rather than being called unchanged or read only as its change since.
A run that read every changed file of its scope, or one recorded
before the count was kept, adds nothing to the line. The JSON comment is unchanged, and no GitHub write is added.
