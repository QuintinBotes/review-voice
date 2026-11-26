# 0038 - The queue reviews what concerns the team

**Status:** Accepted · **Date:** 2026-11-26
**Amends:** [0026](0026-the-queue-reads-github-search-inside-the-allowlist.md) -
the queue gains a relevance skip rule and one search source. No write is added.

## Context

A team review request (0026) says nothing about whether the change touches what
the team owns, so a team-only request in a large repository is often noise
(#483). Asking an agent is the expensive way to find out.

## Decision

**With `queue.relevance` configured, a team-only candidate that matches no
signal is skipped as `relevance`, decided from GitHub reads alone.**

- **Reads, inside the allowlist.** The pull request's files with patches
  (capped; `truncated` is reported) and CODEOWNERS at the base sha, from
  `.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS`, first found. A
  missing or unreadable file gives an owned share of null, never an error.
- **Signals.** `owned` (share of changed lines in files a configured team owns,
  at least `min_owned_share`), `path`, `added_line`, `author`, `keyword`. Any
  one makes the pull request relevant; the reasons list them.
- **Scope.** Run after the cheaper skip rules, so a draft or bot is skipped
  with no files read. A request for the owner personally, an assignment, a
  follow-up or a dismissed review is never filtered.
- **Discovery.** With `discover`, recently updated open pull requests in each
  allowlisted repository are checked and the relevant ones listed as `surface`
  with source `discovered`. A surface entry is report-only: never reviewed,
  posted or recorded as handled, and not counted toward `max_per_pass`.
- **Command.** `relevance --pr <n>` prints the result; exit 0 either way.

## Consequences

- Without the block nothing changes.
- Share and signals are heuristics: a filtered pull request is listed as a skip
  with reasons, so a wrong skip is visible.
- Discovery costs one search per allowlist entry and up to `max_pulls` reads.

## Alternatives considered

**Ask an agent whether a pull request is relevant.** Rejected. Cost and
non-determinism for a question GitHub's own data mostly answers.

**Fetch team membership for the author signal.** Rejected. A configured
`authors` list needs no extra permission.
