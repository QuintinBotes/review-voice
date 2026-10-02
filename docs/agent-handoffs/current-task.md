# Current task - raise a high-complexity change for a human's approval

**Decision record:** [ADR 0012](../adr/0012-complex-changes-need-human-approval.md).
Read it first; it is the spec. Do not re-open its decisions.
**Risk:** medium. Changes the verdict mapping (only ever more conservative), a
storage migration and the `diff --out` manifest. No new GitHub write.
**Baseline:** `main` at `4010eb7` (release 1.8.0). Branch
`feat/human-review-complexity`.

## Goal

`diff --out` assesses whether a change is high-complexity (added decision
points, sensitive paths). The assessment is recorded with the run. `verdict`
and `post` never approve a high-complexity pull request, and the review says
why in one line, so a human picks it up.

## Scope - allowed files

- `plugins/review-voice/src/diff/complexity.ts` (new) - the assessment.
- `plugins/review-voice/src/cli.ts` - `diff --out` manifest and summary,
  `record` reads it, `explain` shows it, `verdict`/`post` pass config.
- `plugins/review-voice/src/policy/load.ts` - `review.human_review` config.
- `plugins/review-voice/src/store/db.ts` - migration adding
  `review_runs.complexity_json`.
- `plugins/review-voice/src/store/runs.ts` - store and read it on `RunDetail`.
- `plugins/review-voice/src/publish/verdict.ts`, `src/publish/post.ts` - the cap.
- `plugins/review-voice/commands/review.md` - print `humanReviewNote`.
- `plugins/review-voice/templates/config.example.yaml` - document the block.
- `plugins/review-voice/dist/review-voice.mjs` - rebuilt with `npm run build`.
- `test/human-review-complexity.test.mjs` (new). **Do not edit any existing
  test file**; every existing one is pinned. Put all new tests in the new file.

## Non-goals

- No GitHub write other than the existing create-review request. No
  requested reviewers, no labels.
- No size (lines/files) or directory-spread signal; no truncation signal.
- Do not touch the prose "very large change" paragraph in `review.md`.
- Do not change `eventFor` or the severity mapping table.
- No CHANGELOG, version bump, CI or workflow changes.

## Design

### Assessment (`src/diff/complexity.ts`)

```ts
export interface HumanReviewConfig {
  maxDecisionPoints: number;      // default 40
  maxHunkDecisionPoints: number;  // default 15
  sensitivePaths: string[];       // default DEFAULT_SENSITIVE_PATHS
}
export const DEFAULT_SENSITIVE_PATHS = ['.github/workflows/**', '**/migrations/**', '**/auth/**', '**/security/**'];

export interface ComplexityAssessment {
  level: 'normal' | 'high';
  /** One short clause per signal that fired, e.g. "62 decision points added (limit 40)". */
  reasons: string[];
  decisionPoints: number;
  densestHunk: { path: string; line: number; decisionPoints: number } | null;
  /** Matched changed paths, at most 20, sorted. */
  sensitivePaths: string[];
  limits: { maxDecisionPoints: number; maxHunkDecisionPoints: number; sensitivePaths: string[] };
}

export function assessComplexity(diff: string, files: readonly ChangedFile[], config?: Partial<HumanReviewConfig>): ComplexityAssessment;
export function humanReviewNote(assessment: ComplexityAssessment | null): string | null;
export function parseComplexity(value: unknown): ComplexityAssessment | null; // for stored JSON; null on anything malformed
```

- Decision points: only `+` lines (not `+++`) inside hunks of files with
  `class === 'source'` and `reviewed === true`. Skip lines whose trimmed text
  starts with `//`, `#`, `*`, `/*` or `--`. Count, per line:
  `\b(if|elif|for|foreach|while|case|catch|except|when)\b`, `&&`, `||`, and a
  ternary ` ? ` (space either side). `else if` counts once (via `if`). Do not
  count `?.`, `??` or `?:`.
- Hunk = one `@@` block; `line` is the new-side start line of that hunk. Reuse
  `src/diff/hunks.ts` if it already splits hunks with new-side lines.
- Sensitive paths: match every changed file's `path` and `previousPath` (any
  class, reviewed or not) with `globToRegExp` from `src/conventions/globs.ts`.
  Verify `**/migrations/**` matches `migrations/001.sql` at the root and
  `db/migrations/001.sql`; if the helper does not, handle the leading `**/`
  in `complexity.ts` without changing `globs.ts` behaviour.
- `level` is `high` when decisionPoints > max, densest hunk > hunk max, or any
  sensitive path matched. Strictly greater than: at the limit is normal.
- `humanReviewNote`: null unless high. Otherwise one line:
  `Raised for human review: <reasons joined with "; ">. Review Voice will not approve this change.`
  Sensitive reason reads `touches sensitive paths (<first 3>, +N more)`.

### Config (`src/policy/load.ts`)

`review.human_review: { max_decision_points, max_hunk_decision_points,
sensitive_paths }` -> `LoadedConfig.humanReview: HumanReviewConfig`. Missing
block or key -> default. Non-positive or non-integer numbers -> default, with a
warning in `result.warnings`. `sensitive_paths: []` is valid and disables the
signal; a non-array is ignored with a warning.

### Manifest and summary (`src/cli.ts`)

`emitDiff` (both local and `--pr` paths) computes the assessment from the
diff result's `diff` and `files` with the repository config, and adds
`complexity` and `humanReviewNote` to the emitted object, `files.json`
manifest and `diffSummary`. Without `--out`, the inline JSON carries them too.

### Record (`src/store/db.ts`, `src/store/runs.ts`, `record` in `src/cli.ts`)

- New migration appended at the end of the migration list:
  `ALTER TABLE review_runs ADD COLUMN complexity_json TEXT;` with a short
  comment in the style of the v8 one.
- `record` reads `manifest.complexity` via `parseComplexity`; malformed -> not
  stored (with a stderr line, the run still records).
- `RunDetail.complexity: ComplexityAssessment | null`; a malformed stored value
  reads as null.

### Verdict (`src/publish/verdict.ts`, `src/publish/post.ts`)

- `computeVerdict` resolves the pull request's assessment: the recorded run's,
  and if its scope kind is not `full`, also each run along `scope.priorRunId`
  (depth at most 8, stop at a missing run or a cycle). High if any is high;
  the first high one found supplies the reasons. Null if none recorded one.
- `decide` gains `needsHuman?: boolean`. When `mapped === 'APPROVE'` and
  `needsHuman`: not a recheck -> `{ event: 'COMMENT', action: 'post',
  exitCode: 0 }` with reason `the change was raised for human review, so this
  comments rather than approves`, **before** the CI checks (pending CI does not
  produce a wait; red CI does not change the reason set beyond adding nothing
  further). Recheck -> `action: 'refuse', exitCode: 2`, reason `the change was
  raised for human review, so there is no approval to re-check`. Head moved
  still refuses first with exit 3.
- `summaryLine` gains `cappedBy: 'complexity'`: `No problems found; leaving
  approval to a human reviewer.` / `<n nits>; leaving approval to a human
  reviewer.` Precedence when several caps apply: `ci` > `held` > `complexity`.
- `buildPayload` gains `humanReviewNote?: string | null`; when set it is the
  body's second paragraph, for every event (also COMMENT and REQUEST_CHANGES).
- `VerdictOutput` gains `complexity: ComplexityAssessment | null`; when null on
  a recorded run, add the reason `no complexity assessment was recorded for this
  run` only to `reasons` (no cap).
- `post` uses the same `computeVerdict`, so it inherits all of the above. The
  re-read immediately before sending must not drop the cap.

### Explain and review command

- `explain` prints one line under the scope line: `complexity  high - <reasons>`
  or `complexity  normal`, nothing for null.
- `commands/review.md` Step 1: read `humanReviewNote` from the summary; if not
  null, print it on its own line after the findings, like `scopeNote`,
  including after `No actionable findings.`. Step 6: note that `record --files`
  is what carries the assessment to `verdict`.

## Acceptance criteria

1. `assessComplexity` counts decision points as specified, ignores comments,
   removed lines, non-source and unreviewed files, and `?.`/`??`.
2. Thresholds are strict-greater; densest hunk is reported with path and line.
3. Sensitive paths match unreviewed and renamed (`previousPath`) files; an
   empty configured list disables them; defaults apply when unconfigured.
4. `diff --out` writes `complexity` and `humanReviewNote` to `files.json` and
   the summary (test with a temp git repo through the bundle, as other tests do).
5. `record --files` stores the assessment; `runDetail` returns it; a run
   without it returns `complexity: null`; an old database migrates.
6. `verdict` on a high run that would APPROVE returns COMMENT, exit 0, with
   the reason and the note in `payload.body`; with CI pending it is still
   COMMENT/post, not wait; `--recheck` refuses with exit 2.
7. A high run that maps to REQUEST_CHANGES or COMMENT keeps its event but its
   body carries the note.
8. An incremental run with normal complexity whose prior run was high is
   still capped.
9. A run with no assessment is not capped and says so in `reasons`.
10. `npm run verify --silent` passes (typecheck, dist check, all tests,
    identity guard, pins). No existing test file is modified.

## Commands

```
npm run build
npm run typecheck
node --test test/human-review-complexity.test.mjs
npm run verify --silent
```

## Rules

- Never name any employer or its repositories in code, tests or comments; use
  `acme/web` and generic descriptions.
- Match the surrounding style: comments explain why, in full sentences, at
  the density of the neighbouring code.
- Do not commit, push or open a pull request.

## Return format

Compact report: files changed, tests run with outcomes, assumptions, any
deviation from this handoff and why, unfinished work.
