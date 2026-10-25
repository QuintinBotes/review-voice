# 0029 - Posted findings are followed to an outcome

**Status:** Accepted · **Date:** 2026-10-25
**Amends:** [0004](0004-outcome-inference-limits.md) - the same inference rules
now also apply to findings Review Voice posted. No write is added.

## Context

`evaluate` reports `owner_accepted_precision` from explicit feedback only. In
practice almost nobody records feedback, so the metric is empty, and the
posting gate it feeds is reported but never met. Meanwhile GitHub already holds
the answer for every posted comment. The thread was resolved or not, the author
replied, or the anchored lines changed in a later commit. 0004 decided how to
read those signals honestly for historical comments. Nothing applies them to
Review Voice's own.

## Decision

**`outcomes` follows each posted inline comment to an outcome, with 0004's
strength rules, and `evaluate` reports precision from strong outcomes.**

- **Signals.** The review thread state (the ADR 0018 GraphQL query), replies in
  the thread, and the pull request's later commits matched to the anchored file
  and line range. These are all reads already allowed.
- **Outcomes.**
  - `fixed` (strong): the anchored lines changed after the comment, and the
    thread was resolved or the author agreed.
  - `dismissed` (strong): a reply disagreed, or the owner recorded `dismiss`.
  - `resolved` (weak): resolved with no change.
  - `outdated` (weak): lines changed, thread open.
  - `open` or `unknown`: nothing decides it.
- **Storage.** A `finding_outcomes` table keyed by run and finding id. A newer
  check replaces an older one. Explicit feedback always wins.
- **Metrics.** `evaluate` adds `posted_findings_tracked`, `posted_fixed_rate`
  and `posted_dismissed_rate`, over strong outcomes only. They are broken down
  by lane and severity with `--json`.
- **When.** `watch` checks the pull requests it touched each pass. `outcomes`
  checks on demand.

## Consequences

- An owner sees how often posted findings were acted on, without labelling
  anything.
- The silence rule holds. An unanswered comment is `open`, never `dismissed`.
- Reading threads costs one GraphQL query per pull request with posted
  comments, bounded by the same rate-limit handling as sync.

## Alternatives considered

**Count a merge without a change as dismissal.** Rejected, as in 0004.

**Ask the author to react with an emoji.** Rejected. It adds work for the
author and depends on a convention nobody follows.
