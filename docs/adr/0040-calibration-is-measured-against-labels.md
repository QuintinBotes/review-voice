# 0040 - Calibration is measured against labels

**Status:** Accepted · **Date:** 2026-11-25

## Context

The confidence floors and the final-score gate were set from small
hand-labelled samples quoted in comments, and nothing in the tool could
re-measure them. `evaluate` reports what became of posted findings and
approvals, which says nothing about candidates that were held, rejected by
the verifier, or never posted, and nothing about whether a verifier
confidence of 0.85 means the same thing in every category (#481).

## Decision

**`evaluate calibration` measures the stored score breakdowns against a
human-labelled set, and `evaluate label-sample` draws the set to label.
Neither reads the network, calls a model, or writes the store.**

- **Labels.** A JSON array of `{run, candidate_id, label, note?}` with label
  `TRUE`, `TRUE-NOT-WORTH`, `PARTLY`, `FALSE` or `UNCHECKABLE`, validated
  strictly with the entry and field named. A label for a run or candidate
  the store does not have is listed under `unmatched` and never counted.
- **Precision.** By verifier-confidence band and by category, verified and
  verifier-rejected candidates apart. `TRUE` and `TRUE-NOT-WORTH` count as
  true and `FALSE` as false; `PARTLY` and `UNCHECKABLE` are reported but
  never in a denominator. Each precision carries a Wilson 95% lower bound.
- **Volume.** Eligible findings per review and holds by reason under the
  thresholds each breakdown recorded, and under a proposed set re-applied
  through the scorer's own gate logic (`reGateBreakdown` over
  `verifiedFloor` in `scoring/score.ts`). A breakdown lacking a field the
  decision needs counts under `notReapplicable` with the field named.
- **Audits.** A materiality 2x2 where a breakdown or verification records
  `material` (`n: 0` while none does), and a rejection audit: the share of
  labelled verifier-rejected candidates a human called `TRUE` or
  `TRUE-NOT-WORTH`, with Wilson bounds.
- **Sampling.** `label-sample` draws proportionally from band crossed with
  verified-or-rejected, at least one per non-empty stratum when the draw
  reaches the stratum count, from a seeded stream. The sheet it writes is
  the labels format plus context, so a filled sheet is the next
  calibration's input unchanged.

## Consequences

- A threshold change can be argued from labelled evidence, band by band,
  before it is made, including what it would have done to volume.
- The first cut buys no stability measurement: re-verification was left
  out on purpose (#481), so a confidence that moves between runs is still
  invisible here.
