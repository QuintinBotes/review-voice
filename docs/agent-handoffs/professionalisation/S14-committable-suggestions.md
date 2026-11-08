# S14. Committable suggestion blocks for verified fixes

**Phase:** 3 (evidence made visible), optional. **Depends on:** nothing.
**Size:** about 260 source lines, 300 test lines, two prompt paragraphs, one
schema field, one ADR; one Orbit run. **Risk:** medium. A suggestion the author
applies in one click is a stronger act than a sentence, so the bar for rendering
one is higher than for rendering prose. Baseline `919d0fd` (1.21.1). Verified
against the code on 2026-11-07.

## Why

Every professional pull-request reviewer surveyed for the program README posts
committable suggestion blocks the author applies in one click (GitHub Copilot,
CodeRabbit, Qodo, Sourcery, Greptile, Graphite, Cursor, Augment, Devin).
Review Voice renders a verified fix as a sentence of prose. It already has the
hard part: the verifier judges a `suggested_fix` separately from the defect,
and a fix renders only when `fix_verdict` is `verified` and `fix_confidence`
meets the configured threshold (`renderFix`, `plugins/review-voice/src/scoring/score.ts:1367-1400`,
stored as `ScoreBreakdown.fix.render`), and candidates are anchored on real
new-side lines (`check-candidates`). CodeRabbit documents the exact constraint
for a committable block: anchored to new-side lines with a valid range.

What is missing is the replacement text itself. `suggested_fix` is a
description of at most 300 characters (`schemas/candidate.schema.json`), not
code. The pipeline also drops any field it does not know: `normaliseCandidate`
in `score.ts` builds a fixed-shape `Candidate`, `score`'s `eligible` list is an
explicit projection (`cli.ts:2216-2245`) that becomes `record-candidates.json`,
and `post.ts recordedCandidates` normalises again (`post.ts:512-530`). The
writer's `ReviewComment` is `{ path, line, side, body }` and `assertPayload`
validates exactly those (`src/github/writer.ts:11-16`, `:148-176`).

## Outcome

When a candidate carries a concrete replacement for a short range of changed
lines, the verifier verified that replacement at the fix bar the prose already
meets, and the CLI confirmed the range's current text, the inline comment
carries a GitHub suggestion block the author can commit. Everything else
renders as today. The feature is off until a repository turns it on.

## Design

### Candidate field

`schemas/candidate.schema.json` gains an optional

```json
"suggested_patch": {
  "start_line": 84, "end_line": 85,
  "original": "res.json(token);\nawait tx.commit();",
  "replacement": "await tx.commit();\nres.json(token);"
}
```

with all four properties required, `start_line <= end_line`,
`end_line - start_line <= 4` (at most five lines), `end_line === line` (the
candidate's anchor, so the comment's `line` stays the matched anchor and the
block replaces exactly `start_line..line`), both strings at most 600
characters, and no line of either string starting with three backticks (it
would close the fence). `agents/diff-analyst.md` documents it beside
`suggested_fix`, with the example above: provide it only when the fix is a
direct replacement of those lines and nothing else must change; a fix that
needs a new import, a new test or an edit elsewhere stays prose.

### Data path (the pipeline drops unknown fields)

- `normaliseCandidate` (`score.ts`) refuses a `suggested_patch` that is not
  an object with integer `start_line` and `end_line`
  (`1 <= start_line <= end_line`, `end_line - start_line <= 4`,
  `end_line === line`), string `original` and `replacement` each at most 600
  characters, or with a line starting with three backticks, with a
  `MalformedCandidate` message naming the rule; the 600 cap is enforced here
  because `boundLists` (`cli.ts:1521`) truncates longer strings with `...` at
  the eligible projection. It carries the valid field as `suggestedPatch` on
  `Candidate`.
- `check-candidates` checks that `start_line..end_line` are added lines of
  the anchored file in the diff and that `original` equals the added lines'
  text at that range. `FileHunks` (`src/diff/hunks.ts:14-20`) gains
  `addedText: Map<number, string>` (right-side line to the line's text without
  the leading `+`), filled by `parseHunks` where `added` is
  (`hunks.ts:236-244`); `check-candidates` compares `original` with
  `addedText` over the range, so a transcription slip is caught before the
  verifier runs; it refuses a range on context lines, a range longer than
  five lines, an `end_line` that is not the anchor, a missing `original`, an
  `original` that differs from the diff, or a fenced line.
- `score`'s `eligible` projection includes `suggested_patch`.
- `recordRun`'s `assignIds` copies it from the paired `CandidateHint` onto
  `StoredFinding.suggestedPatch`.
- `post` and `outcomes` read it from `run.findings` by `findingId`
  (`reviewFindings` numbers `rv_NN` exactly as `record` does, `verdict.ts:47-50`),
  never from `candidates_json`.

### Verification

`agents/evidence-verifier.md` says that when a `suggested_patch` is present
the fix verdict judges that exact replacement: `verified` only when the
replacement, applied to those lines, removes the failure and breaks no served
path, and when the replacement compiles in context as far as reading shows.
The block renders only when the finding's backing score (the one
`verification()` matched, `verdict.ts:127-183`) has `fix.render === 'fix'`,
that is the verifier's `fix_verdict` is `verified` and its `fix_confidence`
meets `review.confidence_threshold`; `ScoreLike` gains `fix?: { render?: unknown }`.
This is the same bar the prose fix already meets.

### Head check and rendering

`review.suggestions: false` travels on `VerdictPolicy` (`verdict.ts:275-283`,
filled by `load.ts` as `cap_approval` is), so `cli.ts` and the watcher need no
plumbing change; `test/verdict-policies.test.mjs` "config: each setting is
read" deep-equals the whole policy, so its literal gains `suggestions: true`
and its yaml `suggestions: true` under `review:`, and "an invalid value warns"
gains `suggestions: maybe` under `review:` with its expected warning count
raised by one (S09 raises it by two; the two land in either order). In
`computeVerdict` (shared by `verdict`, `post` and the watcher, so the preview
is what is sent), for each rendered finding with a patch and
`fix.render === 'fix'`, and only when `suggestedPatch.end_line` equals the
finding's recorded line (the challenge step and `reanchor` move a confirmed
finding to a corrected line through `reanchorScores`,
`verify/challenge.ts:298-303`, and the patch range does not move with it;
otherwise the block is withheld with reason `anchor moved`), the client
fetches
`GET /repos/{r}/contents/{path}?ref={head}` (base64 content; `assertAllowed`
checks only the repository), decodes it, and renders the block only when lines
`start_line..end_line` equal `original`; otherwise the prose stays and
`VerdictOutput.withheldSuggestions` records the finding and reason, which
`renderPreview` prints as "suggestion withheld". A failed read withholds. The
idempotency key covers the payload, so a block is part of the review identity
as the prose already is.

`ReviewComment` (`writer.ts`) gains optional `start_line` and
`start_side: 'RIGHT'`; `assertPayload` refuses a comment whose `start_line` is
not an integer at or below `line` or whose `start_side` is not `RIGHT`; a
one-line range sets neither. `inlineComment` renders, after the prose:

````
```suggestion
await tx.commit();
res.json(token);
```
````

The concise editor is unchanged: it receives the fix instruction as today and
never writes code; the block comes from the candidate's verified field through
the CLI.

### Outcome tracking

When a `StoredFinding` carries `suggestedPatch` and `linesChanged` is true
(`outcomes.ts:381-405` reads only whether the range was touched), `outcomes`
fetches the file at the current head through the same contents endpoint,
compares the lines from `start_line` for as many lines as `replacement` has
(`replacement.split('\n').length`) with `replacement`, and on equality
returns `fixed` (strong) with evidence "suggestion applied" before the
resolved-or-agreed rule; an empty `replacement` (a deletion) skips this rule;
a failed read falls through to the existing rules.
The outcomes test fake (`test/outcomes.test.mjs:79-93`) learns `/contents/`.

### Documentation

A new ADR, `00NN-committable-suggestions-are-verified-patches.md` (the next
free number at implementation time; 0033 if S06 has landed, else 0032),
records the bar (fix verdict at the prose bar, range check against the head,
opt-in), what is rejected (editor-written code, blocks for partial fixes,
blocks longer than five lines) and the relation to ADR 0010 (a block is comment
text the author applies; the bot still never pushes). ADR 0029 gains a dated
`## Amendment - <date>` section naming the applied-suggestion outcome (S07
adds its own dated section, so both coexist). `docs/adr/README.md` lists the
new ADR and marks the 0029 row `Accepted, amended by 00NN`;
`config.example.yaml` and `help.ts` document `review.suggestions`;
`docs/ARCHITECTURE.md` "Fixes are verified separately" gains a paragraph.

## Non-goals

- No block from a prose-only fix.
- No block for a stale-consumer finding (it is not inline).
- No change to the editor's word budget; the block is outside the validated
  prose, like the location prefix.

## Acceptance criteria

- AC-1. `check-candidates` accepts a `suggested_patch` whose range is within
  five added lines ending at the anchor with a matching `original`, and
  refuses one on context lines, one longer than five lines, one whose
  `end_line` is not the anchor, one without `original`, one whose `original`
  differs from the diff, one with either string over 600 characters, and one
  with a fenced line; `normaliseCandidate` carries the field and `score`'s
  `eligible` entry includes it.
- AC-2. A recorded finding carries `suggestedPatch`; with `review.suggestions: true`,
  a finding whose backing score has `fix.render === 'fix'` and whose `original`
  matches the head file renders the block with the correct `start_line`,
  `start_side` and `line`; with `fix.render` anything else it renders prose
  only; `assertPayload` refuses a malformed range (a test beside the writer
  shape tests in `test/post.test.mjs`).
- AC-3. When the head's lines differ from `original`, the read fails, or the
  finding's recorded line differs from `end_line`, the block is withheld, the
  prose stays, `withheldSuggestions` names it with its reason and the preview
  says so; `verdict` and `post` produce the same payload.
- AC-4. With the default `review.suggestions: false`, every existing payload
  test passes unchanged; the only existing-test edit is the
  `test/verdict-policies.test.mjs` extension the design names.
- AC-5. `outcomes` records `fixed` with evidence "suggestion applied" when
  the lines from `start_line`, as many as the replacement has, equal the
  replacement at the head; an empty replacement never matches by this rule;
  a failed read falls through to the existing rules.
- AC-6. A test asserts both agent prompts mention `suggested_patch`, the new
  ADR exists, `docs/adr/README.md` lists it and its 0029 row names the new
  ADR, `docs/adr/0029-*.md` contains a `## Amendment - 2026` heading, and
  `config.example.yaml` contains `suggestions: false` and still loads with no
  warnings; `help.ts` and `docs/ARCHITECTURE.md` document the setting
  (reviewer-checked).
- AC-7. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/schemas/candidate.schema.json`, `plugins/review-voice/src/cli.ts`
(`check-candidates`, the `score` eligible projection), `plugins/review-voice/src/scoring/score.ts`,
`plugins/review-voice/src/diff/hunks.ts`, `plugins/review-voice/src/publish/**`,
`plugins/review-voice/src/github/writer.ts`,
`plugins/review-voice/src/store/outcomes.ts`, `plugins/review-voice/src/store/runs.ts`,
`plugins/review-voice/src/policy/load.ts`, `plugins/review-voice/src/help.ts`,
`plugins/review-voice/agents/diff-analyst.md`, `plugins/review-voice/agents/evidence-verifier.md`,
`plugins/review-voice/templates/config.example.yaml`, `docs/adr/00NN-*.md` (new),
`docs/adr/0029-*.md`, `docs/adr/README.md`, `docs/ARCHITECTURE.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S14-committable-suggestions.md
in this repository. Read the spec first, then docs/ARCHITECTURE.md ("Fixes are
verified separately", "Posting"), docs/adr/0010-review-verdict-posting.md,
docs/adr/0017-moving-a-verified-anchor.md, plugins/review-voice/schemas/candidate.schema.json,
plugins/review-voice/src/scoring/score.ts (normaliseCandidate, renderFix,
ScoreBreakdown.fix), the eligible projection and the anchor checks in
checkCandidatesCommand in plugins/review-voice/src/cli.ts,
plugins/review-voice/src/publish/verdict.ts (inlineComment, buildPayload,
verification, ScoreLike), plugins/review-voice/src/publish/post.ts
(computeVerdict, recordedCandidates), plugins/review-voice/src/github/writer.ts
(ReviewComment, assertPayload) and plugins/review-voice/src/store/outcomes.ts
(linesChanged).

Outcome: candidates may carry a suggested_patch (range of at most five added
lines ending at the anchor, original text, replacement, no fenced line) that
normaliseCandidate carries, check-candidates validates against the diff,
score's eligible projection keeps and assignIds stores on the finding; the
verifier prompt judges the exact replacement under fix_verdict; with
review.suggestions true (default false) on VerdictPolicy, computeVerdict
fetches the head file and renders a GitHub suggestion block on the inline
comment (ReviewComment gains start_line and start_side, assertPayload checks
the range) only when the backing score has fix.render === 'fix' and the
original text still matches, otherwise withholds it visibly in the preview;
outcomes records an applied suggestion as fixed through the same contents
read; the new ADR records the decision and the docs are updated. All seven
acceptance criteria in the spec must hold.

Scope: only the paths the spec lists under "Allowed paths" (including
plugins/review-voice/src/github/writer.ts, plugins/review-voice/src/scoring/score.ts
and plugins/review-voice/src/diff/hunks.ts). The concise editor never writes
code; the block comes only from the verified candidate field through the CLI.
No new GitHub write beyond the existing review payload; the one new read is
GET /repos/{r}/contents/{path}. The only existing test you may edit is the
test/verdict-policies.test.mjs extension the spec names. Do not edit scripts/,
.github/, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities. Write the ADR in the format of the existing ones at the
next free number and add it to docs/adr/README.md.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
