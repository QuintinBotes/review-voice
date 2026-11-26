# Handoff rv-482-fix2

- Task ID: rv-482-fix2
- Tier: 2 (correction pass on PR #491, branch fix/482-cat-file-timeout)
- Profile: M
- Baseline ref: c250d19 (the branch head; this pass adds uncommitted changes on top)

## Goal and scope

`plugins/review-voice/src/git-exec.ts` ~151: on POSIX, `runGitCatFileSync` always calls `killGroup(-pid, SIGKILL)` after `spawnSync` has reaped git. Once the group is empty its id can be reused by another group leader, which then gets killed. Decided fix (option b, approved): end the group only when `spawnSync` reports a timeout (its `error.code` is `ETIMEDOUT`, or `signal` is set by the timeout), never after a normal exit or an ordinary non-zero exit. On a timeout the leftover descendants keep the group alive, so the id cannot be reused yet.

1. Make the group-kill function injectable (an optional dependency or parameter with the real kill as default), so a test can count calls.
2. Test first: a normal, fast git exit sends no group kill (count calls through the injected kill, not by timing). Run it and see it fail before the fix.
3. Keep the existing timeout test that proves the descendant dies.
4. Windows: `taskkill /T` follows the same rule (only on a timeout). Keep its documented limit.
5. At the kill site, add one comment exactly in the form `shortcut: <the limit>, <when to upgrade>`: the limit is that descendants exiting between the reap and the kill leave a small reuse race, and on Windows the tree is reaped first; the upgrade is the async runner in issue #493.
6. `npm run build`.

## Allowed files

- `plugins/review-voice/src/git-exec.ts`
- `plugins/review-voice/dist/**`
- `test/issue-482-cat-file-timeout.test.mjs`

## Non-goals

- No async conversion of any caller (that is issue #493).
- No version bump, CHANGELOG or manifest change.

## Acceptance criteria

- The no-kill-on-normal-exit test failed before and passes after.
- The existing timeout and clamp tests stay green.

## Commands to run

- focused: `npm run build && node --test test/issue-482-cat-file-timeout.test.mjs`
- broad: `npm run verify`

## Safety

- No commits, pushes, merges or rebases.
- No database writes.
- No pkill or killall by pattern. No docker rm or stop on containers you did not start.
- Do not edit CLAUDE.md, AGENTS.md or CI files.
- Stop and return on ambiguity or scope expansion.

## Return format

30 lines max: files changed, tests run and outcomes, assumptions and risks,
deviations from this handoff, unfinished work.
