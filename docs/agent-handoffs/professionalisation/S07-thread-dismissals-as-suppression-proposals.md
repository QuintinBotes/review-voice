# S07. Thread dismissals become path-scoped suppression proposals

**Phase:** 2 (the learning loop closes). **Depends on:** S06. **Size:** about
220 source lines, 220 test lines, one additive migration, two ADR amendments;
one Orbit run. **Risk:** medium (a misclassified reply could propose a
suppression; approval still gates it). Baseline `919d0fd` (1.21.1). Verified
against the code on 2026-11-07.

## Why

`outcomes` already reads what became of every posted finding and records a
strong `dismissed` when a reply turned it down (`plugins/review-voice/src/store/outcomes.ts:414-464`,
ADR 0029). That signal feeds only the `evaluate` metrics: `compileProposals`
reads `feedback JOIN review_runs` and deliberately nothing else
(`src/policy/compile.ts:97-112`). So the one source of calibration evidence
that arrives without anyone running a command is thrown away, and the owner
must retype each dismissal as `/review-voice:feedback` for it to count.

Every proposal is global. `ProposedRule.scope` is typed `global | repository`
but only `global` is ever emitted, and `proposePolicy` hardcodes the scope in
its INSERT and its YAML (`compile.ts:14`, `:163`; `src/policy/versions.ts:25-55`);
`calibrate` stores the whole batch of proposals as one row (`cli.ts:2295`),
and version numbers are per `(scope_type, scope_key)` (`versions.ts:18-23`).
The policy schema allows `path` scope on an artifact and nothing uses it. The
`feedback` table has no path or glob field (`src/store/db.ts:30-40`), and
`feedback.actor` is the literal `'owner'` the CLI writes (`cli.ts:3703`), not a
login. Neither `checkOutcomes` (`outcomes.ts:197-206`) nor `compileProposals`
(`compile.ts:104`) knows the owner's login.

The product specification this program draws on scopes a dismissal to a rule
id and a path glob, and lets it suppress nothing until a maintainer approves
it. Review Voice has the approval gate and the rule id (S06); it lacks the
path scope and the thread source.

## Outcome

A strong dismissal on the pull request becomes evidence for a suppression
scoped to the rule and the directory it happened in. Nothing activates without
the owner's approval, and the owner's own replies count as owner signals.

## Design

### Who dismissed

`finding_outcomes` gains `decided_by TEXT` (one appended migration): the login
of the reply author that decided a strong outcome, or the owner's login when
an owner `dismiss` feedback row decided it. `saveOutcome` writes it; older rows
read null. Two existing tests touch the table shape and are updated as part of
this change: `test/human-review-complexity.test.mjs:367-393` rewinds
`schema_version` to 8 and reruns every later migration, so its rewind step
also drops `finding_outcomes.decided_by` before rewinding, beside the
`review_runs.provenance_json` drop S02 added (SQLite has no
`ADD COLUMN IF NOT EXISTS`); `test/issues-record.test.mjs:147` inserts into
`finding_outcomes` positionally with nine values and gains a column list.

`decide()` ignores replies from the account that posted the review
(`outcomes.ts:423-425`). When the review was posted with the owner's own
credential (ADR 0002) that account is the owner, so the owner's reply would
never become an outcome. Exempt from that filter a reply whose author equals
`ownerReviewer` (case-insensitive) and whose stance is `reject`; an
`acknowledge` from the poster stays ignored, because the posting account
agreeing with itself is not evidence. The ADR 0029 amendment names this.

`CheckOptions` gains optional `ownerReviewer?: string | null`; `outcomes`
passes `loadConfig(...).ownerReviewer` (loading config even with
`--repository`) and `watch` passes `config.ownerReviewer`: `followOutcomes`
(`src/watch/command.ts:380`) gains an `ownerReviewer: string | null`
parameter that `runPass` supplies from `config` at its call (`command.ts:244`),
and the `checkOutcomes` call (`command.ts:387`) forwards it. When absent, a
feedback-decided outcome stores null and every thread dismissal is a team
signal.

### Evidence from the thread

`compileProposals(db, { ownerReviewer })` gains an optional second argument so
existing callers stay valid; `calibrate` loads config to supply it. It reads a
second source: `finding_outcomes` where `outcome = 'dismissed'` and
`strength = 'strong'`, joined to `review_runs` for the finding's `ruleId`,
`path` and `category`. Each row is one signal with `actor: 'owner'` when
`decided_by` equals `ownerReviewer` (case-insensitive) and `actor: 'team'`
otherwise. An outcome row is dropped when a feedback row with action `dismiss`
or `never_flag` exists for the same `(review_run_id, finding_id)`, so a
dismissal counts once. The activation rule is unchanged: three signals, at
least one from the owner, no owner contradiction. Team dismissals alone can
therefore never activate a rule, which is ADR 0006's trust model, and the
owner replying "not a bug" on the pull request is now the same evidence as
running `feedback dismiss`.

### Scope

Only suppress proposals take a path scope; a prioritise proposal has no
dismissals and a `priorities` entry carries no glob, so it stays global. A
suppress proposal's scope is the longest common directory of every dismissal
in its bucket: `{ type: 'path', key: '<common directory>/**' }` with that glob
on its `suppressions[].glob`, or global when the common directory is the
repository root. `calibrate` groups the proposals by scope and calls
`proposePolicy` once per scope (one `policies` row per scope, each with its
own version sequence under the existing `UNIQUE (scope_type, scope_key, version)`),
printing one `{ policyId, version, scope }` per row.
`proposePolicy(db, rules, scope?)`, `rollbackTo(db, version, scope?)` and
`listPolicies(db, scope?)` take an optional `{ type, key }` scope; the default
is `{ type: 'global', key: 'owner' }` for `proposePolicy` and `rollbackTo`, and
`listPolicies` with no scope returns every scope, so the scope-less calls in
`test/scoring.test.mjs:174-231` stay valid. `approvePolicy(db, policyId)`
keeps its signature and deactivates siblings by the row's own `scope_type`
and `scope_key` (`versions.ts:95`). `policy show` lists every scope by default
and `policy show` and `policy rollback <version>` accept `--scope path:<glob>`
(default global); `approve <id>` needs no scope because the id is unique.
`help.ts:375-389` is updated.

### Loading and enforcement

`loadConfig` (S06) loads active `path` policies as layers after the global one,
and `score` applies a suppression only when the finding path matches its glob
(`governsAny` from `src/conventions/globs.ts`). The carve-out from S06 applies
unchanged.

### Documentation

ADR 0029 amendment: strong dismissals are calibration evidence as well as a
metric; silence and weak outcomes still are not. ADR 0004 amendment: the
strength rules now also decide whether an inferred outcome may become policy
evidence (strong only). `docs/adr/README.md` marks both. `docs/POLICY-FORMAT.md`
documents path scopes. `docs/ARCHITECTURE.md` "Scoring and activation" and
the comment at `compile.ts:114-116` say that rules stay keyed by rule id and
an approved rule's path scope only narrows where it applies.

## Non-goals

- No automatic activation (ADR 0005 and 0006 stand).
- No change to `classifyReply`'s regexes.
- No GitHub write.

## Acceptance criteria

- AC-1. `saveOutcome` records `decided_by` for a strong dismissal from a
  reply and for an owner feedback dismissal; a weak outcome records null; old
  rows migrate to null; a reply by the owner login on a comment posted under
  that same login yields dismissed/strong with `decided_by` equal to the owner
  login, and the same reply with stance acknowledge changes nothing; the
  rewind test in `test/human-review-complexity.test.mjs` and
  `test/issues-record.test.mjs` pass with their stated updates.
- AC-2. Three strong thread dismissals of `maintainability:diff` findings
  under `src/billing/` by the owner produce a proposal scoped
  `path:src/billing/**` with one `suppressions` entry carrying that glob and
  three provenance signals of actor `owner`.
- AC-3. Three strong dismissals by a teammate who is not the owner produce a
  proposal that `approvePolicy` refuses as not activatable (no owner signal).
- AC-4. Dismissals under `src/billing/` and `docs/` for the same rule produce
  a global proposal, not a path one.
- AC-5. A dismissal that also has a `dismiss` or `never_flag` feedback row
  counts once.
- AC-6. After approval, `score` holds a matching finding under `src/billing/`
  and leaves an identical finding under `src/orders/` eligible.
- AC-7. `calibrate` prints one row per scope; `policy show` lists both a
  global and a path policy and `--scope path:src/billing/**` narrows it;
  `policy rollback <version> --scope path:src/billing/**` rolls back that
  scope only.
- AC-8. A test asserts `docs/adr/0029-*.md` and `docs/adr/0004-*.md` each
  contain a `## Amendment - 2026` heading and that the `docs/adr/README.md`
  rows for 0004 and 0029 each contain `amended 2026-11` (the 0004 row already
  says `amended by 0029`, so a bare `amended` check would pass unchanged).
  `docs/POLICY-FORMAT.md` and `docs/ARCHITECTURE.md` are updated as specified
  (reviewer-checked).
- AC-9. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/policy/**`, `plugins/review-voice/src/store/outcomes.ts`,
`plugins/review-voice/src/store/db.ts`, `plugins/review-voice/src/scoring/score.ts`,
`plugins/review-voice/src/watch/command.ts` (`followOutcomes` and its call in
`runPass` only),
`plugins/review-voice/src/cli.ts` (`calibrate`, `policy`, `outcomes`),
`plugins/review-voice/src/help.ts`, `plugins/review-voice/skills/review-voice-policy/SKILL.md`,
`docs/POLICY-FORMAT.md`, `docs/ARCHITECTURE.md`, `docs/adr/0029-*.md`,
`docs/adr/0004-*.md`, `docs/adr/README.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S07-thread-dismissals-as-suppression-proposals.md
in this repository. S06 is already on the base branch. Read the spec first,
then docs/adr/0029-posted-findings-are-followed-to-an-outcome.md,
docs/adr/0004-outcome-inference-limits.md, docs/adr/0006-team-governance.md,
plugins/review-voice/src/store/outcomes.ts (decide, saveOutcome, CheckOptions),
plugins/review-voice/src/policy/compile.ts, plugins/review-voice/src/policy/versions.ts
and the calibrate and policy handlers in plugins/review-voice/src/cli.ts.

Outcome: finding_outcomes records who decided a strong dismissal (one appended
migration, with the two existing tests the spec names updated); decide()
exempts a reject reply by the owner login from its poster filter; checkOutcomes
and compileProposals take an optional ownerReviewer that outcomes, watch
(through followOutcomes) and calibrate supply from config; compileProposals
reads strong thread dismissals as signals, owner when the decider is the owner
reviewer and team otherwise, dropping rows a dismiss or never_flag feedback
row already covers; a suppress bucket's scope is the longest common directory
of its dismissals, global at the root, and prioritise proposals stay global;
calibrate writes one policies row per scope; proposePolicy, rollbackTo and
listPolicies take an optional scope defaulting to global, approvePolicy
deactivates by the row's own scope, and policy show and rollback accept
--scope; loading and scoring apply path-scoped suppressions by glob; ADR 0029
and ADR 0004 are amended and the index marks them with the date. All nine
acceptance criteria in the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". Do not change the
activation thresholds, classifyReply, or any GitHub write. Do not edit
scripts/, .github/, CHANGELOG.md or the manifests. Add no dependency. Append
migrations; never edit an existing one. The only existing tests you may edit
are the two the spec names.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities (use your-github-login style placeholders in tests).

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
