# S12. Split `cli.ts` into command modules, one slice at a time

**Phase:** 5 (maintainability). **Depends on:** nothing, but run it last and
never concurrently with another spec that edits `cli.ts`. **Size:** about
5,300 lines moved, no behaviour change; nine Orbit runs (slices 0, 1, 2, 3, 4,
5a, 5b, 6a, 6b), each green on its own. **Risk:** low per slice, because every
slice is verified by the existing suite and the byte-compared bundle; the two
design points are module state and bundle size. Baseline `919d0fd` (1.21.1);
measure again before each slice, since every earlier spec adds to `cli.ts`.
Verified against the code on 2026-11-07.

## Why

`plugins/review-voice/src/cli.ts` is 5,329 lines: imports (10-170), module
state (173-200), about fifty command handlers and their private helpers
(250-4903), `main`, `agentCommand` and the dispatch switch (4904-5218),
`failureOf` and `runInProcess` (5225-5277), `reviewCommand` (5279-5320) and a
top-level bootstrap that runs `main` on import (5322-5329). Five cases already
call modules (`help`, `version`, `queue`, `watch`, `doctor`); the rest are
inline. `scoreCommand` alone is 580 lines and `recordCommand` 440.

A reader looking for one command reads past forty others. Every spec in this
program touches `cli.ts`, so every Orbit run competes for the same file.

## Outcome

`cli.ts` keeps the dispatch switch, `main`, `runInProcess`, `reviewCommand`,
the bootstrap and compatibility re-exports, at roughly 500 lines. Each command
lives in `plugins/review-voice/src/cli/<name>.ts`. Behaviour, output and exit
codes are unchanged, proven by the existing suite and the rebuilt bundle.

## Design

### Constraints the research established

- No command module may import `cli.ts`: importing it runs
  `await main(process.argv.slice(2))` at module top level (`cli.ts:5322-5329`)
  and creates a cycle. Shared helpers move out first.
- `let inProcess` (`cli.ts:200`) is the only mutable module state, written by
  `runInProcess` (`:5255`, `:5273`) and read by `githubClient`, `readStdin`,
  `postCommand` (`:1362`, two references) and `runInProcess` itself (`:5251`).
  An ESM importer cannot assign an imported `let`, so `cli/shared.ts` keeps
  the variable under its current name, `let inProcess: InProcess | null = null`,
  unexported, and exports `function inProcessState(): InProcess | null`
  and `function setInProcess(value: InProcess | null): void`. `githubClient`
  (`:203-205`) and `readStdin` (`:207-241`) move into `shared.ts` verbatim
  and keep reading `inProcess` directly. Exactly four lines of `cli.ts` change
  text, the only edits slice 0 may make to existing code: at `:1362`
  `inProcess?.fetchImpl` becomes `inProcessState()?.fetchImpl` and
  `inProcess.fetchImpl` becomes `inProcessState()!.fetchImpl`; at `:5251`
  `inProcess !== null` becomes `inProcessState() !== null`; at `:5255` the
  assignment becomes `setInProcess({ stdin: options.stdin ?? '', fetchImpl: options.fetchImpl })`;
  at `:5273` it becomes `setInProcess(null)`.
- `test/issue-52-command-help.test.mjs:27-33` extracts dispatched commands
  from `cli.ts` text with `^ {4}case '([a-z][a-z-]*)':`. The switch stays in
  `cli.ts` with that shape. Slice 0 hardens the test to fail when it finds zero
  cases, so the constraint is enforced rather than implied.
- Tests import five runtime symbols from `cli.ts`: `runInProcess`
  (`test/review-driver.test.mjs:14`), `diffSummary` (four tests), `emitDiff`
  (`test/issue-225-scoped-complexity.test.mjs:16`), `verificationProblem`
  (`test/lanes.test.mjs:16`) and `resolveOutPath` (a dynamic import in
  `test/output-paths.test.mjs:102`). `cli.ts` re-exports whichever move;
  `runInProcess` and the `CommandResult` type stay in `cli.ts`.
- `cli.ts:5113` passes `fileURLToPath(import.meta.url)` to `spawnReview`; the
  `watch` case body stays in `cli.ts`.
- New files use only erasable TypeScript syntax (tests import `src/*.ts` under
  Node's type stripping), `.ts` import extensions and `import type`
  (`verbatimModuleSyntax`), as `cli.ts` does today.
- Every slice rebuilds `dist/review-voice.mjs`; `check:dist` fails otherwise.
- `docs/ARCHITECTURE.md:101` says `runInProcess` lives in `src/cli.ts`; it
  still will.

### Bundle size

Orbit counts added plus deleted lines over every text file, the bundle
included. A move costs twice its source lines in `src` and about twice its
code lines in `dist`, and esbuild emits modules in first-import order from
`cli.ts`, so when the last `cli.ts` import of a module leaves with the moved
code, that whole module changes position in the bundle and shows as deleted
plus added lines nobody edited. Two rules keep most modules in place: the new
`./cli/*.ts` import lines are appended at the end of `cli.ts`'s import block,
and each command module lists its imports in the same relative order `cli.ts`
has today. Even so, slices 5 and 6 are split into one command each, and slice
0's run report is the measurement: its `changed_lines` figure calibrates the
remaining slices. A person may also raise `scheduler.hard_limits.changed_lines`
in `.orbit/config.yaml` for the S12 runs (the README names this as an owner
decision).

### Layout

`plugins/review-voice/src/cli/<name>.ts`, one file per command or per tightly
paired family, exporting `<name>Command(argv)` with the signature the dispatch
case calls today. `cli/shared.ts` holds the helpers. The name `cli/` is chosen
over `commands/` because `plugins/review-voice/commands/*.md` already holds
the Claude Code slash commands and one word with two meanings in one plugin
misleads a reader; the existing `queue/command.ts` and `watch/command.ts` stay
where they are. The README records this as an owner decision; if the owner
prefers the `src/<area>/command.ts` precedent, substitute it throughout before
slice 0.

### Slices

Each slice is one Orbit run and moves code verbatim; comments move with the
code; nothing is renamed or reformatted beyond what the move requires. Handlers
and helpers that S01 to S11, S13 and S14 add to `cli.ts` move with the command
they belong to (`recall` from S04 joins slice 1).

| Slice | Moves | Notes |
|---|---|---|
| 0 | into `cli/shared.ts`: `flag`, `numericFlag`, `readStdin`, `STDIN_INPUT`, `noFindingsHint`, `githubClient`, `inferRepository`, `remoteRepositories`, `repositoryConfig`, `resolveOutPath`, the `inProcess` state behind the getter and setter, the verification-shape helpers `refExists`, `VERDICT_KEYS`, `verificationProblem`, `isMissingContext`, `verdictList`, and the list caps `LIST_CAP`, `EXCERPT_CAP`, `TEXT_CAP`, `CLAIM_CAP` with `boundLists` and `containsCut` (the comment at 1498-1505 goes above `boundLists`); `cli.ts` re-exports `resolveOutPath` and `verificationProblem`; harden the issue-52 test; add `test/cli-modules.test.mjs` (no `cli/*.ts` file imports `cli.ts`) | ~230 lines |
| 1 | `redact`, `draft`, `post-check`, `discover`, `evidence`, `calibrate`, `retrieve`, `feedback`, `decline`, `anchors`, `context`, `validate-output`, `follow-ups`, `purge`, `policy`, `evaluate`, `conventions`, `check-intent`, `recall` | shared helpers only, ~750 lines |
| 2 | `diff` and `diff --pr` with `EmittedDiff` (type), `diffSummary`, `markedGenerated`, `emitDiff`, `readFilesAndDiff` into `cli/diff.ts` (exports `EmittedDiff`, `markedGenerated`, `readFilesAndDiff` for plan and lanes; `cli.ts` re-exports `diffSummary` and `emitDiff`); `thread`, `symbols` into their own | ~450 lines |
| 3 | `plan` and `lanes` (`asLevel`; import `readFilesAndDiff` from `cli/diff.ts`); `verdict` and `post` (`ReviewTarget`, `reviewTarget`); `consent-plan` and `sync` (`namedRepositories`, exported for `status`); `outcomes` | ~480 lines |
| 4 | `check-verification` with `keptCandidateIds`; `check-simplification`; `verify`; `reconcile`; `challenge`; `reanchor`; `agent`; `status` (`distinctReviewers`); `explain` (exports `describeReviewScope` and `reviewScopeFromManifest` for record) | ~1,000 lines |
| 5a | `carry` and `carry-candidates` with `carryForRun`, `listIn`, `stringsIn`, `idOfEntry`, `withId`, `sameCommit`, `readInterdiffReview`, `partialDiffReason` (exports `carryForRun`, `sameCommit`) | ~450 lines |
| 5b | `record` (imports `boundLists` from shared, `carryForRun` and `sameCommit` from `cli/carry.ts`, `reviewScopeFromManifest` and `describeReviewScope` from `cli/explain.ts`) | ~450 lines |
| 6a | `score` with `anchorFor`, the owner-override helpers, `locallyListable`, `gateOf`, `withSnakeCaseId` (exports `anchorFor`, `configuredOwner`) | ~700 lines |
| 6b | `check-candidates` with the `CarriedHeld` helpers and `markSiblings` | ~600 lines |

After slice 6b, `cli.ts` holds imports, the dispatch switch, `main`,
`failureOf`, `CommandResult`, `runInProcess`, `reviewCommand`, the `watch`
case body, the bootstrap and the re-exports. `docs/ARCHITECTURE.md`
"Components" gains one sentence: `commands/*.md` are the slash commands;
`src/cli/*.ts` are the CLI handlers.

## Non-goals

- No behaviour, output, flag or exit-code change of any command.
- No renaming of handlers, helpers or flags, except the `inProcess` accessor
  edits listed in slice 0.
- No test changes beyond hardening the issue-52 test and adding
  `test/cli-modules.test.mjs` in slice 0, and the two assertions slice 6b adds
  to it.

## Acceptance criteria (every slice)

- AC-1. `npm run verify` passes: typecheck, byte-compared bundle, all tests,
  identity guard, action pins.
- AC-2. No file under `src/cli/` imports `cli.ts` (`test/cli-modules.test.mjs`
  greps for it and fails on a match).
- AC-3. The dispatch switch in `cli.ts` still has every `case '<name>':` at
  four spaces, and the hardened issue-52 test fails when it finds none.
- AC-4. `cli.ts` keeps exporting `runInProcess`, and re-exports `diffSummary`,
  `emitDiff`, `verificationProblem` and `resolveOutPath` once each has moved;
  no test file other than the two named changes.

Slice 0 only:

- AC-5. `inProcess` is owned by `cli/shared.ts` behind `inProcessState()` and
  `setInProcess()`; the four lines named in the constraints are the only
  textual changes to existing code (nine references in all, the rest moved
  verbatim); `test/review-driver.test.mjs` passes.

Slice 6b only:

- AC-6. `test/cli-modules.test.mjs` gains two assertions and passes:
  `src/cli.ts` has fewer than 600 lines, and `docs/ARCHITECTURE.md` contains
  `src/cli/`.

Reviewer checks, not judged by Orbit: each moved function is identical in
text to its original apart from import lines, the `export` keyword and the
slice-0 accessor edits (`git diff --color-moved` shows moves, not edits).

## Allowed paths

`plugins/review-voice/src/cli.ts`, `plugins/review-voice/src/cli/**` (new),
`test/issue-52-command-help.test.mjs` (slice 0 only), `test/cli-modules.test.mjs`
(slices 0 and 6b), `docs/ARCHITECTURE.md` (slice 6b),
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal (template; replace N and the slice row)

```
Implement slice N of docs/agent-handoffs/professionalisation/S12-split-cli-into-command-modules.md
in this repository. Read the spec first, in particular "Constraints the
research established", "Bundle size" and the row for slice N in the slices
table; the earlier slices are already on the base branch. Before moving
anything, re-measure the handlers the row names in the current cli.ts, since
earlier specs have added to them.

Outcome: the handlers and helpers that slice N names move verbatim from
plugins/review-voice/src/cli.ts into plugins/review-voice/src/cli/ as the spec
lays out, with the new import lines appended at the end of cli.ts's import
block and each module's imports in cli.ts's relative order; cli.ts keeps its
dispatch switch (every `case '<name>':` at four spaces), main, runInProcess,
reviewCommand, the watch case body, the bootstrap and the compatibility
re-exports the spec lists; no module under src/cli/ imports cli.ts; and every
command behaves exactly as before. The acceptance criteria "every slice" plus
the slice-specific ones in the spec must hold.

Scope: only plugins/review-voice/src/cli.ts, plugins/review-voice/src/cli/**,
the test files the spec names for this slice, docs/ARCHITECTURE.md (slice 6b
only) and the rebuilt bundle. Change no behaviour, output, flag or exit code;
rename nothing beyond the slice-0 accessor edits; reformat nothing beyond what
the move needs; change no other test. Do not edit scripts/, .github/,
CHANGELOG.md or the manifests. Add no dependency.

Conventions: moved comments move with their code unchanged; new import lines
use .ts extensions and `import type` for type-only names; no em or en dashes
anywhere (the identity guard rejects them).

Proof: run `npm run build` after the move so plugins/review-voice/dist/review-voice.mjs
is rebuilt; the dist-check check fails otherwise. Run `node --test
test/cli.test.mjs test/issue-52-command-help.test.mjs test/cli-modules.test.mjs`
and the test files that import the moved symbols; Orbit runs unit-tests,
typecheck, build, dist-check, identity-guard and action-pins on the whole
tree.
```
