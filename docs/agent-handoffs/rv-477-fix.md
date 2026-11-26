# Handoff rv-477-fix

- Task ID: rv-477-fix
- Tier: 2
- Profile: M
- Baseline ref: 2f74a88 (origin/main); the working tree already holds the rv-477 change (uncommitted). Build on it.

## Goal and scope

Correction pass on the rv-477 change in `plugins/review-voice/src/diff/incremental.ts` (`demoteBaseAdditions` / `addedHeadLines` / `interdiffFrom`). Two review findings:

1. A line the author restores after deleting it in the reviewed head (a withdrawn deletion) is not a `+` line of the own diff (merge base to head), so it is demoted to context, its hunk is dropped, and the withdrawal disappears; a file with only that change reads as unchanged. Fix: demote a non-own `+` line only when the BASE added it between the two merge bases. Use the `baseDelta` section already read in `interdiffFrom` (`diffText(priorMergeBase, mergeBase, ...)`): collect its added new-side line numbers (lines in the mergeBase file). Map each candidate head line to its mergeBase line number by walking the own-diff section's hunks (mergeBase..head): for a head line that is not a `+` line of the own diff, its mergeBase line is the head line minus (own `+` lines before it) plus (own `-` lines before it), computed hunk by hunk. Demote only when that mergeBase line is an added line of `baseDelta`. A `+` line that is neither own-added nor base-added (a restored line) stays `+`. If `baseDelta` for the path is missing or cannot be parsed, fall back to the current rule (demote every non-own `+`), so behaviour never gets less safe than rv-477.
2. A path is added to the `demoted` note list before the empty-text check, so a file dropped entirely is named in the "shown as context" note though absent from the patch. Only name files whose demoted section is still in the patch.

## Allowed files

- `plugins/review-voice/src/diff/incremental.ts`
- `test/issue-477-interdiff-base-lines.test.mjs`
- `test/issue-235-conflicting-replay-interdiff.test.mjs`
- `test/issue-26-merge-resolution-hunks.test.mjs`
- `test/issue-63-conflicted-replay-unchanged.test.mjs`
- `plugins/review-voice/dist/review-voice.mjs`
- `CHANGELOG.md`
- `docs/agent-handoffs/rv-477.md`
- `docs/agent-handoffs/rv-477-fix.md`

## Non-goals

- Do not change matching by head line number to matching by text.
- No change to check-candidates, carry, scoring, CLI flags, or non-conflicting interdiff paths.
- No version bump.

## Acceptance criteria

- New test case in `test/issue-477-interdiff-base-lines.test.mjs`: the reviewed head deletes a line L of a file; the base then conflicts in that file (so it takes the conflicting-replay path) and adds its own lines; the author merges the base and restores L. Assert L appears as a `+` line in the interdiff, the base-only lines do not appear as `+`, the hunk header counts match their bodies, and the scope is not `unchanged`.
- New assertion that the "shown as context" note does not name a file absent from the patch (a case where every since-review `+` in a file is base-added).
- The existing rv-477 test and the updated issue-235 / issue-26 / issue-63 tests stay green (adjust their expectations only if the narrower demotion legitimately keeps a line as `+`, and say which).
- `npm run typecheck` passes; `npm run build` then `npm run check:dist` passes.

## Commands to run

- focused: `node --test test/issue-26-merge-resolution-hunks.test.mjs test/issue-477-interdiff-base-lines.test.mjs test/issue-235-conflicting-replay-interdiff.test.mjs test/issue-63-conflicted-replay-unchanged.test.mjs test/issue-73-no-replay-markers.test.mjs test/incremental.test.mjs`
- broad: `npm run typecheck && npm run check:dist && node --test "test/**/*.test.mjs"`

## Safety

- No commits, pushes, merges or rebases.
- No database writes.
- No pkill or killall by pattern. No docker rm or stop on containers you did not start.
- Do not edit CLAUDE.md, AGENTS.md or CI files.
- Stop and return on ambiguity or scope expansion.

## Return format

30 lines max: files changed, tests run and outcomes, assumptions and risks,
deviations from this handoff, unfinished work.
