# 0018 - Reading review-thread state through a GraphQL query

**Status:** Accepted · **Date:** 2026-10-06
**Amends:** [0002](0002-github-auth-model.md) - the read-only client's rule
moves from "only GET" to "only GET, and GraphQL queries", checked in code.
[0010](0010-review-verdict-posting.md) - the read-only client no longer
rejects every non-GET request; it sends one kind of POST, a GraphQL query. The
writer and its one write path are unchanged, and no GitHub write is added.

## Context

A candidate that repeats a comment already on the pull request is linked to it
for the verifier, with the comment's author, location and whether GitHub still
places it on the head (`outdated`). Field use found a case that signal misses:
another reviewer's comment had been marked fixed - its thread resolved - but
the fix covered one query in the file and the candidate was about another. The
verifier had no way to know the earlier point was considered closed.

Whether a review thread is resolved is not in GitHub's REST API. It is only in
GraphQL (`reviewThreads { isResolved isOutdated }`), and GitHub's GraphQL
endpoint takes every operation, a read included, as a `POST`. The client
enforced read-only as "any request whose method is not GET throws", so it
could not ask.

## Decision

**The read-only `GitHubClient` may send GraphQL `query` operations, and
nothing else, as its only non-GET request. Read-only is checked on the
operation, in code, before anything is sent.**

- **`graphql(repository, document, variables)`** refuses, with
  `ReadOnlyViolation` and before any network call:
  - any document containing the word `mutation` or `subscription` anywhere,
    case-insensitively, a comment included;
  - any document that does not begin with `query` or `{`;
  - any document holding a string literal, so a repository can be named only
    through the `owner` and `name` variables.
- **The allowlist still bounds it.** `repository` must be allowlisted, and
  `owner` and `name` are always overwritten with it, whatever the caller
  passed.
- **REST stays GET-only.** `get`, `paginate` and `paginateWrapped` are
  unchanged and still refuse any other method; their test still passes.
- **No retries.** A GraphQL read is optional for every caller, so a rate limit
  or permissions error fails it at once.
- **One query today.** `RV thread` reads each review thread's `isResolved`
  and `isOutdated` and its comments' `databaseId`, `path` and `line`, joins
  them to the REST inline comments on the comment id, and marks a comment
  whose thread is resolved `resolved: true`. `check-candidates` carries it into
  `possibleRepeatOf`, and the verifier treats a resolved thread as a likely
  addressed point: it keeps the candidate only for an instance the resolution
  did not cover.
- **A failed read never fails the review.** If the query fails - a token
  without the permission, a rate limit, an error in the answer, an answer in
  the wrong shape - `thread` prints a local warning and writes the REST data
  alone, with no comment marked resolved. Nothing about it is posted.

## Consequences

- **The guarantee is narrower in kind.** "Only GET" was checkable by method
  alone; "only queries" depends on refusing two words in the document. The
  refusal is deliberately coarse - a field or comment that merely contains the
  word is refused too - because a false refusal costs one optional read and a
  false pass would be a write.
- **Scopes are unchanged.** Reading review threads needs the same pull-request
  read access the REST reads already use.
- **Still never done:** resolving or unresolving a thread, or any other
  GraphQL mutation. The writer of 0010 remains the only write.

## Alternatives considered

**A separate GraphQL reader class.** Rejected: it would hold the same token
and need the same allowlist, and a second client is a second place for the
read-only rule to drift. One client with the check beside the GET check keeps
both rules in one file under one test.

**Infer resolution from REST.** The nearest REST signal is `outdated`, which
says the code moved, not that anyone considered the point closed. Already in
use; not a substitute.

**An allowlist of exact query texts.** Stronger, but it turns every new field
into a security change. Revisit if a second query is added.
