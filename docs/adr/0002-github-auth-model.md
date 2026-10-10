# 0002 - GitHub authentication model

**Status:** Accepted, amended 2026-10-06 by [0018](0018-read-only-graphql-thread-state.md) · **Date:** 2026-09-16

## Context

Historical ingestion needs read access to pull requests in allowlisted
repositories. The specification names three candidates - GitHub App, OAuth app,
personal access token - and prefers a GitHub App for team deployment.

A GitHub App requires a hosted callback, private key management, and an
installation flow. Review Voice is a local-first tool with no server. Shipping a
GitHub App would mean operating infrastructure whose entire purpose is to hand
the user a credential they already have.

## Decision

**Borrow the user's existing `gh` CLI credential.** Review Voice calls
`gh auth token` at request time and never stores a credential of its own.

Fallback order:

1. `gh auth token` (preferred)
2. `GITHUB_TOKEN` or `GH_TOKEN` in the environment
3. A clear error explaining how to authenticate

Required scopes are read-only: repository metadata, pull requests, contents,
commit statuses, and issues where PR conversation comments are in scope.

**The client enforces read-only in code**: any request whose method is not `GET`
throws, regardless of what a caller asks for. This is covered by test.

Team deployment via GitHub App is deferred to Phase 4, if webhook sync ever
justifies the infrastructure.

## Consequences

- No credential storage, so no credential storage bugs. `gh` handles the
  keychain.
- Most Claude Code users already have `gh` authenticated.
- Scopes are the user's existing scopes, which are likely **broader than Review
  Voice needs**. The allowlist, not the token, is what bounds access - so the
  allowlist must be enforced rigorously, and `--repo` arguments validated
  against it before any request.
- `gh` becomes a dependency for GitHub features. It is not needed for local diff
  review; `doctor` reports its absence without failing.
- Rate limits are shared with the user's other `gh` usage. Sync must handle 403
  and 429 with backoff.

## Alternatives considered

**GitHub App.** Rejected for v1: requires hosted infrastructure and key
management for a local-first tool. Revisit only if webhooks ship.

**Prompt for a PAT and store it.** Rejected: makes Review Voice responsible for
secure credential storage on three platforms, for no benefit over `gh`.

## Amendment - 2026-10-06

[ADR 0018](0018-read-only-graphql-thread-state.md): the client's read-only
rule is "only GET, and known GraphQL queries". Whether a review thread is
resolved is only in GitHub's GraphQL API, which takes every operation as a
POST. The client may send only a GraphQL document that is exactly one of a
fixed set of queries (today one), with only the variables that query declares;
`owner` and `name` always come from the allowlisted repository. Anything else
is refused in code before it is sent. Every REST request is still GET-only,
and the test that a non-GET REST request throws is unchanged.
