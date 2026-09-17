# 0006 - Team and policy governance

**Status:** Accepted · **Date:** 2026-09-16

## Context

Can a repository's maintainers set review policy for anyone who runs Review
Voice against their repository, or does the owner reviewer remain the sole
authority?

Repository-scoped policy is genuinely useful - a repository knows its own
conventions better than a global policy does. But `.review-voice/policy.yaml` is
repository content, and the threat model classifies repository content as
untrusted. A policy file that activates on checkout is a supply-chain path into
the reviewer's behaviour: `suppressed_patterns` is one line away from "never
mention authentication".

## Decision

**The owner reviewer is the sole policy authority. A committed repository policy
is a proposal, not an activation.**

On encountering `.review-voice/policy.yaml`, Review Voice:

1. Parses it and validates it against the policy schema.
2. Shows the owner exactly what it would change, as a diff against the active
   stack.
3. Waits for explicit approval.
4. Records the approval, the file's content hash, and its provenance.

An approved repository policy is re-proposed when its content hash changes. A
suppression rule arriving by repository file is never auto-approved, whatever
the layering precedence would otherwise imply.

Repository policies cannot alter the safety preamble, the untrusted-data
boundary, the read-only constraint, or the output contract's hard limits. Those
are not policy.

## Consequences

- A hostile or compromised repository cannot silently blind the reviewer.
- Teams get real repository conventions, at the cost of one approval per person
  per change. Acceptable: the file changes rarely.
- Content-hash re-approval means a quiet edit to an approved policy file is
  caught rather than inherited.
- Multi-maintainer governance - where an organisation sets policy centrally -
  is deliberately not solved here. It needs a trust root this architecture does
  not have, and would be a new ADR.

## Alternatives considered

**Repository policies activate automatically.** Rejected: directly contradicts
the threat model.

**No repository-scoped policy at all.** Rejected: repository conventions are one
of the strongest precision signals available, and the specification's layering
depends on them.
