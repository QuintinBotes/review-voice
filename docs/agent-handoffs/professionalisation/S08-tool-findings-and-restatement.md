# S08. Tool findings: restatement, checks that did not run, tool versions

**Phase:** 3 (evidence made visible). **Depends on:** nothing. **Size:** about
170 source lines, 220 test lines, one ADR amendment; one Orbit run. **Risk:**
low. Baseline `919d0fd` (1.21.1). Verified against the code on 2026-11-07.

## Why

Static evidence is collected and then half used.

- Signals reach the analyst only. `evidence.json` is listed in the lane prompt
  (`plugins/review-voice/src/review/prompts.ts:103-107`) and nowhere else; the
  verifier, `check-candidates`, `score`, `verdict` and `post` never read it.
  No code compares a candidate's location or wording with a tool signal, so a
  model finding that restates a compiler error is caught only if the analyst
  obeys `review.md:259-260` ("a type error the compiler already reports does
  not need a review comment repeating it"). The repository already has the
  exact matcher shape for prior held findings: `matchHeld` (`src/cli.ts:4433-4455`:
  same path, line delta at most 2 as a literal, word overlap at
  `DUPLICATE_OVERLAP` imported from `score.ts`).
- Checks that did not run are inconsistent. `run.ts` lists every configured
  command in `didNotRun` when collection is disabled (`src/evidence/run.ts:24-26`),
  but under `REVIEW_VOICE_NO_COMMANDS=1` the driver writes an ad hoc
  `{ enabled: false, signals: [], didNotRun: [], skipped: 'REVIEW_VOICE_NO_COMMANDS' }`
  (`src/review/driver.ts:291-294`), so a watcher-run review cannot name what it
  skipped. A shell `command not found` is exit 127 with zero signals and is
  recorded as "ran" (`test/evidence.test.mjs:120-132`).
- The `evidence` CLI itself ignores `REVIEW_VOICE_NO_COMMANDS`; only the driver
  refrains from calling it (`src/cli.ts:2563-2580`), and a driver test pins
  that it never does (`test/review-driver.test.mjs:582-594`).
- No tool version is captured; `CommandOutcome` has none
  (`src/evidence/types.ts:16-24`). ADR 0003 forbids running anything the
  config did not list, so a version cannot be guessed from the command text.

The product specification this program draws on says models may not restate a
tool hit and that the audit record names tool versions.

## Outcome

A candidate that restates a static signal is held, visibly, as
`restates-tool`. Every review can say which configured checks ran, failed, or
did not run, and why. A check may record its tool's version when the
configuration says how.

## Design

### Restatement

`check-candidates --evidence <path>` reads `evidence.json`. The flag joins the
condition at `cli.ts:4662` that chooses the full `kept` report over the short
validity report, so `check-candidates --diff-file ... --evidence ...` alone
emits `kept`, `droppedAsRepeat`, `droppedAsHeld` and the new `droppedAsTool`
(always present, `[]` when nothing matched). For each kept candidate,
`matchSignal` applies `matchHeld`'s rule against every signal with a path:
same path, `|line delta| <= 2` (the literal `matchHeld` uses), and
`overlap(significantWords(claim + failure_mode), significantWords(signal.claim + signal.evidence)) >= DUPLICATE_OVERLAP`.
A match drops the candidate into `droppedAsTool[]` with the tool name, the
signal's line and its verbatim message.

The driver passes the flag beside `--thread` (`driver.ts:487-495`) and, in
the loop that already holds `droppedAsRepeat` entries (`driver.ts:536-547`),
holds each dropped entry with the candidate's own `path` and `line`,
`verdict: 'restates-tool'` (new `HeldVerdict`, added to `HELD_VERDICTS`),
`source: <tool name>`, `reason: 'line <signal line>: <message>'`,
`candidateId` and `text: claim`; the signal's line lives in the reason, never
in `line`, so `heldForRecord` keeps it. `record --held` stores it, and
`explain` needs no change: its existing held line prints
`[restates-tool] path:line  tool - line N: message`. `restates-tool` is not
added to `carriedHeldFindings` (`cli.ts:4379-4386`): the tool reports the
defect again at the next head, so nothing needs carrying. The slash command's
`review.md` step 2 documents the flag and the held list.

A dropped candidate is not lost: it is in `held`, and S09's scope block counts
it and names the check's signal count, so the reader knows the tool flagged
it.

### What did not run

`didNotRun` stays `string[]` (`test/evidence.test.mjs:49` and `:139` pin it).
`EvidenceReport` gains a top-level `skipped?: string`. Under
`REVIEW_VOICE_NO_COMMANDS` the driver must not call `evidence`
(`test/review-driver.test.mjs:582-594` pins that `$ review-voice evidence` is
absent from `commands.log`); it reads the configured names from `context.json`,
which it writes one line earlier (`driver.ts:290`) and which carries
`staticEvidence.commands[].name` (`cli.ts:897`), and writes
`{ enabled: false, signals: [], commands: [], didNotRun: <every configured name>, skipped: 'REVIEW_VOICE_NO_COMMANDS' }`.
The `evidence` command itself refuses to spawn when the variable is set and
writes the same report, so a caller outside the driver cannot run repository
commands by accident. A command whose exit code is 126 or 127 keeps its real
`exitCode`, gains `unavailable: 'not found or not executable (exit N)'`, and
is listed in `didNotRun` as well as in `commands`; `test/evidence.test.mjs:120-132`
is updated to assert `unavailable` and `didNotRun` and its comment corrected.

### Tool versions

`static_evidence.commands[]` gains an optional `version: <command>` string.
`collectEvidence`'s options gain `spawn?: typeof spawnSync` (default
`spawnSync`), the test seam. When `version` is present, `run.ts` spawns it
with the same cwd, timeout and output cap as the check, trims the first
stdout line to 80 code points through a small sanitiser in `run.ts` that
strips control, bidi and zero-width characters (mirroring `verdict.ts:308-320`),
and records it as `CommandOutcome.version`. Without the key nothing runs and
the field is absent. A version command that errors, times out, exits non-zero
or prints an empty first line records no `version` and nothing else; it never
adds to `didNotRun` or `signals`. ADR 0003 gains an amendment: a configured
version command is configuration, so running it keeps "detection suggests,
configuration enables".

## Non-goals

- No posting of tool output (S09 renders the checklist, behind a setting).
- No new adapters.
- No change to how signals reach the analyst.

## Acceptance criteria

- AC-1. `check-candidates --diff-file ... --evidence <file>` alone emits the
  full report; it drops a candidate at the same path within two lines of a
  signal with overlapping wording into `droppedAsTool`, naming the tool and
  message; a candidate on the same line with unrelated wording is kept; a
  signal with no path matches nothing.
- AC-2. The driver passes `--evidence`, holds each dropped candidate as
  `restates-tool` with the fields specified, `record --held` stores it, and
  `explain` prints it with the existing held line.
- AC-3. Under `REVIEW_VOICE_NO_COMMANDS=1` the driver's `evidence.json` lists
  every configured command in `didNotRun` with the top-level `skipped`, and
  `commands.log` still has no `evidence` line; the `evidence` CLI with the
  variable set spawns nothing and writes the same report.
- AC-4. A command exiting 126 or 127 keeps its exit code, is recorded as
  unavailable and listed in `didNotRun`; `test/evidence.test.mjs:120-132` is
  updated accordingly.
- AC-5. A unit test imports `collectEvidence` with a fake `spawn` and asserts
  one call per check without `version`, two with it, that the recorded
  version is the sanitised first line capped at 80 code points, and that a
  failing version command records nothing.
- AC-6. A test asserts `docs/adr/0003-*.md` contains a `## Amendment - 2026`
  heading and `docs/adr/README.md` marks its row amended;
  `config.example.yaml`, `help.ts` and `commands/review.md` document the flag,
  the held verdict and the version key (reviewer-checked).
- AC-7. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/cli.ts` (`check-candidates`, `evidence`),
`plugins/review-voice/src/review/driver.ts`, `plugins/review-voice/src/evidence/**`,
`plugins/review-voice/src/store/runs.ts`, `plugins/review-voice/src/policy/load.ts`,
`plugins/review-voice/src/help.ts`, `plugins/review-voice/templates/config.example.yaml`,
`plugins/review-voice/commands/review.md`, `docs/adr/0003-*.md`,
`docs/adr/README.md`, `docs/ARCHITECTURE.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S08-tool-findings-and-restatement.md
in this repository. Read that file first. Read
docs/adr/0003-static-analysis-adapters.md, plugins/review-voice/src/evidence/run.ts,
plugins/review-voice/src/evidence/types.ts, the matchHeld helper and
checkCandidatesCommand in plugins/review-voice/src/cli.ts, and in
plugins/review-voice/src/review/driver.ts the evidence branch, the
droppedAsRepeat loop in the candidates stage (where the new restates-tool hold
goes) and the hold closure in score() for the held entry's field shape.

Outcome: `check-candidates --evidence <path>` drops candidates that restate a
static signal (same path, within two lines, overlapping wording) into
droppedAsTool and emits the full report with that flag alone; the driver holds
them as restates-tool with the candidate's own path and line; under
REVIEW_VOICE_NO_COMMANDS the driver reads the configured names from
context.json and both it and the `evidence` command write a report whose
didNotRun names every configured command with a top-level skipped, spawning
nothing; exit 126 and 127 keep their code, gain unavailable and join
didNotRun; collectEvidence takes a spawn seam and an optional per-command
`version` setting records the tool's sanitised version line; ADR 0003 is
amended and the index marks it. All seven acceptance criteria in the spec must
hold.

Scope: only the paths the spec lists under "Allowed paths". No new adapter, no
change to the analyst prompt, no GitHub write. Do not edit scripts/, .github/,
CHANGELOG.md or the manifests. Add no dependency. The only existing test you
may edit is test/evidence.test.mjs:120-132 as the spec says.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
