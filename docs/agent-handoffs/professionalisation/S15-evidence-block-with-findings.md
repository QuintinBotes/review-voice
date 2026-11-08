# S15. Evidence posted with each finding: a collapsed block built from the recorded run

**Phase:** 6 (market additions, after the program's phases 0 to 5; first of
the ten in `GOAL.md`'s order), optional. **Depends on:** S09 (the
`record --evidence` read, the exported `safeCheckName`, and the pattern of
appending to a posted body after the idempotency key is taken), S08
(`restates-tool`, so a posted finding never restates the signal the block
cites). **Size:** about 300 source lines, 320 test lines, two ADR amendments;
one Orbit run, two with the stop point below. **Risk:** medium. The block
posts text the validator never saw, so every string in it is a recorded fact,
flattened and capped, and the whole surface is off until a repository turns
it on. Baseline `main` at `11e6f69` (1.21.1 plus S01, S02, S03 and S13);
where S08 and S09 move code, locate it by function name. S09's own code
(`safeCheckName`) and S08's (`readSignals`) are cited at `3fb8443`, the S11
branch tip that carries them. Once S12 has moved `cli.ts`, find `record`,
`explain` and `evaluate` by function name in `src/cli/`. Verified against the
code on 2026-11-08.

## Why

An author who reads a Review Voice comment sees forty words and a severity,
and nothing that says why the claim survived. Everything that would let them
check it without asking stays on the reviewer's machine. `explain` prints the
score, the verifier's confidence, the precedent ids and the fix verdict
(`plugins/review-voice/src/cli.ts:3928-4015`); the challenger's verdict and the
`path:line` references it turned on are stored on the backing score as
`challenge` (`src/verify/challenge.ts:268-279`) and printed nowhere, not even
by `explain`. The posted inline comment is `**severity** - prose`
(`src/publish/verdict.ts:669-678`) and the body is one summary line
(`verdict.ts:686-706`).

The market research report for this program found the author-facing evidence
to be the one differentiator two competitors already ship and Review Voice
has the data for but does not show: a collapsed "why this was flagged" section
and an evidence tab with code references and links to the precedents that
favoured the finding. Review Voice records more than either (an independent
challenge, a derived severity, owner precedents with role and polarity,
verified fixes) and posts none of it. The report also observed that the owner's
precedent is today inferred by the reader rather than visible, so a finding
that follows the owner's own earlier comments reads as the bot's opinion.

The constraints are already decided. Only verified and challenged findings
post (ADR 0010, ADR 0024). The validated review text is the finding, and the
validator owns its shape (`src/contract/validate.ts`); the block therefore
sits beside the prose, as the location prefix and S14's suggestion block do,
and never inside it. The idempotency key covers the payload before derived
lines are appended (`src/publish/post.ts:433`, ADR 0028), and S09 appends its
scope block the same way. ADR 0016 keeps the unverified and below-gate lists
local; nothing from them is in this block. ADR 0012 keeps the human-review
note off the pull request; the block never carries it.

## Outcome

With `verdict.evidence_block: true`, every inline comment Review Voice posts
ends with a collapsed block that states, from the recorded run alone, that the
evidence verifier established the finding and what the challenger decided,
the `path:line` references the challenger's verdict turned on, the static
check that also flagged the same line when one did, the convention document
and the quoted rule the analyst cited when the quote occurs in that document,
and how many of the owner's retrieved precedents favoured the finding. With
`verdict.evidence_block_fix_prompt: true` as well, a finding whose repair the
verifier verified carries that repair as one copyable line an author can hand
to an agent. The visible finding, the review event, the idempotency key and
the comment signatures are unchanged whether the block is on or off.
`explain` prints the same facts locally, and `evaluate --json` splits the
posted outcome rates by whether the posted comments carried a block.

## Design

### What the block may say, and where each fact comes from

Every line is built from the recorded run, through two objects the posting
code already has in hand: the `StoredFinding` that `reviewFindings` numbers
exactly as `record` did (`verdict.ts:44-75`, `src/store/runs.ts:451-478`), and
the backing score `verification()` matched to the finding (`verdict.ts:127-183`),
which is the one object in the run that carries the challenger's verdict,
the retrieved precedents and the fix decision. Nothing is re-derived and no
agent runs.

| Line | Source | Rendered when | Cap |
|---|---|---|---|
| `Verified by the evidence verifier. Challenger: confirmed, line confirmed.` or `..., anchor moved from line N.` or `Challenger: not run.` | the backing score's `confidenceSource === 'verifier'` (always true for a posted finding) and its `challenge` object (`challenge.ts:270-279`); N is the backing score's `reanchoredFrom.line` (`src/diff/reanchor.ts:86`), since `corrected_line` is the line it moved to, which is the comment's own anchor | always, the fixed first line | none |
| `Decisive lines: \`path:line\`, ...` | `challenge.decisive_evidence` | the challenger ran and at least one entry matches the `DECISIVE` pattern (`challenge.ts:136`) after trimming and names a repository-relative path; an entry that fails, or whose path is absolute or climbs out with `..` (a run directory or S16's reproduction copy, which would post the reviewer's home path), is dropped | 6 entries, 120 code points each |
| `Static check \`<tool>\` also flagged this line: \`<text>\`` | `StoredFinding.toolSignal` (below) | present | tool name through `safeCheckName`; text 160 code points |
| `Convention \`<path>\` says \`<quote>\`.` | `StoredFinding.conventionQuotes` (below), one line per entry; the quote is inline code because the document can come from the pull request's head, so a mention, link or `</details>` in it must not render | present | 2 entries; quote 160 code points |
| `Owner precedents in favour: N of M retrieved.` | the backing score's `precedents` (`cli.ts:2151-2157`), each a `Precedent` with `role` and `polarity` (`src/retrieval/retrieve.ts:5-21`); N counts `role === 'owner' && polarity === 'positive'`, M is the array length | M is at least 1 | none; never an excerpt, id or login |
| `Fix prompt (verified repair):` then one indented code line `In <path> at line <line>, <suggested>.` | the backing score's `fix.render === 'fix'` and `fix.suggested` (`src/scoring/score.ts:453-462`) | `verdict.evidence_block_fix_prompt` is true and both hold | 300 code points |

A line whose source is absent is left out; the first line is the only fixed
one. Zero is never printed as a count except in the "N of M" line, where M is
at least 1 and the zero is a fact about those precedents. A carried finding
is rendered from the score `verification()` followed `carriedFrom` to, so the
block describes the run that verified it, as the posting decision already
does.

The evidence verifier records no structured line references (its output is
`reason` prose, `schemas/verification.schema.json`), and the first verifier's
`verification.json` is not stored with the run at all (`record` takes
`--scores` and the second pass's `--verdicts`). The decisive lines are
therefore the challenger's, which ADR 0024 requires to be cited. Adding a
structured list to the verifier is the `guards_checked` change the program
README declined under "Not taken".

### Shape

Rendered by a pure `evidenceBlock(finding: StoredFinding | undefined, backing: ScoreLike | null, policy: Pick<VerdictPolicy, 'evidenceBlockFixPrompt'>): string`
in a new `src/publish/evidence-block.ts`, so two renders of one run are
identical. The module exports `EVIDENCE_MARKER` (the exact HTML comment
below) and `stripEvidenceBlock(body: string): string`, which returns the text
before the first `\n\n<!-- review-voice evidence -->` and otherwise the body
unchanged.

```
**minor** - The total skips the discount. A discounted cart is overcharged.

<!-- review-voice evidence -->
<details><summary>Evidence</summary>

Verified by the evidence verifier. Challenger: confirmed, line confirmed.
Decisive lines: `src/cart.ts:12`, `src/pricing.ts:48`.
Static check `typecheck` also flagged this line: `Object is possibly 'undefined'.`
Convention `CONTRIBUTING.md` says `totals are computed after discounts`.
Owner precedents in favour: 2 of 3 retrieved.
Fix prompt (verified repair):

    In src/cart.ts at line 12, apply the discount before the total is computed.

</details>
```

The block follows the prose, and the S14 suggestion block when both land,
after one blank line. `ScoreLike` (`verdict.ts:79-87`) gains
`challenge?: { verdict?: unknown; line_ok?: unknown; corrected_line?: unknown; decisive_evidence?: unknown } | null`,
`reanchoredFrom?: { line?: unknown } | null`, `precedents?: unknown` and
`fix?: { render?: unknown; suggested?: unknown } | null` (S14 adds `fix.render`
too; the two land in either order).

Every string that reaches the block from the store passes through one
flattener. S09 exports `safeCheckName` (`verdict.ts:311-327` at `3fb8443`); this spec gives
it an optional second parameter `max = MAX_CHECK_NAME` so the same rule
(strip bidi and zero-width characters and backticks, collapse control
characters and whitespace to one space, cut by code point with an ellipsis)
serves the longer lines above. A `decisive_evidence` entry is re-checked
against the `DECISIVE` pattern at render time, because a stored row can be
edited by hand. The fix prompt is flattened to one line before it is
indented, so it can neither close a fence nor start a heading.

### Where it goes in the payload, and what stays the same

`verification()` returns, beside `verified`, the score it matched as
`score: ScoreLike | null` and the `StoredFinding` it matched in that run as
`stored` (the origin finding when it followed `carriedFrom`, whose `findingId`
differs from the carried one's). `planFindings` (`verdict.ts:218-266`) keeps
each inline finding's backing in
`PlannedFindings.backing: Map<ReviewFinding, { score: ScoreLike; stored: StoredFinding | undefined; runId: string }>`.
`computeVerdict` (`post.ts:351-476`) takes the idempotency key from `full` at
`:433` as today, filters comments already sent at `:436-438`, and then, when
`policy.evidenceBlock` is true, maps the remaining comments through
`withEvidenceBlocks(comments, planned, policy)` before building `payload` at
`:439`. The finding for a comment is found by `path` and `line` in
`planned.inline`, and its score and stored finding come from
`planned.backing`, so nothing is looked up a second time. `VerdictOutput` gains `evidenceBlocks: number` (the comments that
carry a block; 0 in `refusal()` and when the setting is off), so `verdict`,
`post` and the watcher show one preview (`renderPreview` prints each
comment's body, `verdict.ts:731-760`) and nothing parses bodies to count
them.

Two identities must not move:

- The idempotency key (`verdict.ts:772-775`) is taken before the block is
  appended, so a run keys the same with the setting on and off, exactly as
  annotations (`post.ts:429-433`) and S09's scope block.
- `commentSignature` (`verdict.ts:763-765`) hashes `stripEvidenceBlock(comment.body)`,
  so the signatures `review_post_sent` records (`post.ts:853`) and the
  `sentInline` filter reads (`post.ts:333-344`) name the finding, not the
  derived text. A COMMENT posted while CI was red and the APPROVE that follows
  still send each inline comment once, whichever setting each was posted
  under.

`claimKey`'s metadata (`post.ts:836-841`) gains `evidenceBlocks: verdict.evidenceBlocks`
(`verdict` is `postReview`'s name for the computed output, `post.ts:717`),
so the attempted row, which already carries `run`, says whether the payload
carried blocks. `postReview` is otherwise unchanged; the thread re-check and
the approval re-read do not touch comment bodies.

### Readers of posted comments see the finding, not the block

Three places read Review Voice's own posted comments back and compare words.
Each strips the block first, so the rules see exactly the text they saw
before this spec:

- `clean` in `src/diff/thread.ts:106-109` applies `stripEvidenceBlock` before
  redaction, so `check-candidates --thread`, the own-comment matching in
  `score` and `raisedByOthers` (`post.ts:552-612`) never read a decisive line
  of one finding as a point raised at another location.
- `matchComments` in `src/store/outcomes.ts:305-334` strips the body before
  `significantWords`, so a comment is still paired with its finding by the
  finding's words alone; the `severityPrefix` check reads the first line and
  is unaffected.
- The corpus self-output detector (`src/corpus/eligibility.ts:76`) matches
  the review text format (``[severity] `path:line` -``) at the start of any
  line. No block line starts that way, so the block changes nothing for it.
  It does not match the inline `**severity** - ` format today, with or
  without the block; that gap predates this spec and is out of its scope
  (reviewer-checked; no change here).

### Two facts recorded with the run

The challenger's verdict, the precedents and the fix are already in the
stored score. The other two sources are recorded by `record`, from files the
driver and the slash command already produce, so posting still reads only
the run:

- **Tool signal.** S09's `record --evidence <file>` reads `evidence.json` for
  `checks`. This spec extends that read: for each stored finding, the first
  `signals[]` entry (`src/evidence/types.ts:5-14`) with the same `path` and
  the same `line` is stored as
  `StoredFinding.toolSignal?: { tool: string; line: number; text: string }`,
  where `text` is the signal's first `evidence` entry, else its `claim`,
  passed through `redact` (`src/redact/redact.ts:37`, because a secret
  scanner's message can quote the secret) and cut at 160 code points. The
  signals are read with S08's `readSignals` (`cli.ts:4855-4883` at `3fb8443`),
  so an absolute or `./` tool path compares as `check-candidates` compares it
  and a path outside the repository matches nothing. Same line only, never the two-line window
  `check-candidates` uses for restatement: under S08 a candidate that restates
  a nearby signal is held as `restates-tool`, so what reaches this field is a
  tool that spoke about the same line in other words, and the block says so
  without implying agreement.
- **Convention quote.** `record --conventions <file>` (new) reads the
  `ConventionReport` that `RV conventions` prints (`src/conventions/discover.ts:7-45`).
  `CandidateHint` (`runs.ts:190-199`) gains `evidence?: unknown`, which the
  `eligible[]` entries `record --candidates` receives already carry
  (`cli.ts:2286-2303`). For each finding paired with a hint, each `evidence`
  string is scanned for a document path (a `documents[].path` from the report,
  matched exactly, or by basename when exactly one document in the report has
  that basename, since `CLAUDE.md` and `.claude/CLAUDE.md` share one) and a quoted segment (text
  between straight or curly double quotes, at least four words). An entry is
  stored as `StoredFinding.conventionQuotes?: { path: string; quote: string }[]`
  only when the quote, with whitespace collapsed and case folded, occurs in
  that document's `content`. At most two per finding, in evidence order. A
  quote the document does not contain is dropped and nothing is said; the
  analyst's paraphrase stays local in `candidates_json`. This is the
  verbatim-quote check `check-intent` applies to the pull request description,
  applied to the one other repository text the analyst is told to cite.

`record --help` lists `--conventions <path>`; the driver's `record()`
(`src/review/driver.ts:930-998`) passes `--conventions <dir>/conventions.json`
when `prep` wrote it (`driver.ts:447`), beside S09's `--evidence` and
`--symbols`, so both the full run and the `carry` path (`driver.ts:485`)
record it. The carry path passes no `--candidates`, so it stores no quotes,
and its block reads the origin run's stored finding anyway; what a carried
record holds is for `explain` only. `commands/review.md` step 6 adds `--conventions <tmpdir>/conventions.json`
to its `RV record` line (`review.md:884-885`) and step 1d (`review.md:266-277`)
says to save the `RV conventions` output to that file. `test/issue-52-command-help.test.mjs:84`
("every flag review.md passes a command is in that command's own --help")
fails otherwise. Both fields are optional on `StoredFinding`, so every
existing deep-equal on recorded findings passes unchanged, and `runDetail`
(`runs.ts:660-715`) returns them as stored.

### explain

`explain` prints, per finding, after the `verified` line
(`cli.ts:3998-4013`): `  challenge         confirmed (line confirmed); decisive src/cart.ts:12, src/pricing.ts:48`
when the backing score carries `challenge`, `  tool signal       typecheck line 12: <text>`
when `toolSignal` is stored, and `  convention        CONTRIBUTING.md "<quote>"`
per stored quote. The block is `explain` for the author; the two must agree.

### Settings

`verdict.evidence_block: false` and `verdict.evidence_block_fix_prompt: false`,
read by `readVerdictPolicy` (`src/policy/load.ts:351-374`) through its
`enabled` helper into `VerdictPolicy` (`verdict.ts:275-285`) as `evidenceBlock`
and `evidenceBlockFixPrompt`, with both defaults in `DEFAULT_VERDICT_POLICY`
(`verdict.ts:287-295`). The policy travels on `VerdictPolicy`, so `cli.ts`,
the driver and the watcher need no plumbing change. `test/verdict-policies.test.mjs`
"config: each setting is read" (lines 741-771) deep-equals the whole policy
against a literal: extend the literal with `evidenceBlock: true, evidenceBlockFixPrompt: true`
and add `evidence_block: true` and `evidence_block_fix_prompt: true` to its
yaml; in "an invalid value warns" (lines 773-795) add `evidence_block: sometimes`
and `evidence_block_fix_prompt: 3` and raise the expected warning count at
`:791` by two from its current value (7 on `main` at `b91a3e2`; S14, which
lands before this spec, adds one, and S24 adds two after it), and "help for
verdict and post names the settings and exit 8" (line 797, its key list at
`:800`) adds both keys to the list it looks for in `verdict --help`. S22 and
S24 extend the same literal and key list later. The fix prompt is a second key because a copyable repair instruction
is a stronger act than a citation, and a repository may want the evidence
without it.

`help.ts` documents both keys under `verdict` (`help.ts:451-486`) and the
block under `post` (`help.ts:487-515`); `templates/config.example.yaml` adds
both, commented, to its `verdict:` block (`:151-172`) with one line each
saying why they are off; `commands/draft-review.md` adds an "Evidence block"
bullet beside its annotations bullet (`:58-62`) saying the block is in the
preview and outside the key.

### Measurement

`postedBreakdown` (`outcomes.ts:524`) gains `byEvidenceBlock: { with: PostedStats; without: PostedStats; unknown: PostedStats }`,
grouping each outcome's run by the `evidenceBlocks` value of the
`review_post_attempted` rows that a `review_post_sent` row names by `attempt`
(the join `sentRuns` already makes, `outcomes.ts:147-187`), so an attempt
that never sent counts for nothing. A run is `with` when any such row
has a value above 0, `without` when every row has 0, `unknown` when no row
carries the key, which is every post recorded before this spec. `evaluate --json`
emits it as `posted_breakdown.by_evidence_block` (`cli.ts:1453-1455`); the
text output is unchanged and no `Metric` is added, so the two every-metric
tests in `test/evaluate.test.mjs` pass untouched. `docs/EVALUATION.md` lists
it under "Posted findings" as reported, not scored, with the `unknown` group
explained, and keeps the rule that a group with no strong outcome reports
`null`, never zero.

### Documentation

ADR 0028 gains a dated `## Amendment - <date>` section naming both keys and
stating that the inline comment body is the validated finding plus, under
`evidence_block`, a block of recorded facts outside the idempotency key and
the comment signature. ADR 0024 gains a dated amendment stating that the
challenger's verdict and decisive lines may be posted beside the finding
under that setting, and that the challenger's inputs and the hold rules are
unchanged. `docs/adr/README.md` marks both rows `amended <date> (evidence block)`,
as S09 marked 0028 `(scope block)`. `docs/ARCHITECTURE.md`
"Posting" (line 1035) gains a paragraph on the block and what it never
carries, and "The independent challenge" (line 838) one sentence on the
posted verdict.

### Never in the block

The human-review note, `wouldHaveEvent`, `wouldHaveSummary`,
`staleRequestChanges`, a carry reason, any held finding or held count, the
unverified or below-gate lists, a precedent excerpt, event id or reviewer
login, a model id or model family (S17 shows the challenge family only in
the scope block, under `verdict.scope_block_models`), a confidence number,
and any text the verifier or challenger wrote as `reason`. A test asserts
their absence on a run that has all of them.

### Order against the other market specs

S15 lands first of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"). Where
a later spec changes the same code, it builds on this one:

- `safeCheckName` gains its optional `max` parameter here. S22 and S24 use
  it as it is and do not add it again.
- `planFindings` gains `PlannedFindings.backing` and `computeVerdict` gains
  `withEvidenceBlocks` here. S17 adds an approval cap to `planFindings`, S22 a
  path hold to `computeVerdict` and `decide()`, and S24 a posting tier to
  both, each on top of this change.
- `thread.ts clean` and `outcomes.ts matchComments` strip the block here. S19
  (`thread.ts`) and S21 (`outcomes.ts`) keep the strip, and S21's new prefix
  and action parameters on `claimKey` keep the `evidenceBlocks` metadata this
  spec adds.
- Dropping a decisive entry with an absolute or `..` path is what keeps S16's
  reproduction copy off the pull request. S21's reply applies the same rule.
- S23 carries `posted_breakdown.by_evidence_block` into its report object and
  renders it.
- ADR 0024 is also amended by S16 and S17, and ADR 0028 by S22 and S24. Each
  content test names its own keys, so the order of the sections does not
  matter.

## Non-goals

- No change to the validated findings text, `validate-output` or the word
  budget; the block sits outside the prose like the location prefix.
- No new GitHub write; the block rides on the existing inline comments.
  `draft` (`src/publish/draft.ts`) has no run in hand and is unchanged.
- No default-on. Turning either key on is the repository's choice.
- No structured line references from the evidence verifier (see the README's
  "Not taken"); the decisive lines are the challenger's.
- No replies, no edits of posted comments, no thread resolution.
- Open question for the owner, not settled here: whether the owner precedent
  count should post on a public repository at all. The line reveals that a
  precedent store exists and nothing else; if the owner prefers, the line
  moves behind a third key with the same default, as S09 did for model ids.
- Open question for the owner: whether to ship the fix prompt key, or to let
  S14's committable suggestion be the only repair surface.

## Acceptance criteria

- AC-1. With both settings off, every existing payload, body-equality and
  signature test passes unchanged and `post` sends the same bytes as before;
  `test/verdict-policies.test.mjs` is extended as the design says and
  passes; `VerdictOutput.evidenceBlocks` is 0 (`test/evidence-block.test.mjs`,
  new, built on the helpers of `test/verdict.test.mjs:94-109` and
  `test/post.test.mjs:112-140`).
- AC-2. With `evidence_block` on, a verified and challenged finding's inline
  comment ends with the block in the shape specified, built from the stored
  finding and its backing score; a finding without a `challenge` key renders
  `Challenger: not run.`; a moved anchor renders `anchor moved from line N`
  with N the score's `reanchoredFrom.line`, not `corrected_line`; a carried
  finding renders from the origin run's stored finding; a `decisive_evidence`
  entry that fails the `DECISIVE` pattern, or names an absolute path or one
  with `..`, is dropped;
  an owner precedent count is rendered only when precedents were retrieved,
  and counts only `owner` and `positive`; `verdict`'s preview and `post`'s
  payload carry the same block; `evidenceBlocks` equals the number of
  comments carrying one (`test/evidence-block.test.mjs`).
- AC-3. The idempotency key and every `commentSignature` of a run are
  identical with `evidence_block` on and off; a COMMENT posted on a head
  without the block followed by an APPROVE with it sends no inline comment
  twice (`alreadyInline` counts it); `claimKey`'s audit row carries
  `evidenceBlocks` (`test/evidence-block.test.mjs`).
- AC-4. Strings from the store are flattened: a `decisive_evidence` path, a
  tool text, a quote and a fix prompt containing backticks, U+202E, a
  zero-width space and a control character render without them and are cut
  at their caps by code point; a quote holding `@someone`, a link and
  `</details>` renders inside inline code; the fix prompt is one indented line even when
  `fix.suggested` contains newlines or three backticks; with
  `evidence_block_fix_prompt` off, or `fix.render` not `fix`, no fix prompt
  renders (`test/evidence-block.test.mjs`).
- AC-5. The block never contains the strings listed under "Never in the
  block" on a high-complexity run with held findings, a carry marker, a
  stale request for changes and an unverified claim; `stripEvidenceBlock`
  on a posted body returns the finding alone; `thread.ts clean` and
  `outcomes.ts matchComments` strip before comparing (a candidate at a
  decisive line of an earlier own comment is not held as a repeat; an
  outcome check pairs a block-bearing comment with its finding)
  (`test/evidence-block.test.mjs`).
- AC-6. `record --evidence` stores `toolSignal` on a finding whose path and
  line match a signal exactly, nothing for a signal two lines away, matches
  a signal whose path is absolute inside the repository, and the
  text is the signal's first `evidence` entry, redacted and cut at 160 code points;
  `record --conventions` stores a `conventionQuotes` entry only when the
  quoted text occurs in the named document's `content` (whitespace collapsed,
  case folded), drops a quote the document does not contain, caps at two,
  and stores nothing when the report has no documents; `runDetail` returns
  both; existing recorded-finding deep-equal tests pass unchanged; `record --help`
  names `--conventions` (`test/evidence-block-record.test.mjs`, new).
- AC-7. The driver passes `--conventions <dir>/conventions.json` to `record`
  on the full path and the `carry` path (a driver test captures `record`'s
  argv through the command seam, as `test/review-driver.test.mjs:920-931`
  does, in `test/evidence-block-record.test.mjs`); `commands/review.md` step 6 passes it and step 1d saves the file;
  `test/issue-52-command-help.test.mjs` passes.
- AC-8. `explain` prints the `challenge`, `tool signal` and `convention`
  lines for a run that has them and none for a run that does not;
  `postedBreakdown().byEvidenceBlock` groups a run posted with blocks under
  `with`, without under `without`, and a run whose attempted row predates
  the key under `unknown`, each with `null` rates when no strong outcome
  exists, and ignores an attempted row no sent row names; `evaluate --json` emits `posted_breakdown.by_evidence_block`; the
  two every-metric tests in `test/evaluate.test.mjs` pass unchanged
  (`test/evidence-block-record.test.mjs`).
- AC-9. A content test in `test/evidence-block.test.mjs` asserts that
  `docs/adr/0028-*.md` and `docs/adr/0024-*.md` each have a
  `## Amendment - <date>` section whose text names `evidence_block` (0028
  already has two amendments, so a heading alone proves nothing), and that
  the `docs/adr/README.md` rows for 0024 and 0028 name the evidence block;
  `verdict --help` names both keys (`test/verdict-policies.test.mjs`); the
  `post` entry in `help.ts`, `config.example.yaml`
  (which still loads with no warnings, `test/issues-config.test.mjs`),
  `draft-review.md`, `docs/ARCHITECTURE.md` ("Posting", "The independent
  challenge") and `docs/EVALUATION.md` ("Posted findings") document the
  block (reviewer-checked).
- AC-10. `npm run verify` passes with the rebuilt bundle committed.

Stop point for a two-run split: run one is the settings, the renderer, the
`computeVerdict` and `postReview` wiring, the signature and strip rules, the
audit field, the policy-shape test and the ADR amendments (AC-1 to AC-5,
AC-9, AC-10), with `toolSignal` and `conventionQuotes` read when present but
not yet written; run two is the two recorded facts, the driver and slash
command flags, `explain` and the breakdown (AC-6 to AC-8, AC-10).

## Allowed paths

`plugins/review-voice/src/publish/**` (including the new `evidence-block.ts`),
`plugins/review-voice/src/store/runs.ts`, `plugins/review-voice/src/store/outcomes.ts`,
`plugins/review-voice/src/diff/thread.ts`, `plugins/review-voice/src/policy/load.ts`,
`plugins/review-voice/src/cli.ts` (`record`, `explain`, `evaluate`), and
the `plugins/review-voice/src/cli/` modules that hold those three once S12 has moved them,
`plugins/review-voice/src/review/driver.ts`, `plugins/review-voice/src/help.ts`,
`plugins/review-voice/templates/config.example.yaml`,
`plugins/review-voice/commands/draft-review.md`, `plugins/review-voice/commands/review.md`
(step 1d and the step 6 `RV record` line only), `docs/adr/0024-*.md`,
`docs/adr/0028-*.md`, `docs/adr/README.md`, `docs/ARCHITECTURE.md`,
`docs/EVALUATION.md`, `test/**`, `plugins/review-voice/dist/review-voice.mjs`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S15-evidence-block-with-findings.md
in this repository. S08 and S09 are already on the base branch, so locate code
by function name, in src/cli/ for commands S12 has moved. Read the spec first, then docs/adr/0010-review-verdict-posting.md,
docs/adr/0024-an-independent-challenge-gates-every-posted-finding.md,
docs/adr/0028-verdict-policies-are-configurable.md,
docs/adr/0012-complex-changes-need-human-approval.md (the amendment that keeps
the human-review note off the pull request), plugins/review-voice/src/publish/verdict.ts
(inlineComment, verification, planFindings, commentSignature, idempotencyKey,
safeCheckName, ScoreLike, VerdictPolicy), plugins/review-voice/src/publish/post.ts
(computeVerdict, where the key is taken and comments are filtered, claimKey,
the sent audit row), plugins/review-voice/src/verify/challenge.ts (how a
judged score entry carries `challenge`, and DECISIVE),
plugins/review-voice/src/diff/reanchor.ts (reanchorScores and the
`reanchoredFrom` it stores), plugins/review-voice/src/store/runs.ts
(StoredFinding, CandidateHint, assignIds, recordRun, runDetail),
plugins/review-voice/src/diff/thread.ts (clean),
plugins/review-voice/src/store/outcomes.ts (matchComments, sentRuns,
postedBreakdown), readSignals in the cli, plugins/review-voice/src/redact/redact.ts
and plugins/review-voice/src/conventions/discover.ts (ConventionReport; read
only, it is not in the allowed paths).

Outcome: a pure evidenceBlock renderer in src/publish/evidence-block.ts builds
a collapsed block from the stored finding and its backing score only, with the
lines, sources, conditions and caps the spec's table gives, every string
flattened through safeCheckName with a max parameter, the quote rendered as
inline code, a decisive entry with an absolute or `..` path dropped, and the
moved-from line read from `reanchoredFrom`; with
verdict.evidence_block true (default false) computeVerdict appends it to each
inline comment after the idempotency key is taken and the already-sent filter
runs, commentSignature hashes the body with the block stripped, VerdictOutput
carries evidenceBlocks and claimKey records it; verdict.evidence_block_fix_prompt
(default false) adds the verified repair as one indented line; thread.ts clean
and outcomes.ts matchComments strip the block before comparing words; record
stores toolSignal from S09's --evidence read through readSignals (same path
and line only, text redacted) and
conventionQuotes from a new --conventions file (quotes that occur in the
document only), the driver and commands/review.md pass the flag, explain
prints the new facts, postedBreakdown gains byEvidenceBlock and evaluate --json
emits it; ADR 0024 and 0028 are amended and the index marks them. All ten
acceptance criteria in the spec must hold. If one run cannot hold everything,
stop at the spec's stop point with every check green and say which half is
next.

Scope: only the paths the spec lists under "Allowed paths". Do not touch
validate-output or the findings contract. No new GitHub write and no new
GitHub read; the block is built from the local store. Nothing in the block
may come from the unverified or below-gate lists, the human-review note, the
would-have fields, a held finding, a precedent excerpt or id, a model id, a
confidence number or an agent's reason text. The only existing test you may
edit is test/verdict-policies.test.mjs as the spec says. Do not edit scripts/,
.github/, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities. Write the ADR amendments as dated `## Amendment - <date>`
sections at the end of the existing records, never by rewriting them.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
