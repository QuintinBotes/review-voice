# Current task - severity collapses every finding to minor or nit

**Milestone:** post-1.0.0 correctness.
**Risk:** medium. Changes the reported tier of shipped findings and the
verifier's output contract.
**Baseline:** `main` at 5549a3f.

## Goal

Make the reported severity reflect the reach of a defect, without
reintroducing the run-to-run tier flapping that derivation was built to stop.

## Why

On a live run every finding landed on `minor` or `nit`:

```
cand_001  requested blocking -> minor   "ci carries minor"
cand_002  requested important -> minor  "correctness carries minor"
```

`cand_001` breaks every lint job in CI and renders indistinguishably from a
stale code comment. Severity is what decides whether a reader continues past
the first finding, so a mapping that cannot express "this breaks the build" is
a reviewer-facing defect, not a cosmetic one.

`BY_CATEGORY` in `scoring/severity.ts:28` assigns one tier per category. The
flaw is not the value chosen for `ci`; it is that `ci` is not one thing.
"Breaks every lint job" and "stale comment in a CI config" are both `ci` and
differ by blast radius - which is exactly what the table claims to encode. For
any category whose members vary in reach, one constant is wrong for half of
them, and re-tuning the constant only changes which half.

## The variable to add, and the one not to

**Do not promote on confidence.** `severity.ts:17` records that a first version
weakened one tier below 0.85 and that this measured as the entire remaining
instability: identical diffs tiering differently at 0.82 against 0.90, and 0.85
against 0.80. Everything that ships already sits in [0.8, 1.0] because the
confidence gate says so, and run-to-run variance is about 0.08. Any boundary
inside that band gets crossed. This is a settled measurement; do not relitigate
it.

**Add reach instead, and grade it.** The concern that a three-value judgement
would flap the same way confidence did is answered by the measurements already
published in `docs/EVALUATION.md`:

| Measurement | Result |
|---|---|
| Category stability, two runs of one diff | 4 of 4 identical |
| Derived severity stability, same two runs | 4 of 4 identical, while the analyst's own requested severity differed on 3 of 4 |

Same agent, same two runs, same diff. A 22-value descriptive field was stable;
a 5-value evaluative one was not. What predicts stability is not how many
values a field has, it is whether the field describes the defect or judges it.
`category` asks what kind of thing this is. `severity` asks how bad it is.
Blast radius asks how far it reaches, which is traceable through the call
graph - descriptive, like category.

That evidence is n=4 on one diff, which is thin. It is what justified grading
reach into three values rather than collapsing to a binary. It is *not* what
makes reach stable - the CLI computing it is, per requirement 1 below. The
evidence would matter if reach were ever moved back to an agent; keep it here
so that move is made knowingly.

## Scope


### Allowed files

- `plugins/review-voice/src/scoring/severity.ts`
- `plugins/review-voice/src/scoring/reach.ts` (new)
- `plugins/review-voice/src/scoring/existence.ts` (export a path-returning
  `git grep` variant; no change to `checkAbsenceClaim`)
- `plugins/review-voice/src/scoring/score.ts` (the `Verification` interface and
  the `deriveSeverity` call at line 497 only)
- `plugins/review-voice/src/cli.ts` (verification parsing near line 684 only)
- `plugins/review-voice/agents/evidence-verifier.md`
- `plugins/review-voice/agents/diff-analyst.md`
- `plugins/review-voice/schemas/candidate.schema.json`
- `plugins/review-voice/schemas/review-event.schema.json`
- `test/scoring.test.mjs`
- `CHANGELOG.md`, `docs/EVALUATION.md`

### Required behaviour

The first draft of this handoff had the verifier *report* a radius. Research
replaced that with computing it, for the reason `score.ts:394` already gives
about the score itself: "Deliberately arithmetic and deliberately in the CLI:
asking a model to compute this would make the thresholds unfalsifiable, and the
whole point of a threshold is that it can be checked."

The same applies here, and it dissolves the stability worry entirely. A radius
the CLI computes from a deterministic search cannot flap between runs, so no
appeal to the descriptive-versus-evaluative evidence is needed to defend it.

1. **Compute reach, do not ask for it.** Add `reach.ts` alongside
   `existence.ts`, reusing the machinery that is already exported and already
   trusted for exactly this shape of question:

   - `namedSymbols(text)` (`existence.ts:138`) extracts the identifiers a claim
     names, already filtered to tokens distinctive enough to search for.
   - `gitGrep` (`existence.ts:189`) searches a ref safely - pattern after `-e`,
     argument array not a shell string, ref after the pattern. A variant
     returning matching paths (`git grep -l`) is the only addition needed.

   Reach is then the spread of the hits:

   - `repository` - hits in three or more distinct top-level directories, or
     the changed file is itself repository-wide toolchain configuration (lint
     config, tsconfig, CI workflow, lockfile, shared script).
   - `component` - hits beyond the changed file but within one top-level
     directory.
   - `local` - hits confined to the changed file.

   Thresholds are a starting point and must be recorded as calibrated-by-guess
   until a run measures them, the way `score.ts:160` records its own history.

2. **Absent reach keeps today's behaviour exactly.** When the claim names no
   searchable symbol, or the search cannot run, reach is absent and the current
   per-category tier is used unchanged. `checkAbsenceClaim` is the model: a
   search that could not run is never read as an answer.

3. **Report the working.** Return the symbols searched, the paths hit and the
   directory count, the way `ExistenceCheck` returns `checked` and
   `searchedRef`. `/review-voice:explain` must be able to show why a finding
   was raised a tier, and a wrong radius must be auditable rather than opaque.

4. **Derive from the pair.** `deriveSeverity` takes the category and the
   computed reach. Category supplies the kind of consequence, reach supplies
   the extent. A category whose members do not vary in reach keeps one tier
   regardless - `security` stays `blocking`, `style` stays `nit`.

5. **Search the ref under review.** Reach is computed against the same `--base`
   ref the absence check uses, for the same reason: the working tree on a pull
   request is usually neither the base nor the head, and a spread measured
   against the wrong tree is worse than no measurement.

6. **Confidence stays out of this path.** No threshold, no band, no weakening
   tier. Neither `deriveSeverity` nor `reach.ts` may read
   `technicalConfidence`.

7. **`question` stops short-circuiting.** `severity.ts:125` returns early for
   `question` before the table is consulted, so it is the one finding type the
   new mechanism cannot reach. Meanwhile `SEVERITY_ORDER` ranks it 4, below
   `nit` at 3, and `contract/limits.ts:11` says that order is "how much of the
   reader's attention each tier earns". A question about a change that breaks
   the build is therefore rendered below a nit.

   The comment at `severity.ts:126` already states the real problem - "a
   question is a kind of finding, not a tier". It is a speech act, asserting
   versus asking, jammed into a severity enum because the enum is what gets
   sorted.

   Derive a question's tier from (category, reach) like anything else. The
   interrogative is carried by the wording, which the editor already handles:
   "A `question` asks something the diff cannot answer. Same shape." This is
   the same principle as `severity.ts:45`, that the wording carries the
   consequence either way. `question` as a *tier* then means what it should -
   an ask whose reach is genuinely local.

   No output-contract change: the enum, the rendered line and the validator's
   ordering rule are all untouched.

   This also closes the confidence question raised separately. A floor is not
   hostile to questions once a question's confidence means *the gap is real and
   material* - that the code does not settle it and the answer changes
   something - rather than confidence in an answer. Record that reading in the
   verifier prompt.

### Non-goals

- Do not change any confidence floor, the final-score gate, or the weights.
- Do not change severity ordering in the output contract. It is correct and was
  confirmed correct on a live run.
- Do not accept a reach value from any agent. Neither the analyst nor the
  verifier supplies it; the CLI computes it. An agent-supplied number here
  would be exactly the unfalsifiable threshold `score.ts:394` warns against.
- Do not touch `verify/external.ts`. The external verifier's contract is a
  queued task with its own prerequisite.
- Do not touch the conventions loader, the diff acquirer, or precedent.

## Acceptance criteria

- `ci` with reach `repository` derives `blocking`; `ci` with reach `local`
  derives `nit` or `minor`.
- `correctness` with reach `repository` derives at least `important`.
- `security` derives `blocking` at every reach, and `style` derives `nit` at
  every reach.
- A candidate whose claim names no searchable symbol derives exactly the tier
  it derives on `main` today. A test asserts this over every category in
  `finding-category.schema.json`.
- A `git grep` that fails (bad ref, timeout) yields absent reach, never
  `local`. This is the failure mode that would silently downgrade every finding
  on a pull request whose refs are missing - see queued task 2.
- Reach is computed against the `--base` ref, and a test asserts a different
  ref can produce a different reach.
- `deriveSeverity` and `reach.ts` contain no reference to confidence.
- The computed symbols, hit paths and directory count are returned and surfaced
  by `/review-voice:explain`.
- A `question` with reach `repository` derives a tier above `nit`; a `question`
  with reach `local` still derives `question`.
- The output contract is unchanged: `SEVERITIES`, `SEVERITY_ORDER` and the
  validator's `severity_order` rule are not edited.
- Two runs over an identical candidate set produce identical tiers. With reach
  computed rather than reported this should be exact, not merely stable.
- `npm run verify` passes.

## Commands

```
npm run typecheck
npm run test
npm run build && npm run check:dist
npm run verify
```

## Return format

Files changed; tests run and outcomes; assumptions; risks; deviations from this
handoff; anything left unfinished.

---

# Queue

Ordered by dependency, then by cost. Each needs its own bounded handoff.

**Why severity leads, given that `docs/EVALUATION.md:62` concludes "which
findings exist at all matters more than what tier they carry", with candidate
set agreement at 0.25.** That conclusion is about *variance*, and it is right
about variance. The severity collapse is not variance: it is systematic, hits
every finding, and never self-corrects. A reader can average two runs to see
past disagreement about which findings exist. Nothing lets them see past a
deterministic floor that renders a build-breaker and a stale comment as the
same tier. Task 3a follows immediately behind it as a small, dependency-free
win.

## 1. Pointer following drops multi-target stubs

**Risk:** low. Independent of everything else; could run alongside severity.

`pointerTarget` at `conventions/globs.ts:141` uses `/^@(?:\.\/)?([^\s]+\.md)$/`
with no `m` flag, anchored against the whole body. It matches only a body that
is exactly one `@path.md`. Verified by repro:

```
two @-refs -> null
one @-ref  -> .agents/rules/controller-patterns.md
bare 23b   -> AGENTS.md
```

On a live run `.claude/rules/controller-patterns.md` - 179 bytes of frontmatter
declaring `paths: ["**/Controllers/**/*.cs", ...]` plus two `@` references -
resolved to nothing on the pull request that added a controller. Neither target
appeared in `documents` or in `skipped`.

Three defects, not one:

- The regex cannot match a multi-line body.
- The model is single-target. `resolvePointer` returns `string | null` and
  `resolved` is a `Map<string, string>` with *substitution* semantics. Multiple
  targets need *expansion*, one entry to N, which touches sizing and ranking at
  `discover.ts:324-364`.
- Both failure paths are silent. A null target on a body containing `@`
  references records nothing, and an unresolvable target records nothing.
  Neither reaches `skipped`.

A stub declaring `paths:` is the strongest relevance signal the loader has - it
is the repository saying *this is the rule for these files*. Losing it is worse
than losing a document the budget dropped, because the budget at least reports
what it dropped.

## 2. Pull-request refs are never made available locally

**Risk:** medium. Blocks task 3.

`diff/pull-request.ts` builds the whole diff from the GitHub API and never
touches local git. Nothing asserts that `base` or `head` is in the clone. On a
live run the head commit was absent: the verifier hit `fatal: bad object` and
fell back to reading head-side code from the patch alone.

Required: emit `refs: { base: {sha, available}, head: {sha, available},
fetched, note }` where `available` comes from `git cat-file -e <sha>^{commit}`
and is never inferred from the fetch's exit status. Fetch best-effort into
`refs/review-voice/pr/<n>/head` with `--no-tags`, **only** when the `origin`
remote resolves to the repository under review - fetching `pull/<n>/head` from
an unrelated clone yields plausible commits from the wrong project, which is
worse than absence. Fetch failure is never fatal.

Then tell the verifier that "the head commit is not present in this clone" is a
`required_context_missing` entry. That closes the hole: the field already drives
the unverifiable cap at `score.ts:432`, so a verifier confined to base-side
evidence is capped and rejected rather than shipping half-checked.

Model to follow: `checkAbsenceClaim` in `scoring/existence.ts` already degrades
correctly on a bad ref, returning `inconclusive: true` and naming `searchedRef`.
Do not edit it.

## 3a. The external verifier is never told what change it is judging

**Risk:** low. **No dependency - this can run immediately after severity.**

`verify/external.ts:155` sends `JSON.stringify(finding)` where
`VerifiableFinding` is `candidateId, path, line, severity, claim, failureMode,
evidence`. No diff, no repository - and the command runs with `cwd:
options.cwd`, so it judges whatever the working tree happens to be. A confident
false rejection at 0.99 under test is the expected output of that contract, not
a fault in the command.

An earlier draft of this queue claimed the whole fix depended on task 2. That
was wrong. `diff.patch` is already on disk from step 1 of the review, so adding
`{repository, diffPath}` to `VerifiableFinding` hands the verifier the change
under review with no fetch and no network. That is the bulk of what it lacks,
and it has no prerequisite.

This matters more than "a feature is off". `cli.ts:364` emits a standing
warning to every user whose config has no `verification:` block, telling them
the second-pass verifier never runs and pointing at the README. The tool
advertises a stage whose contract cannot work. Anyone who follows that advice
gets the 0.99 false rejections.

## 3b. Pass the refs through the verification contract

**Risk:** medium. Depends on task 2.

Add `{base, head}` once they are guaranteed present locally. This is the
increment on 3a, not a precondition for it.

## 4. The editor cannot receive findings by path

**Risk:** low.

`agents/concise-editor.md` declares `tools: []` - an empty list, not a missing
entry. Handed a path it can only reply that it cannot open files.

Do **not** give it `Read`. The no-tools state is load-bearing, not incidental:
the prompt's own "Limits on your authority" section reasons *from* it -
"**You cannot add a new technical claim** - you have no tools and no way to
verify one." Granting `Read` removes the stated premise of the rule that keeps
the editor from inventing claims at the last stage of the pipeline, after every
gate has run. Fix
upstream at `commands/review.md:254`, where "Launch the `concise-editor` agent
with the surviving candidates" is ambiguous enough that an orchestrator passed
a path. Say the candidate JSON must be inlined in the prompt, and add one line
to the editor stating it has no tools.

## 5. The analyst prompt does not carry its schema

**Risk:** low.

`agents/diff-analyst.md:178` says "JSON matching `schemas/candidate.schema.json`"
- a path, not the fields. On at least three runs the analyst returned
`title`/`location`/`description`. Inline the nine required fields:
`candidate_id, path, line, category, severity, claim, failure_mode, evidence,
technical_confidence`.

The guard already works as designed: `normaliseCandidate` detects the foreign
shape through `FOREIGN_KEYS` and its error names the correct fields, which is
why one re-emit fixed it. The prompt is the gap, not the recovery.

## 6. `RV` as a shell variable fails under zsh

**Risk:** low.

`commands/review.md:13` reads "Let `RV` be `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs"`".
zsh does not word-split unquoted parameters, so `RV='node /path'; $RV score`
looks for a command named `node /path/review-voice.mjs` and exits 127. Either
show the full invocation at each call site, or say to define a function rather
than a variable.

## 7. Precedent alignment is close to a constant

**Risk:** high. Carries recalibration with it. Do not land alone.

`RV status` reports 40 of 60 owner events with no file anchor. On a live run all
eight findings drew the same three precedents and the gate rejected nothing.

That constancy is mechanical, not bad luck. `retrieve.ts:175` sets
`matchStrength = relevance / best`, normalised to the best hit *in that
candidate's own result set*, so the top precedent always scores 1.0. When the
same three unanchored summaries are retrieved for every candidate, every
candidate gets the same alignment number.

`ownerAlignment` carries 0.25 of the final score and `repositoryAlignment` a
further 0.15. A constant does not merely fail to discriminate - it compresses
the range available to the four terms that do.

**The repository has already ruled on this exact class of bug.** `evidenceQuality`
once accepted "longer than 40 characters" as specificity and scored 1.000 on
every candidate, described at `score.ts:325` as "a fixed 0.15 added to every
score, carrying no information". It was diagnosed and fixed. Alignment is in
the same state at nearly three times the weight.

**And the tool already prints the diagnosis.** `corpus/store.ts:129` warns that
"unanchored summaries match any candidate, so with the owner weighting applied
they surface regardless of topic". It names the mechanism and then scores on it
anyway.

### Fix the anchoring; do not zero the weights

Zeroing both weights and renormalising was considered and is the wrong trade,
because the neutral fallback already exists: `alignmentFrom` returns **0.5 for
an empty precedent list**, commented "No evidence either way".

So excluding anchor-less precedents from alignment already gives a candidate
with no real precedent the documented neutral - which is what zeroing the
weight would achieve - while *preserving* the term for candidates that do have
anchored precedent. Selective, and strictly better than a global zero that
discards the signal in both cases.

**The coupling:** the 0.68 gate was calibrated on five runs that all carried
this constant (`score.ts:160`). Fixing alignment shifts the whole distribution,
so the threshold must be re-measured in the same change - the exact shape of the
0.78 -> 0.68 episode already documented there.

## 8. Untracked files buy word budget

**Risk:** low.

`diff/acquire.ts:152` admits untracked files as status `A` with `reviewed:
true`, and their `additions`/`deletions` come from a numstat with no entry for
them, so both are zero. On a live run a stray `$HOME/` directory and another
project's handover notes took `reviewedFileCount` from 11 to 17. Nothing was
reviewed wrongly, but `--scale-to-files` feeds `totalWordBudget`
(`contract/limits.ts:50`) from that count.

Do not filter untracked files - the comment at `acquire.ts:66` is right that a
new file is where defects hide, and git cannot tell that from junk.

**Add a field; do not redefine the existing one.** `reviewedFileCount` has
exactly two consumers and they want different things:

- `commands/review.md:40` - "if 0, say nothing and stop". This asks *is there
  anything at all to look at*, and an untracked new file legitimately counts.
- `commands/review.md:260` - `--scale-to-files` for the word budget. This asks
  *how big is this change*, and a zero-hunk file legitimately does not count.

Redefining `reviewedFileCount` to mean the second would break the first, and
the break would be silent: a review whose only reviewable files are untracked
and empty would start returning "No actionable findings." Add `hunkFileCount`
- files that produced diff content - and point `--scale-to-files` at that.

## 9. Convention truncation is silent, and the byte budget is not bytes

**Risk:** low.

`readBounded` at `conventions/discover.ts:111`:

- No marker. Content ends mid-word, `bytes` reports the original size, and the
  warning goes to the operator rather than into the document the analyst reads.
  On a live run `.agents/rules/integration-test.md` was cut from 21,441 to
  15,000 bytes, ending on "bloc", while governing 728 of 1,073 added lines.
- `raw.slice(0, PER_DOCUMENT_BYTES)` slices UTF-16 code units, not bytes. On a
  non-ASCII document one file can take several times its 25% share - the exact
  failure `PER_DOCUMENT_SHARE` exists to prevent - and it can split a surrogate
  pair.
- `discover.ts:411` tests `totalBytes >= TOTAL_BYTES` *before* adding, so the
  last document admitted always overshoots the total by its own size.

Cut at a real byte boundary, back off to the last line break, write an explicit
marker into `content`, and report `includedBytes` alongside `bytes`.

Appending a marker is safe to do inside `readBounded`: nothing parses
`content` structurally. Its only two consumers are the byte count at
`discover.ts:436` and the `ADDRESSES_THE_REVIEWER` scan at `discover.ts:442`.
Two consequences follow - the marker's own bytes must be counted toward the
budget rather than added on top of it, and the marker wording must not itself
trip the reviewer-addressing patterns, so keep it flatly descriptive.

Note the marker fixes silence, not loss. Relevance-scoped selection - the
sections matching changed paths rather than head-of-file - is the real answer
and is a larger piece of work.

## 10. Stale help text

**Risk:** none. Ship with anything.

`cli.ts:133` names 0.78 as the `--min-score` default. It has been 0.68 since
0.9.2 (`DEFAULT_THRESHOLDS`, `score.ts:174`). The help is the only place a user
learns the number.

## 10b. Verify that agent tool grants are actually confining

**Risk:** unknown, which is the reason to check. Security-relevant.

Every agent declares a narrow tool grant:

```
diff-analyst               Read, Grep, Glob, Bash(git:*)
evidence-verifier          Read, Grep, Glob, Bash(git:*)
static-evidence-interpreter Read, Grep
precedent-ranker           Read
concise-editor             []
```

On a live run the verification stage reportedly built a synthetic
three-workspace project using the repository's own pinned yarn, and ran the
repository's `oxlint` across the whole tree. Neither is `git`.

That is worth resolving because `docs/THREAT-MODEL.md` treats it as a named
attack. Threat 4, arbitrary code execution through static analysis, is
mitigated on the stated grounds that "static analysis commands are opt-in and
config-declared. Detection suggests; configuration enables. Never both"
([adr/0003](adr/0003-static-analysis-adapters.md)). Threat 1 asserts that
"commands found in repository content are never executed". A pipeline stage
that runs the repository's own pinned toolchain against a repository whose
content the threat model treats as untrusted reaches the same outcome by a
different route - one the adapter's opt-in gate does not cover.

**This is a question, not yet a finding.** Three possibilities and they have
different fixes:

1. The frontmatter `tools:` grant does not confine subagents in the harness.
   Then the mitigation for threat 4 is not implemented as documented, and every
   agent's declared grant is decorative.
2. The orchestrator ran those commands and the stage was described loosely.
   Then agent confinement holds, and what needs saying is that the *session*
   is not confined and the threat model should say which component the claim
   covers.
3. The grant was widened at runtime. Then the interesting question is what
   widened it.

**The cheap check:** a fixture repository containing a benign non-git command,
and an assertion that the verifier cannot run it. `fixtures/prompt-injection/`
is the existing home for exactly this kind of regression, run by `claude plugin
eval`.

Resolve this before task 3a. Widening the external verifier's contract to hand
it a diff path and repository name is a different proposition depending on
whether the surrounding grants confine anything.

## 11. The pipeline cannot complete inside its own cadence

**Risk:** medium. Design work, not a fix.

Measured on one live pull request: analyst 238k tokens across 94 tool calls,
about ten minutes; verifier 141k across 59, about five. With an external
verifier on top, over twenty-five minutes. A recurring sweep at ten minutes
cannot wrap one review, and no tuning closes a 2.5x gap.

A review has to become a resumable job rather than a tick-scoped task. The
machinery exists: `store/runs.ts` has `recordRun`, `latestRun`, `runDetail`. A
tick becomes check-and-advance.

**Measure before accepting the cost.** 94 tool calls is heavy exploration for an
analyst that was supposed to be handed its conventions, and on that run it
received a stub pointing at two controller rules it never got, while holding
`Grep` and `Glob`. Land task 1, re-run the same pull request, and compare
tool-call counts. If it drops materially, part of the cadence problem is a
conventions problem.

## 12. There is still almost no labelled data

**Risk:** none, and it is the instrument everything else is judged by.

`owner_accepted_precision` has had zero recorded feedback across five runs.
Fourteen hand-verified points now exist across two rounds and are sitting in
conversation rather than in the corpus. Record them through
`/review-voice:feedback`.

`basis` already carries the denominator - `(N kept or rewritten) / (M
labelled)` - so sample size travels with the number. But it is a `gate` with
target `>= 0.80`, so `meets` will render a binary verdict off fourteen points.
Do not let it fail a release yet.

**One inference to keep out of `docs/EVALUATION.md`.** From the three labelled
candidates on the most recent run:

```
          analyst  verifier  truth
cand_001    0.85     0.85    TRUE
cand_002    0.80     0.85    TRUE
cand_003    0.50     0.25    FALSE
```

The self-report separated true from false here too - min-true 0.80 against
max-false 0.50, a clean 0.30 gap - and 0.50 sits below the 0.70 analyst floor,
so it was gated correctly either way. The 0.9.2 split did not change which
findings shipped on this run.

What the sample does support, and it is the better property: the verifier moved
the two true findings by 0.00 and +0.05 and the false one by -0.25. It left
correct assessments alone and corrected the wrong one. That asymmetry is what
you want under a floor. Record it as that, not as separation the analyst also
achieved.
