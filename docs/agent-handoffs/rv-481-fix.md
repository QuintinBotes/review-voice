# Handoff rv-481-fix

- Task ID: rv-481-fix
- Tier: 2
- Profile: M
- Baseline ref: 693bda5 (branch feat/481-calibration-v2: the #481 first pass on top of #486 on top of #485 on origin/main c05ebc6)

## Goal and scope

Correction pass on #481 (`evaluate calibration` and `evaluate label-sample`, in `plugins/review-voice/src/evaluate/calibration.ts` and `src/cli/evaluate.ts`). A review of the first pass confirmed three important defects. Two were blocked on data that #485 and #486 now record, and both are in this baseline. Fix all four items below and nothing else.

1. **Held candidates keep their context (uses #486).** `loadStoredRuns` (calibration.ts, near line 311-364) builds each candidate's category and claim from the run's stored candidates. Before #486 those held only eligible findings, so a held candidate reported category `unknown` and a blank claim, and proposed re-gating was not applicable to it. Since #486, `candidates_json` also holds every held candidate, marked `held: true`, with `category`, `claim`, `failure_mode`, `path`, `line` and `severity`. Match each score breakdown to its stored candidate by candidate id (`candidate_id` or `candidateId`), whether held or not. A run stored before #486 has no held entries; keep today's fallback for it (category `unknown`) and do not guess.
2. **The verdict comes from the recorded field (uses #485).** `verifiedOf` (calibration.ts, near line 269) infers `verified` from prose and from the confidence source. A rejected low-confidence question (`verified: false`, `premises_verified: true`, confidence below 0.5) is wrongly counted as verified. Since #485, every `ScoreBreakdown` records `verified: boolean | null` and `premisesVerified: boolean | null`. Read `score.verified` when the key is present, including an explicit null meaning no verification. Fall back to today's inference only for a breakdown that has no `verified` key (stored before #485). Fix the fallback's prose check too, so the rejected-question case above is not counted as verified either way.
3. **Hold reasons come from `gate` (uses #485).** `holdReasonOf` in `src/scoring/score.ts` (near line 2304) maps `rejectedBecause` prose to a `HoldReason`. Its callers are calibration.ts line 515 and score.ts lines 2380 and 2389. Make it take the breakdown, or the breakdown's `gate` plus `rejectedBecause`. Map from `gate` when it is present: `HOLD_GATES` codes to `confidenceFloor`, `materiality`, `ownerPrecedent`, `unverifiable`, `score` and `policy`, and every other code to `other`. Use the prose only when `gate` is absent. The materiality bucket must come only from `gate === 'materiality'` when gate is present. Look at `gateOf` in `src/cli/score.ts` for the same pattern.
4. **The store is opened read-only.** `calibrationCommand` and `label-sample` call `openDatabase()` (cli/evaluate.ts lines 92, 140 and 223 - check which belong to the two new subcommands and leave the other subcommands alone). `openDatabase` creates the directory, sets WAL, migrates and chmods, which breaks the "never writes the store" contract. Add a read-only open in `src/store/db.ts`, for example `openDatabaseReadOnly(path?)`, that uses `node:sqlite`'s `readOnly: true`, never creates or migrates, and:
   - when the database file does not exist, returns null so the subcommand reports an empty result (no runs) and exits 0;
   - when the schema is older than the code expects, so a column it needs is missing, exits 2 with one line saying to run any other review-voice command once to upgrade the store.
   Use it only in the two calibration subcommands.

## Allowed files

- `plugins/review-voice/src/evaluate/calibration.ts`
- `plugins/review-voice/src/cli/evaluate.ts`
- `plugins/review-voice/src/scoring/score.ts`
- `plugins/review-voice/src/store/db.ts`
- `plugins/review-voice/dist/**`
- `CHANGELOG.md`
- `test/issue-481-calibration.test.mjs`
- `docs/agent-handoffs/rv-481-fix.md`

## Non-goals

- No change to scoring, eligibility, thresholds or any posted text.
- No stability mode (`--no-cache`); that is a separate issue.
- No change to other `evaluate` subcommands or their store access.
- No version bump.

## Acceptance criteria

- Tests in `test/issue-481-calibration.test.mjs`, each failing on the baseline:
  - a run recorded with a held candidate (`held: true` in candidates) reports that candidate's real category in the band/category tables and the label sheet, and it counts as re-gateable;
  - a pre-#486 run without held entries still reports `unknown`;
  - a breakdown with `verified: false`, `premisesVerified: true` and confidence 0.4 on a question counts as rejected, lands in the rejection audit and lands in the rejected sample stratum; the same breakdown without the `verified` key, as stored before #485, does too;
  - holds by reason read `gate`: rewording a `rejectedBecause` string does not change the bucket, `gate: 'materiality'` lands in materiality, and an old breakdown without `gate` keeps the prose mapping;
  - `evaluate calibration` against a data dir with no database file exits 0 with an empty report and leaves no file or directory behind; against an existing database it leaves the file's bytes and mtime unchanged.
- The existing tests in `test/issue-481-calibration.test.mjs`, `test/issue-485-structured-gate.test.mjs`, `test/issue-486-held-context.test.mjs` and `test/scoring.test.mjs` pass.
- `node scripts/build.mjs` then `node scripts/build.mjs --check` pass, and `./node_modules/.bin/tsc --noEmit` is clean.
- Amend the #481 CHANGELOG entry under Unreleased only where the behaviour it describes changed. Do not add a new entry.

## Commands to run

- focused: node --test test/issue-481-calibration.test.mjs test/issue-485-structured-gate.test.mjs test/issue-486-held-context.test.mjs test/scoring.test.mjs
- broad: npm run verify

## Safety

- No commits, pushes, merges or rebases.
- No database writes outside temporary test directories.
- No pkill or killall by pattern. No docker rm or stop on containers you did not start.
- Do not edit CLAUDE.md, AGENTS.md or CI files.
- Stop and return on ambiguity or scope expansion.
- Run node tests with `GIT_CONFIG_GLOBAL=/dev/null` in the environment: the global git hooks on this machine stall commits in scratch test repositories.

## Return format

30 lines max: files changed, tests run and outcomes, assumptions and risks,
deviations from this handoff, unfinished work.
