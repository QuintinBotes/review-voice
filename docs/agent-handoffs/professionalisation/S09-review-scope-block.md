# S09. A review scope block: what ran, what did not, and the independence label

**Phase:** 3 (evidence made visible). **Depends on:** S02 (provenance), S08
(did-not-run list). **Size:** about 200 source lines, 220 test lines, one ADR
amendment; one Orbit run. **Risk:** low while off by default; medium once a
team turns it on, because the posted body grows. Baseline `919d0fd` (1.21.1);
after S02 and S08 locate code by function name (`recordCommand`,
`explainCommand`, `record` in `driver.ts`, `runDetail`, `computeVerdict`).
Verified against the code on 2026-11-07.

## Why

The posted review says what was found and nothing about what was looked at.
`buildPayload` builds the body from the one-line summary, line-less verified
findings and at most one simplification (`plugins/review-voice/src/publish/verdict.ts:644-664`);
`computeVerdict` appends CI annotations with `withAnnotations` at
`src/publish/post.ts:431`, after the idempotency key is taken at `:425`, and
renders the preview from that payload. Everything that would tell a reader the
limits of the review stays local: unverified and below-gate claims, held
findings, inconclusive symbol files, static checks that did not run, the
incremental scope note (`review.md:707-716`, `:865-872`; `cli.ts:826-842`;
`src/evidence/types.ts:16-39`). Inconclusive symbol files and did-not-run
checks are not even recorded with the run (`driver.ts:771-791`).

The output contract is the reason: findings are validated text with no
summary, headings or preamble (`src/contract/validate.ts`). That contract
governs the findings. The body already carries a summary line and annotations
outside it, and ADR 0028 made the body's extra lines configurable. ADR 0016
keeps the `unverified` and `belowGate` lists local; this spec posts only their
counts, and says so in the ADR 0028 amendment. The external survey in the
program README found that only two professional reviewers state per review
what they did not check; the product specification this program draws on
makes that list part of the contract the owner reads.

## Outcome

With `verdict.scope_block: true`, every posted review ends with a collapsed
block that states, from the recorded run alone, the head reviewed, the scope
kind and cost mode, the origin and independence label, which stages ran, which
static checks ran, failed or did not run, how many files the symbol search
could not finish, and how many claims were held and why. The block never
carries the human-review note, the would-have verdict or a carry reason. A
trailing HTML comment holds the same facts as JSON for CI scripts.

## Design

### Recording what the block needs

`record` gains `--evidence <file>` and `--symbols <file>`. `RecordRunInput`
gains `checks`, stored in `output_json`:

```ts
interface RecordedChecks {
  staticRan: { name: string; exitCode: number | null; signals: number; version?: string }[];
  staticDidNotRun: { name: string; reason: string }[];
  symbolsInconclusive: number;
  symbolsBudgetExhausted: boolean;
}
```

`staticRan` is every `commands[]` entry whose `name` is not in `didNotRun`,
in `commands` order; `staticDidNotRun` is every `didNotRun` name, in that
order, so a command that could not start (exit 126 or 127, in both lists
after S08) is reported once, as not run. `reason` is the command's
`unavailable` text when the name also appears in `commands`, else the
report's top-level `skipped` string when present, else `not run`; `version`
is copied from `commands[].version` when S08 recorded one. The driver passes
both files; `commands/review.md` step 6 adds
`--evidence <tmpdir>/evidence.json --symbols <tmpdir>/symbols.json` to its
`RV record` line so interactive runs record them too, and `help.ts`'s
`record` entry lists `--evidence <path>` and `--symbols <path>` beside
`--stages`, because `test/issue-52-command-help.test.mjs` ("every flag
review.md passes a command is in that command's own --help") fails otherwise.
`runDetail` returns `checks: RecordedChecks | null` (null for older rows).
`explain` prints one "Checks" line.

### Rendering

`src/publish/verdict.ts` gains a pure
`scopeBlock(run: RunDetail, planned: PlannedFindings, policy: Pick<VerdictPolicy, 'scopeBlockModels'>): string`
rendered only from recorded data, so two renders of one run are identical.
`safeCheckName` (`verdict.ts:308-320`) is exported and every name from
configuration or the store (check names, model ids, stage names) passes
through it. Fields a run did not record render as `not recorded`, never
silently omitted. Shape:

```
<details><summary>Review scope</summary>

Head `a1b2c3d`, full scope, standard mode. Origin: driver (independent).
Stages: intent, analyst, verifier, challenge, editor.
Static checks: typecheck ran (exit 0, 0 signals); lint did not run (REVIEW_VOICE_NO_COMMANDS).
Symbol context: 2 files not finished (time budget).
Not posted: 1 unverified claim, 2 below the gate, 1 held by the challenger, 1 restating a static check, 1 suppressed by policy.
Not checked: UI behaviour, product policy, load behaviour, files the symbol search did not finish.

</details>
<!-- review-voice {"head":"<full sha>","origin":"driver","independence":"independent","findings":{"blocking":0,"important":1,"minor":2,"nit":1,"question":0},"held":{"unverified":1,"belowGate":2,"challenge":1,"restatesTool":1,"policySuppressed":1,"other":0},"checks":{"ran":1,"didNotRun":1}} -->
```

- `Stages` lists the recorded stage names in recorded order (`stages[].name`,
  the driver's `intent`, `analyst`, `verifier`, `second-pass`, `tie-break`,
  `score`, `challenge`, `editor`); skipped stages are not recorded and so not
  listed.
- The prose head is the first seven characters of `run.headRef`; the JSON
  trailer carries the full sha.
- "Not posted" counts come from `run.held[].verdict`: `unverified` to
  unverified; `below-gate` to belowGate; `challenge-refuted` and
  `challenge-partly` to challenge; `restates-tool` (S08) to restatesTool;
  `policy-suppressed` (S06) to policySuppressed; every other verdict
  (`partly`, `refuted`, `repeat`, `owner-declined`, and any verdict added
  later) to `other`, so a new verdict is never silently dropped. A zero count
  is omitted from the prose and kept in the JSON.
- The "Not checked" line has a fixed first part (UI behaviour, product policy,
  load behaviour), because no stage of Review Voice examines them, plus the
  run-specific items.
- Model ids are included only when `verdict.scope_block_models: true`; a
  public pull request need not advertise vendor choices.

### Where it goes in the body

`computeVerdict` (`post.ts:431`) builds the body as
`withAnnotations(<full.body with the block appended>, decision.annotations)`
when `policy.scopeBlock` is on, after `key` is taken from `full` at `:425`, so
`verdict`, `post` and the watcher show one preview, the idempotency key is
unchanged, and `replaceAnnotations`' suffix match (`verdict.ts:679-683`) still
strips only the trailing annotation lines. `post()` is otherwise unchanged.

### Settings

`verdict.scope_block: false` and `verdict.scope_block_models: false`, read by
`readVerdictPolicy` (`src/policy/load.ts:348-370`) into `VerdictPolicy`
(`verdict.ts:275-296`). `test/verdict-policies.test.mjs` "config: each setting
is read" (lines 741-765) deep-equals the whole policy against a literal: extend
that literal with `scopeBlock: true, scopeBlockModels: true` and add both keys
to its yaml; in "an invalid value warns" (767-787) add `scope_block: sometimes`
and `scope_block_models: 3` and raise the expected warning count by two from
its current value (S13 and S14 add one each, in either order).
ADR 0028 gains an amendment naming both keys and stating that ADR 0016's
lists stay local and only their counts post. `help.ts` and
`config.example.yaml` document them; `commands/draft-review.md` mentions the
block in its annotations bullet.

### Never in the block

The human-review note, `wouldHaveEvent`, `wouldHaveSummary`,
`staleRequestChanges` and the uncovered-carry reason. ADR 0012 and ADR 0017
keep those local, and a test asserts their absence.

## Non-goals

- No change to the validated findings text or to `validate-output`.
- No new GitHub write; the block rides on the existing review body.
- No default-on. Turning it on is the repository's choice.

## Acceptance criteria

- AC-1. `record --evidence --symbols` stores `checks` with the membership and
  `reason` rules specified (a command present in both `commands` and
  `didNotRun` appears only in `staticDidNotRun`, with its `unavailable` text
  as `reason`); `runDetail` returns it; an old row returns null; `explain`
  prints it; `record --help` names both flags.
- AC-2. With `scope_block` off, every existing body-equality test passes
  unchanged and `post` sends the same bytes as before; the policy-shape test
  in `test/verdict-policies.test.mjs` is extended as specified and passes.
- AC-3. With `scope_block` on, the body ends with the block in the shape
  specified, built from the recorded run; a run without `checks` or
  `provenance` renders `not recorded` for those parts; `verdict`'s preview
  and `post`'s payload carry the same block.
- AC-4. The idempotency key of a run is identical with the block on and off;
  a CI annotation swap still works with the block present.
- AC-5. The block never contains the human-review note, the would-have fields,
  `staleRequestChanges` text or a carry reason, on a high-complexity run that
  has all of them.
- AC-6. Model ids appear only with `scope_block_models: true`; a configured
  check name containing backticks, U+202E and a zero-width space, and a
  90-code-point name, render flattened without those characters and cut as
  `safeCheckName` cuts them.
- AC-7. The trailing HTML comment is valid JSON with the keys shown, the full
  head sha, and held counts that cover every `HELD_VERDICTS` value through the
  stated mapping, with `other` for the rest.
- AC-8. A test asserts `docs/adr/0028-*.md` contains a `## Amendment - 2026`
  heading mentioning `scope_block`, `commands/review.md` carries the two new
  `record` flags, and `docs/adr/README.md` marks the row amended; `help.ts`,
  `config.example.yaml`, `draft-review.md` and `docs/ARCHITECTURE.md`
  ("Posting") document the block (reviewer-checked).
- AC-9. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/publish/**`, `plugins/review-voice/src/store/runs.ts`,
`plugins/review-voice/src/policy/load.ts`, `plugins/review-voice/src/cli.ts`
(`record`, `explain`), `plugins/review-voice/src/review/driver.ts`,
`plugins/review-voice/src/help.ts`, `plugins/review-voice/templates/config.example.yaml`,
`plugins/review-voice/commands/draft-review.md`, `plugins/review-voice/commands/review.md`,
`docs/adr/0028-*.md`, `docs/adr/README.md`, `docs/ARCHITECTURE.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S09-review-scope-block.md in
this repository. S02 and S08 are already on the base branch, so locate code by
function name. Read the spec first, then docs/adr/0028-verdict-policies-are-configurable.md,
docs/adr/0016-what-the-verifier-could-not-check.md,
docs/adr/0012-complex-changes-need-human-approval.md (the amendment that keeps
the human-review note off the pull request), plugins/review-voice/src/publish/verdict.ts
(buildPayload, withAnnotations, replaceAnnotations, safeCheckName, PlannedFindings,
VerdictPolicy) and plugins/review-voice/src/publish/post.ts (computeVerdict,
where the idempotency key is taken and annotations appended).

Outcome: `record --evidence --symbols` stores a checks summary with the run and
commands/review.md passes both flags; an exported safeCheckName and a pure
scopeBlock renderer build a collapsed "Review scope" block plus a trailing HTML
comment with JSON counts from the recorded run only, counting every held
verdict through the spec's mapping; computeVerdict appends it after the
findings and before any CI annotation when verdict.scope_block is true
(default false), after the idempotency key is taken, so verdict, post and watch
share one preview; model ids appear only with verdict.scope_block_models; the
block never carries the human-review note, would-have fields, stale
request-changes text or a carry reason; the policy-shape test is extended as
the spec says; ADR 0028 is amended and the docs updated. All nine acceptance
criteria in the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". Do not touch
validate-output or the findings contract, and add no GitHub write. Do not edit
scripts/, .github/, CHANGELOG.md or the manifests. Add no dependency. The only
existing test you may edit is test/verdict-policies.test.mjs as the spec says.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
