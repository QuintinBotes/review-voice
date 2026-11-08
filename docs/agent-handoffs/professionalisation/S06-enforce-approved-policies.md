# S06. Approved policies are enforced, keyed by rule

**Phase:** 2 (the learning loop closes). **Depends on:** S02
(`active_policy_versions_json` and `RunProvenance.policyVersions`). **Size:**
about 320 source lines, 320 test lines, one new ADR; one Orbit run, two with
the stop point below. **Risk:** medium. This changes what a review posts once
a policy is approved, which is the intended behaviour and has never happened
before. Baseline `919d0fd` (1.21.1). Verified against the code on 2026-11-07.

## Why

The learning loop is open at the end. Review Voice ingests history, compiles
proposals, and asks the owner to approve them, and an approved policy then
changes nothing:

- Approved `policies` rows are never loaded as a layer. `loadConfig` builds
  layers from the baseline file (`plugins/review-voice/src/policy/load.ts:809-810`)
  and `.review-voice/config.yaml` (`:788-791`) only; `FROM policies` appears
  only in `versions.ts` for list, approve and rollback.
- `resolvePolicy` is called only by `context`, which prints the result
  (`src/cli.ts:885-910`). No stage, scorer or prompt reads
  `suppressedPatterns`, so there is no enforcement point.
- Rules are prose. `compileProposals` keys buckets by `kind:category`
  (`src/policy/compile.ts:114-130`) and renders them to sentences in
  `suppressed_patterns` (`versions.ts:32-36`); `policy.schema.json:43` types
  that field as `string[]`. A finding carries `category` and `lane`
  (`src/store/runs.ts:23`, `:42`), and candidates keep `blocker_class`
  (`runs.ts:318-323`), but no stable rule identifier exists.
- `review_runs.active_policy_versions_json` is always `[]` (`runs.ts:388`);
  S02 fills it.

The README promises rules "you approve before they take effect" and a
"policy version [that] can be rolled back". Both are true and neither matters
until a rule can be applied. ADR 0006 warned that `suppressed_patterns` "is
one line away from 'never mention authentication'"; the warning is in a
comment today (`load.ts:523-528`) and in no check.

## Outcome

An approved suppression holds matching findings at scoring time, visibly, with
a held verdict `explain` shows. Rules are keyed by a stable `rule_id`, and a
suppression can never silence the categories that name a security breach or a
trust boundary.

## Design

### Rule identity

```ts
/** `${category}:${lane}` or `${category}:${lane}:${blocker_class}` when the candidate claimed one. */
type RuleId = string;
```

`assignIds` in `runs.ts` copies `blocker_class` from the candidate hint onto
`StoredFinding` and derives `ruleId`. `record`, `explain` and `status` print it.
`postedBreakdown` in `src/store/outcomes.ts` gains a `byRule` map read from
each finding's `ruleId`, printed by `evaluate --json` as
`posted_breakdown.by_rule` beside `by_severity` and `by_lane`
(`evaluateCommand` maps the keys explicitly, `cli.ts:1383-1385`).
`test/outcomes.test.mjs:261` pins the empty breakdown as
`{ bySeverity: {}, byLane: {} }`; update that assertion to
`{ bySeverity: {}, byLane: {}, byRule: {} }`.

### Policy artifact

`policy.schema.json` gains `suppressions` under `policy`, beside
`suppressed_patterns`, and `rule_id` as an optional property of
`provenance.items`. `toYaml` in `versions.ts` writes `suppressions:` at the top
level next to `suppressed_patterns:` as it writes the rest today, and the
loader reads it from there:

```yaml
suppressions:
  - rule_id: maintainability:structure:existing-helper-duplicate
    glob: null             # S07 fills path globs; null means everywhere
    reason: "owner dismissed 3 of 3 in October 2026"
```

`compileProposals` buckets by `kind` and `ruleId` (joined with a separator
other than `:`, or split with a limit, since a rule id contains colons); the
contradicting bucket is the opposite kind for the same `ruleId`. `label()`
(`compile.ts:79-95`) reads `ruleId` from the stored finding and, when it is
absent, derives `${category}:${lane ?? 'diff'}`, so feedback on findings
recorded before S06 (and the seeded fixture at
`test/issues-config.test.mjs:138-148`, which writes `category` only) still
forms rules; a finding with no `category` is still skipped. `ProposedRule`
keeps `category` (derived from the rule id) and gains `ruleId`, so the
existing assertions on `category` (`test/scoring.test.mjs:243-284`) keep
passing. Grouping by rule id is intended: three dismissals of `maintainability`
findings from two lanes form two rules, neither activatable. One `suppressions`
entry is emitted per suppress bucket; the prose `suppressed_patterns` are
still written for readers.

### Loading

`loadConfig(repositoryRoot, baselinePath?, path?, db?)` gains an optional
fourth argument. Only when a store is given does it load active `policies`
rows (`scope_type = 'global'`, `scope_key = 'owner'`, the literal `proposePolicy`
writes; `active = 1`; S07 widens the scopes) as layers, placed after the
baseline and before `.review-voice/config.yaml` so `context` lists layers
broadest to narrowest (resolution itself is order-independent, `schema.ts:53-78`).
`LoadedConfig` gains `suppressions` (the resolved list) and
`activePolicyVersions`. `context`, `score` and `record` open the store first
and pass it; `repositoryConfig()` in `cli.ts` takes the store. Tests that call
`loadConfig(dir)` without a store are unaffected. Because `context` now opens
the store, the `context` helpers in `test/policy.test.mjs:25-27`,
`test/issue-129-context-verification-wording.test.mjs:24` and
`test/issue-130-diff-structure-warnings.test.mjs:49` pass
`env: { ...process.env, REVIEW_VOICE_DATA_DIR: <fresh temp dir> }` (as
`test/issue-113-simplification-pass.test.mjs:201` does), so `npm test` never
opens the developer's store; new tests that exercise the loaded layer do the
same.

`record` keeps S02's fill of `active_policy_versions_json`; a test asserts it
equals the versions `loadConfig` loaded for that run.

### Enforcement

After the verifier's verdict is applied and before eligibility, `score` makes
a candidate ineligible with `reason: policy-suppressed:<rule_id>` when its
`ruleId` matches a resolved suppression and, when the suppression has a glob,
its path matches it (`governsAny` from `src/conventions/globs.ts`, import
only). Such candidates are listed in a new `suppressed[]` array (id, ruleId,
path, line, policy version) and in that array only: the `belowGate` filter
(`cli.ts:2100-2106`) excludes a candidate whose `gateOf` is `'policy'`, so the
driver holds it once. The driver holds each as `policy-suppressed` (new
`HeldVerdict`, added to `HELD_VERDICTS`), `record --held` stores them, and
`explain` prints them under "Held back" with the rule and version. The slash
command's `review.md` step that reads `score` output prints them locally like
`belowGate`.

A suppression is preference, not truth ("Precedent adjusts preference; it
never manufactures or unmakes truth", `docs/ARCHITECTURE.md:798`). It holds a
finding; it never deletes it from the record, and the owner can still post it:
`'policy'` joins `ownerPromotion.gate` (`src/scoring/score.ts:514`), `gateOf`
and `locallyListable` (`cli.ts:2274-2285`) recognise the `policy-suppressed:`
prefix so a suppressed candidate is listed and promotable, `applyOwnerPromotion`
records `gate: 'policy'` with the rule id, and `review.md`'s `--promote`
paragraph says a `suppressed[]` entry qualifies.

Precedence rule, enforced in code: a suppression never applies to a finding
whose category is `security`, `authorization`, `authentication`,
`data_integrity` or `trust_boundary`. The list is one exported constant,
`SUPPRESSION_EXEMPT_CATEGORIES`, beside `FIXED_BOUNDARY_CATEGORIES` in
`src/scoring/score.ts`; `score` and `approvePolicy` import it. `trust_boundary`
is included although it can name a non-security control boundary, because S10
and S11 file removed-control leads under it and a suppression that silenced
them would defeat those specs; the cost is one more category a suppression
cannot reach. `approvePolicy` refuses a proposal containing such a suppression
and names it. This makes ADR 0006's warning structural.

### Documentation

A new ADR, `0032-approved-policies-are-enforced-at-scoring.md` (the next free
number at implementation time), records the enforcement point, the rule
identity, the carve-out (citing ADR 0006) and the alternative rejected
(feeding suppressions to the analyst prompt, which would make them
unverifiable); `docs/adr/README.md` lists it. `docs/POLICY-FORMAT.md`
documents `suppressions`. `docs/ARCHITECTURE.md`: the paragraph at `:832-846`
("Rules are compiled by finding category, not by file path") says rules are
keyed by rule id (category, lane, blocker class) and applied in `score`.

## Non-goals

- No path-scoped proposals yet (S07).
- No change to the activation thresholds (three signals, one owner, no
  contradiction).
- No change to the analyst or verifier prompts.

## Acceptance criteria

- AC-1. Every finding recorded from a candidate has a `ruleId` in the form
  specified; `explain` prints it; `evaluate --json` carries
  `posted_breakdown.by_rule`.
- AC-2. A policy proposal built from three owner dismissals of
  `maintainability` findings from the `diff` lane carries one `suppressions`
  entry with `rule_id: maintainability:diff`, provenance naming it and
  `category: maintainability`; the prose pattern is still written; three
  dismissals split across two lanes produce two non-activatable rules.
- AC-3. After `policy approve`, `context` shows the suppression in the
  resolved policy and `loadConfig(..., db)` reports the loaded version;
  `loadConfig(dir)` without a store loads no policy rows.
- AC-4. On the next `score`, a verified candidate with that `ruleId` is
  ineligible with `policy-suppressed:maintainability:diff`, appears in
  `suppressed[]` and not in `belowGate`, is held once as `policy-suppressed`,
  and is absent from the rendered review; `explain` lists it with the policy
  version; `score --promote <id>` makes it eligible with `gate: 'policy'`.
- AC-5. `approvePolicy` refuses a proposal whose suppression names a rule in
  `SUPPRESSION_EXEMPT_CATEGORIES`, with a reason; a test that inserts an
  active `policies` row directly (bypassing `approvePolicy`) with
  `rule_id: security:diff` sees the candidate stay eligible and `suppressed[]`
  empty.
- AC-6. `active_policy_versions_json` on the recorded run equals the versions
  `loadConfig` loaded for that run.
- AC-7. `policy rollback` to a version without the suppression makes the next
  `score` eligible again.
- AC-8. A test reads `commands/review.md` and asserts it names `suppressed`
  and `policy-suppressed`; reads `docs/adr/README.md` and asserts it lists the
  new ADR with a file that exists; and parses `schemas/policy.schema.json`
  and asserts `properties.policy.properties.suppressions` and a `rule_id`
  provenance property exist. `docs/POLICY-FORMAT.md` and `docs/ARCHITECTURE.md`
  are updated as specified (reviewer-checked).
- AC-9. `npm run verify` passes with the rebuilt bundle committed.

Stop point for a two-run split: run one is rule identity, the artifact and
loading (AC-1 to AC-3, AC-6, the schema half of AC-8, AC-9); run two is
enforcement (AC-4, AC-5, AC-7, the ADR, review.md and docs halves of AC-8,
AC-9).

## Allowed paths

`plugins/review-voice/src/policy/**`, `plugins/review-voice/src/scoring/score.ts`,
`plugins/review-voice/src/store/runs.ts`, `plugins/review-voice/src/store/outcomes.ts`,
`plugins/review-voice/src/cli.ts` (`score`, `record`, `explain`, `status`,
`context`, `evaluate` (the `--json` breakdown only), `calibrate`, `policy`,
`repositoryConfig`, and the `gateOf`, `locallyListable` and
`applyOwnerPromotion` helpers),
`plugins/review-voice/src/review/driver.ts`, `plugins/review-voice/src/help.ts`,
`plugins/review-voice/schemas/policy.schema.json`, `plugins/review-voice/commands/review.md`,
`plugins/review-voice/skills/review-voice-policy/SKILL.md`,
`docs/POLICY-FORMAT.md`, `docs/ARCHITECTURE.md`, `docs/adr/0032-*.md` (new),
`docs/adr/README.md`, `test/**`, `plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S06-enforce-approved-policies.md
in this repository. S02 is already on the base branch. Read the spec first,
then docs/ARCHITECTURE.md ("Scoring and activation", "Policy resolution"),
docs/POLICY-FORMAT.md, docs/adr/0006-team-governance.md,
plugins/review-voice/src/policy/compile.ts, plugins/review-voice/src/policy/versions.ts,
plugins/review-voice/src/policy/load.ts, plugins/review-voice/src/policy/schema.ts
(resolvePolicy), plugins/review-voice/src/scoring/score.ts
(FIXED_BOUNDARY_CATEGORIES, ownerPromotion) and the gateOf, locallyListable and
applyOwnerPromotion helpers in plugins/review-voice/src/cli.ts.

Outcome: findings carry a stable ruleId (category:lane[:blocker_class]) and
evaluate --json breaks posted outcomes down by rule; policy artifacts carry a
structured suppressions list keyed by rule_id that compileProposals fills,
bucketing by kind and rule id; loadConfig takes an optional store and, only
then, loads active approved policies as layers; `score` holds a matching
verified finding as policy-suppressed (new held verdict), lists it in
suppressed[], and lets `--promote` post it; a suppression can never apply to
the categories in a new exported SUPPRESSION_EXEMPT_CATEGORIES constant
(security, authorization, authentication, data_integrity, trust_boundary) and
approvePolicy refuses one that tries; a new ADR records the decision citing
ADR 0006 and docs/adr/README.md lists it. All nine acceptance criteria in the
spec must hold. If one run cannot hold everything, stop at the spec's stop
point with every check green and say which half is next.

Scope: only the paths the spec lists under "Allowed paths". Do not change the
activation thresholds, the analyst or verifier prompts, or any GitHub write.
Do not edit scripts/, .github/, CHANGELOG.md or the manifests. Add no
dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities. Write the ADR in the format of the existing ones.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
