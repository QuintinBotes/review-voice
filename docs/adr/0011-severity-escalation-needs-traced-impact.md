# 0011 - Severity escalation needs traced impact

Status: Accepted

## Context

ADR 0009 derives severity from category and computed reach. Reach measures how
widely the touched file's symbols are referenced, not whether the defect
propagates. Two failures followed. An `api_contract` finding the analyst asked
for at `minor` became `important` with no evidence at all, because the no-reach
path returns the category tier unbounded. A `correctness` finding at repository
reach rose a tier on popularity alone. A claim ending "Is that intended?" also
scored `important`, because only a `question` request counted as a question.

The derivation table is pinned by tests, and `severity.ts` and `reach.ts` must
not read technical confidence, so the fix cannot live there.

## Decision

A separate stage, `boundSeverityByEvidence` in `score.ts`, runs on the derived
tier inside `scoreCandidate`:

- Boundary categories (`security`, `trust_boundary`, `authorization`,
  `authentication`) keep their tier.
- An interrogative claim is capped at `minor` unless it was requested as a
  `question`.
- A tier above the requested one is kept only when the verifier reports
  `impact_traced: true` with confidence of at least 0.85. Otherwise the
  requested tier is used.
- Downward derivation is unchanged. Question gating still uses the unbounded
  derivation.

`validate-output` also rejects an `[important]` or `[blocking]` finding whose
problem sentence ends with `?`.

## Consequences

Reviews get quieter: fewer findings sit above what the analyst asked for, and
fewer would map to a blocking review state later. A real escalation now needs
the verifier to follow the failure outside the changed code. The derivation
table is untouched, so ADR 0009 stands.
