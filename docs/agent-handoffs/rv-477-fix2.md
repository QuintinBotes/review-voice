# Handoff rv-477-fix2

- Task ID: rv-477-fix2
- Tier: 1 (correction pass on PR #490, branch fix/477-interdiff-own-lines)
- Profile: M
- Baseline ref: 51ce3c6 (the branch head; this pass adds uncommitted changes on top)

## Goal and scope

One review nit on `plugins/review-voice/src/diff/incremental.ts` ~1035: `demoted` is filled before base-only hunks are dropped. When a separate author hunk is kept, the scope detail says base lines show as context although the hunk holding them is gone. Record a demotion only for hunks that are kept in the final patch.

First confirm the defect with a test that fails before the fix (run it and see it fail). If you cannot make it fail because the behaviour is already right, stop and return the evidence instead of changing code. Then fix, then `npm run build`.

## Allowed files

- `plugins/review-voice/src/diff/incremental.ts`
- `plugins/review-voice/dist/review-voice.mjs`
- `test/issue-477-interdiff-base-lines.test.mjs`

## Non-goals

- No other behaviour change, no version bump, CHANGELOG or manifest change.

## Acceptance criteria

- A test with one dropped base-only hunk and one kept author hunk fails before and passes after: the detail does not claim base lines are shown as context for the dropped hunk.
- Existing #477, #26, #235, #63, #73 and incremental tests stay green.

## Commands to run

- focused: `npm run build && node --test test/issue-26-merge-resolution-hunks.test.mjs test/issue-477-interdiff-base-lines.test.mjs test/issue-235-conflicting-replay-interdiff.test.mjs test/issue-63-conflicted-replay-unchanged.test.mjs test/issue-73-no-replay-markers.test.mjs test/incremental.test.mjs`
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
