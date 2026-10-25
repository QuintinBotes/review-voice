# 0027 - One watcher remembers every head

**Status:** Accepted · **Date:** 2026-10-25
**Relates to:** [0010](0010-review-verdict-posting.md) - posting keeps its
idempotency key. The watcher adds a per-head record above it.

## Context

The store records runs, and `post` refuses to send the same payload twice. It
does not know which pull request heads a watcher has already handled, skipped,
or is waiting on. Operators kept that in their own JSON files and kept a second
file for the verdict per head. They wrote a fresh head before or after the
review, depending on the script. Two loops on one machine would also race on
the same pull request.

## Decision

**`watch` records one `WatchHead` row per repository, pull request and head,
and only one watcher runs per data directory.**

- **Table.** `watch_heads` (repository, pull_number, head_sha primary key;
  run_id, event, review_url, status, detail, attempts, updated_at), added by a
  store migration.
- **Idempotent passes.** An entry whose head already has `posted`, `carried`,
  `skipped` or `held` is not reviewed again. `waiting-ci` is re-checked.
  `failed` is retried until `watch.max_attempts_per_head`, then left for a
  person, with the detail kept.
- **Write order.** The row is written after `post` returns, or after the run
  is recorded when not posting. A crash before that leaves no row, so the next
  pass redoes the head. `post`'s idempotency key stops a double send.
- **Lock.** `watch` holds `<dataDir>/watch.lock`, an exclusive file with the
  process id. A second watcher exits with code 2 and names the holder. A stale
  lock (dead process) is taken over.
- **Clones.** The watcher keeps one clone per repository under
  `watch.workspace` and fetches before each review. It never touches the
  user's working trees.
- **Report.** One line per pull request per pass, then totals. `--json` prints
  the rows.

## Consequences

- Restarting the watcher, or running `--once` from a scheduler, never posts a
  second review on a head.
- The operator's state files are replaced by a table that `status` can show.
- The workspace uses disk. Clones are partial (`--filter=blob:none`).

## Alternatives considered

**Derive watcher state from runs and GitHub reviews alone.** Rejected. Skips,
waiting-on-CI states and failures leave no run or review, so they would be
redone every pass.

**A daemon with a socket.** Rejected. A lock file and `--once` cover
schedulers, and an interval loop covers a terminal.
