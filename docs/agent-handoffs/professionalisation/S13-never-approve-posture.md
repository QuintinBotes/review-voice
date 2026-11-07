# S13. An advisory posture: `verdict.never_approve`

**Phase:** 0 (trust), optional. **Depends on:** nothing. **Size:** about 50
source lines, 120 test lines, one ADR amendment; one Orbit run. **Risk:** low.
Baseline `919d0fd` (1.21.1). Verified against the code on 2026-11-07.

## Why

ADR 0010 lets Review Voice approve a pull request when nothing above a nit
survives verification, with the head and CI re-read first. The external
product specification this program draws on takes the opposite stance in its
own ADR 0003 (not this repository's `docs/adr/0003`): the bot never approves,
because "absence of a comment is not evidence the change is good", and the
external survey in the program README shows the field split on it
(Anthropic's reviewer and Sentry's never approve; CodeRabbit, Qodo, Sourcery
and Devin approve on opt-in). Review Voice already caps approval in several
cases (red CI, held findings, high complexity, structural opt-ins), each
through `decide()` in `plugins/review-voice/src/publish/verdict.ts`, whose
guard order is fixed: head moved (`:417-425`), carry of a standing owner
approval (`:430-445`), annotations (`:448-450`), the needs-rerun hold for
every event (`:456-463`, ADR 0013), uncovered carry (`:467-473`), the
complexity cap (`:477-500`), recheck (`:502-525`), then red and pending CI
(`:527-566`). A team that wants the advisory posture everywhere has no single
setting for it.

## Outcome

One setting makes every review advisory: `verdict.never_approve: true` turns
every APPROVE into COMMENT. REQUEST_CHANGES is unchanged, because a verified
blocking finding is a reason to stop, not an approval. The needs-rerun hold of
ADR 0013 still applies to every event.

## Design

- `verdict.never_approve: false` is read by `readVerdictPolicy`
  (`src/policy/load.ts:348-370`) into `VerdictPolicy` (`verdict.ts:275-296`).
  `test/verdict-policies.test.mjs` "config: each setting is read" (lines
  741-765) deep-equals the whole policy against a six-key literal; it gains
  `neverApprove: false` (and `never_approve` in its yaml), the one permitted
  edit to an existing test besides the help-key list below.
- In `decide()`, the `never_approve` branch sits immediately before the
  complexity cap (`:475-477`), after the carry, needs-rerun and uncovered-carry
  guards, so a standing owner approval still carries and a needs-rerun hold
  still applies. It mirrors the complexity cap: when `input.mapped === 'APPROVE'`
  and the policy is on, a `--recheck` returns
  `{ event: 'COMMENT', action: 'refuse', exitCode: 2, cappedByCi: false }`
  with the reason "there is no approval to re-check under never_approve";
  otherwise `{ event: 'COMMENT', action: 'post', exitCode: 0, cappedByCi: false }`
  with the reason "approval is left to a person by policy", `annotations`
  passed to `done()` as the complexity cap does. `cappedByCi` stays false,
  which is what keeps `queue.ts:179-195` from scheduling `recheck-ci`. When
  the complexity cap also applies, the policy branch runs first and its reason
  is the one recorded.
- `summaryLine` and `buildPayload` (`verdict.ts:578`, `:648`) gain `'policy'`
  in the `cappedBy` union, with the same plain strings the complexity cap uses
  ("No problems found." and "N nits."); `post.ts:413-419` adds
  `policy.neverApprove && planned.mapped === 'APPROVE' ? 'policy'` after the
  `held` arm and before `complexity`. The reason is local, in `reasons`.
- `help.ts` (the `verdict --help` key list that `test/verdict-policies.test.mjs:789-794`
  greps gains `never_approve`), `config.example.yaml` (`never_approve: false`
  under `verdict:`), `docs/WATCHER.md`, `commands/draft-review.md` (one bullet
  in the settings list at lines 40-52, and a note after `--recheck`) and
  `docs/ARCHITECTURE.md` "Posting" (the guard-order sentence and the settings
  list) document it. ADR 0028 gains an amendment naming the key and its
  relation to ADR 0010 (the default stays as 0010 decided); `docs/adr/README.md`
  marks the row.

## Non-goals

- No change to the default.
- No change to REQUEST_CHANGES or COMMENT behaviour.
- No change to the needs-rerun hold.

## Acceptance criteria

- AC-1. With `never_approve: true`, a clean review maps to COMMENT with the
  reason, including when CI is pending (no wait) and when CI is red (reason
  set unchanged beyond the cap, `annotations` preserved); a review with a
  blocking finding still maps to REQUEST_CHANGES; a table-test row with the
  policy on and `carried: <approval url>` shows the standing-approval carry
  still wins; a needs-rerun CI state still returns `wait` with exit 6.
- AC-2. `verdict --recheck` under the policy refuses with exit 2 and the
  stated reason; `cappedByCi` is false in both branches.
- AC-3. Under the default CI settings the posted body for a capped clean
  review is exactly "No problems found." (or "N nits."); with `ci_red: annotate`
  the annotation line still follows it, as it does for the complexity cap; the
  reason is only in local `reasons`.
- AC-4. In `test/watch.test.mjs`, with
  `config: { ...settings(), verdictPolicy: { ...DEFAULT_VERDICT_POLICY, neverApprove: true } }`
  and the fake's `state.ci` extended with `'pending'` (an in-progress check
  run), the head's row status is `posted` and the next pass lists no entry for
  it.
- AC-5. With the default false, every existing verdict test passes; the only
  edits to existing tests are the policy-literal and help-key additions in
  `test/verdict-policies.test.mjs` the design names.
- AC-6. `verdict --help` names `never_approve`; `config.example.yaml` contains
  `never_approve: false` and still loads with no warnings; a test asserts
  `docs/adr/0028-*.md` contains a `## Amendment - 2026` heading mentioning
  `never_approve`, `commands/draft-review.md` and `docs/WATCHER.md` mention
  it, and `docs/adr/README.md` marks the row; `docs/ARCHITECTURE.md` is
  updated (reviewer-checked).
- AC-7. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/publish/verdict.ts`, `plugins/review-voice/src/publish/post.ts`,
`plugins/review-voice/src/policy/load.ts`, `plugins/review-voice/src/help.ts`,
`plugins/review-voice/templates/config.example.yaml`, `plugins/review-voice/commands/draft-review.md`,
`docs/WATCHER.md`, `docs/ARCHITECTURE.md`, `docs/adr/0028-*.md`,
`docs/adr/README.md`, `test/**`, `plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S13-never-approve-posture.md
in this repository. Read the spec first, then
docs/adr/0010-review-verdict-posting.md, docs/adr/0013-ci-needs-rerun.md,
docs/adr/0028-verdict-policies-are-configurable.md, and decide(), summaryLine(),
buildPayload() and the VerdictPolicy type in plugins/review-voice/src/publish/verdict.ts
plus the cappedBy chain in plugins/review-voice/src/publish/post.ts.

Outcome: a verdict.never_approve setting (default false) turns APPROVE into
COMMENT in decide() at the position the spec fixes (after the carry,
needs-rerun and uncovered-carry guards, before the complexity cap), with a
local reason, cappedByCi false and annotations preserved; --recheck refuses
under it with exit 2; the posted summary uses the existing plain strings
through a 'policy' cappedBy; pending CI never makes such a head wait (no
waiting-ci, no recheck-ci) while the needs-rerun hold of ADR 0013 still applies
to every event; help, the example config, draft-review.md, WATCHER.md and
ARCHITECTURE.md document it; ADR 0028 is amended and the index marks it. All
seven acceptance criteria in the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". Do not change the
default or any other verdict rule. The only existing tests you may edit are
the two spots in test/verdict-policies.test.mjs the spec names, plus extending
the fake CI state in test/watch.test.mjs for AC-4. Do not edit scripts/,
.github/, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them).

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
