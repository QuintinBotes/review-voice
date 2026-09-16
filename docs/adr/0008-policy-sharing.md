# 0008 — Policy sharing and export

**Status:** Accepted · **Date:** 2026-09-16

## Context

An approved policy is a distilled statement of what a reviewer cares about.
Sharing one across a team, or committing it to a repository, is obviously
useful. It is also how a bad policy propagates, and how an untrusted policy
enters a trusted position.

## Decision

**Export is free. Import is always a proposal.**

`review-voice policy export` writes an approved policy as portable YAML,
including its provenance and the source window it was compiled from, with local
event ids stripped — the summary counts stay, the pointers into a private corpus
do not.

Importing a policy — from a repository file, a shared file, or a URL — always
routes through the approval flow in [0006](0006-team-governance.md): validate,
diff against the active stack, show, wait. Nothing imported is ever active on
arrival.

Exported policies carry a content hash and the exporting tool version. Imported
policies retain a record of where they came from, so a rule's origin stays
answerable months later.

Sharing a **corpus** is not supported. Review history contains colleagues' words
and other repositories' code; exporting it would move a privacy decision out of
the hands of the people who made those comments.

## Consequences

- A team can converge on shared conventions without any central service.
- Provenance survives the trip, so `policy show` can still answer "why does this
  rule exist" for an imported rule.
- Every user approves every import. Intentional friction.
- Stripping event ids means an imported policy's provenance is less precise than
  a locally compiled one. Correct tradeoff: the alternative leaks corpus
  identifiers.

## Alternatives considered

**A policy registry.** Rejected for v1: infrastructure, moderation, and a trust
root that a local-first tool does not have.

**Export the corpus too.** Rejected on privacy grounds above.
