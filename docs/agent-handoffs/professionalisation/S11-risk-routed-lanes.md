# S11. Risk-routed lanes: eligibility by signal, and shipped security and concurrency analysts

**Phase:** 4 (structural signals and routing). **Depends on:** S10 part A.
**Size:** about 280 source lines, 280 test lines, two agent files, three ADR
amendments; one Orbit run, two with the stop point below. **Risk:** medium.
More lanes cost more; every addition here is gated on a signal or opt-in so
the default review costs the same. Baseline `919d0fd` (1.21.1). Verified
against the code on 2026-11-07.

## Why

Risk routing half exists. Sensitive paths make complexity `high`
(`plugins/review-voice/src/diff/complexity.ts:434-469`) and `auto` mode picks
`thorough` for a high change (`src/review/plan.ts:44-54`, the rule ADR 0025
lists verbatim). But a lane runs on line counts only: `Lane.when` has
`minChangedSourceLines`, `paths` and `excludeKinds` (`src/review/lanes.ts:20`,
`:62-82`), and `lanesCommand` holds the manifest with its `structure` block
without passing it (`src/cli.ts:1286`). Nothing in the diff's content, a
deleted guard, a new route, a lock, a string-built query, can wake a
specialist.

Only `structure-analyst` ships. The `diff-analyst` names security,
authorization, authentication and concurrency among its categories
(`agents/diff-analyst.md:295-298`), inside a 29 KB prompt that ADR 0023 says
dilutes both reviews when every checklist lives in one analyst. ADR 0023 built
lanes so a perspective is "a prompt file and four lines of configuration". No
security or concurrency prompt exists to configure. The shipped example config
keeps its one lane example commented out (`templates/config.example.yaml:44-49`)
and `test/issues-config.test.mjs:38-47` loads the whole example as a live
config.

## Outcome

A lane can be eligible because the change shows a risk signal, not only
because it is long. Two specialist analysts ship, off by default, and the
example configuration shows how to turn them on. A repository may opt in to
holding approval when a control was removed, the same way it opts in for
structural regressions.

## Design

### Risk markers

`src/diff/risk-markers.ts`, the third scanner on the exported
`type-escapes.ts` shape (S10 exports `splitLine`, `Language`, `Rule` with the
`raw` mode), over added lines:

| kind | matched on | added line matches |
|---|---|---|
| `new-route` | code | `app.(get|post|put|patch|delete)(`, `router.`, `@(Get|Post|Put|Patch|Delete|Route)`, `[Http(Get|Post|Put|Delete)]`, `@app.route`, `path(` in a `urls` file |
| `lock-or-async` | code | `lock`, `mutex`, `semaphore`, `Interlocked`, `synchronized`, `Monitor.`, `Promise.all`, `Task.WhenAll`, `go func`, `Parallel.` |
| `string-built-query` | raw | a quoted segment containing `SELECT`, `INSERT`, `UPDATE` or `DELETE` with a concatenation or interpolation operator outside it (`+`, `.format(`, `%`) or an interpolation marker inside it (`${`, `%s`, an f-string prefix) on the same line |
| `unsafe` | code | `unsafe`, `eval(`, `exec(`, `dangerouslySetInnerHTML`, `Marshal`, `pickle.loads`, `yaml.load(` without `SafeLoader` |

Emitted as `structure.riskMarkers: { path, line, kind }[]`, at most 20 per
file; `StructureSignals` gains `riskMarkers: RiskMarker[]`, always present.
`test/issue-108-size-crossings.test.mjs:260` deep-equals the whole
`StructureSignals` object (S10 part A extended it with `removedControls: []`)
and is extended with `riskMarkers: []`; this belongs to run one. Lexical,
documented as a lead. A `new-route`, `lock-or-async` or
`unsafe` pattern inside a string or comment is not a marker; a SQL keyword in
a plain string literal with no concatenation or interpolation is not one
either.

### Lane eligibility by signal

`Lane.when.signals?: ('removed-controls' | 'risk-markers' | 'type-escapes' | 'branch-growth' | 'size-crossing')[]`,
validated in `parseLane` against that list (an unknown name drops the lane
with a warning). `eligibleLanes` receives the manifest's `structure` block from
`lanesCommand`; a manifest without a `structure` block, or without a listed
key, counts as no signal (existing CLI tests write a `files.json` without one,
`test/lanes.test.mjs:209`). Signal entries are filtered by the lane's `paths`
when set, so a marker outside the lane's globs does not wake it. A lane with
`signals` is eligible when any listed signal is non-empty, or when
`min_changed_source_lines` is set explicitly and met; with `signals` an absent
minimum is not a minimum of zero, so such a lane is eligible on a signal alone
(the example security lane). The reason string says which clause held.
Without `signals` nothing changes: an absent minimum still means always
eligible (`lanes.ts:77`).

`PlanInput` gains `removedControls: number`, read by `planCommand` from
`manifest.structure`; the `auto` rule gains one clause: a non-empty
`removedControls` picks `thorough` (it changes models and stages, never the
verdict). ADR 0025 lists the auto rule and gains a dated amendment;
`docs/WATCHER.md`'s `auto` paragraph is updated.

### Shipped specialists

`agents/security-analyst.md` (lane prefix `sec_`, categories `security`,
`authorization`, `authentication`, `trust_boundary`, every one of them in
S06's `SUPPRESSION_EXEMPT_CATEGORIES`) in the structure analyst's shape:
front matter with `name`, `description` and `tools: Read, Grep, Glob, Bash(git:*)`,
the `## Untrusted input` block, what qualifies with the evidence each item
needs, what does not, category and severity rules, output. Its checklist,
each item requiring a cited guard search:

- a new or changed entry point has server-side validation and object-level
  authorisation, found by reading the handler and its middleware;
- queries are parameterised and output is encoded for its sink;
- no new secret, weak cryptography or unsafe deserialisation;
- a removed check, limit or allowlist entry is not re-established elsewhere
  (search the head; the `removedControls` entry is the lead);
- errors do not return secrets or stack data to clients;
- a new flag or configuration default fails closed.

`blocker_class` values: `removed-control`, `missing-object-authorization`,
`string-built-query`, `fail-open-default`. The verifier prompt gains their
definitions beside the structure lane's.

`agents/concurrency-analyst.md` (prefix `cc_`, category `concurrency`):
shared mutable state without a guard, read-decide-write without a unique
index or conditional update, lock ordering, missing cancellation on a budget,
unbounded parallelism. `blocker_class` values: `unguarded-read-decide-write`,
`lock-order`, `missing-cancellation`.

Neither lane is configured by default. `templates/config.example.yaml`
documents both as commented-out entries beside the structure lane example,
with one comment line explaining `when.signals`, so the example still loads
with no lanes and no warnings:

```yaml
#   - name: security
#     agent: security-analyst
#     prefix: sec_
#     when: { signals: [removed-controls, risk-markers], paths: ['src/**'] }
#     severity: { escalate: { to: blocking, requires: blocker_confirmed } }
#   - name: concurrency
#     agent: concurrency-analyst
#     prefix: cc_
#     when: { signals: [risk-markers], min_changed_source_lines: 80 }
#     severity: { cap: important }
```

ADR 0023 is amended for `when.signals` and the two shipped agents.

### Opt-in approval cap

`HumanReviewStructureConfig` gains `removedControls: boolean` (default false;
`review.human_review.structure.removed_controls`). When true, a non-empty
`removedControls` list caps APPROVE at COMMENT through
`applyStructureHumanReviewCap` (`complexity.ts:515`, its `signals` parameter
widened), exactly as `file_line_crossing` and `branch_growth` do. Nothing is
posted about it. ADR 0020 names exactly two opt-in signals and gains a dated
amendment naming the third. The four existing deep-equal assertions that pin
`humanReview.structure` (`test/issue-114-structural-human-review-cap.test.mjs:49`,
`:57` and `:63`, and the whole-`humanReview` assertion at
`test/human-review-complexity.test.mjs:181-189`) are extended with
`removedControls: false` or `true`.

## Non-goals

- No lane on by default; cost stays flat for a repository that changes
  nothing.
- No change to the diff analyst's own coverage of these categories.
- No parser.

## Acceptance criteria

- AC-1. `findRiskMarkers` returns the specified kinds on synthetic hunks for
  each kind; nothing for a `new-route`, `lock-or-async` or `unsafe` pattern
  inside a string or comment; nothing for a SQL keyword in a plain string
  literal with no concatenation or interpolation; `diff --out` writes
  `structure.riskMarkers` and the summary carries the same array;
  `test/issue-108-size-crossings.test.mjs:260` is extended with
  `riskMarkers: []`.
- AC-2. A lane with `when.signals: [removed-controls]` and no line minimum is
  eligible on a change with one removed control and ineligible on one with
  none or with no `structure` block, including a change with 500 changed
  source lines and no signal; a lane with both an explicit minimum and signals
  is eligible when either holds; a marker outside the lane's `paths` does not
  wake it; the reason names the clause that held; a lane naming an unknown
  signal is dropped with a warning.
- AC-3. `plan` picks `thorough` in `auto` mode for a change with a removed
  control and its reason says why.
- AC-4. Both agent files exist and a test shaped like `test/lanes.test.mjs:106-121`
  asserts each one's front matter `name`, non-empty `description`,
  `tools: Read, Grep, Glob, Bash(git:*)`, the `## Untrusted input` heading and
  every `blocker_class` name; `agentExists` finds both; a configured security
  lane runs its agent in a driver test with fake agents and its candidates are
  checked with the `sec_` prefix.
- AC-5. The verifier prompt defines the new `blocker_class` values (a test
  greps for each); a lane escalation with `blocker_confirmed` for
  `removed-control` follows the existing ADR 0011 bar.
- AC-6. With `human_review.structure.removed_controls: true`, a clean change
  with a removed control gets COMMENT not APPROVE, locally noted and never
  posted; with the default false, nothing changes; the four named deep-equal
  assertions are extended.
- AC-7. `config.example.yaml` carries the commented lane entries and still
  loads with no lanes and no warnings (`test/issues-config.test.mjs`); a test
  asserts `docs/adr/0020-*.md`, `docs/adr/0023-*.md` and `docs/adr/0025-*.md`
  each contain a `## Amendment - 2026` heading and `docs/adr/README.md` marks
  the three rows; `docs/WATCHER.md` (lanes section and the `auto` paragraph)
  and `docs/ARCHITECTURE.md` ("Structural evidence" for `riskMarkers`,
  "Analyst lanes" for `when.signals` and the agents) are updated
  (reviewer-checked).
- AC-8. `npm run verify` passes with the rebuilt bundle committed.

Stop point for a two-run split: run one is the risk markers, eligibility and
plan rule (AC-1 to AC-3, the ADR 0025 amendment, AC-8); run two is the agents,
the verifier definitions and the cap (AC-4 to AC-7, AC-8).

## Allowed paths

`plugins/review-voice/src/diff/**`, `plugins/review-voice/src/review/lanes.ts`,
`plugins/review-voice/src/review/plan.ts`, `plugins/review-voice/src/policy/load.ts`,
`plugins/review-voice/src/cli.ts` (`lanes`, `plan`, `diff`),
`plugins/review-voice/src/review/prompts.ts`, `plugins/review-voice/agents/security-analyst.md`
(new), `plugins/review-voice/agents/concurrency-analyst.md` (new),
`plugins/review-voice/agents/evidence-verifier.md`,
`plugins/review-voice/templates/config.example.yaml`, `docs/WATCHER.md`,
`docs/ARCHITECTURE.md`, `docs/adr/0020-*.md`, `docs/adr/0023-*.md`,
`docs/adr/0025-*.md`, `docs/adr/README.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S11-risk-routed-lanes.md in
this repository. S10 part A is already on the base branch. Read the spec
first, then docs/adr/0023-analyst-lanes-are-configured.md,
docs/adr/0020-structural-signals-may-opt-into-human-review.md,
docs/adr/0025-cost-modes-choose-stages-and-models.md,
plugins/review-voice/src/review/lanes.ts, plugins/review-voice/src/review/plan.ts,
plugins/review-voice/src/policy/load.ts (parseLane),
plugins/review-voice/src/diff/type-escapes.ts and
plugins/review-voice/src/diff/removed-controls.ts (the exported scanner
shape), plugins/review-voice/src/diff/complexity.ts (applyStructureHumanReviewCap)
and plugins/review-voice/agents/structure-analyst.md (the shape of a lane
agent).

Outcome: a lexical risk-marker scanner feeds structure.riskMarkers (always
present on StructureSignals) with the per-kind matching the spec gives; lanes
may declare when.signals and become eligible when a listed signal fires within
their paths or an explicit line minimum holds, with a missing structure block
counting as no signal and an absent minimum not counting as met; PlanInput
gains removedControls and auto mode picks thorough when a control was removed;
two new lane agents, security-analyst (sec_) and concurrency-analyst (cc_),
ship with the checklists and blocker_class values the spec gives, documented
as commented-out example entries and not enabled; the verifier prompt defines
the new blocker classes; an opt-in human_review.structure.removed_controls cap
exists with the four named test literals extended; ADR 0020, 0023 and 0025
are amended and the index marks them. All eight acceptance criteria in the
spec must hold. If one run cannot hold everything, stop at the spec's stop
point with every check green and say which half is next.

Scope: only the paths the spec lists under "Allowed paths". No lane may be on
by default; nothing new is posted to GitHub. The only existing tests you may
edit are the four humanReview.structure deep-equal assertions the spec names
and the StructureSignals deep-equal at test/issue-108-size-crossings.test.mjs:260.
Do not edit scripts/, .github/, CHANGELOG.md or the manifests. Add no
dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; agent files
follow the untrusted-input block and sections of agents/structure-analyst.md;
comments explain why; no em or en dashes anywhere (the identity guard rejects
them); no hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
