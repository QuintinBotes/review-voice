# S03. Failure modes by risk, and run-directory retention

**Phase:** 0 (trust). **Depends on:** nothing (S02 is a natural companion).
**Size:** about 300 source lines, 300 test lines; one Orbit run, or two with the
stop point below. **Risk:** low to medium (new deletion path, guarded by
preview and defaults the documents already promise). Baseline `919d0fd`
(1.21.1). Verified against the code on 2026-11-07.

## Why

### Failure has one shape

When a review cannot complete, the driver throws `Stop(code)` and exits 2, 3,
7 or 1 (`plugins/review-voice/src/review/driver.ts:88-95`, `:906-908`). Nothing
is written to `review_runs` or the audit log, and nothing reaches GitHub. The
Action passes the exit code through, so a model outage turns the check red on
every path, documentation-only pull requests included (`action.yml:112-116`).
The watcher reads a `ReviewResult` (`src/watch/review.ts:5-13`) that carries
only `exitCode`, `runId`, `event`, `reviewUrl`, `detail` and `carried`, maps
every non 0/3/4/6 exit to one `failed` status (`src/watch/command.ts:296-307`),
retries up to `watch.max_attempts_per_head`, then drops the head from the
queue; a person sees it only in the pass line, `status` or `queue --settled`.
The retry cap is implemented by string equality on `'failed'` in five places
(`src/store/watch.ts:64`, `:120`; `src/queue/store.ts:50`; `src/watch/command.ts:255`;
`src/queue/command.ts:44`).

Yet the risk of the change is known before any agent runs. `prep` computes the
complexity assessment (level, reasons, sensitive paths) and the human-review
note in its first step (`driver.ts:264-283`, `cli.ts:698-719`), and
`evidence.json` and `files.json` are on disk. A failed run could say what it
did establish and whether a person must look.

### Run directories are kept forever and undocumented

Run directories live at `<data dir>/runs/<owner-repo>-<pr>-<sha8>` or at
`--out` (`driver.ts:253-260`). They hold the raw `diff.patch`, `base/` copies
of every changed file, `history/`, `thread.json` and every stage's JSON
(`driver.ts:289-306`, `:372-421`). Nothing deletes them: the only reference to
the folder in `src` is its creator, and `purge` deletes database tables only
(`src/consent/purge.ts:77-88`). The Action caches the whole data directory,
runs included (`action.yml:67-72`). `PRIVACY.md` lists neither `runs/` nor
`clones/`, states a 180-day audit retention nothing enforces, lists an
`audit/events.jsonl` file that nothing writes (the audit log is the
`audit_events` table, `src/store/audit.ts:32-44`, `src/store/db.ts:43-51`),
and says "Original, unredacted text: Never stored" while run directories hold
the reviewed code and the thread. ADR 0005 states a 30-day raw retention by
default.

## Outcome

A review that cannot complete ends in a named state, `failed_open` or
`failed_closed`, decided by the change's risk, and reports the deterministic
facts it did establish. Run directories and audit events have a stated
retention that the code enforces, and `PRIVACY.md` is true.

## Design

### Failure classification

```ts
interface ReviewFailure {
  code: number;                       // the exit code
  stage: StageId | 'unknown';         // 'unknown' when thrown before the stage loop (headOf, expectHead, mkdir)
  mode: 'failed_open' | 'failed_closed';
  risk: 'high' | 'normal' | 'unknown';   // complexity.level when prep got that far
  reasons: string[];                  // complexity reasons when high; 'risk not assessed' otherwise
  facts: {
    complexity: ComplexityAssessment | null;
    structure: { sizeCrossings: number; branchGrowth: number; typeEscapes: number } | null;  // array lengths from run.summary.structure
    staticChecks: { ran: string[]; failed: { name: string; exitCode: number }[]; didNotRun: string[] } | null;
  };
}
```

Rule: `mode` is `failed_closed` when `risk` is `high` or `unknown`, and
`failed_open` when `risk` is `normal`. Unknown risk fails closed because a
reviewer that could not even read the change has no grounds to wave it
through. Exit 3 (head moved) is not a failure and gets no `failure` object.

`staticChecks` is read from `evidence.json` when it exists: `ran` is the names
of `commands` entries with `exitCode !== null` and no `unavailable`, `failed`
those among them with a non-zero `exitCode`, `didNotRun` the file's
`didNotRun` (so a command S08 marks unavailable appears once, as not run); a
file with no `commands` key
(the `REVIEW_VOICE_NO_COMMANDS` stub) yields `{ ran: [], failed: [], didNotRun: [] }`
(S08 makes that stub name the skipped commands; until then the list is empty).

In the driver's catch block, build `failure` from `run.summary` and
`evidence.json`. `ReviewReport` gains `failure: ReviewFailure | null`.
`reportText` prints:

```
Review unavailable (failed_closed, exit 7): the evidence-verifier failed twice
Risk: high. Reasons: touches sensitive paths (.github/workflows/ci.yml)
Checks: typecheck ran (exit 0), lint did not run
Needs a human reviewer: <humanReviewNote when present>
```

One audit event `review_failed` is appended with repository, pull request,
head, code, stage and mode. No `review_runs` row is written; ADR 0022's
"records nothing" becomes "records no run" by amendment, with the audit event
named.

### Watcher

`ReviewResult` (`src/watch/review.ts`) gains `failureMode?: 'failed_open' | 'failed_closed'`,
set by `reviewResult()` from `doc.failure.mode` only when the child's JSON
carries it (the key is omitted otherwise, so the exact-shape assertions at
`test/watch.test.mjs:596-612` stay green); the exit-124 timeout result and
unparseable JSON leave it unset. `HeadStatus` gains `failed-open` and
`failed-closed`; the watcher writes them from `failureMode` and keeps `failed`
for a child with no report. `detail` carries `failed_closed: <reason>`.

`src/store/watch.ts` exports `isFailure(status)` (true for `failed`,
`failed-open`, `failed-closed`) and it replaces the five `=== 'failed'` checks:
attempts increment (`store/watch.ts:64`), `settledHeads` (`:120`, as
`status IN (...)`), `settledByWatcher` (`queue/store.ts:50`), the `--once`
exit code (`watch/command.ts:255`) and the attempts column of `queue --settled`
(`queue/command.ts:44`). The retry cap is otherwise unchanged. ADR 0027, which
fixes the status vocabulary and the retry rule, gains a dated amendment.

### Action

`action.yml` is protected. The spec provides the exact change under
follow-ups: read `.failure.mode` from the report and, when a new input
`fail-open` is `true` and the mode is `failed_open`, write the summary and exit
0. The default stays red, because silently passing documentation pull requests
during an outage is a policy choice a team makes on purpose. `docs/ACTION.md`
documents the `continue-on-error` alternative now and the `fail-open` input as
"available from the release that adds it", so the docs never advertise an
input the action lacks.

### Retention

A new `retention` block in `.review-voice/config.yaml`, read by `loadConfig`
into `LoadedConfig.retention: { runsDays: number | null; auditDays: number | null }`
with a warning for a non-integer or negative value (`retention` joins
`KNOWN_TOP_LEVEL` in `src/policy/load.ts`, or the template test at
`test/issues-config.test.mjs:37-46` fails):

```yaml
retention:
  runs_days: 30      # run directories under <data dir>/runs older than this are removed; 0 or null disables
  audit_days: 180    # audit events older than this are removed; 0 or null disables
```

Defaults when the block is absent are 30 and 180: `PRIVACY.md` already
promises the 180-day audit retention and ADR 0005 the 30-day raw retention,
so enforcing them is making the documents true, not a new policy. Only
`watch` passes and an explicit `purge --runs` apply the sweep; `review` never
does, so a user who runs neither sees nothing deleted.

`src/store/retention.ts` exports `previewRetention(dataDir, db, config)` and
`applyRetention(dataDir, db, config)`. A run directory's age is its directory
mtime; a directory with no `verdict.json` is a failed run and is kept for
twice `runs_days` so it can be resumed. The audit sweep is
`DELETE FROM audit_events WHERE created_at < ? AND action NOT LIKE 'review_post_%'`:
the posting rows are the single write path's idempotency memory (`keyBlocked`
at `publish/post.ts:614-635`, `sentInline` at `:327-338`, `diff/held.ts:55-69`,
`store/outcomes.ts:147-157` all read them with no time bound), so they stay
until `purge`; there is no audit file.

Callers:

- Run directories are removed only by `store/retention.ts`, which exports
  `removeRunDirectories(dataDir, before: Date | null)` beside
  `applyRetention`. `purge --runs [--before <YYYY-MM-DD>]` is a scope on its
  own (bare `purge` still exits 2 with "needs a scope"); `purgeCommand` in
  `cli.ts` calls `removeRunDirectories` with `dataDirectory()` and merges
  `runDirectories: { count, paths }` into the printed `wouldRemove` and
  `removed` objects; `--before` with `--runs` compares directory mtime; the
  `purge` audit event records the removed count; `purge --all` includes run
  directories. `previewPurge` and `executePurge` keep their `(db, scope)`
  signatures and never touch the filesystem, so `test/consent.test.mjs:91-99`,
  which calls `executePurge(db, { all: true })` with no data directory set,
  cannot reach a real `runs/` folder. The existing confirmation pattern in
  `consent/purge.ts` applies.
- `watch` applies retention once per pass, after outcomes. In text mode it
  appends one line to the pass output (`removed 2 run directories, 15 audit events`);
  in `--json` mode it writes that line through `deps.err`, so stdout stays one
  JSON document. `WatchSettings` gains `retention`; a pass whose settings lack
  the block applies the defaults.

### PRIVACY.md and ARCHITECTURE.md

Add `runs/` and `clones/` rows to the storage table and remove the
`audit/events.jsonl` row (nothing writes it; the audit log is the
`audit_events` table in `review-voice.db`). Replace the "Original, unredacted
text: Never stored" row with two rows: review-history text is redacted on
download and never stored raw; the reviewed pull request's diff, changed files
and thread are kept raw under `runs/` because they are the code under review,
for `retention.runs_days`. State the audit retention as `retention.audit_days`
(default 180) and that `watch` or `purge` enforces it, and that posting
records are kept until purged because they stop a review being posted twice.
Mention that the Action caches the data directory between runs. `docs/ARCHITECTURE.md` "Storage
layout" gets the same corrections.

### Docs and help

`docs/WATCHER.md`: the `HeadStatus` union, the review JSON key list (`failure`)
and the pass-line statuses. `help.ts`: `purge` usage gains
`--runs [--before <date>]` and `--all` says it includes run directories;
`--settled` names the three failure statuses; `watch` help mentions the
retention line; `review` help documents `failure` in `--json`.

## Non-goals

- No GitHub write of any failure text. ADR 0012 keeps the human-review note
  off the pull request.
- No retry policy change in the watcher.
- No change to the posting verdict on success.

## Acceptance criteria

- AC-1. A driver test where the evidence-verifier fails twice on a change that
  touches `.github/workflows/ci.yml` returns exit 7 with
  `failure.mode === 'failed_closed'`, `risk === 'high'`, the complexity
  reasons, and no `review_runs` row; one `review_failed` audit event exists.
- AC-2. The same failure on a documentation-only change returns
  `failed_open` with `risk === 'normal'`.
- AC-3. A failure before the stage loop (for example GitHub returning no head
  sha, `driver.ts:171-177`, provable with a fake whose pull-request JSON has
  `head: {}`) returns `stage === 'unknown'`, `risk === 'unknown'` and
  `failed_closed`; a `diff` command that exits non-zero inside `prep`
  (provable with a repository directory that is not a git checkout) returns
  `stage === 'prep'`, `risk === 'unknown'` and `failed_closed`, because
  `run.summary` is still empty.
- AC-4. `reportText` prints the "Review unavailable" block with risk, reasons
  and the static-check facts when `evidence.json` exists; `--json` carries
  `failure`.
- AC-5. `reviewResult()` sets `failureMode` only when the JSON carries it; the
  watcher stores `failed-open` and `failed-closed` from it and `failed` for a
  child with no report; a `failed-closed` head is capped by
  `watch.max_attempts_per_head`, listed by `queue --settled` with its
  attempts and mode, and makes `--once` exit 1; `status` counts the three
  apart.
- AC-6. `previewRetention` lists run directories older than `runs_days`
  (failed ones only past twice that) and the audit rows older than
  `audit_days`; `applyRetention` removes exactly those; a `review_post_sent`
  row older than `audit_days` survives; `0` or `null` disables the respective
  sweep. A test uses a temp data directory with back-dated mtimes
  (`utimesSync`) and back-dated `audit_events.created_at`.
- AC-7. `purge --runs` previews before deleting and honours `--before`, proved
  by running the bundle with `REVIEW_VOICE_DATA_DIR` set to a temp directory
  as `test/consent.test.mjs:102-140` does; in `test/watch.test.mjs`, a run
  directory under `<h.dir>/runs/` with a back-dated mtime is removed by
  `h.run(['--once'])` when `settings()` carries
  `retention: { runsDays: 1, auditDays: 180 }`, kept when it is younger, and
  the pass prints one line naming what it removed (through `h.out` without
  `--json`, through `h.err` with it); a settings literal without `retention`
  applies the defaults.
- AC-8. A new test (for example `test/retention-docs.test.mjs`) asserts that
  `PRIVACY.md` contains `runs/`, `clones/`, `retention.runs_days` and
  `retention.audit_days` and contains neither `Original, unredacted text` nor
  `events.jsonl`; that `docs/ACTION.md` contains `fail-open` and
  `continue-on-error`; and that `docs/adr/0022-*.md` and `docs/adr/0027-*.md`
  each contain a `## Amendment - 2026` heading. `templates/config.example.yaml`
  documents `retention` and still loads with no warnings.
- AC-9. `npm run verify` passes with the rebuilt bundle committed.

Stop point for a two-run split: run one is the failure half (AC-1 to AC-5,
the ADR 0022 and 0027 amendments and the ACTION.md part of AC-8, AC-9); run
two is the retention half (AC-6, AC-7, the PRIVACY.md and config parts of
AC-8, AC-9).

## Allowed paths

`plugins/review-voice/src/review/driver.ts`, `plugins/review-voice/src/store/retention.ts`
(new), `plugins/review-voice/src/store/audit.ts`, `plugins/review-voice/src/store/watch.ts`,
`plugins/review-voice/src/watch/command.ts`, `plugins/review-voice/src/watch/review.ts`,
`plugins/review-voice/src/queue/store.ts`, `plugins/review-voice/src/queue/command.ts`,
`plugins/review-voice/src/consent/purge.ts`, `plugins/review-voice/src/policy/load.ts`,
`plugins/review-voice/src/cli.ts` (`purge`, `status`), `plugins/review-voice/src/help.ts`,
`plugins/review-voice/templates/config.example.yaml`, `PRIVACY.md`,
`docs/ACTION.md`, `docs/WATCHER.md`, `docs/ARCHITECTURE.md`,
`docs/adr/0022-*.md`, `docs/adr/0027-*.md`, `docs/adr/README.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

`PRIVACY.md` sits at the repository root. Add `PRIVACY.md` to Orbit's
`scope.allowed_paths` before this run, or the goal below tells the implementer
to hand the text back for a person to apply.

## Follow-ups for a person (protected paths)

`action.yml`: add input `fail-open` (default `false`); in the review step,
after the exit-code case statement, add

```bash
mode=$(jq -r '.failure.mode // empty' "$report" 2>/dev/null || true)
if [ "$FAIL_OPEN" = "true" ] && [ "$mode" = "failed_open" ]; then
  echo "Review Voice: the review was unavailable on a low-risk change (failed_open); passing." >> "$GITHUB_STEP_SUMMARY"
  code=0
fi
```

with `FAIL_OPEN: ${{ inputs.fail-open }}` in the step's `env`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S03-failure-modes-and-run-retention.md
in this repository. Read that file first; it is the design and the acceptance
criteria. Read docs/ARCHITECTURE.md ("The review driver", "The watcher",
"Storage layout"), docs/adr/0022-one-command-drives-a-review.md,
docs/adr/0027-one-watcher-remembers-every-head.md, docs/adr/0005-data-encryption.md
and docs/adr/0012-complex-changes-need-human-approval.md before changing code,
then plugins/review-voice/src/review/driver.ts (the catch block, run.summary),
plugins/review-voice/src/watch/review.ts (ReviewResult, reviewResult),
plugins/review-voice/src/store/watch.ts, plugins/review-voice/src/queue/store.ts,
plugins/review-voice/src/consent/purge.ts and plugins/review-voice/src/policy/load.ts
(KNOWN_TOP_LEVEL).

Outcome: a review that cannot complete reports a ReviewFailure with mode
failed_open or failed_closed decided by the change's assessed risk (unknown
risk fails closed), prints the deterministic facts it established, and writes
one review_failed audit event; the watcher's ReviewResult carries an optional
failureMode and the watcher records failed-open and failed-closed statuses,
with an isFailure helper replacing every `=== 'failed'` check so the attempts
cap and queue --settled cover them; a retention block (runs_days 30 and
audit_days 180 by default, 0 or null disabling) is enforced by `purge --runs`
and by each watch pass through a new store/retention.ts (directory mtime for
runs, DELETE on audit_events for audit); PRIVACY.md, ARCHITECTURE.md,
WATCHER.md, ACTION.md and help.ts are updated as the spec says; ADR 0022 and
ADR 0027 gain dated amendments and docs/adr/README.md marks them. All nine
acceptance criteria in the spec must hold. If one run cannot hold everything,
stop at the spec's stop point with every check green and say which half is
next.

Scope: only the files the spec lists under "Allowed paths". If PRIVACY.md is
outside this run's allowed paths, do not edit it: put the exact replacement
text in the run report and report that part of AC-8 as a follow-up for a
person. Do not edit action.yml, scripts/, CHANGELOG.md or the plugin manifests;
the action.yml change is a follow-up for a person. Never post failure text to
GitHub. Add no dependency.

Conventions: follow CONTRIBUTING.md and the style of the surrounding code
(comments explain why, in full sentences; no hardcoded identities; no em or en
dashes anywhere, the identity guard rejects them). Amendments are dated
"## Amendment - <date>" sections in the existing style.

Proof: after changing anything under plugins/review-voice/src, run `npm run
build` so plugins/review-voice/dist/review-voice.mjs is rebuilt; the dist-check
check fails otherwise. Run the test files you add or change with `node --test
<file>`; Orbit runs unit-tests, typecheck, build, dist-check, identity-guard and
action-pins on the whole tree.
```
