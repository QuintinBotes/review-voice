# 0001 — Embedding and retrieval implementation

**Status:** Accepted · **Date:** 2026-09-16

## Context

Precedent retrieval needs to find historical review events relevant to the
current diff. The obvious approach is semantic embeddings, which collides with
two commitments made elsewhere:

- **Zero install.** Plugins arrive by git clone with no install step. A local
  embedding model means a multi-hundred-megabyte download and a native runtime.
- **Local only by default.** `privacy.allow_remote_embeddings: false` is the
  shipped default. A hosted embedding API contradicts it.

The corpus is also small — 250 events at the bootstrap target, often fewer. The
regime where embeddings decisively beat lexical search is large, diverse
corpora.

## Decision

**Default retrieval is SQLite FTS5 lexical matching plus structural filters,**
ranked by the owner-weighted scoring in the specification.

Structural filters — category, repository, path glob, language — do most of the
work here, because "did this reviewer dismiss CI-gating comments in this
repository" is a structured query, not a semantic one.

A pluggable `EmbeddingProvider` interface is defined from the start. The
`embeddings` table exists in the schema. Users may opt into a remote provider;
it is off by default and requires explicit configuration.

No embedding model ships with the plugin.

## Consequences

- No download, no native modules, works offline, deterministic, unit-testable
  without a model or a network.
- **Paraphrase recall suffers.** A dismissal worded differently from the current
  candidate may not be retrieved. This is a real quality cost, accepted
  knowingly.
- The evaluation harness measures precedent recall directly. If it shows
  retrieval is the binding constraint on precision, the provider interface is
  already in place.
- FTS5 must be present in the Node build; `review-voice doctor` checks it.

## Alternatives considered

**Bundle a small local model (e.g. via transformers.js).** Rejected: breaks
zero-install, adds a large binary dependency, and a meaningful ongoing
maintenance burden for a small-corpus gain.

**Require a remote embedding API.** Rejected: contradicts the local-only default
and introduces a second API credential for a tool that otherwise needs none.

**Hash-based semantic approximation.** Rejected: the complexity of a real
embedding approach with substantially worse quality than either alternative.
