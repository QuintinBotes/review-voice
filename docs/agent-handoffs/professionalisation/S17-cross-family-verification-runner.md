# S17. Cross-family verification as a first-class runner

**Phase:** 6 (market additions, after the program's phases 0 to 5; third of
the ten in `GOAL.md`'s order, after S15 and S16). **Depends on:** S02 (provenance), S05
(`challenge_hold_rate` and the `--json` top-level keys), S08 (the first
ADR 0003 amendment) and S09 (the scope block renders the family). **Size:**
about 650 source lines (part A about 370, part B about 280), 620 test lines,
one new ADR, three ADR amendments; two Orbit runs (part A, part B).
**Risk:** medium. A configured runner is a second
place a command from configuration runs, so it is a configured command in the
sense of ADR 0003 and is gated like one; nothing runs until a repository
writes it down, and a runner that cannot run holds rather than passes.
Baseline `11e6f69` (S01, S02, S03 and S13 merged). Verified against the code
on 2026-11-08, and the S05 and S09 names (`challengeCounts`, `stage_seconds`,
`scopeBlock`, `test/scope-block.test.mjs`) at `3fb8443`, the S11 branch tip
that carries them; after S05, S08, S09 and S11 locate code by function name,
and once S12 has moved `cli.ts`, find the command handlers in `src/cli/`.

## Why

Review Voice already says the right thing about correlated error. The second
pass exists because "a verifier from the same family shares the analyst's blind
spots" (`plugins/review-voice/src/verify/external.ts:159-171`,
`docs/ARCHITECTURE.md` "Second-pass verification"), and the challenger exists
because the verifier and the second pass "both start from the analyst's
framing" (ADR 0024). The external survey in the program README measured the
cost of ignoring it, about eight points of high-severity recall when a model
reviews its own diffs, and the market research report (section 4.2, item 3)
finds Greptile's Model Inversion and Copilot's Max level doing cross-family
review as a rule. Review Voice does it by accident of configuration, and only
half way:

- The runner seam has one real backend. `runAgent`
  (`src/agents/runner.ts:35-70`) dispatches to `runFake` when
  `REVIEW_VOICE_FAKE_AGENTS` is set and to `runClaudeCli` otherwise; `AgentSpec`
  (`src/agents/types.ts:1-12`) has no field that could name another family.
  The challenger therefore always runs on Claude, whatever wrote the change.
- The second pass is a shell string. `verification.command` is run through
  `spawnSync(command, { shell: true })` (`external.ts:181-195`), the one place
  the plugin runs a configured string through a shell, while the agent runner
  passes an argument array and the absence guard does so on purpose
  (`docs/THREAT-MODEL.md` 3b). Its verdicts carry a free-text `verifier` name
  (`src/verify/types.ts:43`), so nothing can group them by family.
- Provenance does not know the family. `RunProvenance`
  (`src/store/runs.ts:226-236`) records origin, versions, mode and policy
  rows; the independence label is derived from origin alone (`:214-216`). A
  run whose challenger ran on another family looks exactly like one that did
  not.
- `evaluate` cannot say whether a second family earns its cost.
  `computeMetrics` (`src/evaluate/metrics.ts:52-252`) reads `output_json` but
  never `verdicts[]`, `tieBreaks[]` or the family of anything, and S05's
  `challenge_hold_rate` is one figure over every run.
- Nothing reads who wrote the pull request. `headOf`
  (`src/review/driver.ts:238-247`) reads the head and base shas from
  `/repos/{repo}/pulls/{n}` and drops `user`; `thread.json` keeps the
  description's author login only (`src/diff/thread.ts:135-137`). An
  agent-authored change is reviewed by the same family that may have written
  it, with no record that this happened.

`doctor` already reports `claude` as informational (`src/doctor.ts:57-67`,
`:70`), and ADR 0003 (amended by S08) fixes the posture every new command
must keep: detection suggests, configuration enables, never both.

## Outcome

A repository can name a second model family as a runner, in its configuration
and nowhere else. The second pass and the challenger can run on it, through
the one runner seam and without a shell. Every recorded run says which family
ran its second pass and its challenge, the scope block shows the challenge
family, and `evaluate` reports drop, downgrade, tie-break and hold rates per
family, printing `no data` where there is none. A repository may also ask that
a pull request an agent of one family authored is challenged by another family,
and when that family cannot run the findings are held, never passed. With no
`runners:` block nothing changes.

## Design

### Part A. The runner seam, configuration, the second pass and provenance

#### Families and the agent spec

`src/agents/types.ts` gains the closed enum and the runner shape:

```ts
export const FAMILIES = ['claude', 'codex', 'gemini'] as const;
export type Family = (typeof FAMILIES)[number];
export type ExternalFamily = Exclude<Family, 'claude'>;

/** A configured command that runs an agent on another model family (docs/adr/0021, amended). */
export interface RunnerSpec {
  family: ExternalFamily;
  /** argv, never a shell string; `{schema}`, `{output}` and `{cwd}` are replaced before spawn. */
  command: readonly string[];
  /** What the run records as the stage's model; the family name by default. */
  label: string;
}
```

`AgentSpec` gains `runner?: RunnerSpec`. Absent means the built-in Claude
backend, so every existing caller is unchanged.

#### The command backend

`src/agents/command-cli.ts` (new) exports
`runCommandCli(spec, prompt, cwd, addDirs, env): Promise<Omit<AgentResult, 'seconds'>>`
and the pure helper
`expandCommand(command, { schema, output, cwd }): string[]`, which replaces
each whole-argument token `{schema}`, `{output}` and `{cwd}` and leaves every
other argument as written. The backend:

- writes `schemaForRunner(spec.schema, spec.schemaDir ?? schemasDir())` to a
  file in a fresh `mkdtempSync(join(tmpdir(), 'rv-runner-'))` directory, and
  removes the directory when the process closes, whatever happened;
- spawns `command[0]` with the expanded arguments under the same watchdog
  wrapper, process group, timeout (`agentTimeoutMs`), 32 MiB stdout cap,
  SIGINT and SIGTERM ownership and stripped environment as the Claude
  backend. `claude-cli.ts` exports `childEnv`, `track`, `untrack` and
  `killTree` (`:17-23`, `:55-67`, `:252-260`) so both backends share one
  process discipline and `stopAll` kills either; no second copy;
- sends on stdin, in this order, the body of `agents/<name>.md` after its
  front matter, a blank line, `COMMAND_RUNNER_PREAMBLE`, a blank line and the
  prompt. The agent file is the system prompt; an external CLI has no
  `--system-prompt-file` the runner can rely on, so the text travels with the
  prompt;
- reads the answer from the `{output}` file when the command names one, else
  from stdout, and takes the last top-level JSON object in it, found by
  `jsonCandidates`, which is private in `src/verify/external.ts:102-135`
  today and is exported for the purpose. A codex `--json` stream is many objects and the last one is not the
  answer, which is why `{output}` exists;
- returns `{ ok: true, output, costUsd: null }` on exit code 0 with an object,
  and `{ ok: false, output: null, costUsd: null, error }` otherwise, where
  `error` is the first 500 characters of stderr, else stdout, else
  `<binary> exited with code N`, `timeout` or `output too large`, as
  `interpretEnvelope` does. No `tokens` key, ever, because no count was
  reported, and never zero. S05's cost figures therefore exclude a run with
  an external stage and say so in their basis.

`COMMAND_RUNNER_PREAMBLE` (in `runner.ts` beside `RUNNER_PREAMBLE`) reads:
`This run is read-only. Read files under the working directory, which is the pull request head, and under the directories named below; change nothing, run nothing from the repository, and use no network. Answer with one JSON object matching the schema you were given, and nothing after it.`
followed by `Also readable: <addDirs>` when there are any. It states the
confinement the sandbox flags in the configured command enforce; the runner
cannot narrow an external CLI's tools the way `runnerTools` narrows Claude's,
and the ADR amendments below say so.

`runAgent` (`runner.ts:35-70`) chooses the preamble from `spec.runner`
before the fake dispatch, so the fake records the text the real backend would
have sent, then dispatches: `REVIEW_VOICE_FAKE_AGENTS` first, as today; then
the `REVIEW_VOICE_AGENT_RUNNER=fake` guard; then, when `spec.runner` is set,
`ok: false` with `REVIEW_VOICE_NO_COMMANDS=1 keeps the configured <family> runner from running`
if `env` carries `REVIEW_VOICE_NO_COMMANDS=1`, else `runCommandCli`; else
`runClaudeCli`. The driver checks the variable first (below), so the seam's
refusal is the backstop that keeps any other caller from running a configured
command the variable forbids. `runFake` (`fake.ts:25-28`) adds
`runner: { family, label }` to `<name>.<n>.spec.json` only when the spec has
one, so existing `spec.json` assertions hold.

#### Configuration

`runners:` becomes a top-level key (`KNOWN_TOP_LEVEL`,
`src/policy/load.ts:619`). `LoadedConfig` gains

```ts
runners: {
  external: Partial<Record<ExternalFamily, { command: string[]; timeoutSeconds: number; label: string }>>;
  use: { challenge: Family; agentAuthoredChallenge: Family | null };
};
```

seeded as `{ external: {}, use: { challenge: 'claude', agentAuthoredChallenge: null } }`
beside the other defaults (`load.ts:694`). Parsing, each failure a warning in
the style of `readCostMode` (`:169-194`) and the entry dropped:

- `runners.<family>` for `codex` and `gemini`; a `claude` block warns
  `runners.claude: claude is the built-in runner and takes no command`; an
  unknown family warns and is ignored.
- `command` must be a non-empty list of non-empty strings whose `{...}`
  tokens are only `{schema}`, `{output}` and `{cwd}`. A string warns
  `runners.<family>.command must be a list of arguments, not a shell string; ignoring it`.
- `timeout_seconds` is a positive integer (`positiveInt`), default 600, the
  runner's `DEFAULT_AGENT_TIMEOUT_MS`.
- `label` must match the model-name pattern `cleanStages` applies
  (`src/store/effort.ts:44`); default the family name.
- `runners.use.challenge` is one of `FAMILIES` (default `claude`);
  `runners.use.agent_authored_challenge` is one of `FAMILIES` or absent
  (default null). Either naming an external family with no `runners.<family>`
  block warns and keeps the default.
- When `runners.use.challenge`, `runners.use.agent_authored_challenge` or
  `verification.runner` names an external family and
  `watch.run_repository_commands` is false, one warning says that watched
  reviews will skip the second pass and hold every challenged finding, because
  `REVIEW_VOICE_NO_COMMANDS=1` keeps a configured runner from running.

`verification:` (`load.ts:45-61`, `:788-800`) gains two optional keys.
`runner: <external family>` makes the second pass run `runners.<family>`:
`config.verification.command` becomes that block's argv and
`timeoutSeconds` defaults to its timeout; a string `command` beside it is
ignored with a warning, and a `runner` with no matching block warns and leaves
the pass disabled with `howToEnable`. `family: <family>` labels a hand-written
`command` so its verdicts can be grouped; `runner` implies it. The
`verification` type's `command` becomes `string | readonly string[]` and
gains `family?: Family`.

`templates/config.example.yaml` documents the block, commented out, beside
`verification:` (`:184-214`), with the codex example marked as one the
operator checks against the installed codex version, since no codex command
line was verified for this spec (the only codex example today,
`codex exec -s read-only` in `docs/ARCHITECTURE.md` "Second-pass
verification", carries no such note). S16 adds a `reproduction:` block
with its own `runners` list before this spec; that list names commands that
run a reproduction file and has nothing to do with the top-level `runners:`
block here.

```yaml
# runners:
#   codex:
#     command: [codex, exec, --sandbox, read-only, --output-schema, "{schema}", --output-last-message, "{output}", -]
#     timeout_seconds: 600
#     label: codex
#   use:
#     challenge: claude
#     agent_authored_challenge: codex
```

and `verification:` gains `# runner: codex` and `# family: codex` lines. The
`watch.run_repository_commands` comment (`:263-265` on `main` at `b91a3e2`,
which S16 extends with "and reproductions" first) and
`src/watch/config.ts:10` name runners beside the static evidence and
second-pass commands. The example still loads with no warnings
(`test/issues-config.test.mjs:38-47`).

#### The second pass without a shell

`Runner` (`external.ts:179`) takes `command: string | readonly string[]`.
`spawnRunner` keeps `shell: true` for a string, the existing behaviour, and
for a list runs `spawnSync(command[0], expandCommand(rest, ...), { shell: false, input, timeout, maxBuffer })`
with `{schema}` pointing at a temporary file holding `SECOND_PASS_SCHEMA`, a
small JSON Schema of `RawVerdict` declared in `external.ts` (`verdict` enum,
`confidence` 0 to 1, `reason`, `suggested_severity`, `decisive_evidence`),
`{output}` at a temporary file read after exit in place of stdout, and `{cwd}`
at the cwd. The stdin JSON (`external.ts:226`) is unchanged.
`VerifierConfig.command` (`external.ts:39`) takes the same union and gains
`family?: Family`, and the empty-command check at `:204` treats an empty list
as no command. Each `FindingVerdict` gains `family?: Family`, present when the
config knows it, and `VerificationReport` gains the same; the `verifier` name
stays.

#### The run records the families

`runs.ts` gains

```ts
export interface RunFamilies { secondPass: Family | 'unknown' | null; challenge: Family | null }
```

and `RunDetail` gains `families: RunFamilies | null`. It is stored beside the
provenance, not in it. The independence label keeps its two values,
`independent` and `not-independent`, derived from origin as S02 defines it;
a family is a separate recorded fact, never a third label value.
`RunProvenance`, `RunProvenanceInput` and
`storedProvenance` are unchanged, because five existing assertions
deep-equal a provenance object (`test/run-provenance.test.mjs:152`, `:164`,
`:397`, `test/review-driver.test.mjs:1082-1083`). `recordRun` writes it as a
`families` key inside `provenance_json` (no migration; `storedProvenance`
builds its result from the known keys and ignores it), returns it as
`families` beside `provenance`, and `record` prints it as a top-level
`families` key. A run recorded without provenance has no families.

`recordRun` (`runs.ts:506-516`) derives it, never trusts it: `secondPass` is
the `family` of the first entry of `input.verdicts` when that is a `Family`,
`unknown` when verdicts exist without one, `null` when there are none;
`challenge` is the `family` of the `input.stages` entry named `challenge`,
`claude` when that entry has no `family` (the only runner before this spec),
`null` when there is no such stage. `StageTiming` (`runs.ts:377-392`) gains
`family?: Family` and `cleanStages` (`effort.ts:36-59`) keeps it only when
it is in `FAMILIES`. A `storedFamilies` beside `storedProvenance`
(`runs.ts:272-318`) reads a row without the key as `families: null` and a
malformed value as null too, with the same once-per-run note on stderr. The
`Provenance` line and its exact tests (`test/run-provenance.test.mjs:298-325`)
are unchanged. A new `describeFamilies(families)` prints on its own line, in
the driver report immediately after the `Provenance` line (`driver.ts:1303`,
from a new `families` on the report), and in `explain` after the `Effort`
lines and any shallow-pass `Warning` (`cli.ts:3900-3903`), because
`test/run-provenance.test.mjs:309` pins the first `Effort` line directly after
`Provenance`:

```
Families second-pass codex, challenge claude
Families second-pass none, challenge none
Families not recorded
```

with `unknown` for a second pass whose family is not known and `none` for a
stage that did not run. `status` is unchanged. The driver's `account()`
(`driver.ts:331-347`) sets `stage.family` from the call's runner, `claude`
when none, so the slash command's `--stages` file may also carry it.

#### Detection

`runDoctor` (`doctor.ts:72-81`) adds `codex` and `gemini` to
`OPTIONAL_CHECKS` and reports each with `checkBinary`, probing the family
name on `PATH` (`codex --version`, `gemini --version`), with the detail
`found (used only when runners.<family> is configured): <version>` or
`not found on PATH (needed only when runners.<family> is configured)`. It
never runs `runners.<family>.command[0]`, because `doctor` runs in whatever
checkout it is started in, and a binary that configuration names runs only
where configuration enables it. Detection never writes configuration and never
enables anything.

#### Documents, part A

ADR 0003 gains a dated amendment naming `runners.<family>.command` (S16's
amendment to the same ADR lands before it, S20's after): a configured runner is a configured
command; its sandbox is the external CLI's own, chosen by the flags the
configuration names, which the runner cannot narrow; the exposure is that an
external agent may run repository code or reach the network whenever those
flags allow it, so the configuration names a read-only, no-network sandbox
and the operator checks it; it runs only when named in configuration, in the
detached worktree, and never under `REVIEW_VOICE_NO_COMMANDS=1`. ADR 0021
gains a dated amendment naming the second backend, the `runner` field, the preamble and the fact that `Read`,
`Grep`, `Glob` confinement applies to the Claude backend alone. `docs/adr/README.md`
marks both rows. `docs/ARCHITECTURE.md` "Agent runner", "Second-pass
verification" and "Storage layout", `docs/THREAT-MODEL.md` section 4 (one
paragraph on the runner as a second configured-command route) and
`docs/ACTION.md` (a configured runner must be installed by the workflow, or
its stages hold) are updated. `help.ts` documents `verification.runner` and
`family` in the `verify` entry (`:208-223`) and names runners in the `review`
entry's `REVIEW_VOICE_NO_COMMANDS` line (`:883-885`).

### Part B. The agent-authored rule, the challenger's family and measurement

#### Who wrote the change

`src/review/authorship.ts` (new, pure) exports

```ts
export interface Authorship {
  agent: boolean;
  /** The family the evidence names; `other` for an agent of no listed family. */
  family: Family | 'other' | null;
  evidence: string[];
}
export function detectAuthorship(input: { author: { login: string; type: string } | null; trailers: string[] }): Authorship;
```

Two deterministic signals, each a lead the evidence names:

- A `Co-authored-by` trailer value matching a family pattern marks the change
  agent-authored by that family. The patterns are a closed table in the
  module, matched case-insensitively on word boundaries: `claude` for the
  Claude family; `codex`, `chatgpt`, `openai` for the Codex family; `gemini`,
  `jules` for the Gemini family. A trailer that matches none is not a signal.
- A pull request author whose `type` is `Bot` marks the change agent-authored;
  the family comes from the same patterns over the login, else `other`.

The trailer decides the family when both fire; `evidence` lists both. Neither
signal gives `{ agent: false, family: null, evidence: [] }`. The table is a
starting point and the comment above it says so. Both signals are written by
the pull request's author, so they are a lead, never a trust decision. A
forged or missing trailer can only choose between the families the
configuration already names, and a family that cannot run holds the findings
and caps approval (below), so no trailer can pass a finding or earn an
approval.

`headOf` (`driver.ts:238-247`) also keeps `data.user.login` and
`data.user.type` as `run.pullAuthor` (null when absent). In `prep`, after
`thread` (`:439`) and before `plan` (`:453`), the driver reads trailers with
`git <SAFE_GIT> log --max-count=500 --format=%(trailers:key=Co-authored-by,valueonly,unfold) <base>..<head>`
in the clone, where `<base>` is `run.base`; when `run.base` is null the list
is empty and the evidence says `base not readable, trailers not read`. It
writes `authorship.json` and passes `--authorship <file>` to `plan`. The
interactive slash command is not changed; its origin is `interactive` and the
label already says so.

#### The plan names the challenge family

`PlanInput` (`plan.ts:30-37`) gains `runners?: LoadedConfig['runners']` and
`authorship?: Authorship`; `planCommand` (`cli.ts:1312-1318`) passes
`config?.runners` and the `--authorship <file>` it is given. `StagePlan`
(`plan.ts:18-28`) gains two top-level keys, so `test/plan.test.mjs:61-62`,
which deep-equals `plan.stages` and `plan.laneModels`, passes unchanged:

```ts
families: { challenge: Family; reason: string };
/** The configured external runners, echoed as `overrides` is, so the driver needs no second config read. */
runners: LoadedConfig['runners']['external'];
```

The rule in `resolvePlan`: the base family is `runners.use.challenge`
(`claude` when no config). When `runners.use.agent_authored_challenge` is set,
`authorship.agent` is true and `authorship.family` equals the base family, the
challenge family is the configured alternative and the reason reads
`agent-authored by <family>; challenged on <other> (runners.use.agent_authored_challenge)`.
Otherwise the reason is `runners.use.challenge` or `default`. A change
authored by an agent of another family already has a cross-family challenge
and is left alone; `other` and unknown families never trigger the rule, since
"different from" an unknown family is undefined. `fast` mode still runs the
challenge for any finding above a nit (`modelForFinding`, `plan.ts:100-111`),
on whichever family the plan names.

#### The driver runs the challenger on that family

`agent()` (`driver.ts:353-378`) gains an optional `runner?: RunnerSpec`
argument passed through to `runAgent`, and `account()` records its family.
`challenge()` (`:821-866`) reads `plan.families.challenge`. For `claude`
nothing changes. For an external family it builds the `RunnerSpec` from
`plan.runners[family]` and passes `runner.label` as the model to `agent()`.
When the family cannot run, every challenged finding is held through the
existing failure path (`:849-854`): the verdict is `partly`, `line_ok: true`,
`decisive_evidence: []` and the reason is
`challenger not run: REVIEW_VOICE_NO_COMMANDS=1 keeps the configured <family> runner from running`
or `challenger not run: runners.<family> is not configured`, with one note in
`run.notes`; an external runner that starts and fails twice holds through the
same path with `challenger not run: the configured <family> runner failed: <error>`.
A Claude challenger that fails twice keeps today's `challenger failed:`
reason. Nothing falls back to another family on its own, because a challenge
the configuration asked for and did not get is a missing gate, and ADR 0024
holds a finding whose gate is missing. The posted review is then the
validated text over the surviving findings, which may be
`No actionable findings.`, and the held findings appear under `held` and,
with S09 on, in the scope block's "held by the challenger" count.

A held finding does not change the event today (ADR 0024), so a review whose
every finding was held this way would approve. That turns a runner that
cannot run into a pass. `planFindings` (`src/publish/verdict.ts:218-266`)
therefore also sets `heldBackApproval` when the run's recorded `held` has an
entry whose reason starts with `challenger not run:`, so the event is COMMENT
at most, exactly as for an unverified held finding above a nit. No other
held finding changes the event.

#### The scope block shows the family

S09's `scopeBlock` adds ` Challenge: <family>.` to the origin sentence when
`run.families.challenge` is recorded and is not `claude`, and the JSON
trailer gains `"families": { "secondPass": ..., "challenge": ... }` when the
prose names a challenge family or `run.families.secondPass` is not null,
omitted otherwise. It is the trailer's last key, after S09's `checks`; S19,
which lands later, puts its `issues` key before it. Both appear only with `verdict.scope_block_models: true`,
because a family is a vendor choice and S09 shows those only on request.
Every S09 test records a Claude challenge stage and no second pass
(`test/scope-block.test.mjs:23-31` at `3fb8443`), so the exact block and
trailer assertions there hold unchanged. The idempotency key is taken before
the block is appended (S09), so nothing about posting changes.

#### `evaluate` reports per family

`metrics.ts` exports `byFamily(db)` and `evaluate --json` emits it as the
top-level key `by_family`, beside `posted_breakdown` and S05's
`stage_seconds`; it is not a `Metric`, so the two every-metric tests
(`test/evaluate.test.mjs:25-44`) pass unchanged. For each family that has
data:

| Figure | Definition |
|---|---|
| `second_pass.verdicts`, `dropped`, `downgraded`, `tie_breaks`, `runs` | over runs whose recorded `families.secondPass` is this family: `output_json.verdicts[]` entries, those with `outcome` `dropped`, those with `downgraded`, and `output_json.tieBreaks[]` entries marked `applied` (ADR 0014, amended); a second pass recorded as `unknown` is listed under `unknown` |
| `second_pass.drop_rate`, `downgrade_rate`, `tie_break_rate` | each count over `verdicts`; null when `verdicts` is 0 |
| `challenge.judged`, `held`, `runs`, `hold_rate` | S05's `challenge_hold_rate` counts (`challengeCounts`), restricted to runs whose recorded `families.challenge` is this family |
| `runs_without_families` | runs with no recorded `families` (recorded before part A, or without provenance), counted once beside the map |

A family with no second pass has `second_pass: null`, one with no challenge
`challenge: null`; a family with neither is not listed. The text output
prints a `by family` block after the metrics, one line per listed family:

```
by family
  codex   second pass 12 verdicts, drop 0.25, downgrade 0.17, tie-break 0.08, 3 run(s); challenge no data
  claude  second pass no data; challenge 20 judged, hold 0.10, 9 run(s)
```

and `by family  no data` when nothing is listed, with
`(N run(s) recorded before families were stored)` appended when
`runs_without_families` is positive. Every figure is reported, never a gate,
and nothing prints zero for an absence.

#### Documents, part B

A new ADR, `docs/adr/00NN-a-cross-family-runner-is-configured-never-detected-into-use.md`
(NN the next free number when the run starts, 0034 once S14's ADR has taken
0033; S21's ADR follows this one),
records the decision: one runner seam with one external backend, families
recorded beside the provenance, the agent-authored rule and its fail-closed
behaviour with the approval cap, the
per-family figures, and the alternatives (a model-name heuristic over
`review.models`, a silent fallback to Claude, a per-finding family). ADR 0024
gains a dated amendment naming `runners.use.challenge` and
`runners.use.agent_authored_challenge`: the challenger may run on a configured family, a
challenge the configuration required and could not get holds the finding,
and such a held finding keeps the review from approving, the one held
finding that changes the event.
`docs/adr/README.md` marks the rows. `docs/EVALUATION.md` "Reported, not
scored" gains rows for the per-family figures and a sentence that a single
family's rate on a small sample is a sample; `docs/ARCHITECTURE.md` "The
review driver" and "The independent challenge" and `docs/WATCHER.md` (the
cost-mode table's `challenge` row and the stage table's `challenge` row,
row 9 on `main` and row 10 once S16 has inserted `reproduce`) are updated.
`help.ts` documents `plan --authorship <file>` and the `evaluate` `by_family`
key.

### Order against the other market specs

S17 lands third of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"):

- After S15, whose `PlannedFindings.backing` this spec's `planFindings` cap
  sits beside.
- After S16, which adds the `reproduce` stage, the challenger's reproduction
  rows and the first market amendments to ADR 0003 and ADR 0024. The
  challenger this spec runs on another family reads that prompt unchanged.
- Before S19 and S24, which extend the scope block after this spec. S19's
  `issues` trailer key goes before `families`; S24's `belowTier` sits inside
  `held`.
- Before S22 and S24, which add the other approval caps of this phase: a
  path hold in `decide()` (S22) and verified findings below the posting tier
  (S24). Neither is a held finding in ADR 0024's sense, so this spec's ADR
  0024 sentence, that a `challenger not run:` hold is the one held finding
  that changes the event, stays true.
- S22's held queue lists the `challenger not run:` holds (verdict
  `challenge-partly`) with no promote command. S23 carries `by_family` through
  its report object as a JSON-only key.

## Non-goals

- No runner is on by default, no family is detected into use, and `doctor`
  only reports.
- No change to the Claude backend's confinement, the stage graph, the
  validator or the single GitHub write, and no change to the verdict beyond
  the one cap above, where a finding held because its challenge did not run
  keeps the event at COMMENT.
- No `gemini` example command ships; the enum carries the family so a run can
  be configured and labelled, and no command line was verified for this spec.
- No per-finding family. The challenge family is one per run, which is what
  the rule and the figures need.
- No model-name heuristic. `review.models` values stay opaque strings and
  never imply a family.
- The interactive slash command keeps its Claude subagents; its runs are
  `not-independent` already.
- No change to `agent` (the CLI command); the seam is proven through
  `runAgent` and the driver.
- Open question for the owner, not settled here. The `runners` block is read
  from wherever the run's configuration comes from, the base commit of an
  allowlisted repository included, and gated by `REVIEW_VOICE_NO_COMMANDS`
  exactly as `verification.command` is today. The owner may instead decide
  that `runners` is honoured only from the operator's own configuration
  (`--config` or `REVIEW_VOICE_CONFIG`); that would be a one-line check in
  `loadConfig` and an ADR sentence, and this spec takes the existing posture
  until the owner says otherwise.
- Open question for the owner. The family patterns in `authorship.ts` are a
  shipped table; the owner may prefer them configurable under
  `runners.families`, which this spec does not add.
- Open question for the owner. A configured external family that cannot run
  holds the challenged findings and caps the event at COMMENT. The
  alternatives are falling back to Claude with a note, which keeps reviews
  flowing at the price of a silent loss of independence, or stopping the
  review through S03's failure path, which posts nothing; this spec chooses
  the hold and records why in the new ADR.
- Open question for the owner. The challenge family shows in the scope block
  only with `verdict.scope_block_models: true`, as S09 treats model ids. The
  owner may prefer it always shown, since it is part of the independence
  story.

## Acceptance criteria

Part A:

- AC-1. `runAgent` with `spec.runner = { family: 'codex', command: [...] }`
  pointed at a stub binary (the `writeStub` shape at
  `test/agent-runner.test.mjs:53-104`) spawns it without a shell (an argument
  `$HOME` arrives literally); `{schema}` names a readable file whose content
  deep-equals `schemaForRunner(spec.schema)`, `{output}` names a file the
  backend reads after exit in place of stdout, `{cwd}` is the cwd; stdin is
  the agent body, `COMMAND_RUNNER_PREAMBLE` and the prompt in that order; the
  child environment carries no `GITHUB_TOKEN`, `GH_TOKEN` or `REVIEW_VOICE_*`
  key; the result is `ok` with the last JSON object, `costUsd` null and no
  `tokens` key; a non-zero exit, no object, a binary that does not exist and
  a timeout (the group is gone afterwards, as the existing timeout test
  checks) each give `ok: false` with the stated error; with
  `REVIEW_VOICE_NO_COMMANDS=1` in `env` and no fake directory the stub never
  starts and the result is `ok: false` with the stated reason;
  `REVIEW_VOICE_FAKE_AGENTS` wins over `spec.runner` and the fake's
  `.spec.json` carries `runner: { family, label }` while its `.prompt.txt`
  starts with `COMMAND_RUNNER_PREAMBLE`; the temporary schema directory is
  removed (`test/command-runner.test.mjs`, new).
- AC-2. `loadConfig` over YAML (as `test/plan.test.mjs` loads it) reads a
  valid `runners` block into the stated shape with the defaults; a string
  `command`, an unknown token, a `claude` block, an unknown family, a bad
  `label`, a `use` value naming an unconfigured family and
  `verification.runner` naming one each produce the named warning and the
  default; `verification.runner` sets the argv command and family, and a
  string `command` beside it warns; the `run_repository_commands` warning
  fires only when an external family is in use and the setting is false; the
  example config still loads with no warnings (`test/runners-config.test.mjs`,
  new; `test/issues-config.test.mjs` unchanged).
- AC-3. `verifyFindings` with an argv command runs it without a shell through
  `spawnSync`, with `{schema}` holding `SECOND_PASS_SCHEMA` and `{output}`
  read in place of stdout (a stub script), and each verdict carries the
  family; with a string command and `verification.family`, verdicts carry
  that family; with neither, no `family` key; the injected-runner fixtures in
  `test/verify.test.mjs:14-42` pass unchanged and new cases cover the three
  shapes.
- AC-4. `recordRun` derives `families` as specified from `verdicts` and
  `stages` (`codex`, `unknown`, `none` and `claude` for a challenge stage with
  no family), stores it in `provenance_json` and returns it beside
  `provenance`; `runDetail` reads a row recorded before the key, and a
  malformed value, as `families: null`; `record` prints the top-level
  `families` key; the driver report prints the `Families` line in each exact
  form on the line after `Provenance`, and `explain` prints it after the
  `Effort` lines; `cleanStages` keeps a `family` only from `FAMILIES`; every
  existing test in `test/run-provenance.test.mjs` and
  `test/review-driver.test.mjs` passes unchanged, the provenance deep-equals
  and the exact-line tests at `:298-325` included
  (`test/provenance-families.test.mjs`, new).
- AC-5. `doctor` prints an informational `codex` line and a `gemini` line,
  present (a stub named `codex` or `gemini` on a temporary `PATH`) or absent,
  and exits 0 either way, in the shape of `test/agent-runner.test.mjs:672-682`;
  with a repository config whose `runners.codex.command[0]` names a stub that
  records its calls, the stub is never run (new cases in
  `test/command-runner.test.mjs`).
- AC-6. `test/runners-docs.test.mjs` (new) asserts `docs/adr/0003-*.md`
  carries a `## Amendment - 2026-` section whose text names
  `runners.<family>.command` (S16's amendment there speaks of reproduction
  runners, so `runners` alone proves nothing) and `docs/adr/0021-*.md` one
  whose text mentions `runners`, and `docs/adr/README.md` marks both rows;
  `config.example.yaml` carries the commented `runners:` block and the two
  `verification` lines; `docs/ARCHITECTURE.md`, `docs/THREAT-MODEL.md`,
  `docs/ACTION.md`, `help.ts` and the two `run_repository_commands` comments
  are updated (reviewer-checked).

Part B:

- AC-7. `detectAuthorship` returns the specified result for a trailer naming
  each family, a `Bot` author with and without a family in its login, both
  signals with different families (the trailer wins and both are in
  `evidence`), a trailer naming no family, and neither signal
  (`test/authorship.test.mjs`, new).
- AC-8. In a scratch repository whose head commit carries
  `Co-authored-by: Claude Example <noreply@example.com>`, a driver run with
  fake agents writes `authorship.json` with `agent: true`,
  `family: 'claude'` and the trailer evidence; with no base readable the
  trailers are empty and the evidence says so; `headOf` keeps the author from
  the stub's `user` field (`test/review-driver.test.mjs`, new cases).
- AC-9. `resolvePlan` with `runners.use.challenge: codex` names `codex` with
  reason `runners.use.challenge`; with `agent_authored_challenge: codex` and
  an authorship of `claude` it names `codex` with the rule's reason; with an
  authorship of `codex`, `other` or null it names the base family; with no
  `runners` it names `claude` with reason `default`; `plan.runners` echoes the
  configured blocks; `plan --authorship <file>` reads the file and an
  unreadable one exits 2; every existing case in `test/plan.test.mjs` passes
  unchanged (new cases there).
- AC-10. A driver test with fake agents and `runners.use.challenge: codex`
  shows the challenger's `.spec.json` with `runner.family: 'codex'` and the
  recorded `challenge` stage with `family: 'codex'` and `model` equal to the
  label; the same configuration under `REVIEW_VOICE_NO_COMMANDS=1` holds
  every challenged finding as `challenge-partly` with the stated reason, posts
  nothing above a nit, records the note, and its verdict is COMMENT, against
  the APPROVE the same fixture gives when a Claude challenger refutes every
  finding (green CI, normal complexity); a configured family whose runner
  fails twice (a fake `challenger.json` carrying `error`) holds the same way
  with the runner-failed reason and the same cap; a Claude challenger that
  fails twice keeps its `challenger failed:` reason and its current event
  (`test/review-driver.test.mjs`, new cases).
- AC-11. Over a store with runs of known `verdicts`, `tieBreaks`, `scores`
  and `families`, `evaluate --json` carries `by_family` with the stated
  counts, rates and nulls and `runs_without_families`; the text block prints
  the stated lines and `no data` where there is none; a family with neither
  half is not listed; the two every-metric tests pass unchanged
  (`test/evaluate-by-family.test.mjs`, new).
- AC-12. With `verdict.scope_block: true`, `verdict.scope_block_models: true`
  and a run whose challenge family is `codex`, the block's origin sentence
  ends ` Challenge: codex.` and the trailer carries `families`; with
  `scope_block_models` false, or a `claude` challenge and no second-pass
  family, or no recorded `families`, neither appears and the trailer has no
  `families` key; every existing test in `test/scope-block.test.mjs` passes
  unchanged (new cases there).
- AC-13. New cases in `test/runners-docs.test.mjs` assert
  `docs/adr/0024-*.md` carries a `## Amendment - 2026-` section whose text
  names `runners.use.challenge` (S15 and S16 amend 0024 too), the new ADR
  exists and `docs/adr/README.md` lists it;
  `docs/EVALUATION.md` carries the per-family rows; `help.ts` documents
  `plan --authorship` and `evaluate`'s `by_family`; `docs/ARCHITECTURE.md`
  and `docs/WATCHER.md` are updated (reviewer-checked).
- AC-14. `npm run verify` passes with the rebuilt bundle committed.

Stop point for the two-run split: run one is part A (AC-1 to AC-6, AC-14);
run two is part B (AC-7 to AC-13, AC-14). Part A on its own changes nothing
for a repository without a `runners:` block and records `families` for every
new run.

## Allowed paths

`plugins/review-voice/src/agents/**`, `plugins/review-voice/src/verify/external.ts`,
`plugins/review-voice/src/verify/types.ts`, `plugins/review-voice/src/policy/load.ts`,
`plugins/review-voice/src/review/plan.ts`, `plugins/review-voice/src/review/driver.ts`,
`plugins/review-voice/src/review/authorship.ts` (new),
`plugins/review-voice/src/store/runs.ts`, `plugins/review-voice/src/store/effort.ts`,
`plugins/review-voice/src/evaluate/metrics.ts`, `plugins/review-voice/src/publish/verdict.ts`
(the scope block and the `planFindings` cap only), `plugins/review-voice/src/cli.ts`
(`plan`, `verify`, `record`, `explain`, `evaluate`, `doctor`; after S12, those
commands' modules under `plugins/review-voice/src/cli/`), `plugins/review-voice/src/doctor.ts`,
`plugins/review-voice/src/help.ts`, `plugins/review-voice/src/watch/config.ts`
(a comment), `plugins/review-voice/templates/config.example.yaml`,
`docs/ARCHITECTURE.md`, `docs/EVALUATION.md`, `docs/WATCHER.md`,
`docs/THREAT-MODEL.md`, `docs/ACTION.md`, `docs/adr/0003-*.md`,
`docs/adr/0021-*.md`, `docs/adr/0024-*.md`, `docs/adr/00NN-*.md` (new),
`docs/adr/README.md`, `test/**`, `plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal, part A

```
Implement part A of docs/agent-handoffs/professionalisation/S17-cross-family-verification-runner.md
in this repository. S02, S05, S08 and S09 are already on the base branch, as
are S15 and S16, so locate code by function name where the spec's line
numbers have moved. Read
the spec first, then docs/adr/0021-agents-run-in-a-confined-headless-runner.md,
docs/adr/0003-static-analysis-adapters.md (with every amendment, S16's included),
plugins/review-voice/src/agents/runner.ts, plugins/review-voice/src/agents/claude-cli.ts
(childEnv, WATCHDOG, track, untrack, killTree, interpretEnvelope),
plugins/review-voice/src/agents/fake.ts, plugins/review-voice/src/agents/types.ts,
plugins/review-voice/src/verify/external.ts (Runner, spawnRunner, jsonCandidates,
verifyFindings), plugins/review-voice/src/policy/load.ts (the verification block,
readCostMode, KNOWN_TOP_LEVEL), plugins/review-voice/src/store/runs.ts
(RunProvenance, describeProvenance, storedProvenance, recordRun, RunDetail,
runDetail, StageTiming), plugins/review-voice/src/store/effort.ts
(cleanStages), plugins/review-voice/src/doctor.ts, and the provenance
deep-equals in test/run-provenance.test.mjs and test/review-driver.test.mjs,
which must pass unchanged.

Outcome: src/agents/types.ts declares FAMILIES, Family, ExternalFamily and
RunnerSpec and AgentSpec gains an optional runner; a new
src/agents/command-cli.ts runs a configured argv without a shell, under the
same watchdog, process group, timeout, output cap and stripped environment as
the Claude backend (those helpers exported from claude-cli.ts, not copied),
replacing only the {schema}, {output} and {cwd} tokens, sending the agent
file's body, COMMAND_RUNNER_PREAMBLE and the prompt on stdin, and reading the
last top-level JSON object from the {output} file or stdout; runAgent chooses
the preamble from spec.runner before the fake dispatch and dispatches fake,
then the fake guard, then, for a spec with a runner, a refusal under
REVIEW_VOICE_NO_COMMANDS=1 or the command backend, then claude; runFake
records runner only when set; loadConfig reads a top-level runners block (external
families codex and gemini, each an argv command, timeout and label; use.challenge
and use.agent_authored_challenge) and verification.runner and
verification.family with every warning the spec names and the
run_repository_commands warning; verifyFindings runs an argv command through
spawnSync without a shell with SECOND_PASS_SCHEMA behind {schema} and labels
verdicts with a family; RunDetail gains families, derived in recordRun from
the verdicts and the challenge stage's family, stored as a families key in
provenance_json while RunProvenance keeps its shape, null for older rows, and
printed by record as a top-level key; a Families line follows the unchanged
Provenance line in the driver report and the Effort lines in explain;
cleanStages keeps a family from FAMILIES; doctor reports codex and gemini as
informational by probing the family name on PATH, never a configured binary;
ADR 0003 and ADR 0021 are amended and the index marks
them; config.example.yaml, ARCHITECTURE.md, THREAT-MODEL.md, ACTION.md and
help.ts are updated. Acceptance criteria AC-1 to AC-6 and AC-14 of the spec
must hold.

Scope: only the paths the spec lists under "Allowed paths". No runner may be
on by default; nothing is detected into use; nothing new is posted to GitHub.
Do not change the Claude backend's tools, flags or confinement, the stage
graph, the verdict or the validator. Edit no existing test assertion; add new
test files and new cases only. Do not edit scripts/, .github/, CHANGELOG.md
or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities; no real email address in a test (use example.com).

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```

## Orbit goal, part B

```
Implement part B of docs/agent-handoffs/professionalisation/S17-cross-family-verification-runner.md
in this repository. Part A is already on the base branch, as are S05, S09,
S15 and S16, so locate code by function name. Read the spec first, then
docs/adr/0024-an-independent-challenge-gates-every-posted-finding.md,
docs/adr/0025-cost-modes-choose-stages-and-models.md,
plugins/review-voice/src/review/plan.ts (StagePlan, PlanInput, resolvePlan,
modelForFinding), plugins/review-voice/src/review/driver.ts (headOf, the prep
stage around thread and plan, SAFE_GIT, account, agent, challenge, the report
lines), plugins/review-voice/src/evaluate/metrics.ts (computeMetrics, S05's
challengeCounts, challenge_hold_rate and stage_seconds),
plugins/review-voice/src/publish/verdict.ts (planFindings, S09's scopeBlock
and its trailer), test/scope-block.test.mjs, and the plan handler in
plugins/review-voice/src/cli.ts.

Outcome: a pure src/review/authorship.ts detects an agent-authored change from
Co-authored-by trailers and a Bot author with the closed family table the spec
gives; headOf keeps the pull request author and prep reads trailers over
base..head with SAFE_GIT, writes authorship.json and passes --authorship to
plan; StagePlan gains top-level families and runners (plan.stages unchanged,
so test/plan.test.mjs passes as it is) and resolvePlan applies the
agent-authored rule with the exact reasons the spec gives; the driver runs the
challenger on the plan's family through agent() and account(), holding every
challenged finding through the existing failure path with the stated
"challenger not run:" reasons when the configured family cannot run, fails
twice or REVIEW_VOICE_NO_COMMANDS=1 is set, never falling back on its own;
planFindings caps the event at COMMENT when the run holds a finding with that
reason; S09's scope block shows the challenge family and its trailer gains
families under the rule the spec gives, only with
verdict.scope_block_models: true; metrics.ts exports byFamily
and evaluate prints the by family block and the by_family JSON key with no
data where there is none and never zero; ADR 0024 is amended, the new ADR
exists and the index lists both; EVALUATION.md, ARCHITECTURE.md, WATCHER.md
and help.ts are updated. Acceptance criteria AC-7 to AC-14 of the spec must
hold.

Scope: only the paths the spec lists under "Allowed paths". The rule is off
unless runners.use.agent_authored_challenge is set; nothing new is posted to
GitHub and the idempotency key is unchanged. Edit no existing test assertion;
every existing test, test/scope-block.test.mjs included, passes unchanged.
Do not edit scripts/, .github/, CHANGELOG.md or the manifests. Add no
dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities; no real email address in a test (use example.com).

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
