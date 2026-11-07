# S04. A recall evaluation over the fixtures

**Phase:** 1 (measurement). **Depends on:** nothing. **Size:** about 500
source lines, 400 test lines, 20 one-line fixture edits; two Orbit runs (part A,
part B). **Risk:** low; nothing on the review path changes. Baseline `919d0fd`
(1.21.1). Verified against the code on 2026-11-07.

## Why

Recall is not measured anywhere. `docs/EVALUATION.md` names recall as the
blind spot and lists the `positive/` fixture class as "Real defects are
caught" with no checker named. In fact:

- `test/fixtures.test.mjs` checks shape only (every fixture has `case.yaml`
  and `diff.patch`, `expect:` is present, clean fixtures expect the exact
  no-findings string, no real identities); no test runs a positive fixture
  through real or fake agents (`test/fixtures.test.mjs:33-113`).
- Positive `case.yaml` files name `path`, `category`, `severity` and
  `findings` or `min_findings`, but no line (`fixtures/positive/transaction-ordering/case.yaml:5-9`).
  One positive, `simplification-dispatcher`, has no `path` at all: it
  exercises the opt-in simplification pass, which the driver's stage table
  does not run. Another, `shadow-path-parity`, has no `category`.
- The fixture patches are hand-written. `git apply --numstat` reports
  `corrupt patch` for 27 of 39 because hunk headers do not match their bodies;
  `--recount` rescues 26, and `positive/structural-serialized-awaits/diff.patch:10`
  has a context line with no leading space that even `--recount` rejects. The
  repository's own parser (`src/diff/hunks.ts:252-269`) tolerates both, which
  is why they pass today's tests.
- Six positives (`structural-*`) need the structure lane, which runs only
  when `review.lanes` configures it (`src/policy/load.ts:685`, default
  `[DIFF_LANE]`).
- The three `claude plugin eval` suites (restraint, injection, confinement) are
  absence checks graded by a model, never a positive-recall check.
- `computeMetrics` (`plugins/review-voice/src/evaluate/metrics.ts:52-252`) has
  no recall figure and no per-fixture result.

The product specification this program draws on sets "key-bug inclusion at
least 70% on a frozen bug set" and "clean-PR silence at least 80%" as the
quality bar. Review Voice cannot report either number today.

What exists to build on: `candidate_set_agreement` matches locations by path
with a line tolerance of 3 (`AGREEMENT_LINE_TOLERANCE`, `metrics.ts:266`,
module-private); the driver runs end to end in process with
`REVIEW_VOICE_FAKE_AGENTS` against a git repository and a stubbed GitHub pull
request (`test/review-driver.test.mjs:34-104`, `:295-313`), with `fetchImpl`
seams on `GitHubClient` and `runInProcess`; `parseHunks` (`src/diff/hunks.ts:175-288`)
returns the added lines per path.

## Outcome

`review-voice recall` runs every fixture through the real pipeline and scores
key-bug recall, causal-line hit and clean-fixture silence. `evaluate` reports
the latest figures. The fixture set is frozen by its own test, and a positive
fixture names the line its defect lives on.

## Design

### Part A. Fixture annotations and a fixture materialiser

1. Every `fixtures/positive/*/case.yaml` whose `expect` names a `path` gains
   `expect.line`, the new-file line of the causal line in `diff.patch`.
   `positive/simplification-dispatcher` instead gains `harness: skip` with a
   one-line reason (its pass is not driven by `runReview`). `fixtures/README.md`
   documents both keys. `test/fixtures.test.mjs` asserts that `line` is present
   exactly when `path` is, that it is an added line of `expect.path` according
   to `parseHunks` from `src/diff/hunks.ts` (the same notion of an added line
   `check-candidates` enforces), that `negative/` and `no-findings/` fixtures
   have no `line`, and that a positive without `path` carries `harness: skip`.
   The fixture `diff.patch` files are not changed.
2. `plugins/review-voice/src/evaluate/fixtures.ts` exports
   `materializeFixture(fixtureDir, targetDir, options): { base: string; head: string; files: string[] }`.
   It creates a git repository with two commits. Base: for every file in
   `diff.patch`, the pre-image reconstructed from each hunk's context and
   removed lines, placed at the old-side line numbers with a filler line
   (`// filler` or `# filler` by extension) for lines the patch does not show,
   overridden by any file present under `context/`; plus
   `.review-voice/config.yaml`, copied from a `config.yaml` at the fixture root
   when one exists, otherwise written with the repository's full shipped lane
   set (the diff lane plus
   `{ name: structure, agent: structure-analyst, prefix: st_, when: { min_changed_source_lines: 0, exclude_kinds: [] } }`)
   so every shipped analyst can reach every fixture. Head: base with a
   **normalised copy** of `diff.patch`, written to the temp directory, applied
   by `git apply`: hunk headers recounted from the body, and a body line inside
   a hunk with no leading marker read as a context line, the tolerance
   `hunks.ts` already has. The fixture file is never changed. A patch whose
   context does not match the reconstructed pre-image is a materialisation
   error that names the fixture. Commits are authored as
   `review-voice-fixtures <fixtures@example.com>`.
3. A deterministic test materialises every fixture under `fixtures/`
   (`prompt-injection/` and `confinement/` included; for those it asserts only
   that the patch applies) and asserts the head tree contains `expect.path`
   with the expected line where one is set, and that the materialised diff's
   added and removed lines equal the fixture's hunks' (ignoring filler), which
   catches a mis-normalised patch.

### Part B. The `recall` command and metrics

1. `review-voice recall --fixtures <dir> [--class positive,negative,no-findings]
   [--runner claude|fake] [--mode <mode>] [--out <results.json>] [--only <name>] [--keep]`.
   The default classes are the three named; `prompt-injection/` and
   `confinement/` are never scored. For each fixture it materialises a temp
   repository, changes directory into it (restored afterwards, because the
   driver runs git and its head check in `process.cwd()`), and runs
   `runReview` from `src/review/driver.ts` with `fetchImpl` replaced by a local
   pull-request shim (the shape `test/review-driver.test.mjs` uses: one pull
   request, base and head from the materialised repo, empty thread, the
   fixture's `pr-body.md` as the description when present). The whole
   invocation points `REVIEW_VOICE_DATA_DIR` at one fresh temporary directory,
   removed at the end unless `--keep`, so no fixture run is recorded in the
   operator's store or `runs/`; sets `GITHUB_TOKEN` to a placeholder when
   neither `GITHUB_TOKEN` nor `GH_TOKEN` is set so the shimmed commands never
   call `gh`; and passes `env` with `REVIEW_VOICE_NO_COMMANDS=1` into
   `ReviewDeps`. `driver.ts` needs no change: the seams exist and
   `pluginVersion()` is exported from `src/version.ts`.
   With `--runner fake`, each fixture's `agents/` directory is copied to a
   temporary directory and `REVIEW_VOICE_FAKE_AGENTS` points at it for that
   fixture only (through `ReviewDeps.env`), so the fake backend's on-disk call
   numbering restarts per fixture and nothing is written under the fixtures.
2. Scoring per fixture:
   - positive with `path`: `hit` when a validated finding has
     `path === expect.path` and `|line - expect.line| <= AGREEMENT_LINE_TOLERANCE`
     (exported from `metrics.ts`); `categoryMatch` is true when the recorded
     finding's `category` equals `expect.category`, null when either side lacks
     a category (`ReviewReport['findings']` is widened with `category?: string`
     from the recorded finding); `findings` is the count of validated findings.
   - positive with `harness: skip`: listed with `skipped: <reason>` and left
     out of every denominator.
   - negative and no-findings: `silent` when the validated output is exactly
     `No actionable findings.`.
   - every fixture: `lanes` from the run's plan, `seconds`, `costUsd` (null
     under the fake runner), the run's exit code, and `error` when the run did
     not complete.
3. Output `results.json` (figures illustrative):

```json
{ "pluginVersion": "1.22.0", "mode": "standard", "runner": "claude",
  "fixtures": [ { "name": "positive/transaction-ordering", "class": "positive",
    "hit": true, "lineDelta": 0, "categoryMatch": true, "findings": 2,
    "lanes": ["diff", "structure"], "seconds": 71.2, "costUsd": 0.42, "exitCode": 0 } ],
  "summary": { "keyBugRecall": 0.84, "causalLineHit": 0.79, "cleanSilence": 0.93,
    "positives": 19, "skipped": 1, "cleanFixtures": 15, "failedRuns": 0 } }
```

   `keyBugRecall` is hits over positives that completed; `causalLineHit` is
   hits over positives that completed with at least one finding on
   `expect.path` (so a finding on the right file but the wrong line is
   visible); `cleanSilence` is silent over clean fixtures that completed.
   Failed runs are counted, never dropped silently.
4. `evaluate --recall <results.json>` reports `fixture_key_bug_recall`,
   `fixture_causal_line_hit` and `fixture_clean_silence` as goals (reported,
   not gated; the suite is small and runs are stochastic) with the file's
   plugin version, runner and counts in the basis. Without the flag the three
   print `no data` with the basis `pass evaluate --recall <results.json>`, the
   repository's convention (`EVALUATION.md:415-417`). `docs/EVALUATION.md`
   gains a "Fixture recall" section stating how the figures are produced, that
   one pass per fixture is a noisy sample (the repository's own candidate-set
   agreement figure is 0.25 to 0.60), and that the frozen set must not be
   tuned against.
5. `help.ts`: `COMMAND_HELP` gains a `recall` entry in the `evaluate` entry's
   shape (synopsis line `review-voice recall ...`, Flags, `Reads:`, `Writes:`,
   `Exit codes:`), and the `evaluate` entry lists `--recall <results.json>`;
   `test/issue-52-command-help.test.mjs` and `test/issue-132-command-list-help.test.mjs`
   pass unchanged.
6. A deterministic test runs `recall --runner fake` over canned fixtures under
   `test/fixtures-recall/<class>/<name>/` (each with `case.yaml`, `diff.patch`
   and `agents/<agent>.<n>.json`): one hit at delta 0 (canned diff-analyst,
   evidence-verifier, challenger and concise-editor outputs), one miss whose
   canned candidate anchors on another added line of `expect.path` at least
   four lines away (a candidate off the diff is sent back to the analyst, so
   the wrong line must still be an added line), and one clean fixture. It
   asserts the three per-fixture results, the summary figures, that the
   operator's data directory is untouched and that the temporary store holds
   one run per completed fixture.

### Follow-up for a person (protected path)

`.github/workflows/eval.yml`: add a nightly job that runs
`recall --fixtures fixtures --runner claude --out recall.json` on Linux with
the API key and uploads the file as an artifact.

## Non-goals

- No change to the review pipeline, prompts or scoring.
- No new fixtures beyond the `line` and `harness` annotations (S10 part A
  adds the seeded removed-control fixtures and relies on this convention).
- No gate on the recall figures.

## Acceptance criteria

Part A:

- AC-1. Every `fixtures/positive/*/case.yaml` with `expect.path` has
  `expect.line`; `simplification-dispatcher` has `harness: skip`;
  `test/fixtures.test.mjs` fails if a `line` is missing where `path` is
  present, is not an added line of `expect.path` per `parseHunks`, appears on
  a clean fixture, or a positive has neither `path` nor `harness: skip`;
  `fixtures/README.md` documents `expect.line` and `harness`.
- AC-2. `materializeFixture` builds a two-commit repository for every fixture
  under `fixtures/` without changing any fixture file; the head contains
  `expect.path`; the base contains `.review-voice/config.yaml` with the
  structure lane when the fixture ships no config; a test asserts the
  materialised diff reproduces the fixture's added and removed lines.
- AC-3. A patch whose context does not match the reconstructed pre-image
  raises an error naming the fixture.

Part B:

- AC-4. `recall --runner fake` over the canned test fixtures produces the
  specified `results.json` with one hit at delta 0, one miss, one silent, and
  summary figures that match.
- AC-5. `recall` never runs configured repository commands, never posts, and
  writes nothing under the operator's data directory; the deterministic test
  asserts the last two.
- AC-6. `evaluate --recall <file>` prints the three goal metrics with their
  basis; without the flag they print `no data` with the stated basis.
- AC-7. `help.ts` carries the `recall` entry and the `--recall` flag in the
  shape specified; the two help tests pass unchanged; `docs/EVALUATION.md` has
  the "Fixture recall" section (reviewer-checked).
- AC-8. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/evaluate/**`, `plugins/review-voice/src/cli.ts`
(`recall`, `evaluate` flags), `plugins/review-voice/src/help.ts`,
`plugins/review-voice/src/review/driver.ts` (only to widen
`ReviewReport['findings']` with `category?`), `fixtures/**` (case.yaml and
README.md only; no diff.patch), `test/**`, `docs/EVALUATION.md`,
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal, part A

```
Implement part A of docs/agent-handoffs/professionalisation/S04-recall-eval-harness.md
in this repository. Read that file first. Read fixtures/README.md,
test/fixtures.test.mjs, plugins/review-voice/src/diff/hunks.ts (parseHunks and
the tolerances around line 252) and test/review-driver.test.mjs (how a fixture
repository and a stubbed pull request are built) before changing code.

Outcome: every fixtures/positive/*/case.yaml with expect.path names expect.line
(the new-file line of its causal line) and simplification-dispatcher carries
harness: skip; test/fixtures.test.mjs enforces both using parseHunks; a new
plugins/review-voice/src/evaluate/fixtures.ts materialises any fixture into a
two-commit git repository (reconstructed pre-image plus context/ plus a
.review-voice/config.yaml that enables the structure lane when the fixture
ships none, then a normalised copy of the patch applied with recounted hunk
headers and unmarked lines read as context) with a test over every fixture
that also checks the materialised diff reproduces the fixture's added and
removed lines. No fixture diff.patch changes. Acceptance criteria AC-1 to
AC-3 and AC-8 of the spec must hold.

Scope: only fixtures/**/case.yaml, fixtures/README.md, test/**,
plugins/review-voice/src/evaluate/** and the rebuilt bundle. Do not change any
fixture's diff.patch. Do not edit scripts/, .github/, CHANGELOG.md or the
manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md (fixtures stay synthetic; no real names,
hosts or credentials; no em or en dashes anywhere, the identity guard rejects
them); comments explain why, in full sentences.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```

## Orbit goal, part B

```
Implement part B of docs/agent-handoffs/professionalisation/S04-recall-eval-harness.md
in this repository. Part A is already on the base branch. Read the spec first,
then plugins/review-voice/src/evaluate/fixtures.ts, plugins/review-voice/src/evaluate/metrics.ts
(computeMetrics, AGREEMENT_LINE_TOLERANCE), plugins/review-voice/src/review/driver.ts
(runReview, ReviewDeps, ReviewReport), plugins/review-voice/src/agents/fake.ts
and test/review-driver.test.mjs (reviewIn and the fake GitHub).

Outcome: a `review-voice recall` command runs every fixture of the chosen
classes through runReview with a local pull-request shim and the configured
agent runner, inside a fresh temporary REVIEW_VOICE_DATA_DIR with
REVIEW_VOICE_NO_COMMANDS=1 and a placeholder GITHUB_TOKEN, changing into each
materialised repository; it scores key-bug recall, causal-line hit (within
AGREEMENT_LINE_TOLERANCE, exported) and clean-fixture silence, skips fixtures
marked harness: skip, and writes results.json in the shape the spec gives;
`evaluate --recall <file>` reports the three figures as goals with their basis
and prints `no data` without the flag; help.ts gains the recall entry and the
--recall flag in the existing shape; docs/EVALUATION.md gains the "Fixture
recall" section. Acceptance criteria AC-4 to AC-8 of the spec must hold, with
the deterministic test using per-fixture canned agent outputs under
test/fixtures-recall/ as the spec lays out.

Scope: only the paths the spec lists under "Allowed paths". The command must
never post, never run repository commands and never write to the operator's
data directory. Do not edit scripts/, .github/, CHANGELOG.md or the manifests.
Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere; no hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
