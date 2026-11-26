# Handoff rv-480-fix

- Task ID: rv-480-fix
- Tier: 2 (correction pass on rv-480)
- Profile: M
- Baseline ref: 2f74a88 (origin/main); the rv-480 changes are uncommitted in this worktree and stay

## Goal and scope

One correction pass for three review findings on the uncommitted rv-480 work in `plugins/review-voice/src/retrieval/retrieve.ts`. Each gets a test that fails before the fix (run it and see it fail), then the fix, then `npm run build`.

1. ~355 and ~520: `matchStrength` divides every precedent's relevance by the best relevance of the whole mixed set, so an outcome term-count score and a corpus bm25 score are compared as if on one scale. Normalise each source on its own: a corpus precedent by the best corpus relevance, an outcome precedent by the best outcome relevance (keep the existing floor of 1 per source). Fix the "BM25-like scale" comment to say what is now true. Test: one strong outcome match beside corpus hits does not shrink the corpus hits' matchStrength.
2. ~247-258: `loadOutcomeFindings` takes the newest 500 rows before `outcomePrecedents` scopes them by repository, so 500 newer out-of-scope outcomes hide an in-scope one. Give the loader an optional row filter and apply the 500 cap to rows that pass it: iterate the statement (node:sqlite `StatementSync.iterate()`) and stop after 500 kept rows, rather than `LIMIT 500` in SQL. `outcomePrecedents` passes its `inScope` and `isExcludedPull` checks as that filter; `learnedPrecedentStats` passes none and keeps today's behaviour. Test: 501 newer out-of-scope outcomes and one older in-scope outcome; the in-scope one is returned.
3. ~322-329: outcome matching compares exact lower-cased words, while corpus retrieval uses the FTS5 Porter tokenizer, so `timeouts` does not match `timeout`. Do not build a stemmer. Add a one-line `shortcut:` comment at the word match naming that limit and when to upgrade (match through FTS5 if outcome recall proves too low). No test.

## Allowed files

- `plugins/review-voice/src/**`
- `plugins/review-voice/dist/**`
- `test/issue-480-*.test.mjs`

## Non-goals

- No other behaviour change, no version bump, CHANGELOG or manifest change.
- No schema change and no migration.

## Acceptance criteria

- Cases 1 and 2 each have a test that failed before and passes after.
- Existing #480, outcomes and scoring tests stay green.
- `npm run verify` passes, apart from the known load-flaky process-timing tests in `issue-277-stoppable-commands` and the agent-runner timeout test (name any failure and its file).

## Commands to run

- focused: `npm run build && node --test test/issue-480-outcome-precedent.test.mjs test/outcomes.test.mjs test/scoring.test.mjs`
- broad: `npm run verify`

## Safety

- No commits, pushes, merges or rebases.
- No database writes outside a test's own temporary database.
- No pkill or killall by pattern. No docker rm or stop on containers you did not start.
- Do not edit CLAUDE.md, AGENTS.md or CI files.
- Stop and return on ambiguity or scope expansion.

## Return format

30 lines max: files changed, tests run and outcomes, assumptions and risks,
deviations from this handoff, unfinished work.
