# S22. Path-scoped approval, and a visible queue of held findings

**Phase:** 6 (additions from the 2026-11-08 code review landscape report,
section 5 item 9). **Depends on:** S13 (`never_approve`, `cappedByPolicy` and
the `'policy'` summary line), S09 (`heldCounts`, `scopeBlock` and the exported
`safeCheckName`), S06 and S08 (the `policy-suppressed` and `restates-tool`
held verdicts), and S01 (the Action reads `verdict:` from the base commit).
All five are on `main`. Phase 6 runs after S12, so where S12 has moved a
command into `src/cli/`, that module takes the place of `cli.ts`. **Size:** about 240 source lines, 400
test lines, two ADR amendments; two Orbit runs (part A about 90 source lines,
part B about 150). **Risk:** low. Part A can only turn an APPROVE into a
COMMENT, and reads one more GitHub list only when a path list is set. Part B
prints text the run already recorded in two places that are not the pull
request (the Action's job summary and the watcher report), behind a switch
that is off. Baseline `main` at `6294511` (S01 to S11 and S13 merged). Line
references verified against that tree with git grep on 2026-11-08; where S12
or S14 moves code, locate it by function name.

## Why

Section 5 item 9 of the report asks for two things the field has and Review
Voice lacks. One is approval policy by path (Macroscope's `neverApprove` and
`onlyApprove`, Copilot's path-scoped approvals, cubic's `low_risk_only`). The
other is a held set a person can act on (Baz routes low-confidence findings to
a person). Section 4.2 items 4 and 5 give the reasons.

Approval can be capped today in three ways, and none of them is by path alone.

- `verdict.never_approve` caps every approval (S13, the branch in `decide()`
  at `plugins/review-voice/src/publish/verdict.ts:494-521`).
- `review.human_review.sensitive_paths` makes a change `high` complexity
  (`src/diff/complexity.ts:479-491` collects every changed path, renames by
  both names), and the complexity cap then turns APPROVE into COMMENT unless
  `cap_approval` is false (`verdict.ts:523`). High complexity also adds the
  local human-review note and makes `auto` mode pick `thorough`. So "the bot
  never approves a migration" costs a thorough review of every migration, and
  `cap_approval: false`, meant for complex code, lifts it.
- Nothing can say "the bot may approve only documentation".

Held findings are recorded and then hidden. Every run keeps
`held: HeldFinding[]` with a verdict and a reason (`src/store/runs.ts:119`,
`:131`), and `review --json` carries the list (`src/review/driver.ts:116`,
`:1359`). The Action's job summary prints only its length (`action.yml:102`)
and then the raw report in a collapsed JSON block (`:107`). The watcher prints
one line per pull request and nothing about what was held
(`src/watch/command.ts:244`). Only `explain` lists them (`src/cli.ts:4356`).

An owner can post a verified finding held by the score, confidence or policy
gate with `score --promote <candidate_id>` (`applyOwnerPromotion`,
`cli.ts:1795`; `commands/review.md:654`). Nothing tells them which held
entries qualify or what to run. A headless run cannot even be continued that
way. The driver pipes the score input from memory (`driver.ts:861-882`),
although its header says every file lands in the run directory
(`driver.ts:29`).

## Outcome

Two lists of globs under `verdict:` keep approval with a person by path. An
APPROVE becomes COMMENT, with a local reason, when a path the pull request
changes matches `never_approve_paths`, or when one falls outside
`only_approve_paths`. With `verdict.held_queue: true`, the Action's job
summary and the watcher report list each held finding with its verdict and
reason. Each one `score --promote` can post carries the exact command that
re-scores it from the run directory. The posted review, the GitHub write and
the S09 scope block counts are unchanged.

## Design

### Part A. Approval by path

**Settings.** `VerdictPolicy` (`verdict.ts:275`) gains
`neverApprovePaths: string[]` and `onlyApprovePaths: string[]`, both empty in
`DEFAULT_VERDICT_POLICY` (`:291`). `readVerdictPolicy`
(`src/policy/load.ts:374`) reads `verdict.never_approve_paths` and
`verdict.only_approve_paths`. A value that is not a list warns and keeps the
default, as every verdict setting does. A non-string or blank entry warns and
is skipped. The reader assigns new arrays and never mutates the defaults. An
empty list means no restriction; an owner who wants no approvals at all sets
`never_approve`. In the Action the configuration comes from the base commit
(S01), so a pull request cannot widen its own list. Globs compile with
`globToRegExp` (`src/conventions/globs.ts:57`), the matcher the sensitive
paths use. It is anchored and case-sensitive, and knows `**`, `*` and `?`.

**The changed paths.** `src/publish/post.ts` gains
`readChangedPaths(client, repository, pullNumber): Promise<{ paths: string[]; truncated: boolean }>`
beside `readHead` (`:121`). It pages
`/repos/{repository}/pulls/{n}/files?per_page=100` through `client.paginate`
with a limit of 3000, GitHub's own cap on that list
(`src/diff/pull-request.ts:63`). It keeps `filename` and `previous_filename`
of every entry, deleted files included, because a rename out of a guarded
directory touches it. `truncated` is true when 3000 entries came back, since
more may exist. A failed read throws, as a failed `readHead` does, so nothing
is posted and the watcher retries the head. These are the pull request's
paths, not the review scope's. An incremental review of a later commit must
not approve a pull request whose first commit touched a guarded path, the
same reason `pullRequestComplexity` walks prior runs.

**The rule.** `verdict.ts` gains a pure
`approvalPathHold(changed, policy): string | null`, where `policy` is
`Pick<VerdictPolicy, 'neverApprovePaths' | 'onlyApprovePaths'>`.

- It returns null when both lists are empty.
- A truncated list returns
  `approval is left to a person, as the pull request lists more files than GitHub returns, so the approval paths cannot be checked`.
- A path matching a `never_approve_paths` glob returns
  `approval is left to a person, as verdict.never_approve_paths matches <paths>`.
- Otherwise, with `only_approve_paths` set, a path matching none of its globs
  returns `approval is left to a person, as verdict.only_approve_paths does not cover <paths>`.
- Anything else returns null.

`<paths>` is the first three matching paths, sorted and joined by `, `, then
`, +N more` when there are more, as the sensitive-paths reason reads.

`computeVerdict` calls `readChangedPaths` and `approvalPathHold` only when the
answer could change the event. That is when the head did not move,
`planned.mapped` is APPROVE, `never_approve` is off, no standing approval was
found to carry (`post.ts:382`), and at least one list is non-empty. Under the
defaults no new request is made.

**The guard.** `decide()` (`verdict.ts:397`) takes
`approvalPathHold?: string | null`. The `never_approve` branch at `:499`
becomes one policy branch in the same slot, after the carry, needs-rerun and
uncovered-carry guards and before the complexity cap and CI. Its reason is
`never_approve`'s fixed text when that is on, else the path reason. A
`--recheck` under a path hold refuses with exit 2 and the reason
`there is no approval to re-check under the approval paths`; the
`never_approve` texts are unchanged. Both outcomes set `cappedByPolicy: true`
and `cappedByCi: false`, and a post keeps its annotations. So pending CI never
makes such a head wait, a standing owner approval still carries, the
needs-rerun hold still applies to every event, and the watcher settles a
queued recheck exactly as it does for `never_approve`
(`src/watch/command.ts:376`). The doc comments on `Decision.cappedByPolicy`
(`verdict.ts:380`) and `VerdictOutput.cappedByPolicy` (`post.ts:101`) name
both settings.

**The posted body.** The arm `policy.neverApprove && planned.mapped === 'APPROVE'`
in the `cappedBy` chain (`post.ts:425`) becomes `decision.cappedByPolicy`.
That flag is true only on the branch that posts COMMENT for a mapped APPROVE,
so `never_approve` behaves as before and a path hold posts the same plain
line, `No problems found.` or `N nits.` The reason stays in the local
`reasons`. The idempotency key (`:435`) and the scope block (`:441`) are
untouched.

**Documents.** `help.ts` (the `verdict --help` settings, `:496`),
`templates/config.example.yaml` (`never_approve_paths: []` and
`only_approve_paths: []` under `verdict:`, beside `never_approve` at `:176`),
`commands/draft-review.md` (the settings list at `:48`), `docs/WATCHER.md`
(the `verdict:` block at `:191` and a row in the "Verdict policy" table,
`:334`) and `docs/ARCHITECTURE.md` "Posting" (`:1147`) document both keys.
They say when to use which. `sensitive_paths` is for code that needs a
person's eyes and a thorough review; the path lists are an approval rule and
cost nothing. ADR 0028 gains a dated amendment naming both keys, their slot
in the guard order, the live file list and its fail-closed cap, and
`docs/adr/README.md` marks the row.

### Part B. The held queue

**Settings.** `VerdictPolicy` gains `heldQueue: boolean`, read from
`verdict.held_queue`, default false. It changes nothing about the verdict. It
sits under `verdict:` beside `scope_block` because it decides what a review
shows about what it held, and the watcher already carries `verdictPolicy` in
its settings. `contextCommand` (`cli.ts:922`, or `src/cli/context.ts` once
S12 has moved it) adds `heldQueue: config.verdictPolicy.heldQueue` to its
output. The driver already reads configuration through `context.json`
(`driver.ts:441`), written after `resolveConfig` (`driver.ts:272`) pointed
`REVIEW_VOICE_CONFIG` at the trusted file (in the Action, the base commit's
copy in the run directory).

**What the run keeps.** The driver's `score` stage (`driver.ts:861`) writes
the exact input it pipes to `score` to `score-input.json` in the run
directory, on every scored run, so the run can be continued by hand as the
driver's header says. It keeps the call on the run as a `PromoteCall`, which
holds the arguments it passed, `process.cwd()`, and `REVIEW_VOICE_CONFIG` and
`REVIEW_VOICE_DATA_DIR` when set, the two environment variables `score` reads.

**The entries.** A new module `src/review/held-queue.ts` exports these.

```ts
interface PromoteCall {
  program: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  args: readonly string[];
  stdin: string;
  stdout: string;
}
interface HeldQueueEntry {
  path: string;
  line: number;
  severity: string | null;
  verdict: string;
  reason: string;
  candidateId: string | null;
  /** The command that re-scores the run with this finding promoted; null when `score --promote` cannot post it. */
  promote: string | null;
}
function heldQueue(held: readonly HeldFinding[], call: PromoteCall | null): HeldQueueEntry[];
function heldQueueLines(entries: readonly HeldQueueEntry[], runId: string | null): string[];
function writeJobSummary(report: Pick<ReviewReport, 'heldQueue' | 'runId'>, env: NodeJS.ProcessEnv): string | null;
```

`heldQueue` maps every `run.held` entry, in order, one to one, so its length
is the sum of S09's `heldCounts` (`verdict.ts:738`). `promote` is set for
`below-gate` and `policy-suppressed` entries that have a `candidateId`, when
the run kept its call. Those are the two verdicts `applyOwnerPromotion`
accepts with a bare `--promote`. It is null for every other verdict,
`unverified` included (decision 4 below), and so for S16's
`reproduction-did-not-fail` and for S17's `challenger not run:` holds (verdict
`challenge-partly`), which the list shows with their reasons. The command is

```
cd <cwd> && [REVIEW_VOICE_CONFIG=<path>] [REVIEW_VOICE_DATA_DIR=<dir>] <node> <cli> score <the driver's arguments> --promote <id> < <run>/score-input.json > <run>/scores.promoted.json
```

`<node>` is `process.execPath`. `<cli>` comes from a new optional
`ReviewDeps.cli` (`driver.ts:70`), which `reviewCommand` sets to the running
bundle, `fileURLToPath(import.meta.url)`, the path `spawnReview` is given
(`cli.ts:5680`). Without it no command is built. A word is written bare when
it holds only letters, digits and `_@%+=:,./-`, and single-quoted otherwise,
with `'` written as `'\''`, for a POSIX shell. A word holding a backtick or a
control character makes `promote` null, so the command can always sit in one
inline code span. The output goes to `scores.promoted.json`, so the run's own
`scores.json` is never overwritten.

The driver builds the queue in `record` (`driver.ts:1027`), after
`heldForRecord` settles the entries, when `context.json` says
`heldQueue: true`. `ReviewReport` (`:107`) gains
`heldQueue?: HeldQueueEntry[]`, present only then. A run that ends before
`record`, a carried one included, has none.

**Rendering.** `heldQueueLines` returns nothing for an empty list. Otherwise
it returns a first line `Held by Review Voice (N), run <id>`, then the note
`A promoted finding still has to pass the challenge. Continue from step 4b of commands/review.md, with scores.promoted.json in place of scores.json.`,
then one line per entry. An entry line is `- ` followed by the location,
severity, verdict and reason, each in an inline code span after
`safeCheckName`, then `Promote with <the command in a code span>.` or
`Not promotable.` `safeCheckName` (`verdict.ts:317`) has the optional `max`
parameter S15 adds, default the current 60 (`:311`); if S15 has not landed,
this spec adds it exactly as S15 specifies. The queue passes 200 for a path
and 120 for a reason, and every existing caller is unchanged. Each untrusted
string becomes one line without backticks inside a code span, so nothing in
it can render as markdown or HTML, the way the scope block renders names.

**The job summary.** `writeJobSummary` appends the lines, the first as a
`## ` heading, to the file `GITHUB_STEP_SUMMARY` names, only when
`GITHUB_ACTIONS` is `true`, that path is absolute and the queue is non-empty.
It returns a warning when the append fails and null otherwise, and it never
changes the exit code. `reviewCommand` (`cli.ts:5846`) calls it after
`runReview` and prints a warning on stderr. `action.yml` is not edited. The
Action already calls `review` (`action.yml:92-96`) and the runner owns the
summary file, so the list appears in the job summary above the Action's own
`## Review Voice` section (`:100`). Every field in it is already in the report
JSON that section prints (`:107`). The job summary is not a GitHub API write
by Review Voice, so the single write of ADR 0010 is untouched.

**The watcher report.** `ReviewResult` (`src/watch/review.ts:5`) gains
`heldQueue?: HeldQueueEntry[]`. `reviewResult` (`:42`) keeps the well-formed
entries of the child's `heldQueue` and omits the key when there are none, as
it does for `failureMode` (`:69`), so existing results keep their shape. The
child review reads the watcher's own config copy, so the switch is the
watcher's. `Outcome` (`src/watch/command.ts:50`) carries the rendered lines
from `review()` (`:303`). In `runPass` (`:212`) a `review` entry whose result
carries a queue prints them under its report line (`:244`), two spaces in.
With `--json` the same lines go to stderr after the rows, as the retention
line does (`:252`), so stdout stays one JSON document. A `verdict-only` or
`recheck-ci` entry prints none, because its run was listed when it was
reviewed.

**The scope block.** Nothing in either part changes `run.held`, `heldCounts`,
`scopeBlock` or the posted body, so the S09 counts are unchanged. A test pins
it.

**Documents.** `help.ts` (`verdict --help` names `held_queue`;
`review --help`, `:905`, says `--json` carries `heldQueue` under it and that
a run inside GitHub Actions appends the list to the job summary),
`config.example.yaml` (`held_queue: false`), `docs/WATCHER.md` (the "`watch`"
section, `:286`, names the held lines) and `docs/ARCHITECTURE.md` (beside
"Review scope", `:1189`). ADR 0031 gains a dated amendment for the job summary
list, and `docs/adr/README.md` marks its row.

### Order against the other market specs

S22 is eighth of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"):

- After S15, which gives `safeCheckName` its `max` parameter, adds
  `withEvidenceBlocks` to `computeVerdict` and extends the
  `test/verdict-policies.test.mjs` literal and help-key list first; this
  spec's keys join that literal and list.
- After S17, whose `challenger not run:` cap in `planFindings` sets
  `heldBackApproval`; a path hold is a separate guard in `decide()`.
- After S16, S17 and S21. The queue lists S16's and S17's new holds, and
  `runPass` already prints S21's pass-level `replies:` line, which these
  per-entry lines do not change.
- Before S24, which changes `decide()`'s held-back reason, reads `policy`
  earlier in `computeVerdict`, adds its own ADR 0028 amendment after this
  one and adds `minPostedTier` and `readingGuide` to the same policy literal.
  Its `belowTier` findings are not in this queue (Non-goals).

### Decisions for the owner

The spec implements the default named in each. A run that meets one applies
the default and files an issue, as `GOAL.md` says.

1. `never_approve_paths` overlaps `review.human_review.sensitive_paths`,
   which already holds approval on matched paths through the complexity cap.
   The difference is cost and intent. The path list adds no thorough mode and
   no human-review note, and `cap_approval: false` does not lift it. The
   default ships both lists. The alternative ships `only_approve_paths` alone
   and points the docs at `sensitive_paths`.
2. Under a path hold the posted body is the plain `No problems found.` line
   and the reason stays local, as for `never_approve` and the complexity cap.
   Section 6 item 8 of the report warns against silent withholding of
   approval. The default keeps the plain line. The alternative posts a fixed
   sentence naming the setting, which changes the posted shape.
3. A malformed path list warns and keeps the default, which is no
   restriction, as every verdict setting does. The default follows that
   precedent. The alternative fails closed and holds every approval until the
   list is fixed.
4. `unverified` entries get no command, although
   `score --promote <id> --allow-unverifiable --owner-note "<why>"` accepts
   one held by the unverifiable cap alone. The default prints none, so the
   queue never offers a route to post a claim the verifier could not check.
5. The list reaches the job summary because `review` appends it, so it sits
   above the Action's own section. Moving it below needs a person to edit
   `action.yml`, a protected path. The default is the append; a person may
   file the reorder as a follow-up.
6. In the Action, the commands name runner paths that do not outlive the job,
   and the data directory survives only in the actions cache. The default
   prints them anyway. The alternative prints only the candidate id there.
7. One switch gates the report key, the job summary and the watcher lines.
   Neither surface is the pull request. The default is off, as for every new
   surface in this program.

## Non-goals

- No change to `never_approve`, `sensitive_paths`, the complexity cap, any
  default, the posted body text or the validated findings. No new GitHub
  write.
- The commands are printed for a person and never run. No command posts
  anything, and a promoted finding still goes through the challenge.
- No claim text in the list (`explain --run <id>` shows it), no `decline`
  command, and no list in the `review` text report or the interactive flow.
- No edit to `action.yml`, `scripts/`, `.github/`, the manifests or
  `CHANGELOG.md`.
- POSIX shells only. A watcher on Windows prints the same command.
- S24 lands after this spec. Its `belowTier` findings are verified findings a
  posting tier withheld, not findings `score` held. They are not in this
  list, and `score --promote` cannot post them.

## Acceptance criteria

Part A:

- AC-1. `verdict.never_approve_paths` and `verdict.only_approve_paths` are
  read as lists of globs, default empty; a non-list warns and keeps the
  default; a non-string or blank entry warns and is skipped. The literal in
  `test/verdict-policies.test.mjs` "config: each setting is read" (`:741`)
  gains both keys in its yaml and its expected object, and the help-key list
  (`:800`) gains both names; these are the only edits to existing tests in
  part A (`test/approval-paths.test.mjs`, new).
- AC-2. `approvalPathHold` returns the specified text in a table test for a
  matching path, a rename whose previous path matches, a deleted file, a
  change wholly inside `only_approve_paths` (null), one path outside it, both
  lists set, a truncated list and both lists empty (null); the path list
  shows three paths and `+N more` (`test/approval-paths.test.mjs`).
- AC-3. In `decide()`, a path hold on a mapped APPROVE posts COMMENT with exit
  0, the path reason, `cappedByPolicy: true` and `cappedByCi: false`, for
  green, pending and red CI; with `ci_red: annotate` the annotations are kept;
  `--recheck` refuses with exit 2, the stated reason and
  `cappedByPolicy: true`; REQUEST_CHANGES and COMMENT are unchanged; a
  standing owner approval still carries; a needs-rerun state still waits with
  exit 6; with `never_approve` also on, its reason is the one recorded; with
  `needsHuman` also true, the path reason is recorded.
  `test/never-approve.test.mjs` passes unchanged
  (`test/approval-paths.test.mjs`).
- AC-4. Through `computeVerdict`, with a fake GitHub shaped like the one at
  `test/never-approve.test.mjs:143` that also serves `/pulls/7/files`, a
  change to `db/migrate/001.sql` under
  `never_approve_paths: ['db/migrate/**']` yields event COMMENT, a body of
  exactly `No problems found.` (`1 nit.` with one nit) and the reason only in
  `reasons`. `only_approve_paths: ['docs/**']` approves a change to
  `docs/a.md` and comments on one that also changes `src/a.ts`. 3000 listed
  files hold with the truncation reason. With both lists empty, with a mapped
  COMMENT, and with a moved head, the fake records no request to the files
  list. A 404 for the files list makes `computeVerdict` reject
  (`test/approval-paths.test.mjs`).
- AC-5. `verdict --help` names both keys; `config.example.yaml` carries
  `never_approve_paths: []` and `only_approve_paths: []` and still loads with
  no warnings (`test/issues-config.test.mjs:39`); a test asserts that
  `docs/adr/0028-*.md` has a `## Amendment - 2026` heading and names
  `never_approve_paths`, and that `docs/adr/README.md`,
  `commands/draft-review.md` and `docs/WATCHER.md` name both keys;
  `docs/ARCHITECTURE.md` "Posting" is updated (reviewer-checked).

Part B:

- AC-6. `verdict.held_queue` is read, default false, and a bad value warns;
  the `test/verdict-policies.test.mjs` literal and help-key list gain it,
  the only edits to existing test cases in part B; `context` prints
  `heldQueue` (`test/held-queue.test.mjs`, new).
- AC-7. Every scored run leaves `score-input.json` in its run directory, equal
  as JSON to the input `score` read. With `verdict.held_queue: true` at the
  base commit, the report carries `heldQueue`, one entry per `held` entry in
  order; under the default it has no `heldQueue` key. In a driver test with
  the fake agents, where the verifier confirms `cand_001` at confidence 0.7,
  the report has one `below-gate` entry. Its `promote` command, run with
  `sh -c` after the review returned, exits 0 and writes `scores.promoted.json`
  whose `eligible` lists `cand_001` with `ownerPromotion.gate` equal to
  `confidence` (new cases in `test/review-driver.test.mjs`, built on its
  `repository` and `fakeGitHub` helpers at `:40` and `:78`, calling
  `runReview` with `cli` set to the bundle).
- AC-8. `heldQueue` sets `promote` only for `below-gate` and
  `policy-suppressed` entries with a candidate id and a call. It is null for
  every other `HeldVerdict`, for an entry without a candidate id, without a
  call, and when a word holds a backtick or a control character; a word with a
  space or a quote is single-quoted. `heldQueueLines` returns nothing for an
  empty list; for entries whose path and reason hold backticks, newlines and
  `<details>`, no output line holds a newline and no code span's text holds a
  backtick. `safeCheckName` called with one argument behaves as before
  (`test/held-queue.test.mjs`).
- AC-9. `writeJobSummary` appends the heading and lines to a temporary
  `GITHUB_STEP_SUMMARY` file with `GITHUB_ACTIONS=true`; it writes nothing
  without `GITHUB_ACTIONS`, with a relative path, or with no or an empty
  `heldQueue`; it returns a warning when the path is a directory.
  `test/action.test.mjs` passes unchanged and `action.yml` is not in the diff
  (reviewer-checked) (`test/held-queue.test.mjs`).
- AC-10. `reviewResult` carries a well-formed `heldQueue` and omits the key
  otherwise; the deep-equal cases at `test/watch.test.mjs:641` pass unchanged.
  A `watch --once` pass whose fake review result carries two entries prints
  them two spaces in under that entry's line; with `--json`, stdout parses as
  one JSON array and the lines are on stderr; a result without a queue prints
  exactly what it printed before (new cases in `test/watch.test.mjs`, using
  `fakeReview` and `withWatcher` at `:114` and `:140`).
- AC-11. For a recorded run holding one entry of every `HeldVerdict`,
  `computeVerdict` with `scope_block: true` returns a payload whose scope
  block is byte-identical with `held_queue` on and off, and with and without
  a path hold (`never_approve_paths` matching a changed file), and
  `heldQueue(run.held).length` equals the sum of `heldCounts(run.held)`
  (`test/held-queue.test.mjs`).
- AC-12. `verdict --help` names `held_queue`; `review --help` names
  `heldQueue` and the job summary; `config.example.yaml` carries
  `held_queue: false` and still loads with no warnings; a test asserts that
  `docs/adr/0031-*.md` has a `## Amendment - 2026` heading and names
  `held_queue`, and that `docs/adr/README.md` and `docs/WATCHER.md` name it;
  `docs/ARCHITECTURE.md` is updated (reviewer-checked).

Both parts:

- AC-13. `npm run verify` passes with the rebuilt bundle committed.

Stop point. The parts are independent. Run part A first; part B then extends
the same test literal and help-key list.

## Allowed paths

`plugins/review-voice/src/publish/verdict.ts`,
`plugins/review-voice/src/publish/post.ts`,
`plugins/review-voice/src/policy/load.ts`, `plugins/review-voice/src/help.ts`,
`plugins/review-voice/src/review/held-queue.ts` (new, part B),
`plugins/review-voice/src/review/driver.ts` (part B),
`plugins/review-voice/src/cli.ts` (`contextCommand` and `reviewCommand`,
part B), `plugins/review-voice/src/cli/context.ts` (part B, only once S12 has
moved `contextCommand` there), `plugins/review-voice/src/watch/review.ts` and
`plugins/review-voice/src/watch/command.ts` (part B),
`plugins/review-voice/templates/config.example.yaml`,
`plugins/review-voice/commands/draft-review.md` (part A), `docs/WATCHER.md`,
`docs/ARCHITECTURE.md`, `docs/adr/0028-*.md` (part A), `docs/adr/0031-*.md`
(part B), `docs/adr/README.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal, part A

```
Implement part A of docs/agent-handoffs/professionalisation/S22-path-scoped-approval-and-held-queue.md
in this repository. S15 and S17 are already on the base branch (see the
spec's "Order against the other market specs"), so locate code by function
name. Read the spec first, then
docs/adr/0028-verdict-policies-are-configurable.md, decide(), the
VerdictPolicy type, DEFAULT_VERDICT_POLICY and summaryLine() in
plugins/review-voice/src/publish/verdict.ts, readVerdictPolicy() in
plugins/review-voice/src/policy/load.ts, readHead(), computeVerdict() and its
cappedBy chain in plugins/review-voice/src/publish/post.ts, globToRegExp in
plugins/review-voice/src/conventions/globs.ts, the sensitive-path matching in
plugins/review-voice/src/diff/complexity.ts, and test/never-approve.test.mjs
(the decide table and the fake GitHub to copy into a new test file).

Outcome: verdict.never_approve_paths and verdict.only_approve_paths (lists of
globs, default empty) are read; computeVerdict reads the pull request's whole
file list from GitHub (renames by both names, deleted files included, 3000
entries holding approval as possibly truncated) only when a list is set and
the answer could change the event; a pure approvalPathHold gives the local
reason; decide() treats a path hold in never_approve's slot, so an APPROVE
becomes COMMENT with cappedByPolicy true and annotations kept, --recheck
refuses with exit 2, and a carry, a needs-rerun hold and never_approve's own
reason still win; the cappedBy arm becomes decision.cappedByPolicy, so the
posted body is the existing plain line; help, the example config,
draft-review.md, WATCHER.md and ARCHITECTURE.md document both keys and when
to prefer sensitive_paths; ADR 0028 is amended and the index marks it.
Acceptance criteria AC-1 to AC-5 and AC-13 of the spec must hold.

Scope: only the paths the spec lists under "Allowed paths" for part A. Do not
change never_approve, sensitive_paths, the complexity cap, any default or the
posted body text; nothing new is posted to GitHub. The only existing tests you
may edit are the policy literal and the help-key list in
test/verdict-policies.test.mjs. Do not edit action.yml, scripts/, .github/,
CHANGELOG.md or the manifests. Add no dependency.

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
Implement part B of docs/agent-handoffs/professionalisation/S22-path-scoped-approval-and-held-queue.md
in this repository. Part A is already on the base branch, as are S15, S16,
S17 and, when the owner admitted it, S21, and S12 may have
moved cli.ts into src/cli/ (contextCommand to src/cli/context.ts,
applyOwnerPromotion and gateOf to src/cli/score.ts), so locate code by
function name. Read the spec first,
then docs/adr/0031-a-github-action-runs-one-review-per-pull-request-event.md,
action.yml (only to see how the job summary is written; do not edit it),
the score, record and resolveConfig functions and the ReviewDeps and
ReviewReport types in plugins/review-voice/src/review/driver.ts,
contextCommand, reviewCommand, applyOwnerPromotion and gateOf in
plugins/review-voice/src/cli.ts, safeCheckName, heldCounts and scopeBlock in
plugins/review-voice/src/publish/verdict.ts, HeldFinding and HELD_VERDICTS in
plugins/review-voice/src/store/runs.ts, reviewResult in
plugins/review-voice/src/watch/review.ts, runPass and review in
plugins/review-voice/src/watch/command.ts, and commands/review.md steps 4 and
4b.

Outcome: verdict.held_queue (default false) is read and context prints it;
the driver writes score-input.json on every scored run and keeps its score
call; with the switch on, the review report carries heldQueue, one entry per
held entry, where below-gate and policy-suppressed entries with a candidate
id carry the exact, POSIX-quoted score --promote command (cd, the two
REVIEW_VOICE_ variables when set, process.execPath, ReviewDeps.cli, the
driver's arguments, score-input.json in, scores.promoted.json out) and every
other entry carries none; heldQueueLines renders the list with every
untrusted string through safeCheckName (with the optional max S15 adds) inside
code spans; review appends it to GITHUB_STEP_SUMMARY inside GitHub Actions
without failing the run; the watcher prints it under the entry's line, or on
stderr with --json; the S09 scope block is byte-identical with the switch on
or off; help, the example config, WATCHER.md and ARCHITECTURE.md document it;
ADR 0031 is amended and the index marks it. Acceptance criteria AC-6 to AC-13
of the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". No command is ever
run by the product and nothing new is posted to GitHub. The only existing test
cases you may edit are the policy literal and the help-key list in
test/verdict-policies.test.mjs; new cases go in test/held-queue.test.mjs,
test/review-driver.test.mjs and test/watch.test.mjs. Do not edit action.yml,
scripts/, .github/, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
