# S10. Removed controls, tests that reference changed symbols, single-caller declarations

**Phase:** 4 (structural signals and routing). **Depends on:** S04 part A (the
`expect.line` convention and its fixtures test). **Size:** about 400 source
lines, 400 test lines, four fixtures; two Orbit runs (part A, part B).
**Risk:** low; every new signal is evidence for the analyst, not a verdict
input, until S11 opts a repository in (ADR 0020 keeps every structural signal
evidence-only by default). Baseline `919d0fd` (1.21.1). Verified against the
code on 2026-11-07.

## Why

"A deleted auth check, validation, limit or allowlist is blocking even if the
new code looks cleaner." Review Voice has no way to notice one. Removed lines
are read only to set hunk scope and net branch growth (`plugins/review-voice/src/diff/complexity.ts:256-265`),
mark deletion sites (`src/diff/hunks.ts:157-166`), collect removed declaration
names (`src/diff/symbols.ts:128-134`) and harvest identifiers for the absence
check (`src/scoring/reach.ts:64-90`); their text is otherwise dropped. Nothing
looks for a deleted guard. The external survey in the program README found no
professional reviewer that documents deleted-control detection either.

A wholly deleted file never reaches the diff at all: both acquisition paths
mark it `reviewed: false` and build the patch from reviewed files only
(`src/diff/acquire.ts:263-295`, `src/diff/pull-request.ts:527-558`), and
`countHunks` drops a hunk whose header is `/dev/null` (`complexity.ts:203-209`).
Deleting an authorisation module is the case most worth a lead, so this spec
reads such a file from the base blob instead.

Two cheaper gaps sit beside it in the symbol context:

- A reference hit records no classification. `isTestPath` exists but is used
  only to exclude test hits from `possibleExisting`, so test files are mixed
  into `references`, `referenceCount` and `downstreamFiles` (`symbols.ts:119-121`,
  `:304-321`). The analyst is told to check test adequacy and is never told
  which tests touch the changed symbol.
- A new declaration carries no caller count, and the whole collection searches
  the base ref where a new name has no hits by definition (`symbols.ts:41-50`;
  `src/review/driver.ts:298`). "Flag new generality that has one caller" is a
  review rule the analyst cannot apply from evidence.

The templates exist. `src/diff/type-escapes.ts` is a table-driven per-language
scanner over added lines with quote and comment handling (`splitLine`,
`Language`, `Rule`, all module-private today); `findBranchGrowth` nets removed
against added (`src/diff/structure.ts:219-239`); `collectStructure` wires
signals into `files.json` and the summary (`cli.ts:698-744`) and already reads
base blobs through `readBlobs`.

## Outcome

`files.json` carries three new facts the CLI measured: control lines the
change removed, the test files that reference each changed symbol, and the
callers of each new declaration at the head. The analyst gets each as a lead
with a stated bar; nothing changes in the verdict.

## Design

### Part A. Removed controls

`HunkCount` keeps `removed: { line: number; text: string; scope: string | null }[]`
beside `added` (`complexity.ts:195`, pushed at `:262` with the enclosing
declaration `scope` already in hand at `:226`), where `line` is the new-side
line of the deletion site, as `Branch` already records it (`:181-184`).

`type-escapes.ts` makes `Rule` and `Language` generic over their kind
(`Rule<Kind extends string = TypeEscapeKind>`,
`Language<Kind extends string = TypeEscapeKind>`), adds `'raw'` to `Rule.in`,
and has `splitLine` return `{ code, comment, raw }` where `raw` is the text
before the line comment with string contents intact (`kindsIn` reads `raw`
for a rule whose `in` is `'raw'`; no existing type-escape rule uses it, so the
type-escape output is unchanged). It exports `splitLine`, `Language` and
`Rule`. `src/diff/removed-controls.ts` imports them and declares its rules as
`Rule<RemovedControlKind>[]` inside its own `Language<RemovedControlKind>`
table, so the two scanners share one tokenizer and one rule shape. Kinds, all
lexical, each with a comment saying what it is and is not:

| kind | matched on | removed line matches |
|---|---|---|
| `guard` | code for the keyword, raw for the word list | a conditional (`if`, `unless`, `guard`, `when`, `case`) whose condition contains an authorisation, validation or limit word, in code or inside a string: auth, authoriz, permission, role, scope, token, session, owner, admin, allow, deny, validate, verify, check, limit, quota, rate, throttle, sanitize, escape, csrf, origin |
| `refusal` | raw | `throw`, `raise` or `return` with 401, 403, Forbidden, Unauthorized, Unauthorised, TooMany, Invalid, Denied |
| `decorator` | code | an attribute or decorator line such as `@authorize`, `@Authorize`, `@RequireRole`, `@login_required`, `@PreAuthorize`, `[Authorize]`, `@permission_classes` |
| `middleware` | code | `.use(` or `router.*(` with a middleware name containing auth, verify, require, csrf, ratelimit |
| `allowlist-entry` | raw | a single element (a quoted string, an identifier or `key: value`, optionally followed by a comma, containing no `=`, `(` or statement keyword) when the file's basename or the entry's `scope` contains allow, whitelist, permitted, roles, scopes, origins |

A line that is entirely a comment, or a keyword that appears only inside a
comment, never produces an entry. Netting: a removed line whose text, with
whitespace collapsed, is added back anywhere in the diff (the union of every
hunk's added lines across files) is a move, not a removal, and is dropped. At
most 20 entries per file, earliest first.

Output `structure.removedControls: { path, line, kind, text, deletedFile?: true }[]`,
`text` capped at 120 characters. Deleted files never reach the production
path list (`productionPaths` classifies reviewed files only), so
`complexity.ts` exports `deletedProductionPaths(files, partial, markedGenerated): string[]`,
which runs `reviewedKinds` over the `status === 'deleted'` entries as if they
were reviewed and keeps the production ones; `emitDiff` (`cli.ts`, beside
`productionPaths`) computes it and passes it to `collectStructure` as a new
optional fifth argument `deletedProduction: readonly string[] = []`, so the
existing three-argument calls in `test/issue-108-size-crossings.test.mjs`
keep working. For each path in `deletedProduction`, `collectStructure` reads
the base blob with the existing
`readBlobs(root, [`${sides.base}:${file.previousPath ?? file.path}`])` and
scans every line of it as a removed line with `deletedFile: true` and
`line: 1`; when `sides.base` is null the file is skipped and the doc says so.
The `RemovedControlKind` union stays closed.

The analyst prompt (`agents/diff-analyst.md`, after the `typeEscapes`
paragraph) gets one paragraph: an entry is a lead; raise an `authorization`,
`security` or `trust_boundary` candidate only after reading the surrounding
code and searching the head for where the check is re-established; when the
search finds it elsewhere, there is no finding; when it finds nothing and the
consequence cannot be traced, file a `question`. The verifier prompt gets the
matching paragraph: confirm the control is absent at the head by search before
verifying such a claim.

Seeded fixtures, all synthetic, each positive crafted so the removed guard is
replaced by an added line at the same new-side line (so `expect.line` is both
the deletion site and an added line, which S04's fixtures test requires), with
`expect: { min_findings: 1, severity, path, category, line }`:

- `fixtures/positive/removed-auth-check` (a route handler's `requireRole`
  guard is replaced by the unguarded call), `fixtures/positive/removed-rate-limit`,
  `fixtures/positive/removed-allowlist-entry`.
- `fixtures/negative/moved-auth-check` (the guard moves into a shared
  middleware file and is added back there in the same diff), with
  `expect: { output: "No actionable findings." }`.

A deterministic test runs `findRemovedControls` over each fixture's
`diff.patch` and asserts one entry of the right kind at `expect.line` on the
positives and none on the negative. A scratch-repository unit test (modelled
on `test/issue-108-size-crossings.test.mjs:253`) deletes a file holding a
guard and asserts a `deletedFile: true` entry. `test/issue-108-size-crossings.test.mjs:260`
deep-equals the whole `StructureSignals` object and is extended with
`removedControls: []`. `fixtures/README.md` lists the class.

### Part B. Symbol context

- `SymbolReferences` gains optional `testReferences: string[]` and
  `testReferenceCount`, present only when at least one test path matched (the
  `truncated?: true` precedent at `symbols.ts:29`), so the five existing
  deep-equal assertions in `test/symbols.test.mjs` keep passing. `reportFile`
  partitions hits with `isTestPath` using the repository's configured
  `test_paths` (the `symbols` command reads them through `repositoryConfig`,
  falling back to `DEFAULT_TEST_PATHS`). `references`, `referenceCount` and
  `downstreamFiles` then count production code only; today they also count
  test consumers, and the doc says so.
- `symbols` gains `--head <ref>`, validated with `refExists` exactly as
  `--base` is (exit 2 otherwise). For each `declared[]` entry, `reportFile`
  searches the head ref for the name, keeps code paths only (`isCode`),
  excludes the declaring path and test paths, and records `callers: string[]`
  (at most 8) and `callerCount`. Without `--head`, when the budget runs out
  first, or when the line search fails, the declaration has
  `callersInconclusive: true` (the time-budget and failed-search shapes at
  `symbols.ts:182-190` and `:338-347` set it too), so the field has one
  meaning. The three existing `declared[]` deep-equal assertions
  (`test/issue-111-possible-existing.test.mjs:100-110`, `:166-173` and
  `:236-242`) are updated for the new field (each entry gains
  `callersInconclusive: true`); the change is deliberate.
- The driver passes `--head <sha>` only when `summary.refs.head.available`
  is true (the driver always runs `diff --pr`). The interactive flow
  (`commands/review.md:289-294`, step 1e) passes `--head <head sha>` when the
  head is a local commit and nothing for a working-tree or staged review.
- `agents/diff-analyst.md`: `testReferences` names the tests to read for the
  test-adequacy check; a new declaration with `callerCount === 1` is a lead
  for one `maintainability` nit, "new generality with one caller", only when
  the declaration adds a parameter, mode or abstraction nobody else uses;
  inconclusive means unknown.

## Non-goals

- No verdict change. `removedControls` joins the human-review cap only when
  S11 adds the opt-in switch and amends ADR 0020.
- No parser. Every signal is lexical and says so.
- No lane or routing change (S11).

## Acceptance criteria

Part A:

- AC-1. `HunkCount.removed` carries each removed line's new-side anchor, text
  and scope; existing complexity and branch-growth tests pass unchanged;
  `test/issue-108-size-crossings.test.mjs:260` is extended with
  `removedControls: []`.
- AC-2. `findRemovedControls` returns the specified kinds for the seeded
  positives at `expect.line`, nothing for the moved-guard negative, nothing
  for a line that is entirely a comment or whose keyword is only in a
  comment, nothing for a `guard`, `decorator` or `middleware` pattern that
  appears only inside a string, and at most 20 per file.
- AC-3. `diff --out` writes `structure.removedControls` to `files.json` and
  `summary.structure.removedControls` equals it; a scratch-repository test
  shows a `deletedFile: true` entry for a deleted file holding a guard, none
  when the base side is unavailable, and none for a deleted file matching a
  configured `test_paths` glob or marked generated (the test covers one of
  the two).
- AC-4. The four fixtures pass `test/fixtures.test.mjs` (S04's rules
  included); `agents/diff-analyst.md` and `agents/evidence-verifier.md` carry
  the paragraphs (a test greps for `removedControls` in both);
  `docs/ARCHITECTURE.md` "Structural evidence" documents the signal and its
  netting (reviewer-checked).

Part B:

- AC-5. `symbols` splits references into production and test hits using the
  configured `test_paths`; `testReferences` is present only when a test path
  matched; counts match; `downstreamFiles` counts production only; the five
  `test/symbols.test.mjs` assertions pass unchanged.
- AC-6. With `--head <ref>`, each new declaration carries `callers` and
  `callerCount` from the head (own path, tests and non-code excluded);
  without it, after budget exhaustion or a failed search,
  `callersInconclusive` is true; an unknown `--head` exits 2; the three named
  `declared[]` assertions are updated.
- AC-7. The driver passes `--head` only when the head is available (a driver
  test asserts both branches); `commands/review.md` step 1e passes it for a
  local head commit.
- AC-8. `agents/diff-analyst.md` documents `testReferences` and the
  single-caller lead; `help.ts` documents `--head`; `docs/ARCHITECTURE.md`
  "Changed-symbol context" documents both (reviewer-checked).
- AC-9. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/diff/**`, `plugins/review-voice/src/cli.ts` (`diff`,
`symbols`), `plugins/review-voice/src/review/driver.ts`,
`plugins/review-voice/src/help.ts`, `plugins/review-voice/agents/diff-analyst.md`,
`plugins/review-voice/agents/evidence-verifier.md`, `plugins/review-voice/commands/review.md`
(step 1e only), `fixtures/**`, `docs/ARCHITECTURE.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal, part A

```
Implement part A of docs/agent-handoffs/professionalisation/S10-removed-controls-and-symbol-context.md
in this repository. S04 part A is already on the base branch. Read the spec
first, then plugins/review-voice/src/diff/type-escapes.ts (the scanner shape
to export and reuse), plugins/review-voice/src/diff/structure.ts
(findBranchGrowth netting, collectStructure, readBlobs and changeSides),
plugins/review-voice/src/diff/complexity.ts (HunkCount, countHunks, the scope
variable, productionPaths and reviewedKinds for the new deletedProductionPaths)
and docs/ARCHITECTURE.md "Structural evidence".

Outcome: HunkCount keeps removed lines with their new-side anchor, text and
enclosing scope; type-escapes.ts exports a generic splitLine, Language and
Rule, Rule gains a raw mode and splitLine returns raw; a new
src/diff/removed-controls.ts scans removed lines with the kinds, per-kind
matching mode and diff-wide netting the spec gives; complexity.ts exports
deletedProductionPaths and collectStructure takes it as an optional fifth
argument and scans those deleted files from the base blob with
deletedFile: true; `diff --out` writes structure.removedControls and the
summary carries the same array; the analyst and verifier prompts gain the lead
paragraphs; four synthetic fixtures (three positives whose expect.line is an
added line, one moved-guard negative) exist and deterministic tests prove the
scanner on them and on a scratch repository with a deleted file. Acceptance
criteria AC-1 to AC-4 and AC-9 of the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". The signal is
evidence only; do not touch the verdict, plan.ts or lanes.ts. Fixtures stay
synthetic (no real names, hosts, credentials). The only existing test you may
edit is test/issue-108-size-crossings.test.mjs as the spec says. Do not edit
scripts/, .github/, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```

## Orbit goal, part B

```
Implement part B of docs/agent-handoffs/professionalisation/S10-removed-controls-and-symbol-context.md
in this repository. Part A is already on the base branch. Read the spec first,
then plugins/review-voice/src/diff/symbols.ts (reportFile, isTestPath, the time
budget and failed-search shapes), plugins/review-voice/src/scoring/existence.ts
(gitGrepPaths and its ref argument), the symbols handler in
plugins/review-voice/src/cli.ts (refExists on --base), plugins/review-voice/src/review/driver.ts
(where `symbols` is invoked), commands/review.md step 1e and docs/ARCHITECTURE.md
"Changed-symbol context".

Outcome: symbol references are split into production references and optional
testReferences using the repository's configured test_paths, with
downstreamFiles counting production only; `symbols --head <ref>` (validated
with refExists) records callers and callerCount for each new declaration from
the head (code only, own path and tests excluded) and marks a declaration
callersInconclusive without a head, after budget exhaustion or a failed
search; the driver passes --head only when the head is available and the
interactive flow passes it for a local head commit; the analyst prompt
documents testReferences and the single-caller lead; help.ts documents --head.
Acceptance criteria AC-5 to AC-9 of the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". Evidence only; no
verdict, plan or lane change. The only existing tests you may edit are the
three declared[] assertions in test/issue-111-possible-existing.test.mjs the
spec names (lines 100-110, 166-173 and 236-242). Do not edit scripts/,
.github/, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
