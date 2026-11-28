# 0026 - The queue reads GitHub search, inside the allowlist

**Status:** Accepted · **Date:** 2026-10-25
**Amends:** [0002](0002-github-auth-model.md) - the read-only client gains one
endpoint outside a repository path, and the allowlist accepts owner globs. No
write is added.

## Context

To watch, Review Voice must find the pull requests that need its owner. GitHub
only answers "where is my review requested" through search, which is not under a
repository path. The client refuses any request outside an allowlisted
repository, and the allowlist names repositories one by one. An owner who
reviews across an organisation would list every repository by hand and miss each
new one.

Operators also need skip rules their scripts applied by hand. Examples are
authors never to review, bots, pull requests assigned to someone else, and team
requests another reviewer already approved at the current head.

## Decision

**The client may send `GET /search/issues` and nothing else outside a
repository path. Every result outside the allowlist is dropped before it is
read further. The allowlist accepts `owner/*`.**

- **Search.** Only `GET /search/issues`, with a query the client builds from
  typed sources: `requested`, `assigned`, `team:<org/slug>`, always with `is:pr
  is:open draft:false`. A caller cannot pass a raw query.
- **The filter.** The repository of each result is matched against the
  allowlist, globs included, before anything else is read. Results outside it
  are counted in the report and never read.
- **Globs.** `owner/*` matches every repository of one owner. A bare `*` is
  refused.
- **Follow-ups and dismissals** come from the store: open pull requests with a
  recorded run whose head moved, and pull requests where the owner's latest
  review was dismissed.
- **Skip rules.** `queue.skip` takes `authors`, `author_patterns`,
  `allow_bots_when_requested`, `assigned_to`, `approved_at_head_by` (with the
  sources it applies to) and `drafts`. A skipped entry names its rule.
- **Order and limit.** Oldest first. At most `max_per_pass` review entries,
  and the rest are reported as not reached.

## Consequences

- One configuration line covers an organisation.
- Search shares the user's rate limit. The queue pages at most five pages per
  source and reports truncation.
- The allowlist remains the boundary. A glob widens it on purpose, in the
  owner's configuration.

## Alternatives considered

**List every repository's open pull requests.** Rejected. That is one request
per repository per pass, and it reads pull requests in repositories the owner
was never asked to review.

**Accept a raw search query.** Rejected. A query is the easiest place to reach
outside the allowlist by accident.

## Amendment 2026-11-28 - code search for linked consumers (#548)

A change can break a consumer in another repository, which neither this
repository's tree nor its CI can show. The client may now also send
`GET /search/code`, through `searchCode` only, under the same rules as
`/search/issues`:

- The query is built by the client from one bounded identifier, schema key, event name or route
  and one repository, `"<name>" repo:<owner>/<repo>`. A repository outside the
  allowlist, or any other term, is refused before a request is sent.
- A result whose `repository.full_name` is not the searched repository is
  dropped unread. One page of ten results, no rate-limit retry.
- Only `review.linked_repositories` are searched, and only those also in
  `repositories.include`; the rest are skipped with a note. `symbols` searches
  the names of declarations on removed lines (a removal, a rename or a new
  signature leaves one) and selected literal contract names. Searches and exact blob
  reads share a six-request limit and the remaining time budget.
- A failed search (no credential, a token that cannot read the repository, a
  rate limit) or a spent budget marks the result inconclusive and adds a note
  to the review. It never fails the review.

The hits are lexical leads, as `symbols` references are: no symbol graph or
index is built (docs/adr/0009). Text from another repository is redacted and
is evidence, never instructions. Linked consumers do not count toward reach;
see the amendment to docs/adr/0009.
