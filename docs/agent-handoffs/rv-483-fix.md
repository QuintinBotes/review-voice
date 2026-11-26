# Handoff rv-483-fix

- Task ID: rv-483-fix
- Tier: 2 (correction pass on rv-483)
- Profile: M
- Baseline ref: 2f74a88 (origin/main); the rv-483 changes are uncommitted in this worktree and stay

## Goal and scope

One correction pass for four review findings, plus one comment, on the uncommitted rv-483 work. Each code fix gets a test that fails before it (run it and see it fail), then the fix, then `npm run build`.

1. `plugins/review-voice/src/queue/relevance.ts` ~125-132 (`codeownersPatternMatches` or its pattern builder): an unanchored pattern whose last path segment has no wildcard (`**/logs`, `docs/**/logs`) must also own every file beneath that directory, as GitHub CODEOWNERS does (`**/logs` owns `build/logs/a.ts`). Today descendants are added only when the whole pattern has no wildcard. Test: `**/logs` owns `build/logs/a.ts` and `deeply/nested/logs/x/y.ts`; `**/*.ts` still does not own a directory's descendants by that rule.
2. relevance.ts ~85-94 (`parseCodeowners`): a rule line starting with `\#` is ignored, because GitHub does not support escaping a leading `#`. Test: `\#foo @team` owns nothing, so a change to `#foo` gets no owned signal.
3. `plugins/review-voice/src/queue/relevance-command.ts` ~65: a `GitHubError` with status 401 or 403 from the pull request or files read exits 2 (credential problem) with one line on stderr naming the status, as the command's contract says; other GitHub errors keep exit 1. Test both.
4. `plugins/review-voice/templates/config.example.yaml` ~378: the single-quoted regex example must be `'\bbilling\b'` (YAML single quotes keep backslashes as typed). No test.
5. `plugins/review-voice/src/github/client.ts` ~126: discovery uses `org:` for an `owner/*` scope, which misses a personal account. Do not change the query. Add a one-line `shortcut:` comment there naming the limit and when to upgrade (pick `user:` or `org:` from the owner type if a personal owner is ever allowlisted). No test.

## Allowed files

- `plugins/review-voice/src/**`
- `plugins/review-voice/dist/**`
- `plugins/review-voice/templates/config.example.yaml`
- `test/issue-483-*.test.mjs`

## Non-goals

- No other behaviour change, no version bump, CHANGELOG or manifest change.
- `readFiles` truncation stays as it is: an exact-fit final page omits nothing, so `truncated: false` is correct there.

## Acceptance criteria

- Cases 1, 2 and 3 each have a test that failed before and passes after.
- Existing #483, queue and issues-config tests stay green.
- `npm run verify` passes, apart from the known load-flaky process-timing tests in `issue-277-stoppable-commands` and the agent-runner timeout tests (name any failure and its file).

## Commands to run

- focused: `npm run build && node --test test/issue-483-queue-relevance.test.mjs test/queue.test.mjs test/issues-config.test.mjs`
- broad: `npm run verify`

## Safety

- No commits, pushes, merges or rebases.
- No database writes outside a test's own temporary database. No network calls; tests use the fake client.
- No pkill or killall by pattern. No docker rm or stop on containers you did not start.
- Do not edit CLAUDE.md, AGENTS.md or CI files.
- Stop and return on ambiguity or scope expansion.

## Return format

30 lines max: files changed, tests run and outcomes, assumptions and risks,
deviations from this handoff, unfinished work.
