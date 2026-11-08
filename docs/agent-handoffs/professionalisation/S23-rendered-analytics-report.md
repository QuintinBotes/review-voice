# S23. A rendered analytics report from `evaluate --json`

**Phase:** 6 (market additions, after the program's phases 0 to 5).
**Depends on:** S04 part B (`evaluate --recall`, `recallMetrics`,
`readRecallResults`), S05 (`stage_seconds`, cost, `--since`,
`ComputeOptions.now`, `windowStart`, `challengeCounts`), S06
(`posted_breakdown.by_rule`, `ruleId` on findings, `POLICY_SUPPRESSED_PREFIX`,
`activePolicyRows`, `readSuppressions`) and S07 (path-scoped policy rows);
within phase 6, S15 (`by_evidence_block`) and S17 (`by_family`), whose
`evaluate --json` keys it carries.
**Size:** about 330 source lines, 320 test lines; one Orbit run, two with the
stop point below. **Risk:** low; reporting only. Nothing is posted, nothing new
is recorded, and the renderer is a pure function over the JSON `evaluate`
already prints. Baseline `919d0fd` (1.21.1) plus S02, S03 and S13 (the
`professionalisation/specs-2` branch); line references are to that branch. The
S04 to S07 names were checked on the stack branch
`professionalisation/s11-risk-routed-lanes` at `3fb8443`. Once S05, S06 or S12
has moved `evaluateCommand`, locate code by function name. Verified against the
code on 2026-11-08.

## Why

`evaluate` prints text or JSON and nothing renders either. `evaluateCommand`
(`plugins/review-voice/src/cli.ts:1449-1484`) prints one padded line per
metric with its basis beneath it, or `{ metrics, posted_breakdown }`; after S05
and S06 the JSON is `{ metrics, posted_breakdown: { by_severity, by_lane,
by_rule }, stage_seconds }`. Every `Metric` carries a `basis` string saying how
its number was reached (`src/evaluate/metrics.ts:9-27`), and a figure with no
data is `null`, never zero (`:44-51`). That discipline is the product's
measurement claim, and today the only way to read it is a terminal.

The GitHub Action already writes a report to the job summary, but it is the
`review --json` document of the one run (`action.yml:99-111`); nothing of
`evaluate` reaches it, although the store the Action restores from the cache
(`action.yml:67-72`, keyed by repository) holds every earlier run.

The market research in this program's second report (section 4.1, item 6)
found that CodeRabbit, Greptile, Bito, Qodo, Sourcery, Cursor, Graphite and Baz
show acceptance rates by repository, author and rule, and (section 4.2, item 7)
that Cursor and Graphite show per-rule acceptance after a rule activates while
Qodo deactivates rules that are rarely fixed. Review Voice records better
figures than any of them and shows them as 32-character padded text. Section
5 ranks a rendered report tenth of ten additions, sized small to medium, with
one condition. Every figure prints its basis as the CLI does today.

Two figures the report asks for do not exist yet:

- Precision by lane and rule. The `feedback` table holds `review_run_id`,
  `finding_id` and `action` (`src/store/db.ts:30-40`) and `computeMetrics`
  counts actions over the whole table (`metrics.ts:112-119`). The lane and rule
  of a labelled finding are in the run's `output_json.findings[]`, which is
  where `postedBreakdown` already reads them for outcomes
  (`src/store/outcomes.ts:524-555`).
- Anything about an approved suppression after it activates. `policies` records
  `approved_at` (`db.ts:142`), S06 holds a verified finding with a
  `rejectedBecause` of `POLICY_SUPPRESSED_PREFIX` plus the rule id (the `score`
  handler in `cli.ts` slices the rule id from it), and `record --scores` keeps
  those entries in `output_json.scores[]`, the array S05's `challengeCounts`
  reads. Nothing joins them.

`CONTRIBUTING.md:93-96` says dashboards are out of scope unless discussed in an
issue first. This spec is not one. There is no server, no script, no
interactivity and no new data; it is a rendering of one command's output, the
way the Action already renders `review --json`. The owner's call on that
sentence is an open question under "Non-goals".

## Outcome

`evaluate --json` carries everything the report shows, including two new
figures (owner precision by lane and rule, and per-rule effectiveness since a
suppression was approved), built by one function so the JSON and the rendering
cannot disagree. `evaluate --html` renders that object as an HTML fragment a
workflow can append to its job summary; `--out <path>` writes a complete static
page. Every figure prints its basis, a figure with no data prints `no data`,
and gates, goals and reported figures are told apart exactly as the text output
tells them apart. Nothing is posted and nothing new is recorded.

## Design

### One report object

`metrics.ts` exports the object `evaluate --json` prints and the one function
that builds it:

```ts
export interface EvaluationReport {
  /** ISO time the report was computed, from ComputeOptions.now so a test can pin it. */
  generated_at: string;
  /** The window the `_recent` rates use, so the page can say which days it covers. */
  window_days: number;
  metrics: Metric[];
  posted_breakdown: {
    by_severity: Record<string, PostedStats>;
    by_lane: Record<string, PostedStats>;
    by_rule: Record<string, PostedStats>;
    /** S15's split by whether the posted comments carried an evidence block. */
    by_evidence_block: { with: PostedStats; without: PostedStats; unknown: PostedStats };
  };
  precision_breakdown: { by_lane: Record<string, PrecisionStats>; by_rule: Record<string, PrecisionStats> };
  stage_seconds: Record<string, { median: number; p95: number; runs: number }>;
  rule_effectiveness: RuleEffectiveness[];
  /** S17's per-family figures, carried as `byFamily(db)` returns them. */
  by_family: ReturnType<typeof byFamily>;
}

export function evaluationReport(db: Database, metrics: Metric[], options: ComputeOptions): EvaluationReport;
```

`evaluateCommand` computes `metrics` as it does after S04 and S05
(`[...computeMetrics(db, { windowDays }), ...recallMetrics(recall)]`) and
passes them in, so recall figures ride along when `--recall` is given. `--json`
prints `evaluationReport(...)`; `--html` renders the same object. Keys stay
snake case on the wire, as `posted_breakdown` and `stage_seconds` are today.
The existing keys keep their shape, so the S05 test "evaluate --json carries
stage_seconds beside metrics, and the text does not print it" passes
unchanged. The text output is unchanged.

The keys S15 and S17 add to `evaluate --json` before this spec are carried
through unchanged. `posted_breakdown.by_evidence_block` is S15's
`postedBreakdown().byEvidenceBlock`, and `by_family` is S17's `byFamily(db)`,
whose shape S17 defines and this spec does not restate. Metrics that S16 and
S21 add (`reproduction_hold_rate`, `posted_replies`, `replied_fixed_rate`)
ride in `metrics` like any other.

### Precision by lane and rule

`outcomes.ts` exports `precisionBreakdown(db): { byLane: Record<string,
PrecisionStats>; byRule: Record<string, PrecisionStats> }` with

```ts
export interface PrecisionStats {
  /** keep and rewrite rows, as owner_accepted_precision counts them. */
  kept: number;
  dismissed: number;
  /** kept / (kept + dismissed); null with no labelled finding. */
  precision: number | null;
}
```

Rows come from `feedback`. Each is placed by its finding's lane and rule id
read from the run's `output_json.findings[]` exactly as `postedBreakdown`
places outcomes after S06: the lane defaults to `diff`, the rule is the stored
`ruleId`, else `ruleIdFor(category, lane)`, else `unknown`. Factor that lookup
out of `postedBreakdown` into one module-private helper both functions call, so
the two breakdowns can never place one finding differently. S15's
`byEvidenceBlock` groups by run, through the audit rows, not by this lookup,
and is left as it is. `keep` and
`rewrite` count as kept and `dismiss` as dismissed; `never_flag` and any later
action are not labels for this figure, as they are not for the global metric.
Unlabelled findings appear nowhere, because silence is never a label
(`docs/EVALUATION.md`, "Online precision"). Keys are sorted. The empty store
gives `{ byLane: {}, byRule: {} }`.

### Rule effectiveness since approval

The question a suppression raises after approval is whether it is still right.
The store already holds the two facts that answer it. One is how many verified
findings the suppression held since it was approved. The other is what became
of findings of the same rule that were posted anyway (promoted with
`score --promote`, or on a path outside the suppression's glob).

`versions.ts`: `activePolicyRows` also returns `approvedAt: string | null`
(one more column in its select; every caller destructures by name, so nothing
else changes). A new export reads the suppressions of those rows:

```ts
export type ActiveSuppression = Suppression & { policyId: string; scopeType: string; approvedAt: string | null };
export function activeSuppressions(db: Database): ActiveSuppression[];
```

`Suppression` is the type in `src/policy/schema.ts`.

For each active row it parses `content_yaml` with `parseYaml` (already
imported there since S06) and calls `readSuppressions(doc.suppressions,
row.version)`. On a path-scoped row every suppression's `glob` is the row's
`scopeKey`, the rule `approvedPolicyLayers` in `src/policy/load.ts` applies; a
comment says the rule is repeated here because that function is private and
returns layers, not rows. A row that will not parse contributes nothing, as in
`load.ts`. No warnings are collected; this is a report, and `load.ts` already
warns where the policy is used.

`metrics.ts` exports `ruleEffectiveness(db): RuleEffectiveness[]`:

```ts
export interface RuleEffectiveness {
  rule_id: string;
  /** Every active suppression naming the rule; a null glob is everywhere. */
  suppressions: { glob: string | null; policy_version: number | null }[];
  /** The earliest approval among them, ISO; null when no row records one. */
  approved_at: string | null;
  /** Verified findings of the rule held since approval; null when approved_at is null or runs is 0. */
  held: number | null;
  /** Runs created at or after approval, the basis of held; null when approved_at is null. */
  runs: number | null;
  /** Strong outcomes of the rule's findings posted since approval; null with none. */
  posted: PostedStats | null;
  basis: string;
}
```

One entry per distinct rule id among `activeSuppressions`, sorted by rule id.
`held` counts entries of `output_json.scores[]` whose `rejectedBecause` equals
`POLICY_SUPPRESSED_PREFIX + rule_id` (imported from `src/scoring/score.ts`) in
runs whose `created_at` is at or after `approved_at`, read the way
`challengeCounts` reads `scores[]`, so a row that will not parse or has no
array is skipped. `runs` counts the runs read. With none, `held` is null,
because a count over no run is no data, not zero. `posted` is `postedBreakdown(db, { since: approved_at }).byRule[rule_id] ?? null`,
and `postedBreakdown` gains the optional `{ since }` that `postedStats` gained
in S05 (join `review_runs`, `created_at >= since`); without it the query is
unchanged, so the deep-equal of the empty breakdown at
`test/outcomes.test.mjs:261` (extended by S06) still holds. The basis reads
`H held in R run(s) since <approved_at>; posted outcomes count strong ones only`,
`no run recorded since <approved_at>` when `runs` is 0, or
`no approval time recorded for policy version N; nothing counted` when
`approved_at` is null. With no active suppression the array is `[]`.

A version reactivated by `policy rollback` keeps its first `approved_at`
(`rollbackTo` sets `active` only), so its window starts at that approval and
includes the time it was inactive. The doc says so. Correcting it needs a
column this spec does not add.

### Shared formatting

The text output's three rules, how a value prints, the mark and the target
column (`cli.ts:1458-1475`), move into `metrics.ts` as exported pure helpers:

```ts
export function formatMetricValue(metric: Metric): string;          // 'no data', an integer for *_tracked, else toFixed(2)
export function metricMark(metric: Metric): 'ok' | 'FAIL' | 'over' | '-';
export function metricTarget(metric: Metric): string;               // 'reported, not scored', 'goal <t>' or 'target <t>'
```

`evaluateCommand` calls them and prints each mark in the column it uses today,
so `-` prints as `  -` and `ok` as `  ok`. The dash is three characters wide,
not four, so a `padStart(4)` would change every unscored line. The text output
is then byte for byte what it was, and the report prints one figure the same
way the terminal does.

### The renderer

`src/evaluate/report.ts` imports only the types and the three helpers:

```ts
export function renderEvaluationHtml(report: EvaluationReport): string;  // a fragment
export function htmlDocument(fragment: string, title: string): string;   // a complete page
```

Rules for the fragment:

- Elements used, and no others: `h2`, `h3`, `p`, `table`, `thead`, `tbody`,
  `tr`, `th`, `td`, `code`, `details`, `summary`. No attribute on any of them.
  No `style`, `script`, `img` or `a`. This is the subset GitHub renders in a
  job summary (its own `@actions/core` summary helpers emit headings, tables
  and details), so the same bytes work appended to `$GITHUB_STEP_SUMMARY` and
  saved in a file.
- Sections, in this order and always present:
  1. `<h2>Review Voice evaluation</h2>`, then one `<p>` carrying
     `generated_at`, the window (`the recent posted rates cover the last N days`)
     and the sentence "A figure with no data prints no data, never zero. A gate
     is a contract; a goal and a reported figure are never failed."
  2. `<h3>Gates</h3>`: metrics with `kind` `gate` and a target other than
     `no target`. Columns are metric, value, mark, target, basis.
  3. `<h3>Goals</h3>`: `kind` `goal` with a target other than `no target`.
  4. `<h3>Reported, not scored</h3>`: target `no target`, whatever the kind.
     The three tables partition `metrics`, so no figure prints twice. The
     recall figures of S04 have target `no target` and land here.
  5. `<h3>Seconds by stage</h3>`: stage, median, p95, runs.
  6. `<h3>Posted findings</h3>`: a `<p>` saying rates count strong outcomes
     only, then four tables (by severity, by lane, by rule, and by evidence
     block with the keys `with`, `without` and `unknown`) with key, tracked,
     fixed, dismissed, fixed rate, dismissed rate.
  7. `<h3>Owner labels</h3>`: a `<p>` saying unlabelled findings are excluded,
     then two tables (by lane, by rule) with key, kept, dismissed, precision.
  8. `<h3>Suppressions since approval</h3>`: rule, scopes, approved, held,
     runs, posted fixed, posted dismissed, basis.
- A section with nothing to show prints one `<p>` with `no data` and the
  reason (`no run has recorded stage timings`, `no posted finding has a
  recorded outcome`, `no finding has been labelled`, `no approved suppression
  is active`). Never an empty table, never a zero.
- Values: metrics through `formatMetricValue`; a rate `toFixed(2)`; a count as
  an integer; null as `no data`.
- Every string from the store or configuration (lane, rule id, stage name,
  glob, severity, basis, reason) is cut at 120 code points with `...` and then
  passes a module-private `escapeHtml` (the five characters `&`, `<`, `>`, `"`
  and `'`). Cutting first means a cut never splits an entity. Metric names are
  code constants and go through it too, because a rule with no exception is
  easier to check.
- Deterministic. The producers sort their keys; the renderer adds no time of
  its own; two renders of one report are identical.

`htmlDocument` wraps a fragment in `<!doctype html>`, `<html lang="en">`,
`<meta charset="utf-8">`, an escaped `<title>`, a `<style>` with table borders
and a monospace `code` and nothing else, and `<body>`. It is used only for
`--out`.

### The command

`evaluate` gains `--html` and `--out <path>`:

- `--html` prints `renderEvaluationHtml(report)` to stdout and exits 0.
- `--html --out <path>` writes `htmlDocument(fragment, 'Review Voice evaluation')`
  to `resolveOutPath(out, 'evaluation.html')` (`cli.ts:869-889`), the helper
  `thread --out` and `symbols --out` use, so a directory gets that file name
  and a missing parent is created. It prints nothing and exits 0. A write that
  fails prints the `Cannot write <path>` line `thread --out` prints and exits
  2 (`cli.ts:383-405`).
- `--json` with `--html` exits 2 with `--json and --html are exclusive.`;
  `--out` without `--html` exits 2 with `--out needs --html.`. Both are checked
  before the store opens, as `--since` is, so a bad invocation never touches
  the data directory.
- `--since <Nd>` and `--recall <file>` apply as they do to text and JSON.
- `help.ts` lists both flags, its `Writes` line names the fragment and the
  file, and the exit-code line stays `0 ok, 2 bad invocation.`.

### The job summary (a follow-up for a person)

`action.yml` is protected. Proposed, and filed as an issue when this spec
merges, as `GOAL.md` requires: an input `analytics` (default `'false'`) and a
step after the review that runs `evaluate --html >> "$GITHUB_STEP_SUMMARY"`
with the same `REVIEW_VOICE_DATA_DIR`, so the figures cover the store the cache
restored. Off by default because a job summary is visible to everyone who can
see the Actions run, and the page names the lanes, rule ids and globs of the
repository's configuration. `docs/ACTION.md` gains a short section saying what
the report is, that the input is pending, and that
`review-voice evaluate --html --out <path>` gives the same page locally today.

### Documentation

`docs/EVALUATION.md`: under "Reported, not scored", a `#### Precision by lane
and rule` paragraph and a `#### Suppressions since approval` paragraph (the
definitions, the `since` rule, the rollback caveat, the `no data` rule), and
under "Reading the numbers" a `### The rendered report` subsection naming
`--html`, `--out`, the fixed sections, the GitHub subset and the escaping.
`docs/ACTION.md` as above. `help.ts` as above.

### Order against the other market specs

S23 is ninth of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"), after
every spec whose figures it shows: S15 (`by_evidence_block`), S16
(`reproduction_hold_rate`), S17 (`by_family`) and S21 (`posted_replies`,
`replied_fixed_rate`). Each of those adds to `evaluateCommand`, `metrics.ts`
or `outcomes.ts` first; this spec then moves the JSON into `evaluationReport`
and keeps every key they print. S21 waits on an owner decision; if it has not
landed, its two metrics are simply absent. S18's benchmark `results.json`
renders through `--recall` like any recall file.

## Non-goals

- No rendering of S17's `by_family`. It stays a JSON key of the report; a
  section for it is a follow-up once it has data.
- No breakdown by author or repository. An author is a person; the identity
  rule and the privacy posture keep people out of figures, and the store is one
  owner's.
- No chart, script, stylesheet in the fragment, interactivity or served page.
- No change to what a review records. Both new figures are computed from what
  the store already holds.
- No GitHub write. The plugin writes stdout or a local file; a workflow appends
  to its own summary.
- No new gate, target or warning. Nothing here is scored.
- No rule is deactivated, demoted or proposed for removal by these figures,
  as Qodo does with rarely fixed rules. Reshaping review from outcomes without
  approval is anti-feature 6 of the research report; a suppression that looks
  wrong stays the owner's `policy rollback`.
- Open question for the owner (1). `CONTRIBUTING.md:93-96` lists dashboards as
  out of scope unless discussed in an issue first. This spec treats a rendering
  of `evaluate` as not a dashboard, and `CONTRIBUTING.md` is outside Orbit's
  allowed paths, so the owner either opens that issue before the run, amends
  the sentence by hand, or leaves it as it is.
- Open question (2). Whether the `action.yml` `analytics` input is wanted at
  all, or the report stays a local page. The spec's default is off.
- Open question (3). Whether `rule_effectiveness` should also count owner
  feedback (`keep`, `dismiss`) on promoted findings of the rule. This spec
  reads posted outcomes only, where an owner `dismiss` already appears as a
  dismissed outcome.

## Acceptance criteria

- AC-1. `evaluate --json` prints the `EvaluationReport` shape, with
  `generated_at`, `window_days`, `metrics`, `posted_breakdown` (by severity,
  lane, rule and S15's evidence block), `precision_breakdown`, `stage_seconds`,
  `rule_effectiveness` and S17's `by_family`, built by `evaluationReport`, and
  S15's and S17's keys equal to what their functions return; the existing S05 tests in
  `test/evaluate.test.mjs` pass unchanged; the text output for a seeded store
  is identical to the output before this change (a test pins the two lines
  printed for a metric marked `-` and for one marked `ok`, leading spaces
  included).
- AC-2. `precisionBreakdown`: on a store with findings in two lanes and two
  rule ids, one `keep`, one `rewrite`, one `dismiss` and one unlabelled
  finding, the by-lane and by-rule entries carry the right `kept`, `dismissed`
  and `precision`; the unlabelled finding appears nowhere; a finding recorded
  without `ruleId` is placed by `ruleIdFor(category, lane)`; a `never_flag` row
  counts as neither; the empty store gives `{ byLane: {}, byRule: {} }`; and
  `postedBreakdown` and `precisionBreakdown` place one finding identically
  (`test/evaluate-report.test.mjs`, new).
- AC-3. `ruleEffectiveness`: with one suppression approved through
  `proposePolicy` and `approvePolicy` and runs recorded before and after the
  approval, `held` counts only `scores[]` entries whose `rejectedBecause` is
  `POLICY_SUPPRESSED_PREFIX + rule_id` from runs created at or after
  `approved_at`, `runs` counts those runs, `posted` carries the strong outcomes
  of the rule's findings from those runs and is null with none, and a run
  created before approval contributes to neither; two active suppressions
  naming one rule id (a global and a path scope) give one entry listing both
  scopes; `postedBreakdown(db, { since })` excludes a run aged before `since`
  and without `since` returns what it returned before; a suppression approved
  after every recorded run gives `runs` 0, null `held` and the
  `no run recorded since` basis; an active row inserted directly with no
  `approved_at` gives an entry with null `held`, `runs` and `posted` and a
  basis naming the version; no active suppression gives `[]`
  (`test/evaluate-report.test.mjs`).
- AC-4. `formatMetricValue`, `metricMark` and `metricTarget` are exported and
  `evaluateCommand` uses them; a test asserts each against the text rules: an
  integer `_tracked` value prints as an integer and any other value
  `toFixed(2)`, null prints `no data`; the mark is `-` for a null value or a
  `no target` target, `ok` when met, `over` for a missed goal and `FAIL` for a
  missed gate; the target column is `reported, not scored`, `goal <target>` or
  `target <target>` (`test/evaluate-report.test.mjs`).
- AC-5. `renderEvaluationHtml` on a report built from a seeded store yields
  the eight sections in the stated order; each metric row carries exactly the
  strings `formatMetricValue`, `metricMark`, `metricTarget` and `basis` give;
  every null value prints `no data`; a section with nothing prints its
  `no data` paragraph and no `<table>`; every tag in the output is one of the
  twelve allowed elements with no attribute (the test tokenises the tags); two
  renders of one report are identical; on the empty store every section is
  present, every value cell of the three metric tables reads `no data`, and
  sections 5 to 8 each print their `no data` paragraph and no table
  (`test/evaluate-report.test.mjs`).
- AC-6. A lane named `<script>alert(1)</script>`, a rule id containing `&`
  and both quote characters, a glob containing `<`, and a 200-code-point stage
  name render cut at 120 code points with `...` and then escaped, a long rule
  id with `&` three code points before the cut renders `&amp;` whole and no
  partial entity, and the fragment
  contains no `<script` (`test/evaluate-report.test.mjs`).
- AC-7. Through the bundle with `REVIEW_VOICE_DATA_DIR`, as the S05 CLI tests
  run it: `evaluate --html` exits 0 with the fragment on stdout and nothing on
  stderr; `evaluate --html --out <dir>/sub/report.html` creates the directory,
  writes a document starting `<!doctype html>` that carries
  `<meta charset="utf-8">`, a `<title>` and the fragment, and prints nothing;
  `--json --html` exits 2 with the stated message and creates no data
  directory; `--out x.html` without `--html` exits 2; `--html --out` onto a
  path under a regular file exits 2 with the `Cannot write` line;
  `--html --since 7d` names 7 days in the header paragraph;
  `--html --recall <file>`, with a results file in the shape
  `readRecallResults` accepts, lists the three `fixture_` metrics in the
  "Reported, not scored" table (`test/evaluate-report.test.mjs`).
- AC-8. `evaluate --help` lists `--html` and `--out <path>` and keeps
  `Exit codes: 0 ok, 2 bad invocation.`; a test reads `docs/EVALUATION.md` and
  asserts it names `--html` and `rule_effectiveness`
  (`test/evaluate-report.test.mjs`); the content of `docs/EVALUATION.md` and
  `docs/ACTION.md` is as specified (reviewer-checked).
- AC-9. `npm run verify` passes with the rebuilt bundle committed.

Stop point for a two-run split: run one is the data and the shared formatting
(AC-1 to AC-4, AC-9, and the two `docs/EVALUATION.md` paragraphs under
"Reported, not scored"); run two is the renderer, the command, the help and the
rest of the docs (AC-5 to AC-9).

## Allowed paths

`plugins/review-voice/src/evaluate/**`, `plugins/review-voice/src/store/outcomes.ts`,
`plugins/review-voice/src/policy/versions.ts` (`activePolicyRows` and the new
`activeSuppressions` only), `plugins/review-voice/src/cli.ts` (`evaluate`), or,
once S12 has moved the handler, the `src/cli/` module that holds
`evaluateCommand` (`plugins/review-voice/src/cli/evaluate.ts` in S12's layout),
`plugins/review-voice/src/help.ts`, `docs/EVALUATION.md`, `docs/ACTION.md`,
`test/**`, `plugins/review-voice/dist/review-voice.mjs`.

Never `action.yml` (the follow-up above is a person's), `CONTRIBUTING.md`,
`scripts/`, `.github/`, the manifests, `CHANGELOG.md`, the agents, the prompts
or `plugins/review-voice/src/publish/**`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S23-rendered-analytics-report.md
in this repository. S04 part B, S05, S06 and S07 are already on the base
branch, as are S15 and S17 (and S16 and S21 when they have landed), and S12 may have moved cli.ts into src/cli/, so locate code by
function name. Read the spec first, then docs/EVALUATION.md ("Gates and
goals", "Reported, not scored", "Reading the numbers"),
plugins/review-voice/src/evaluate/metrics.ts (Metric, computeMetrics,
ComputeOptions, stageSeconds, challengeCounts), the evaluateCommand handler
(how a value, mark and target print, the leading spaces of the mark included)
and resolveOutPath,
plugins/review-voice/src/store/outcomes.ts (postedStats with since,
postedBreakdown), plugins/review-voice/src/policy/versions.ts
(activePolicyRows, approvePolicy, rollbackTo), plugins/review-voice/src/policy/rules.ts
(ruleIdFor, readSuppressions), the approvedPolicyLayers function in
plugins/review-voice/src/policy/load.ts (the path-scope glob rule to repeat),
POLICY_SUPPRESSED_PREFIX in plugins/review-voice/src/scoring/score.ts, and
test/evaluate.test.mjs (the withStore and cli helpers).

Outcome: metrics.ts exports an EvaluationReport type and one evaluationReport
builder that evaluate --json prints, carrying generated_at, window_days, the
metrics, posted_breakdown (S15's by_evidence_block included), S17's by_family
unchanged, a new precision_breakdown by lane and rule from the
feedback table, stage_seconds and a new rule_effectiveness list with one entry
per rule id named by an active suppression (held since approval from scores[]
entries, runs since approval, posted strong outcomes since approval through
postedBreakdown's new since option, null and a basis when no approval time is
recorded or no run has been recorded since); activePolicyRows returns approvedAt and versions.ts exports
activeSuppressions; the text output's value, mark and target rules become three
exported pure helpers the text output and the renderer share, with the text
output unchanged byte for byte; a new src/evaluate/report.ts exports a pure
renderEvaluationHtml that emits only the twelve allowed elements with no
attributes, the eight sections in the spec's order, no data paragraphs for
empty sections, escaped and length-capped strings and identical output on
identical input, plus htmlDocument for a complete page; evaluate gains --html
and --out <path> with the exit-2 rules the spec gives; help.ts, docs/EVALUATION.md
and docs/ACTION.md document them. All nine acceptance criteria in the spec must
hold. If one run cannot hold everything, stop at the spec's stop point with
every check green and say which half is next.

Scope: only the paths the spec lists under "Allowed paths". Nothing is posted
to GitHub and nothing new is recorded in the store; no figure becomes a gate; a
figure with no data prints no data, never zero. Do not edit existing tests
except to add to them. Do not edit action.yml, CONTRIBUTING.md, scripts/,
.github/, CHANGELOG.md or the manifests. Add no dependency; the renderer is
string building and the yaml parser is the one versions.ts already imports.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities; synthetic names only in tests.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
