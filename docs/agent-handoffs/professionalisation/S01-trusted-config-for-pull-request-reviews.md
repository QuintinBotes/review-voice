# S01. Trusted configuration for pull-request reviews

**Phase:** 0 (trust). **Depends on:** nothing. **Size:** about 180 source lines,
250 test lines, one Orbit run. **Risk:** low. Baseline `919d0fd` (1.21.1); line
numbers below are as of that commit. Verified against the code on 2026-11-07.

## Why

A pull request can lower its own review bar. Every stage of `review --pr` loads
`.review-voice/config.yaml` from the checkout the command runs in
(`repositoryConfig` at `plugins/review-voice/src/cli.ts:1302-1308` calls
`loadConfig(repositoryRoot(process.cwd()))`), never from a trusted copy. In the
GitHub Action, `actions/checkout` on a `pull_request` event checks out the pull
request's merge ref, so the author's config drives the run. What that config
can do today:

- `sensitive_paths: []`, or a list that omits the defaults, removes
  `.review-voice/**` and `.github/workflows/**` from the sensitive set
  (`src/policy/load.ts:106-114` replaces the default list; `src/diff/complexity.ts:303-307`
  and `:434` build matchers only from the configured list). The change to the
  config file is then no longer flagged.
- `review.human_review.cap_approval: false` disables the ADR 0012 approval cap
  (`load.ts:119-123`, `src/publish/verdict.ts:477-479`).
- `max_decision_points` has no upper bound (`load.ts:97-105`).
- Targeted `test_paths`, `generated_paths` and `sensitive_exempt_paths` globs
  pass the catch-all guard, which drops only globs that also match a
  production probe (`complexity.ts:326-349`).

Blocked today: catch-all exclusion globs, and exempting `.review-voice/**` or
`.github/workflows/**` through `sensitive_exempt_paths`
(`SENSITIVE_NEVER_EXEMPT`, `complexity.ts:59`, `:443-452`). ADR 0012 admits the
globs "come from .review-voice/config.yaml in the checked-out tree".

The fix already exists for one path. `watch` copies the operator's config into
the data directory and passes it to the child review as an absolute
`REVIEW_VOICE_CONFIG` (`cli.ts:5113-5116`, `src/watch/review.ts:103`), which
`configFile` honours (`load.ts:652-659`), and `loadConfig` yields the defaults
when the named path does not exist (`load.ts:692-693`). The Action and a bare
`review --pr` do not use that mechanism.

## Outcome

A pull-request review reads its configuration from a source the author of the
pull request cannot edit in that pull request. The built-in sensitive globs
that protect the reviewer's own configuration and CI cannot be removed by any
configuration.

## Design

### Config source for `review --pr`

`headOf()` in `src/review/driver.ts:171-177` reads only `head.sha` from
`GET /repos/{repo}/pulls/{n}`; extend it to return `base.sha` and `base.ref`
from the same response (the test stub at `test/review-driver.test.mjs:84-85`
already serves both). Then, in `runReview`, right after `mkdirSync(run.dir)`
(`driver.ts:898-899`) and before the stage loop, the driver resolves one config
source. This is run setup beside `prepareWorkspace`, not a review stage, so
ADR 0022 is unchanged; it must not live in `prep`, which `reviewInFull`
(`driver.ts:338-343`) calls a second time. Order:

1. `--config <path>` on the `review` command: absolute, or relative to the
   current directory and resolved to absolute. The operator's explicit choice.
2. `REVIEW_VOICE_CONFIG`, when it is already set to an absolute path. This is
   how `watch` works and nothing about `watch` changes.
3. The pull request's base commit. Before resolving, the driver removes any
   existing `<run dir>/config.yaml`, as `prepareWorkspace` does for `base/`
   and `history/` (`driver.ts:380-382`), so a re-run with `--out` into the
   same directory never reads an earlier run's base config. It then runs
   `git show <base.sha>:.review-voice/config.yaml`; when the base commit is not
   in the clone it tries `origin/<base.ref>`. The content, when found, is
   written to `<run dir>/config.yaml` (mode 0600).

In every case the driver sets `REVIEW_VOICE_CONFIG` to the resolved absolute
path for the rest of the run, and in case 3 that path is `<run dir>/config.yaml`
whether or not anything was written: when the base has no config the file is
absent, `loadConfig` yields the built-in defaults, and the checkout's own
`.review-voice/config.yaml` is never read. The previous value of the variable
is restored (or removed) when the run ends, on `Stop` exits too.

The source is recorded on the run report as
`configSource: { kind: 'flag' | 'env' | 'base' | 'default', ref?: string, path?: string }`,
printed by `reportText` as one `Config: ...` line, and included in
`review --json`. It is local only and never posted. Two fixed notes go into
`run.notes` (local only):

- when `kind` is `default`: `No .review-voice/config.yaml at the base commit <sha7>; the review ran with the built-in defaults.`
- when the pull request's changed files include `.review-voice/config.yaml`
  (already a sensitive path, so the change is high complexity):
  `Configuration was read from the base commit <sha7>; the pull request's changes to .review-voice/config.yaml were not applied to this review.`

`REVIEW_VOICE_CONFIG` is read by `loadConfig` in the same process
(`runInProcess`), so every stage sees the trusted file without further change.

### Tighten-only sensitive paths

`src/diff/complexity.ts`: when building the effective sensitive list, append
each `SENSITIVE_NEVER_EXEMPT` glob that the configured list does not already
contain, after the configured entries, and use that one array for both
`sensitiveMatchers` and `globOf`, so a configured match is still reported under
its configured glob and the default list is not duplicated. `sensitive_paths: []`
therefore keeps flagging `.review-voice/**` and `.github/workflows/**`, and
`limits.sensitivePaths` in the assessment records the effective globs. Reword
the two comments at `complexity.ts:45-48` and `:54-58` so the reason is "the
reviewer protects its own configuration and CI whatever the list says", not
"the list is read from the checked-out tree". Update the template comment at
`templates/config.example.yaml:87`: an empty list turns off every sensitive
path except those two.

### Not in this spec

Ceilings on `max_decision_points` and a trust floor for `cap_approval`. With
the config read from the base commit these settings are the maintainers',
which is the intended trust model. ADR 0012's existing guards stay as they are.

## Non-goals

- No change to the interactive `/review-voice:review` command, which reviews
  the operator's own working tree and reads the operator's own config.
- No change to `.review-voice/policy.yaml` handling (already proposal-only).
- No new GitHub read or write beyond the two fields already in the pull
  request response.
- `action.yml` is a protected path for Orbit. The one-line change it needs is
  listed under follow-ups for a person.

## Acceptance criteria

Tests that drive the driver use the harness in `test/review-driver.test.mjs`.
Its `repository()` helper commits the change map at the head only and ends
with `git checkout main`, and `reviewIn()` runs in that tree, so today's code
reads the base config from the working tree by accident. Each test below
therefore (a) gives the harness a way to commit files at the base commit, and
(b) checks out the head commit in the working tree before `runReview`, which
is what `actions/checkout` gives a `pull_request` job. Each behavioural test
must fail on the baseline when the driver's config step is removed. Five
existing driver tests write `.review-voice/config.yaml` into the working tree
after `repository()` returns and depend on the checkout being read: (h) fast
mode with the structure lane (`test/review-driver.test.mjs:329-333`),
"--post sends the verdict" (`:399-400`), "exit 8 from post" (`:677-678`), and
the two tests that call `commandsConfig()` (`:565-580`, used at `:584` and
`:597`). Move each of those configs into the base commit through the
harness's new base-files parameter (or pass it as `--config`); their
assertions stay as they are.

- AC-1. `review --pr` with neither `--config` nor `REVIEW_VOICE_CONFIG` reads
  `.review-voice/config.yaml` from the pull request's base commit. The base
  commits a default config; the head sets
  `review.human_review.sensitive_paths: []` and `cap_approval: false` and
  touches `.github/workflows/ci.yml`; the head is checked out; the fake
  analyst returns no candidates, so without the cap the verdict would be
  APPROVE. The complexity read from `<run dir>/files.json` is `high`, the
  verdict is `COMMENT` (which proves the base config was applied), and
  `configSource.kind` is `base`.
- AC-2. `--config <path>` beats `REVIEW_VOICE_CONFIG`, which beats the base
  commit; the report names the winner. One test per case.
- AC-3. A base commit with no `.review-voice/config.yaml` and a head that adds
  one with `cap_approval: false` and touches `.github/workflows/ci.yml`, head
  checked out, fake analyst returning no candidates: `configSource.kind` is
  `default`, the verdict is `COMMENT` (the head's `cap_approval: false` was
  not applied), and the default-case note is present.
- AC-4. A head that changes `.review-voice/config.yaml` produces the "not
  applied" note; a head that does not change it produces no such note.
- AC-5. `assessComplexity` with `sensitivePaths: []` still marks
  `.review-voice/config.yaml` and `.github/workflows/x.yml` sensitive, and
  `sensitive_exempt_paths` still cannot exempt them; a configured list such as
  `['**/billing/**']` matches billing paths and the two protected globs and
  nothing else; `limits.sensitivePaths` holds each glob once; every existing
  complexity test passes unchanged.
- AC-6. `REVIEW_VOICE_CONFIG` is restored to its previous value (or removed)
  when the run ends, including on a `Stop` exit. A test asserts it.
- AC-7. `review --help` lists `--config`. A new test (for example
  `test/trusted-config-docs.test.mjs`) asserts that `docs/ACTION.md` mentions
  `REVIEW_VOICE_CONFIG`, `base commit` and `fetch-depth`, and that
  `docs/adr/0012-*.md` and `docs/adr/0031-*.md` each contain a
  `## Amendment - 2026` heading whose section mentions the base commit.
- AC-8. `npm run verify` passes with the rebuilt bundle committed.

Reviewer checks, not judged by Orbit: `docs/ACTION.md` says which config a CI
review reads, that the base config is found only when the checkout has the
base commit (`fetch-depth: 0`, as the minimal workflow already uses; a shallow
checkout falls to `default`), and how to point the action at another file.
`docs/ARCHITECTURE.md` "Layer resolution in practice" and the trust boundary
paragraph say a pull-request review reads the base commit's config.
`docs/adr/README.md` marks 0012 and 0031 as amended with the date.

## Allowed paths

`plugins/review-voice/src/review/driver.ts`, `plugins/review-voice/src/cli.ts`
(the `review` flags only), `plugins/review-voice/src/diff/complexity.ts`,
`plugins/review-voice/src/policy/load.ts`, `plugins/review-voice/src/help.ts`,
`plugins/review-voice/templates/config.example.yaml`, `docs/ACTION.md`,
`docs/ARCHITECTURE.md`, `docs/adr/0012-*.md`, `docs/adr/0031-*.md`,
`docs/adr/README.md`, `test/**`, `plugins/review-voice/dist/review-voice.mjs`.

## Follow-ups for a person (protected paths)

In `action.yml`, replace the step that copies a non-default `config` input over
`.review-voice/config.yaml` with exporting
`REVIEW_VOICE_CONFIG="$(realpath "$CONFIG")"` into the review step's
environment, so the input keeps working under the new rule. Until then the
action reads the base commit's config and the `config` input is ignored, which
`docs/ACTION.md` says.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S01-trusted-config-for-pull-request-reviews.md
in this repository. Read that file first; it is the design and the acceptance
criteria. Read docs/ARCHITECTURE.md ("Layer resolution in practice", "The
review driver"), docs/adr/0012-complex-changes-need-human-approval.md,
docs/adr/0022-one-command-drives-a-review.md and
docs/adr/0031-a-github-action-runs-one-review-per-pull-request-event.md before
changing code, then plugins/review-voice/src/review/driver.ts (headOf, runReview,
prepareWorkspace), plugins/review-voice/src/policy/load.ts (configFile,
loadConfig) and plugins/review-voice/src/diff/complexity.ts (the sensitive
matchers) and the harness in test/review-driver.test.mjs.

Outcome: `review --pr` resolves its config once in runReview, from --config,
else an absolute REVIEW_VOICE_CONFIG, else the pull request's base commit
(headOf also returns base.sha and base.ref), and always sets
REVIEW_VOICE_CONFIG to the resolved path so the checked-out head's
.review-voice/config.yaml is never read; the report names the source and the
two fixed notes are added when they apply; .review-voice/** and
.github/workflows/** stay sensitive whatever sensitive_paths says, each listed
once. All eight acceptance criteria in the spec must hold, with the driver
tests arranged as the spec's preamble to the criteria describes (base files
committed, head checked out). The five existing driver tests that write a
working-tree config are moved to commit it at the base commit, with their
assertions unchanged.

Scope: only the files the spec lists under "Allowed paths". Do not edit
action.yml, scripts/, CHANGELOG.md or the plugin manifests. Do not change the
interactive /review-voice:review command. Add no dependency.

Conventions: follow CONTRIBUTING.md and the style of the surrounding code
(comments explain why, full sentences; no hardcoded identities; no em or en
dashes anywhere, the identity guard rejects them). Amend ADR 0012 and ADR 0031
with a dated "## Amendment - <date>" section in the existing style, and mark
both rows in docs/adr/README.md as amended; do not rewrite their decisions.

Proof: after changing anything under plugins/review-voice/src, run `npm run
build` so plugins/review-voice/dist/review-voice.mjs is rebuilt; the dist-check
check fails otherwise. Run the test files you add or change with `node --test
<file>`; the unit-tests, typecheck, build, dist-check, identity-guard and
action-pins checks are run by Orbit on the whole tree.
```
