# 0031 - A GitHub Action runs one review per pull request event

**Status:** Accepted · **Date:** 2026-10-25
**Relates to:** [0002](0002-github-auth-model.md) - still no hosted service.
The Action runs in the user's CI with the user's keys.

## Context

Review Voice ships only as a Claude Code plugin. A team that wants every pull
request reviewed has to keep someone's machine running a watcher. CI already
runs on every pull request and can hold the two secrets a review needs.

## Decision

**A composite action at the repository root runs `review-voice review` for the
pull request that triggered it, and posts only when the workflow allows it.**

- **Inputs.** `mode` (default `auto`), `post` (default `false`),
  `anthropic-api-key`, `github-token` (default the workflow token),
  `claude-code-version` (pinned default) and `config` (default
  `.review-voice/config.yaml`).
- **Steps.**
  1. Set up Node 22.
  2. Install the pinned Claude Code.
  3. Check out the pull request with full history.
  4. Restore the store from the actions cache, keyed by repository.
  5. Run `review --pr <n> --repository <repo> --mode <mode>`, with `--post`
     when `post` is true.
  6. Save the store.
  7. Write the report to the job summary.
- **Trigger.** Document `pull_request` (opened, synchronize, reopened,
  ready_for_review). The action refuses to run under `pull_request_target`
  when the head is checked out, because that runs untrusted code with secrets.
- **Forks.** Fork pull requests get no secrets. The action exits 0 with a
  summary line saying it skipped, rather than failing the check.
- **Posting.** `post: true` still needs `writes.github_posting_enabled: true` in
  the repository configuration, and the workflow needs `pull-requests: write`.
  The review is authored by the token's identity.
- **Pins.** Third-party actions inside it are pinned by SHA and checked by
  `check-action-pins`.

## Consequences

- A team gets a reviewer on every pull request with one workflow file and one
  secret.
- Each run is one review. The queue and watcher are for individuals. CI already
  is the queue.
- Cost lands on the team's API key, and `mode: auto` keeps routine changes
  cheap.

## Alternatives considered

**A GitHub App.** Rejected for the reasons in 0002.

**A Docker action.** Rejected. A composite action reuses the committed bundle
and starts faster.
