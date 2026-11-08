# S02. Run provenance and the independence label

**Phase:** 0 (trust). **Depends on:** nothing. **Size:** about 150 source
lines, 180 test lines, one Orbit run. **Risk:** low (one additive migration).
Baseline `919d0fd` (1.21.1). Verified against the code on 2026-11-07.

## Why

A recorded run cannot say where it came from or what produced it.

- `review_runs` has no origin field. `RunDetail`, `RecordRunInput` and the
  `review_run_recorded` audit row carry nothing about whether the run came from
  the headless driver, the interactive slash command, `watch` or the Action
  (`plugins/review-voice/src/store/runs.ts:200-249`, `:375-412`, `:417-445`;
  `src/store/db.ts:16-27`). The only proxy is `stages[].model`, which the
  driver stamps and the slash command does not, and `explain` never prints it
  (`src/store/effort.ts:62-69`).
- Neither the plugin version nor the Claude Code version is recorded with a
  run (`src/version.ts:10-19` is used only by `--version`).
- `active_policy_versions_json` is always written as `[]` and never read
  (`runs.ts:388`), so a run cannot say which policy it ran under.
- `tokens` on `StageTiming` is never populated by the driver: the Claude CLI
  envelope is read for `is_error`, `result`, `structured_output` and
  `total_cost_usd`, and `usage` is ignored (`src/agents/claude-cli.ts:99-104`,
  `:147-149`); `account()` in the driver sums only cost, tool calls and files
  read (`src/review/driver.ts:184-198`). The slash command's `--stages` file can
  carry a `tokens` value (`commands/review.md:895`), so the field exists and is
  tested (`test/issue-41-analyst-effort.test.mjs:49-52`).
- The cost mode (fast, standard, thorough) lives in `plan.json` only.

The interactive command runs inside the user's Claude Code session, which may
be the session that wrote the change. The headless driver starts fresh
processes with no transcript. Nothing records which happened, so a reader of a
posted review cannot tell a self-check from an independent review. The product
specification this program draws on calls that distinction a hard label.

## Outcome

Every recorded run carries its origin, an independence label derived from it,
the plugin and Claude Code versions, the cost mode and the policy versions in
force. `explain`, `status` and the driver report print them. S09 renders the
label into the posted scope block.

## Design

### Data shape

```ts
interface RunProvenance {
  origin: 'driver' | 'interactive' | 'watch' | 'action';
  /** 'not-independent' when origin is 'interactive'; 'independent' otherwise. */
  independence: 'independent' | 'not-independent';
  pluginVersion: string;          // version.ts
  claudeVersion: string | null;   // first line of `claude --version`, trimmed; null when unknown
  mode: 'fast' | 'standard' | 'thorough' | null;  // the plan's mode; null for the slash command
  /** The active approved policy rows at record time: listPolicies(db).filter((p) => p.active). */
  policyVersions: { scopeType: string; scopeKey: string; policyId: string; version: number }[];
}
```

The label is derived in code from `origin` and nowhere else. `interactive`
means the review ran inside the host session that may have authored the
change, so it is `not-independent`. Every other origin runs fresh agents on a
committed head.

### Storage

One migration appended to the list in `src/store/db.ts`:
`ALTER TABLE review_runs ADD COLUMN provenance_json TEXT;` in the style of the
existing ones. One existing test needs a matching edit:
`test/human-review-complexity.test.mjs:367-393` rewinds a fully migrated store
to `schema_version = 8` (dropping only `complexity_json`) and reopens it, so
every later migration re-runs, and SQLite has no `ADD COLUMN IF NOT EXISTS`.
Its rewind step also drops `review_runs.provenance_json` before rewinding, as
it already drops `complexity_json`. `RecordRunInput.provenance?: RunProvenance` is optional: when
absent, `recordRun` writes NULL, so the 53 direct `recordRun` calls across 23
test files keep working unchanged; the `record` command always supplies it.
`runDetail` returns `provenance: RunProvenance | null` (null for rows recorded
before this change, and for malformed JSON, which is also reported on stderr
once). The `review_run_recorded` audit metadata gains `origin`.

`active_policy_versions_json` is filled with the same `policyVersions` array,
from `listPolicies(db).filter((p) => p.active)` in `src/policy/versions.ts`
(the rows `policy approve` or `policy rollback` activated; `policy show`
prints every version, so it is not the same list). It stops being a constant.

### Commands

- `record` gains `--origin <driver|interactive|watch|action>` (default
  `interactive`, because the slash command is the one caller that passes
  nothing), `--claude-version <text>` and `--mode <fast|standard|thorough>`.
  The plugin version is read in process. An origin outside the enum is a bad
  invocation (exit 2). `--claude-version` is kept only when it matches
  `/^[\w.\- ()]{1,100}$/`; anything else records null, the policy `cleanStages`
  applies to model names (`src/store/effort.ts:44-46`).
- `review` gains `--origin <watch|action>` (default `driver`). The driver
  passes it to `record` with the plan's mode and the Claude version it reads
  once per run by running `claudeBin(deps.env ?? process.env)` (the existing
  `REVIEW_VOICE_CLAUDE_BIN` seam in `src/agents/claude-cli.ts:95-97`) with
  `--version` through `execFileSync`, first line trimmed; any failure yields
  null.
- `watch` passes `--origin watch` to the child review, appended after
  `--expect-head <sha>` and before the optional `--post --recheck-thread` and
  `--mode` (`src/watch/review.ts:99-101`).
- `help.ts` lists `--origin <driver|interactive|watch|action>`,
  `--claude-version <text>` and `--mode <fast|standard|thorough>` in the
  `record` body and `--origin <watch|action>` in the `review` body.
  `test/seams.test.mjs:193` asserts that every flag an `RV <command>`
  invocation in `commands/review.md` names appears in `--help` (`help.ts:909`
  concatenates every command body), so the `commands/review.md` note needs
  those entries.
- `explain` prints one line after the scope line, exactly:
  `Provenance origin <origin> (<label>), plugin <v>, claude <v or unknown>, mode <mode or unknown>, policy <scopeType>/<scopeKey> v<n>[, ...]` with
  `policy none` when the list is empty, and `Provenance not recorded` for a
  run without provenance.
- `status` appends `origin <origin> (<label>)` to the end of its existing
  last-review line, so the count and ids keep their position.
- The driver's `ReviewReport` gains `provenance` and `reportText` prints the
  same `Provenance ...` line.
- `commands/review.md` documents `--origin interactive` on its `record` step
  (the default, so the text only has to say what it means).
- `docs/ARCHITECTURE.md` ("Storage layout" or "The review driver") documents
  the column and the label's derivation (a required edit, reviewer-checked).

### Tokens

`AgentResult` (`src/agents/types.ts:14-20`) gains `tokens?: number`.
`interpretEnvelope` in `claude-cli.ts` sets it to
`usage.input_tokens + usage.output_tokens` when both are finite non-negative
numbers (cache creation and cache read counts are not added), and leaves the
key absent otherwise, so existing deep-equal assertions on results keep
passing. `runner.ts` spreads the result and needs no change. The driver's
`account()` adds `result.tokens` to the stage's `tokens` the way it adds
`costUsd`. Never write zero for an unknown count. `runFake`
(`src/agents/fake.ts`) passes a fixture's `tokens` through when it is a finite
non-negative number (`{ "output": ..., "tokens": 1200 }`) and leaves the key
absent otherwise; the `fakes()` helper in `test/review-driver.test.mjs` gains
a way to write that field, so a driver test can prove the sum.

### Follow-up for a person (protected path)

`action.yml` should pass `--origin action`. Until then Action runs record
`driver`, which carries the same independence label, so nothing is wrong, only
less specific.

## Non-goals

- No posting of the label (S09 does that, behind a setting).
- No change to how policies are loaded or applied (S06).
- No session fingerprinting beyond the enum.

## Acceptance criteria

- AC-1. An old database migrates; a run recorded before the change reads
  `provenance: null`; `explain` prints `Provenance not recorded`; a direct
  `recordRun` call without `provenance` writes NULL; the rewind test in
  `test/human-review-complexity.test.mjs` passes with its stated extra drop.
- AC-2. `record --origin driver --mode standard --claude-version "2.1.319 (Claude Code)"`
  stores provenance with `independence: 'independent'` and the current plugin
  version; `record` with no `--origin` stores `interactive` and
  `not-independent`; `--origin other` exits 2; a `--claude-version` outside
  the pattern records null.
- AC-3. A driver test with fake agents and `REVIEW_VOICE_CLAUDE_BIN` set to a
  path that does not exist records `origin: 'driver'`, the plan's mode and
  `claudeVersion: null`; a second test points `REVIEW_VOICE_CLAUDE_BIN` at a
  stub script that prints `9.9.9 (Stub Code)` (as `test/agent-runner.test.mjs:62`
  does) and asserts that string is recorded.
- AC-4. `watch` spawns the child review with `--origin watch` in the stated
  position; the two `assert.deepEqual` argv assertions in `test/watch.test.mjs`
  (lines 632 and 641) are updated to include it.
- AC-5. `active_policy_versions_json` and `provenance.policyVersions` both
  equal the active policy rows at record time; with none active both are `[]`;
  an inactive version is not listed.
- AC-6. A unit test on `interpretEnvelope` with a canned envelope: a `usage`
  object with both counts populates `tokens` with their sum; an envelope
  without `usage` leaves the key absent; a driver test whose fixtures give two
  calls of one stage `tokens` 1200 and 300 (the challenge stage calls the
  challenger once per finding) records that stage with `tokens: 1500`, and a
  stage whose fixtures carry none has no `tokens` key.
- AC-7. `explain`, `status` and the driver report print the `Provenance` line
  exactly as specified, including the `policy none` and `unknown` forms; the
  `review_run_recorded` audit row carries `origin`.
- AC-8. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/store/db.ts`, `plugins/review-voice/src/store/runs.ts`,
`plugins/review-voice/src/store/effort.ts`, `plugins/review-voice/src/cli.ts`
(`record`, `explain`, `status`, `review` flags), `plugins/review-voice/src/review/driver.ts`,
`plugins/review-voice/src/agents/claude-cli.ts`, `plugins/review-voice/src/agents/types.ts`,
`plugins/review-voice/src/agents/fake.ts`, `plugins/review-voice/src/watch/review.ts`,
`plugins/review-voice/src/help.ts`,
`plugins/review-voice/src/version.ts`, `plugins/review-voice/commands/review.md`,
`docs/ARCHITECTURE.md`, `test/**`, `plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S02-run-provenance-and-independence.md
in this repository. Read that file first; it is the design and the acceptance
criteria. Read docs/ARCHITECTURE.md ("The review driver", "Storage layout") and
docs/adr/0021-agents-run-in-a-confined-headless-runner.md before changing code,
then plugins/review-voice/src/store/runs.ts (recordRun, runDetail),
plugins/review-voice/src/policy/versions.ts (listPolicies),
plugins/review-voice/src/agents/claude-cli.ts (interpretEnvelope, claudeBin) and
plugins/review-voice/src/review/driver.ts (account, record).

Outcome: every recorded run may store a provenance object (origin, independence
label derived from origin, plugin version, Claude Code version read through
claudeBin with --version, cost mode, the active approved policy rows) in a new
review_runs column, optional on recordRun and always supplied by `record`;
`record` and `review` take the flags the spec names; `watch` passes --origin
watch in the stated argv position; active_policy_versions_json holds the same
active rows; explain, status and the driver report print the exact Provenance
line the spec gives; AgentResult gains tokens from the envelope's usage, summed
into the stage, and never written as zero. All eight acceptance criteria in
the spec must hold.

Scope: only the files the spec lists under "Allowed paths". Do not edit
action.yml, scripts/, CHANGELOG.md or the plugin manifests. Add no dependency.
Append one migration; never edit an existing one. The only existing tests you
may edit are the two argv assertions in test/watch.test.mjs, the rewind step
in test/human-review-complexity.test.mjs and the fakes() helper in
test/review-driver.test.mjs, as the spec names them; help.ts gains the new
flags so test/seams.test.mjs keeps passing.

Conventions: follow CONTRIBUTING.md and the style of the surrounding code
(comments explain why, in full sentences; no hardcoded identities; no em or en
dashes anywhere, the identity guard rejects them).

Proof: after changing anything under plugins/review-voice/src, run `npm run
build` so plugins/review-voice/dist/review-voice.mjs is rebuilt; the dist-check
check fails otherwise. Run the test files you add or change with `node --test
<file>`; Orbit runs unit-tests, typecheck, build, dist-check, identity-guard and
action-pins on the whole tree.
```
