# S05. Latency, cost, hold rate and a rolling dismissed rate

**Phase:** 1 (measurement). **Depends on:** nothing (S02 adds the mode and
version the breakdowns can key on, but this spec does not need them).
**Size:** about 140 source lines, 180 test lines, one Orbit run. **Risk:** low;
reporting only. Baseline `919d0fd` (1.21.1). Verified against the code on
2026-11-07.

## Why

`docs/EVALUATION.md` lists "Small-diff median latency" as "not automated;
observed, not asserted". `computeMetrics`
(`plugins/review-voice/src/evaluate/metrics.ts:52-252`) computes one latency
figure, `median_review_seconds` (the run-seconds loop at `:59-79`, the metric
at `:156-165`), and its `percentile` helper (`:29-38`) is used only for words
and findings (`:176`, `:191`). It computes no challenge-hold rate although the
data is stored (held entries with `source: 'challenge'`, `src/verify/challenge.ts:260`;
every judged score entry carries a `challenge` key, `challenge.ts:270-279`,
kept by `record --scores` in `output_json.scores`), no cost figure although
agent stages record `costUsd` (`src/review/driver.ts:184-198`), and its
`posted_dismissed_rate` is all-time because `postedStats` has no time window
(`src/store/outcomes.ts:519-521`).

The product specification this program draws on alerts when the invalid-comment
rate on human dismissals exceeds 20% over seven days, or when the 95th
percentile time to first comment exceeds eight minutes. Review Voice records
the inputs for both and reports neither.

## Outcome

`evaluate` reports review latency at the median and the 95th percentile, per
stage, cost per review, the share of challenged findings the challenger held,
and a dismissed rate over a rolling window. `status` warns when the rolling
dismissed rate crosses a threshold on a sample large enough to mean something.

## Design

### Metrics

All new figures are **reported, not scored**, in the sense `EVALUATION.md`
gives those words, and each prints its basis (run count, outcome count). A
figure with no data reports `no data`, never zero.

| Metric | Definition |
|---|---|
| `median_review_seconds`, `p95_review_seconds` | per-run sum of stage seconds; p95 added beside the existing median |
| `median_review_cost_usd`, `p95_review_cost_usd` | per-run sum of stage `costUsd`. A run is costed when it recorded at least one stage and every recorded stage carries a numeric `costUsd` (the key is absent, never null, when an agent reported no cost; the slash command's stages carry no cost at all). A run with no stages, or any stage lacking the key, is excluded; the basis prints `N costed run(s), M excluded (no cost recorded)` |
| `challenge_hold_rate` | numerator: `output_json.held` entries with `source === 'challenge'`; denominator: `output_json.scores[]` entries that carry a `challenge` key (exactly the findings the challenger judged); a run counts when it has any such entry or a `challenge` stage in `stages_json`; other runs are excluded and the basis says how many counted |
| `posted_fixed_rate_30d`, `posted_dismissed_rate_30d` | the existing strong-outcome rates restricted to runs whose `review_runs.created_at` is within the window (the run's time is when the finding was posted); default 30 days, `--since <Nd>` changes it, the same spelling `outcomes --since` uses |

`stage_seconds` is not a `Metric` (`Metric.value` is `number | null` and two
tests iterate every metric asserting that shape, `test/evaluate.test.mjs:25-44`).
`metrics.ts` exports `stageSeconds(db): Record<string, { median: number; p95: number; runs: number }>`
and `evaluate --json` emits it as a top-level key beside `posted_breakdown`
(`cli.ts:1383-1385`); the text output does not print it.

`postedStats(db, { since })`: without `since` the query is unchanged, so the
all-time rates and their tests keep their values (an outcome can exist with no
run row, `test/outcomes.test.mjs:327-330`); with `since` it joins `review_runs`
on `review_run_id` and filters `created_at >= since`.

### Status warning

The threshold logic is a pure function in `metrics.ts`,
`dismissedRateWarning({ dismissed, strong, windowDays })`, returning the line or
null; `status` prints it when `posted_dismissed_rate_30d` is above `0.20` and
the window holds at least 10 strong outcomes:

```
Warning: 4 of 15 posted findings in the last 30 days were dismissed (27%); run `review-voice explain` on the dismissed ones and consider /review-voice:feedback.
```

The threshold and minimum are constants with a comment saying where they come
from and that they are a starting point.

### Documentation

`docs/EVALUATION.md`: move the latency row out of the Gates table into the
Goals table as `Small-diff median latency | ≤ 90s`, rewrite the paragraph that
says the last two gates are unmeasured so it names only the false-positive
rate, and add rows for p95 latency, cost, hold rate and the windowed rates
under "Reported, not scored" with a short subsection on the window. `help.ts`
documents `--since <Nd>` on `evaluate` (a value that is not a whole number of
days exits 2 with `--since takes a whole number of days, such as 30d.`).

### Tests

Tests age a run by updating `review_runs.created_at` directly, as
`test/outcomes.test.mjs:285-288` does for `output_json`, or pass `now` to
`postedStats(db, { since, now })`. The `status` warning is asserted both on the
pure function and by running the bundle with `REVIEW_VOICE_DATA_DIR`, as
`test/outcomes.test.mjs:295-319` does.

## Non-goals

- No alerting outside `status` (no webhook, no GitHub write).
- No change to what is recorded; S02 covers provenance.

## Acceptance criteria

- AC-1. Over a store with runs of known stage timings, `evaluate` reports the
  median and p95 review seconds, and `evaluate --json` carries a top-level
  `stage_seconds` map with median, p95 and run count per stage; the two
  every-metric tests in `test/evaluate.test.mjs` pass unchanged.
- AC-2. Cost figures count only costed runs as defined; a run whose stages
  have seconds but no `costUsd` (the slash-command shape) leaves the cost
  metrics at `no data` when it is the only run, and is counted as excluded in
  the basis otherwise.
- AC-3. `challenge_hold_rate` is computed as specified; with no run that
  carries a `challenge` key or stage it reports `no data`.
- AC-4. The windowed rates include only runs created in the window; a run
  aged to 31 days is excluded; `--since 7d` changes the window; a bad value
  exits 2; the all-time rates and their existing tests are unchanged.
- AC-5. `dismissedRateWarning` returns the line only above the threshold with
  at least 10 strong outcomes; `status` prints it in that case and nothing
  otherwise.
- AC-6. `help.ts` documents `--since`; `test/evaluate.test.mjs` covers each
  new metric with its basis. `docs/EVALUATION.md` is updated as specified
  (reviewer-checked).
- AC-7. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/evaluate/metrics.ts`, `plugins/review-voice/src/store/outcomes.ts`,
`plugins/review-voice/src/cli.ts` (`evaluate`, `status`), `plugins/review-voice/src/help.ts`,
`docs/EVALUATION.md`, `test/**`, `plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S05-observability-metrics.md
in this repository. Read that file first. Read docs/EVALUATION.md ("Gates and
goals", "Reported, not scored"), plugins/review-voice/src/evaluate/metrics.ts,
plugins/review-voice/src/store/outcomes.ts (postedStats, postedBreakdown),
plugins/review-voice/src/verify/challenge.ts (how a judged score entry and a
held entry are marked) and test/evaluate.test.mjs before changing code.

Outcome: `evaluate` reports p95 review seconds beside the median, a top-level
stage_seconds map in --json (not a Metric), median and p95 cost per review over
costed runs as the spec defines them, a challenge hold rate over the findings
the challenger judged, and windowed posted fixed and dismissed rates
(`--since <Nd>`, default 30d) that leave the all-time rates untouched; a pure
dismissedRateWarning function drives a `status` warning above 20% on at least
10 strong outcomes; docs/EVALUATION.md and help.ts describe each figure and
its basis. All seven acceptance criteria in the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". Every new figure
is reported, never a gate; a figure with no data reports no data, never zero.
Do not edit scripts/, .github/, CHANGELOG.md or the manifests. Add no
dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
