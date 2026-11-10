# Approval confidence: the program (S25 to S29)

**Status:** proposed, 2026-11-09. **Baseline:** `main` at `ac3b7af` (1.23.0 plus
S16 part A). **Written from:** a read of the docs, ADRs 0010, 0012, 0016, 0024,
0028 and 0029, the professionalisation specs, and the code named below. No test
was run and the issue tracker was not read, so every line reference needs the
same independent check against the code that S01 to S24 received before a run.

Suggested home: `docs/agent-handoffs/approval-confidence/`, one file per spec,
this file as its `README.md`. Each spec ends with a paste-ready goal block.

## The goal of the program

Review Voice approves when no verified finding above a nit survives, the head
is unchanged, CI is green and no cap applies. That is safe today because of the
caps. It is not yet confident, because the tool's own measurements say that
"nothing found" is weak evidence:

- key-bug recall 0.55, 12 of 22 positives (`docs/EVALUATION.md`, "Measured on 1.22.0");
- candidate set agreement 0.25 to 0.60 between two runs of one diff;
- owner-accepted precision: no data.

Five specs close that gap in the order evidence allows:

1. **Measure what an approval is worth.** Follow every approval to an outcome. (S25)
2. **Measure what the caps cost and save.** Record the verdict each cap replaced
   and what a person then did. (S26)
3. **Raise recall where it is cheap.** Sample the diff lane more than once in
   thorough mode and measure the change. (S27)
4. **Say which stated goals have evidence.** Give every intent statement an
   evidence status the CLI can check. (S29)
5. **Add evidence that runs.** Mutate the changed lines in the confined runner
   and require the repository's own tests to notice. (S28)

Done means: `evaluate` reports an approval escape rate with its basis and a
confidence bound; `calibrate --caps` prints what each cap held back and what
people did with it; `docs/EVALUATION.md` carries recall at one, two and three
samples from a real run; a review records intent coverage and, where a
repository opted in, a mutation result; and two opt-in verdict settings can
hold an approval when that evidence is missing. Every default is today's
behaviour.

## Constraints every spec keeps

- No new GitHub write. The single write path and its guards (ADR 0010) are not
  widened. Every new read is a GET inside the allowlist, or the fixed GraphQL
  set of ADR 0018.
- A new setting can only turn an APPROVE into a COMMENT. Nothing here makes an
  approval more likely, counts toward a required approval, or rests on a
  model's score. Each cap's reason stays local, as ADR 0012 decided.
- No generated tests, fixes or findings from a mutant. S28 runs the
  repository's existing tests and reports; it writes no test.
- Settings that affect a pull request's own review are read from the base
  commit (S01). Anything that runs pull request code is opt-in, probe-gated and
  off by default (S16).
- A figure with no data prints `no data`, never zero. Every figure prints its basis.
- `CONTRIBUTING.md` rules: synthetic fixtures only, no identity, no em or en
  dash, new tests in new files, the bundle rebuilt, `CHANGELOG.md` and
  manifests left to the maintainer.

## Order and dependencies

```
Now      S25 approval outcomes  ->  S26 shadow verdicts (shares S25's audit fields and checker)
After S16 part B                  S27 samples (edits driver.ts lanes(), which S16B and S17 also touch)
After S19                         S29 intent coverage (S19 changes the intent extractor first)
After S16 part B and issue #321   S28 mutation check (reuses the confined runner; macOS waits on #321)
```

S25 and S26 touch `store/`, `evaluate/`, `publish/post.ts` metadata and
`watch/`, none of which S16B to S24 rewrite, so they can run now. Pull S22
part A (path-scoped approval) and S17 forward of S18 to S24 for this goal; they
are already specified.

---

## S25. Approvals are followed to an outcome

**Depends on:** nothing. **Size:** about 320 source lines, 380 test lines, one
new ADR (0034), one amendment (0029). **Risk:** low, read-only.

### Why

ADR 0029 follows every posted finding to `fixed` or `dismissed`. Nothing
follows an approval. `review_post_sent` already records `event`, `head` and
`reviewId` (`src/publish/post.ts`, the `recordAudit` call after
`submitReview`), and `sentRuns` (`src/store/outcomes.ts`) already walks that
audit trail, but it drops the event. `evaluate` has no approval figure at all
(`src/evaluate/metrics.ts` names no metric with "approv" in it). So the one
write that can unblock a merge is the one write whose results are never read.

### Outcome

`outcomes` follows each APPROVE Review Voice sent to what the pull request and
the default branch later show, and `evaluate` reports an approval escape rate.

### Design

- **Source.** `approvedRuns(db, { since, repository })` beside `sentRuns`:
  runs whose `review_post_sent` metadata has `event: 'APPROVE'`, with head,
  review id and sent time. `sentRuns` is unchanged.
- **Reads, all GET.** `/repos/{r}/pulls/{n}` (state, `merged`, `merged_at`,
  `merge_commit_sha`, current head); `/pulls/{n}/reviews` (already read by
  `checkOutcomes`); `/pulls/{n}/commits` for commits after the approved head;
  and one allowlisted search per merged pull request, through a new typed
  source on the queue's search route (ADR 0026), for a merged pull request in
  the same repository whose body holds `Reverts {owner}/{repo}#{n}`, the text
  GitHub's revert button writes. The source is `reverts:{owner}/{repo}#{n}`;
  `src/github/client.ts` builds its query as
  `is:pr is:merged repo:{owner}/{repo} "Reverts {owner}/{repo}#{n}" in:body`,
  checks the repository against the allowlist before sending, and lets no
  caller text reach `q`. The search route as it stood admitted only the four
  open-pull-request sources and no other `/search` path, so this one typed
  source is the narrowest change that reaches the revert; ADR 0034 records it
  as an amendment of ADR 0026.
- **Outcomes**, with ADR 0004's strength rules:

  | Outcome | Strength | When |
  |---|---|---|
  | `reverted` | strong | a merged pull request in the same repository reverts this one inside the window |
  | `changes_requested` | strong | a person who is not a bot and not the poster requested changes on the approved head after the approval |
  | `survived` | strong | merged at the approved head, the window has passed, neither of the above |
  | `merged_other_head` | weak | merged at a head the approval did not read |
  | `pending` | weak | merged, window not over yet |
  | `closed`, `open`, `unknown` | weak | not merged, or unreadable |

  The window is `outcomes.approval_window_days`, default 14. Silence before the
  window ends is `pending`, never `survived`.
- **Settings.** `outcomes.approval_window_days` and `outcomes.approval_escape_warn`
  form a new `outcomes` section, read through `CONFIG_KEYS` in
  `src/policy/load.ts` like every other section (#318). The drift test's
  document in `test/issue-318-nested-config-keys.test.mjs` gains an
  `outcomes:` block with both keys, so the new section is held to the same
  check as the rest; that is the one existing test this spec edits.
- **Storage.** A new `MIGRATIONS` entry in `src/store/db.ts`:
  `approval_outcomes (review_run_id, repository, pull_number, head, review_id,
  outcome, strength, evidence_json, checked_at)`, one row per run, a newer
  check replacing an older one, as `finding_outcomes` does. A full `purge`
  removes `approval_outcomes` with the runs it follows (`src/consent/purge.ts`),
  so no reviewer login or figure outlives the data it came from.
- **Metrics** in `computeMetrics`, reported and never gated:
  `approvals_tracked`, and

  ```
  approval_escape_rate = (reverted + changes_requested) / (reverted + changes_requested + survived)
  ```

  with a Wilson 95% upper bound printed beside it and the basis
  `E escaped / N settled approvals; P pending, W weak excluded`. `--json` adds
  `approval_breakdown` by provenance mode, complexity level, independence
  label and origin (`RunProvenance` in `src/store/runs.ts`).
- **When.** `watch` already calls `checkOutcomes` once per pass
  (`src/watch/command.ts`); it calls the approval check beside it.
  `outcomes --approvals` checks on demand. `status` prints one line when the
  upper bound is above `outcomes.approval_escape_warn` (default 0.05) and at
  least 30 approvals are settled; nothing is sent anywhere.

### Non-goals

No incident or deploy data, no read outside the allowlist, no change to any
verdict, no judgement of pull requests Review Voice did not approve.

### Acceptance criteria

- AC-1. Against a fake GitHub, each row of the outcome table is produced from
  the state that defines it, and a pull request that cannot be read leaves its
  stored row unchanged.
- AC-2. A merged pull request inside the window is `pending`; the same state
  with the clock past the window is `survived`.
- AC-3. `evaluate` prints `no data` with zero settled approvals, the rate and
  its bound otherwise, and the basis string above; `--json` carries
  `approval_breakdown`; a group with nothing settled reports `null`.
- AC-4. Every request the check makes is a GET, either to a repository in the
  allowlist or the typed `reverts:` search naming one; a run for any other
  repository is skipped without a request, and a `reverts:` source outside the
  allowlist is refused before any request.
- AC-5. `watch --once` follows approvals in the same pass as findings, and a
  failure there does not fail the pass.
- AC-6. ADR 0034 exists, ADR 0029 gains a dated amendment, the index marks
  both, and `docs/EVALUATION.md` documents the figure (content test).
- AC-7. `npm run verify` passes with the rebuilt bundle.

### Allowed paths

`plugins/review-voice/src/store/outcomes.ts`, `src/store/db.ts`,
`src/github/client.ts` (the one typed `reverts:` search source),
`src/consent/purge.ts` (the purge of `approval_outcomes`),
`src/store/approvals.ts` (new), `src/evaluate/metrics.ts`,
`src/cli/outcomes.ts`, `src/cli/status.ts`, `src/cli/evaluate.ts`,
`src/watch/command.ts`, `src/policy/load.ts`, `src/help.ts`,
`templates/config.example.yaml`, `docs/adr/**`, `docs/EVALUATION.md`,
`docs/WATCHER.md`, `test/**` (new files, plus the one edit to
`test/issue-318-nested-config-keys.test.mjs` named under Settings),
`docs/agent-handoffs/approval-confidence/**`, `dist/review-voice.mjs`.

### Goal block

```
Implement section S25 of docs/agent-handoffs/approval-confidence/README.md in
this repository. Read the section first, then docs/adr/0004, 0010, 0026 and
0029, and sentRuns(), checkOutcomes(), saveOutcome() and postedStats() in
plugins/review-voice/src/store/outcomes.ts, the review_post_sent audit record
in src/publish/post.ts, computeMetrics() in src/evaluate/metrics.ts and the
outcomes call in src/watch/command.ts.

Outcome: every APPROVE Review Voice sent is followed, with GET requests inside
the allowlist only, to one of the outcomes the section's table names, stored
in a new approval_outcomes table; evaluate reports approval_escape_rate with a
Wilson 95% upper bound, its basis and a --json breakdown; watch follows
approvals each pass; status warns locally past the configured bound. All seven
acceptance criteria must hold.

Scope: only the section's allowed paths. No GitHub write, no verdict change.
Put every new test in a new file; the one existing test you may edit is
test/issue-318-nested-config-keys.test.mjs, whose document gains an outcomes
block with both keys. Do not edit scripts/, .github/, CHANGELOG.md or the
manifests. Add no dependency.

Conventions: CONTRIBUTING.md; comments explain why; no em or en dash.

Proof: npm run build after any change under plugins/review-voice/src; run the
test files you add with node --test <file>; npm run verify must exit 0.
```

---

## S26. Shadow verdicts: what each cap replaced, and what a person did next

**Depends on:** S25. **Size:** about 260 source lines, 300 test lines, one
amendment each to ADR 0012 and 0028. **Risk:** low.

### Why

The complexity limits are defaults the ADR itself calls numbers a team will
want to tune (ADR 0012, "Consequences"), and nothing measures them.
`wouldHaveEvent` exists (`src/publish/post.ts`, set only when the change needs
a human) but it is printed locally and never stored, and the `never_approve`
and held-finding caps do not set it. So a capped change leaves no record that
could answer the one calibration question: when Review Voice would have
approved and a cap stopped it, did a person approve the same head unchanged?

### Outcome

Every sent, refused or carried post records the event the findings mapped to
and which cap, if any, replaced it. The S25 check follows capped approvals
too, and `calibrate --caps` prints, per cap, how often a person approved the
head as it stood.

### Design

- **Record.** The `review_post_*` audit metadata gains `mapped` (the event
  before caps) and `cappedBy` (`complexity`, `policy`, `held`, `ci`,
  `uncovered-carry`, or null), taken from the same `planned` and `decision`
  values `post` already computes. Older rows have neither key and read as
  unknown, never as uncapped.
- **Follow.** For a row with `mapped: 'APPROVE'` and a `cappedBy`, the S25
  checker records a `shadow` outcome: `human_approved_same_head` (strong),
  `human_requested_changes` (strong), `head_changed_before_approval` (weak),
  `open` or `unknown` (weak). Stored in `approval_outcomes` with a `kind`
  column (`sent` or `shadow`); S25's rate reads `sent` rows only.
- **Report.** `calibrate --caps` (read-only, text and `--json`): per
  `cappedBy`, the count held back, the share a person approved unchanged, the
  share a person changed or refused, and for `complexity` the distribution of
  `decisionPoints` and densest-hunk counts of each group, read from the
  recorded `complexity_json`. It proposes nothing and changes no setting; the
  owner edits the limits, as with every policy.

### Non-goals

No automatic threshold change, no approval sent because a shadow says so, no
posted text.

### Acceptance criteria

- AC-1. A post under each cap records `mapped` and the matching `cappedBy`; an
  uncapped post records `cappedBy: null`; the idempotency key is unchanged, so
  the same review is never a second post.
- AC-2. Each shadow outcome is produced from the state that defines it.
- AC-3. `approval_escape_rate` over a store holding shadow rows equals the
  rate over the same store without them.
- AC-4. `calibrate --caps` prints `no data` for a cap with no strong shadow
  outcome, and the shares and distributions otherwise.
- AC-5. A row written before this spec is counted as unknown.
- AC-6. ADR 0012 and 0028 gain dated amendments; `npm run verify` passes.

### Allowed paths

`src/publish/post.ts`, `src/publish/verdict.ts` (types only),
`src/store/approvals.ts`, `src/store/db.ts`, `src/cli/calibrate.ts`,
`src/evaluate/metrics.ts`, `src/help.ts`, `commands/calibrate.md`,
`docs/adr/**`, `docs/EVALUATION.md`, `test/**`, `dist/review-voice.mjs`.

### Goal block

```
Implement section S26 of docs/agent-handoffs/approval-confidence/README.md.
Read the section, docs/adr/0012 and 0028, the decide() call and the
wouldHaveEvent fields in plugins/review-voice/src/publish/post.ts, and the
module S25 added at src/store/approvals.ts.

Outcome: every review_post_* audit record carries the mapped event and the cap
that replaced it; capped approvals are followed to a shadow outcome that never
enters approval_escape_rate; calibrate --caps prints the per-cap table the
section describes and changes nothing. All six acceptance criteria must hold.

Scope: the section's allowed paths. No GitHub write, no verdict change, no
change to the idempotency key. New tests in new files. Do not edit scripts/,
.github/, CHANGELOG.md or the manifests.

Conventions and proof: as S25.
```

---

## S27. More than one sample of the diff lane in thorough mode

**Depends on:** S16 part B merged (both edit `lanes()`); S04 (`recall`).
**Size:** about 200 source lines, 300 test lines, one amendment to ADR 0025.
**Risk:** medium: more analyst calls cost more, and more candidates can lower
clean silence. Off by default.

### Why

`docs/EVALUATION.md` says a single run is a sample, and measured agreement of
0.25 to 0.60 between two runs of one diff. Two runs that disagree that much
find different defects, so their union should recall more, and the verifier
and the blind challenger (ADR 0024) already stand between a candidate and the
pull request. `lanes()` in `src/review/driver.ts` runs each eligible lane once
through `inParallel`. Nothing can ask for a second sample, and `recall` has no
flag to measure one.

### Outcome

`review.samples` (1 to 3, default 1) runs the diff lane that many times in
thorough mode, merges the candidates, drops repeats by location, and records
how many samples ran. `recall --samples <n>` measures it.

### Design

- **Config.** `review.samples`, read by the cost-mode reader in
  `src/policy/load.ts`, from the base commit; a value outside 1 to 3 warns and
  reads as 1. Thorough mode only: `StagePlan` (`src/review/plan.ts`) gains
  `samples`, 1 in `fast` and `standard` whatever the setting.
- **Run.** `lanes()` expands the diff lane into `samples` parallel agent calls
  with stage names `lane:diff`, `lane:diff#2`, `lane:diff#3`. Candidate ids
  from a later sample take a suffix so ids stay unique. Other lanes run once.
- **Merge.** Before `check-candidates`, candidates from different samples at
  the same path, within `AGREEMENT_LINE_TOLERANCE` lines
  (`src/evaluate/metrics.ts`) and with the same category are one candidate:
  the earliest sample's is kept and `seenInSamples` records the count. The
  re-anchor loop sends a refused candidate back to the sample that wrote it.
- **Record.** The run's stages carry each sample's seconds and cost, and the
  scope block (S09) shows the sample count when on.
- **Measure.** `recall --samples <n>` passes the setting to the driver.
  `evaluate --recall` prints the sample count in the basis. A person runs the
  frozen fixtures at 1, 2 and 3 and publishes all three rows with cost in
  `docs/EVALUATION.md`; the fixtures are not tuned against.

### Non-goals

No change to the verifier, the challenger, scoring or the verdict. No default
change. No voting: a candidate one sample found is as eligible as one all
three found; `seenInSamples` is recorded, not scored.

### Acceptance criteria

- AC-1. With the fake runner and `samples: 2` in thorough mode, the diff
  analyst is called twice and every other lane once; in `standard` it is
  called once.
- AC-2. Two candidates within tolerance and of one category merge to one with
  `seenInSamples: 2`; two of different categories at one line both survive.
- AC-3. A refused candidate from the second sample is re-anchored by the
  second sample's stage, and ids never collide.
- AC-4. `recall --samples 2` records the count in `results.json`, and
  `readRecallResults` refuses a file whose summary does not follow from it.
- AC-5. With the default, every existing test passes unchanged and the stage
  list of a recorded run is byte-identical to today's.
- AC-6. ADR 0025 gains a dated amendment; `npm run verify` passes.

### Allowed paths

`src/review/driver.ts`, `src/review/plan.ts`, `src/review/stages.ts`,
`src/review/prompts.ts`, `src/policy/load.ts`, `src/cli/recall.ts`,
`src/evaluate/recall.ts`, `src/evaluate/recall-results.ts`,
`src/publish/verdict.ts` (scope block only), `src/help.ts`,
`templates/config.example.yaml`, `docs/adr/**`, `docs/EVALUATION.md`,
`docs/ARCHITECTURE.md`, `test/**`, `dist/review-voice.mjs`.

### Goal block

```
Implement section S27 of docs/agent-handoffs/approval-confidence/README.md.
Read the section, docs/adr/0023, 0024 and 0025, lanes() in
plugins/review-voice/src/review/driver.ts, resolvePlan() in
src/review/plan.ts, and runRecall() in src/evaluate/recall.ts.

Outcome: review.samples (1 to 3, default 1, thorough mode only, read from the
base commit) runs the diff lane that many times in parallel, merges repeats by
path, line tolerance and category before check-candidates, records each
sample as its own stage, and recall --samples measures it. With the default
nothing changes. All six acceptance criteria must hold.

Scope: the section's allowed paths. Do not change verification, the
challenge, scoring or the verdict. New tests in new files.

Conventions and proof: as S25.
```

---

## S29. Intent coverage: which stated goals have evidence

**Depends on:** S19 merged (it changes the intent extractor first); S10 part B
(`testReferences`). **Size:** about 380 source lines, 420 test lines, one new
agent section, one new ADR (0035), one amendment to ADR 0028. **Risk:**
medium: a new agent output, so every status is checked by the CLI before it
counts.

### Why

The intent extractor turns the description into quoted `goal`, `claim` and
`qa` statements (`agents/intent-extractor.md`, `src/intent.ts`), and the
analyst, verifier and challenger use them to find contradictions. That is the
defect-finding half. Nothing records the other half: which goals have any
evidence that the change delivers them. A change whose description promises
three behaviours and whose diff tests none is approved exactly like one that
tests all three, and a change with no description at all is approved on
silence about a goal nobody stated.

### Outcome

A review records, for each `goal`, `claim` and `qa` statement, whether it is
`tested`, `read`, `unbacked` or `contradicted`, with references the CLI
checked. An opt-in setting holds an approval when a goal is unbacked.

### Design

- **Stage.** `intent-coverage`, after `verify`, in `standard` and `thorough`
  (`src/review/stages.ts`, `StagePlan`). One call of the evidence verifier
  with a new section in `agents/evidence-verifier.md`, tools Read, Grep and
  Glob as today, returning per statement `{ id, status, references:
  ["path:line"] }` under a new `schemas/intent-coverage.schema.json`.
- **Checks by the CLI** (`check-intent-coverage`, new command module). A
  status the checks refuse falls back to `unbacked` with the reason kept:
  - every reference passes the `path:line` rule the evidence block uses and
    names a line that exists at the head;
  - `tested` needs at least one reference inside
    `review.human_review.test_paths` that the diff added or changed, or that
    `testReferences` (`src/diff/symbols.ts`) links to a changed symbol;
  - `read` needs at least one reference on a line the diff added or changed;
  - `contradicted` is not decided here: it must already be a verified
    finding, else it reads as `unbacked`.
- **Record.** `intentCoverage` on the run beside `RecordedChecks`; `explain`
  lists it; the scope block shows counts only.
- **Verdict.** `verdict.approve_requires_intent`: `off` (default) or `cap`.
  Under `cap`, in `decide()` after the complexity cap, an APPROVE becomes a
  COMMENT when a `goal` or `claim` is `unbacked`, or when the change touches
  production source and the description states no intent. `cappedBy:
  'intent'`, reason local, recorded by S26.

### Non-goals

No posted comment about missing tests, no generated test, no severity, no
score. `non-goal` and `deliberate` statements are not covered.

### Acceptance criteria

- AC-1. Each check refuses the status it guards and names the reason; a
  reference with an absolute path or `..` is dropped.
- AC-2. With `approve_requires_intent: cap`, a clean review with one unbacked
  goal maps to COMMENT with the local reason; with all goals `tested` or
  `read` it maps to APPROVE; REQUEST_CHANGES is unchanged; `--recheck` refuses
  with exit 2 under the cap.
- AC-3. An empty description caps only when production source changed.
- AC-4. With the default `off`, no existing verdict test changes, and the
  stage does not run in `fast`.
- AC-5. The recall harness's clean fixtures still read exactly
  `No actionable findings.` with the stage on (fake runner).
- AC-6. ADR 0035 exists, ADR 0028 is amended, the index marks both;
  `npm run verify` passes.

### Allowed paths

`src/intent.ts`, `src/cli/check-intent-coverage.ts` (new), `src/cli/explain.ts`,
`src/cli/record.ts`, `src/review/driver.ts`, `src/review/plan.ts`,
`src/review/stages.ts`, `src/review/prompts.ts`, `src/publish/verdict.ts`,
`src/publish/post.ts`, `src/store/runs.ts`, `src/store/db.ts`,
`src/policy/load.ts`, `src/help.ts`, `agents/evidence-verifier.md`,
`schemas/intent-coverage.schema.json`, `templates/config.example.yaml`,
`commands/review.md`, `docs/adr/**`, `docs/ARCHITECTURE.md`, `test/**`,
`fixtures/**`, `dist/review-voice.mjs`.

### Goal block

```
Implement section S29 of docs/agent-handoffs/approval-confidence/README.md.
Read the section, docs/adr/0012, 0024 and 0028, agents/intent-extractor.md,
agents/evidence-verifier.md, plugins/review-voice/src/intent.ts, the
testReferences field in src/diff/symbols.ts, and decide() in
src/publish/verdict.ts.

Outcome: an intent-coverage stage records, for each goal, claim and qa
statement, a status the CLI has checked against the diff and the head;
verdict.approve_requires_intent (default off) can turn an APPROVE into a
COMMENT with a local reason. All six acceptance criteria must hold.

Scope: the section's allowed paths. Nothing new is posted. No default
changes. New tests in new files.

Conventions and proof: as S25.
```

---

## S28. A mutation check on the changed lines, in the confined runner

**Depends on:** S16 parts A and B; issue #321 for macOS; S29 is independent.
**Size:** about 650 source lines, 600 test lines, two fixtures, one new ADR
(0036), amendments to ADR 0003 and 0028, one threat-model subsection.
**Risk:** high by nature, as S16 is: it runs pull request code. Off by
default, opt-in from the base commit, probe-gated, thorough mode only.

### Why

Every check Review Voice makes before approving looks for a defect. None asks
whether the repository's own tests would notice if the changed lines were
wrong. S16 built what such a check needs: a probe that proves the sandbox
(`probeSandbox`), a throwaway copy of the head worktree (`layoutOf`), a
wrapper with no network and bounded time, memory and CPU (`wrapperArgv`,
`reproductionEnvironment`), and a spawner that kills the process group
(`spawnInGroup`), all in `src/evidence/reproduce.ts` and `run.ts`. Today that
runner executes one kind of file, a reproduction the verifier wrote.

### Outcome

When a repository opts in, a thorough review mutates a bounded number of
changed production lines, runs the configured test command against each
mutant in the confined runner, and records which mutants the tests killed and
which survived. An opt-in setting holds an approval when mutants survive or
the check could not run.

### Design

- **Config.** A `mutation:` block read like `reproduction:` (`readReproduction`
  in `src/policy/load.ts`), from the base commit only: `enabled`, `runners[]`
  (`name`, `run`, `paths` globs, `timeout_seconds`), `max_mutants` (default
  12, at most 30), and the reproduction limits reused.
- **Mutants, made by the CLI, no model.** `src/evidence/mutate.ts`: over lines
  the diff added in production source (the complexity module's kinds decide
  what production means), a small lexical operator set: negate a condition,
  swap a comparison, swap `&&` and `||`, flip a boolean literal, shift an
  integer literal by one, remove a `return` value. Deterministic selection:
  at most one mutant per line, spread across hunks, stable for a given diff.
- **Run.** Baseline first: the runner's command on the unmodified copy, twice.
  A baseline that fails or differs between runs ends the check as `did-not-run`
  with the reason; nothing is inferred. Then each mutant in its own copy. Exit
  0 is `survived`, non-zero is `killed`, a timeout is `timeout` and counts as
  neither.
- **Record.** `mutation: { ran, reason, baseline, mutants, killed, survived:
  [{ path, line, operator }], timeouts }` beside `RecordedChecks`. `explain`
  lists survivors; the scope block shows counts; the held queue (S22) may list
  them once that lands.
- **Verdict.** `verdict.approve_requires_mutation`: `off` (default), `report`
  or `cap`. Under `cap`, an APPROVE becomes a COMMENT when any mutant
  survived, or when the check was configured for a changed path and did not
  run. `cappedBy: 'mutation'`, reason local.
- **Threat model.** One subsection: the mutated copy and the test command run
  under the same profile as a reproduction, nothing a sandboxed process wrote
  is read by a later stage except exit codes and capped, redacted output, and
  a survivor is never posted as a finding.

### Non-goals

No generated test, no posted finding from a survivor, no mutation of code the
change did not add, no run outside thorough mode, no run where the probe fails.

### Acceptance criteria

- AC-1. For a fixture diff, `mutate` returns the same mutants on every call,
  at most one per added line, none in test, generated or documentation paths.
- AC-2. With a fake spawner: a failing or flaky baseline yields `did-not-run`
  and no mutant runs; exit codes map to `killed`, `survived` and `timeout` as
  specified.
- AC-3. Nothing runs when `enabled` is false, when the mode is not thorough,
  when the probe fails, or when the setting came from the head and not the
  base.
- AC-4. Under `cap`, a clean review with one survivor maps to COMMENT with the
  local reason, and with none maps to APPROVE; under `report` the verdict is
  unchanged and the record is written.
- AC-5. The confinement evals under `plugins/review-voice/evals/confinement/`
  cover a mutant that tries to write outside its copy and one that tries the
  network, and both are refused.
- AC-6. ADR 0036 exists, ADR 0003 and 0028 are amended, `docs/THREAT-MODEL.md`
  gains the subsection; `npm run verify` passes.

### Allowed paths

`src/evidence/mutate.ts` (new), `src/evidence/reproduce.ts`,
`src/evidence/run.ts`, `src/cli/mutate.ts` (new), `src/cli/explain.ts`,
`src/cli/record.ts`, `src/review/driver.ts`, `src/review/plan.ts`,
`src/review/stages.ts`, `src/publish/verdict.ts`, `src/publish/post.ts`,
`src/store/runs.ts`, `src/policy/load.ts`, `src/help.ts`,
`templates/config.example.yaml`, `evals/confinement/**`, `docs/adr/**`,
`docs/THREAT-MODEL.md`, `docs/ARCHITECTURE.md`, `test/**`, `fixtures/**`,
`dist/review-voice.mjs`.

### Goal block

```
Implement section S28 of docs/agent-handoffs/approval-confidence/README.md.
Read the section, docs/adr/0003, 0021 and 0028, docs/THREAT-MODEL.md,
S16-execution-based-verification.md, and probeSandbox(), layoutOf(),
wrapperArgv() and reproduce() in plugins/review-voice/src/evidence/reproduce.ts.

Outcome: a mutation block, read from the base commit and off by default, lets
a thorough review mutate a bounded, deterministic set of added production
lines and run the configured test command on each mutant in the confined
runner, after a twice-run baseline; the result is recorded with the run;
verdict.approve_requires_mutation (off, report or cap) can turn an APPROVE
into a COMMENT with a local reason. All six acceptance criteria must hold.

Scope: the section's allowed paths. No new network access for any process, no
posted finding from a mutant, no generated test. New tests in new files.

Conventions and proof: as S25.
```

---

## Decisions for the owner before a run

1. S25: the window (14 days) and the two warning numbers (0.05, 30 settled).
   They are starting points, not measurements.
2. S25: whether a revert found by commit message (`This reverts commit <sha>`
   on the default branch) should count beside the revert pull request. It
   needs one more read per merged pull request.
3. S27: who pays for the three recall runs, as with S18's D4.
4. S29: whether an empty description should cap at all, or only be reported.
5. S28: whether `cap` may be set per path, which would want S22 part A first.
6. Numbering: S25 to S29 and ADRs 0034 to 0036 assume S15 to S24 take no
   further numbers.

## Not in this repository

An organisation-wide merge gate is a separate product: Review Voice is
local-first, has one write and never merges or sets a status. Such a gate
would call `RV verdict` for the decision, read the S25 and S26 figures to set
its own lanes, and keep its own attestation of who or what approved.
