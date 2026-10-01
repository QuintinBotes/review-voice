# Current task - verify the suggested fix separately from the defect

**Slice:** 1 of 8 from the field-feedback plan (fix verification, anchors,
follow-up scoping, verdict and posting, thread dedupe, severity, held and
carried findings, CLI consistency).
**Risk:** medium. Changes agent prompts, the score output and what the editor
renders; no GitHub, storage schema or security surface.
**Baseline:** `origin/main` at `abf7d00` (release 1.7.0). Branch
`feat/verify-suggested-fix`.

## Goal

A review states a fix only when the evidence-verifier traced that fix and
found it correct. Today no stage checks the fix: the analyst never sends one,
`normaliseCandidate` drops `suggested_fix` if it does, and the concise-editor
invents "the smallest practical correction" with no tools to check it.
Independent cross-checks then reject verified defects because the fix they
carry is wrong - on one pull request two successive fixes each broke an admin
path the original code served.

## Decided (do not re-open)

- **Fail closed.** No verified fix, no fix sentence. A verification file
  without fix fields renders no fix.
- The fix verdict **never** changes whether the defect is verified, its
  confidence, its eligibility or its severity.
- The rendering decision is arithmetic in the CLI, not a judgement in the
  editor.

## Design

### Analyst (`agents/diff-analyst.md`, `schemas/candidate.schema.json`)

- `suggested_fix` (string, max 300, already in the schema) and a new
  `fix_confidence` (number 0..1) are **optional**. Keep the nine required
  fields exactly as they are.
- Replace "exactly these nine fields" with wording that says nine required
  fields plus these two optional ones. The foreign-key list (`title`,
  `suggestion`, ...) stays refused; `suggestion` is still not `suggested_fix`.
- Instruct: propose a fix only when you can name the concrete change, and
  check it against every input the failure mode names **and** the paths the
  current code already serves correctly. Otherwise omit the field.
- `fix_confidence` is recorded for audit only, like `severity`.

### Verifier (`agents/evidence-verifier.md`)

Add to the output, per candidate:

| Field | Type | Meaning |
|---|---|---|
| `fix_verdict` | `verified` \| `partial` \| `refuted` \| `absent` | `absent` when the candidate has no `suggested_fix` |
| `fix_confidence` | number 0..1 | Confidence the fix removes the failure without breaking a served path |
| `fix_reason` | string | One sentence: which input was traced, what it showed |
| `fix_direction` | string, optional | One imperative clause, no specifics, no hedging words; only for `partial` |

State that the fix is traced through the same real inputs as the defect,
including paths the current code handles correctly, and that the fix verdict
does not feed `verified` or `technical_confidence`.

### Score (`src/scoring/score.ts`, `src/cli.ts` scoreCommand)

- `RawCandidate`/`Candidate` carry `suggestedFix` and `fixConfidence`.
  `normaliseCandidate` throws `MalformedCandidate` for a non-string
  `suggested_fix` or a `fix_confidence` that is not finite in [0, 1].
- `Verification` carries `fixVerdict`, `fixConfidence`, `fixReason`,
  `fixDirection`, read from snake_case or camelCase like the existing fields.
  An unknown `fix_verdict` value is treated as missing.
- Every `ScoreBreakdown` and every `eligible[]` entry gains:

  ```
  fix: {
    suggested: string | null,
    verdict: 'verified' | 'partial' | 'refuted' | 'absent' | null,
    confidence: number | null,
    direction: string | null,
    render: 'fix' | 'direction' | 'none',
    reason: string          // why this render, human-readable
  }
  ```

- Render rule, exactly:
  1. `fix` when `suggested` is non-empty, `verdict === 'verified'` and
     `confidence >= thresholds.technicalConfidence`;
  2. `direction` when `verdict === 'partial'` and `direction` is non-empty;
  3. otherwise `none`.
- Nothing else in scoring reads the fix fields.

### Editor (`agents/concise-editor.md`)

- Contract line becomes `[severity] \`path:line\` - Problem. Consequence. Fix.`
  with the fix sentence present only when `fix.render` is not `none`.
- `fix`: state `fix.suggested`, shortened if needed, without changing what it
  changes. `direction`: state `fix.direction`. `none`: stop after the
  consequence.
- Remove "State the smallest practical correction when it is evident from the
  candidate." The editor never writes a fix of its own.

### Contract and output (`src/contract/validate.ts`, `schemas/review-output.schema.json`)

The format regex is unchanged; a finding without a fix already validates. Only
the violation message at `validate.ts:68` and the schema's `text` description
change, to show the fix as optional.

### Explain (`src/cli.ts` explainCommand)

Per finding, from the stored score breakdown: `fix  verified 0.86`,
`fix  direction (partial 0.70)`, `fix  withheld (refuted): <reason>`, or
`fix  none proposed`. Older runs without `fix` print nothing extra.

### Command and docs

- `commands/review.md` step 3: the verifier's fix fields go into
  `verification.json` with everything else. Step 5: pass each `eligible[]`
  entry with its `fix` inline; the editor renders only what `fix.render` says.
- `plugins/review-voice/README.md` and `docs/ARCHITECTURE.md`: say that the
  editor has no tools, so candidate content must be passed inline, never as a
  path; and that fixes are verified separately from defects.
- `CHANGELOG.md`: an Unreleased entry.

## Allowed files

- `plugins/review-voice/agents/diff-analyst.md`
- `plugins/review-voice/agents/evidence-verifier.md`
- `plugins/review-voice/agents/concise-editor.md`
- `plugins/review-voice/schemas/candidate.schema.json`
- `plugins/review-voice/schemas/review-output.schema.json`
- `plugins/review-voice/src/scoring/score.ts`
- `plugins/review-voice/src/cli.ts` - `scoreCommand`, `explainCommand`,
  `checkCandidatesCommand` and the USAGE text only
- `plugins/review-voice/src/contract/validate.ts` - the message string only
- `plugins/review-voice/commands/review.md` - steps 3 to 5 only
- `plugins/review-voice/README.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`
- `plugins/review-voice/dist/review-voice.mjs` - regenerated by
  `npm run build`, never hand-edited
- `test/scoring.test.mjs`, `test/seams.test.mjs`, `test/cli.test.mjs`,
  `test/contract.test.mjs`

## Non-goals

- The external second-pass `RV verify` and its report shape.
- Anchor checks, severity, thread dedupe, scoping, posting: later slices.
- Version bump, release, commits, pushes, pull requests.
- Agent tool grants: `concise-editor` stays `tools: []`.

## Acceptance criteria

1. The render rule holds for every row: verified at 0.8 and above → `fix`;
   verified below 0.8 → `none`; partial with a direction → `direction`;
   partial without one → `none`; refuted, absent, missing or unknown verdict
   → `none`.
2. For one candidate, `eligible`, `technicalConfidence`, `rejectedBecause` and
   `severity` are identical whether its fix verdict is `verified` or
   `refuted`.
3. A verification file with no fix fields scores exactly as it does today,
   apart from the new `fix` object with `render: 'none'`.
4. `check-candidates` accepts `suggested_fix` and `fix_confidence`, and exits
   2 for `fix_confidence` outside [0, 1] or a non-string `suggested_fix`.
5. Seam tests: every fix field `score` reads is named in the verifier prompt;
   the analyst prompt names `suggested_fix` and `fix_confidence`; the editor
   prompt names the three render values and no longer tells the editor to
   write its own correction.
6. `validate-output` accepts a finding with no fix sentence.
7. `explain` prints the fix line for a run whose scores carry `fix`, and
   nothing extra for an older run.
8. `npm run verify` passes, including `check:dist` and `guard:identity`.
9. No code, test, fixture or comment names a real employer, repository, bot
   or pull request. Use neutral names such as `acme/web` and describe
   incidents generically.

## Commands

```
npm run build
npm run verify
```

## Return format

Files changed; tests run and their outcomes; assumptions; risks; deviations
from this handoff; unfinished work.

---

# Standing items from 1.2.0 (unchanged)

**Milestone:** 1.2.0 released. The queue from the September retests is empty of
code fixes.
**Risk:** low. Nothing is outstanding that can be closed by writing code.
**Baseline:** `main`

## What closed

Twelve queue items, in five releases from 1.1.0 to 1.2.0. Each landed with the
evidence that motivated it in the commit, so the reasoning survives without
this file.

| # | Item | Where |
|---|---|---|
| - | Severity collapsed to minor or nit | #75, ADR 0009 |
| 1 | Convention stubs pointing at two documents resolved neither | #78 |
| 9 | Truncation silent; byte budget counted UTF-16 units | #78 |
| 4 | Editor could not receive findings by path | #79 |
| 5 | Analyst prompt named its schema instead of carrying it | #79 |
| 6 | `RV` as a shell variable fails under zsh | #79 |
| 10 | `--min-score` help advertised a default three releases stale | #79 |
| 10b | Agent tool grants unverified | #80, partially |
| - | Reach measured word popularity; `local` unreachable | #81 |
| 2 | Pull request commits never made available locally | #83 |
| 3a/3b | External verifier judged the working tree | #83 |
| 8 | Empty untracked files bought word budget | #83 |
| 7 | Precedent alignment near-constant | #84, shadowed |

## What remains, and why none of it is a code fix

### 1. Run `evals/confinement`

**Risk:** unknown, which is the point.

#80 pinned every agent's declared tool grant and added an eval that probes
whether the grant binds. **It has never been run.** Until it has,
`docs/THREAT-MODEL.md` says plainly that threat 4's mitigation is asserted
rather than verified.

The observation behind it stands: a verification stage reportedly built a
synthetic workspace with the repository's own pinned yarn and ran its oxlint,
and neither is `git`. Three outcomes, different fixes:

1. The grant does not confine subagents - the mitigation is not implemented as
   documented and every declared grant is decorative.
2. The orchestrator ran those commands - confinement holds, and the threat
   model should say which component its claim covers.
3. Something widened the grant at runtime - then what.

```
claude plugin eval plugins/review-voice --eval-dir evals
```

### 2. Measure the precedent switch

**Risk:** high if guessed, zero if measured.

#84 ships `anchored` on every score breakdown: what the final score would be
with anchor-less precedents excluded, and whether eligibility would flip. The
gate still uses the current computation.

The switch needs runs, not a decision. Excluding moves the score by 0.0527 to
0.1131 against a 0.68 threshold, and `score.ts` already records what happens
when that kind of shift is answered with arithmetic: 0.74 was arithmetic and
was wrong; 0.68 was measured and replaced it.

Collect `anchored.wouldChangeEligibility` across real reviews. When the flips
are visible, move the gate and the exclusion together in one change.

### 3. Label findings in normal use

`owner_accepted_precision` has still never had a data point. This has been the
open item since before 1.0.0 and no amount of code closes it.

Note the distinction that matters for reading the metric: hand-verified labels
record whether a finding was **true**; the metric measures whether it was
**kept**. Related, not identical.

### 4. Derive reach symbols from the diff

**Risk:** medium. The largest remaining design change.

Reach takes its symbols from the claim via `namedSymbols`, an extractor built
to find things to check for absence, where a broad net is cheap. #81 excluded
symbols the changed file does not contain and symbols common enough to describe
the language, which caught `Math.round` and `canEdit`. It does not catch the
symbol a finding exists to say is the **wrong** referent, because that symbol is
genuinely in the file.

The changed hunks name what the pull request actually touched. That is the
thing whose spread matters.

Related, and closed by the same work: reach is computed at the base ref, so a
symbol the change introduces has no spread by construction and falls back to
the category tier. Safe, but it makes the feature inert for most findings,
which are about new code.

### 5. Relevance-scoped convention selection

#78 made truncation visible. It did not make it stop losing content. A 21,441
byte rule governing 728 of 1,073 added lines is still cut at 15,000; the reader
can now see the cut, which is not the same as reading the rule. Selecting the
sections matching changed paths, rather than the head of the file, is the real
answer.

### 6. Reviews cannot complete inside a ten-minute sweep

Measured: analyst 238k tokens across 94 tool calls, roughly ten minutes;
verifier 141k across 59, about five. A review has to become a resumable job
rather than a tick-scoped task, and `store/runs.ts` already has `recordRun`,
`latestRun` and `runDetail` to build on.

**Measure before designing.** #78 fixed the pointer bug that left the analyst
without the controller rules on a run where it made 94 tool calls holding
`Grep` and `Glob`. Re-run that pull request and compare. If the count drops,
part of the cadence problem was a conventions problem.
