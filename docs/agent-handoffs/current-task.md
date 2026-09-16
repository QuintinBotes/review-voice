# Current task — M1.2 Thin end-to-end review slice

**Milestone:** M1 (Phase 1, fixed-policy concise reviewer)
**Risk:** medium-high — first exercise of the CLI-versus-agent split
**Baseline:** `main` after #17

## Goal

Make `/review-voice:review` actually review a real diff, end to end, with no
GitHub access and no storage: acquire the diff, hand it to the agents, and
gate the result through `validate-output`.

Chosen over finishing the deterministic foundation first because the
CLI/agent split is the architecture's central bet and nothing has tested it.
An end-to-end slice surfaces a mistake there now rather than after four more
pieces are built on top, and it makes the plugin dogfoodable immediately.

## Scope

- `plugins/review-voice/src/diff/*.ts` (new): diff acquisition and file
  classification
- `plugins/review-voice/src/cli.ts`: wire the `diff` command
- `plugins/review-voice/commands/review.md`: real orchestration
- `plugins/review-voice/agents/*.md`: tighten where the pipeline needs it
- `test/diff.test.mjs` (new)
- `docs/ARCHITECTURE.md`, `CHANGELOG.md`

## Non-goals

- SQLite, audit log, feedback capture (M1.3)
- Policy file layering and `.review-voice/config.yaml` (M1.4)
- Static evidence adapters (M1.5)
- Precedent retrieval, scoring, GitHub — all later milestones

## Acceptance criteria

1. `review-voice diff` emits structured JSON: base and head, changed files with
   status, language and a generated/vendored/binary classification, plus the
   unified diff.
2. Supports the working tree (default), `--staged`, and `--base <ref>`.
3. Excludes lock files, generated, minified, vendored and binary files by
   default; `--include-generated` overrides.
4. Reports honestly when there is nothing to review rather than inventing a diff.
5. Runs from any subdirectory of a repository, and fails clearly outside one.
6. `commands/review.md` drives: diff → diff-analyst → evidence-verifier →
   concise-editor → validate-output, retrying the editor once on violation.
7. Unit tests cover classification, exclusions, argument handling and the
   empty-diff case.

## Commands

```
npm run typecheck && npm test && npm run build && npm run check:dist
```
