# S24. A deterministic reading guide, and a posting severity threshold

**Phase:** 6 (market table stakes). **Depends on:** S01 (the `verdict:` block
is read from the base commit), S06 (`isSuppressionExempt`), S09 (the scope
block and the recorded run it renders from), S10 part A and S11 part one (the
`removedControls` and `riskMarkers` signals); within phase 6 it lands last,
after S15, S17, S19 and S22 (see "Order against the other market specs").
**Size:** about 270 source
lines, 300 test lines, one ADR amendment; one Orbit run, two with the stop
point below. **Risk:** low. Both settings default to the current behaviour,
and neither adds a GitHub write or a word to the validated findings. Verified
against the stack tip `professionalisation/s11-risk-routed-lanes` at
`3fb8443` (S11 part two) on 2026-11-08; the line references below are to that
tree, because S04 to S11 are not yet on `main`. Every cited line reads the
same at S11 part one (`548accd`) except in `docs/ARCHITECTURE.md`. Once S12
has moved `cli.ts`, locate `recordCommand` and `explainCommand` by name.

## Why

Two items from the market research report of 2026-11-08 (section 4.1, items 8
and 10) are table stakes every surveyed reviewer has and Review Voice lacks.

A reading guide. Every competitor posts a summary or walkthrough and Review
Voice posts none, by contract. A reviewer of a forty-file pull request wants to
know where to start. The report's anti-features (section 6, item 4) rule out
walkthroughs, diagrams and prose nobody verifies, and say that "a
deterministic reading guide is the most that fits". The CLI already measures
what such a guide needs. `collectStructure` writes `sizeCrossings`,
`branchGrowth`, `typeEscapes`, `removedControls` and `riskMarkers` into
`files.json` (`plugins/review-voice/src/cli.ts:735`,
`src/diff/structure.ts:60-82`), the last three each a lexical lead with a
path, a line and a closed kind (`src/diff/risk-markers.ts:16-22`,
`src/diff/removed-controls.ts:15-33`).
Nothing posts them. `record --files` reads the manifest for its scope,
complexity and pull number and drops the rest (`cli.ts:3018-3048`), so a
block rendered from the recorded run, as the scope block is, cannot see them.

A posting threshold. Gemini, Macroscope and Qodo let a repository post only
above a severity tier (report sections 2.6, 2.11 and 2.20), and teams
onboarding a reviewer want a quiet first month. Review Voice has lane caps,
approved suppressions and the word budget, and no tier. The report's
anti-features reject comment caps (section 6, item 10) because a cap drops a
real finding to hit a number. A tier is not a count. It withholds by the
derived severity the CLI computed, keeps the withheld findings in the record,
and says in the scope block how many it withheld. Today `planFindings` splits
a validated review into what posts and what is held for want of verification
(`src/publish/verdict.ts:218-266`); the event follows the posted findings
(`eventFor`, `:19-23`) and an unverified concern above a nit keeps an approval
at COMMENT (`:260-263`). The threshold slots in beside that rule.

## Outcome

With `verdict.min_posted_tier: important`, a verified `minor` or `nit`
finding outside the five categories no suppression may reach is not posted,
stays in the recorded run, is listed in the `verdict`
preview, and is counted in the scope block as "below the posting tier". A
withheld finding above a nit still keeps an approval at COMMENT, so the
reviewer never approves past a defect it chose not to show. With
`verdict.reading_guide: true`, every posted body carries a collapsed block
listing the changed files that carry a structural signal, ordered by removed
controls, risk markers, size crossings, branch growth and type escapes, with
no prose beyond one fixed caption, built from the recorded run alone, placed
before the scope block and never in the findings list. Both default to the
current behaviour.

## Design

### Part A. The posting tier

`src/publish/verdict.ts` exports `POSTED_TIERS = ['blocking', 'important', 'minor', 'nit'] as const`
and `type PostedTier`. `VerdictPolicy` (`:275-289`) gains
`minPostedTier: PostedTier`, default `'nit'` in `DEFAULT_VERDICT_POLICY`
(`:291-301`), which posts every tier and is the behaviour today.
`readVerdictPolicy` (`src/policy/load.ts:374-399`) reads
`verdict.min_posted_tier` through its existing `choice` helper (`:376-382`),
so an unknown value warns `verdict.min_posted_tier must be one of blocking,
important, minor, nit; using nit.` and keeps the default. Because
`verdict:` is read from the base commit for a pull request review (S01, ADR
0031), a pull request cannot raise the tier to hide its own findings.

`planFindings(output, run, loadRun, minPostedTier: PostedTier = 'nit')`
compares each verified finding's severity with the tier through one closed
table, declared beside `RANK` (`:25`) with a comment saying why it differs
from it:

| severity | tier rank |
|---|---|
| `blocking` | 0 |
| `important` | 1 |
| `minor` | 2 |
| `question` | 2, because `eventFor` treats a question as a minor (both comment) and the derivation caps a question at minor |
| `nit` | 3 |

A verified finding whose tier rank is greater than the tier's posts nowhere,
unless its category is exempt (below). It goes to a new `PlannedFindings.belowTier: ReviewFinding[]` (`:193-206`),
in review order, whether it would have been inline or unanchored. `held`
keeps its meaning, unverified. `posted` and `mapped` are computed from what
remains (`:260-261`), and the severities of `belowTier` join `heldSeverities`
before `heldBackApproval` is computed (`:262`), so a withheld verified
finding above a nit caps an approval at COMMENT exactly as an unverified one
does, through the existing `cappedBy: 'held'` branch in `computeVerdict`
(`src/publish/post.ts:421-429`) and the existing summary line "Not approving
yet." A withheld nit changes nothing. The two reason strings that name the
rule, in `decide` (`verdict.ts:433`) and `wouldHaveSummary` (`:670`), say
"a finding above a nit was held back, unverified or below the posting tier"
where they now say "an unverified finding above a nit was held back", and
keep the rest of each line ("so this comments rather than approves", and the
nit count); no test pins either string.

`computeVerdict` reads `policy` before it plans (`post.ts:379` moves above
`:369`) and passes `policy.minPostedTier`. `VerdictOutput` (`:68-109`) gains
`belowTier: HeldBack[]`, each entry with `reason` set to
`below verdict.min_posted_tier (<tier>)`, filled from `planned.belowTier`.
`renderPreview` (`verdict.ts:902-931`) gains `belowTier: readonly ReviewFinding[]`
and, after the held lines, prints `Below the posting tier, not posted: N`
followed by one `  rv_NN path:line (severity)` line each; the existing
`Held back, not verified` label is unchanged (`test/verdict.test.mjs:203`
pins it). The scope block counts them. `HeldCounts` (`:724-731`) gains
`belowTier: number` as its last key, after `other`, and `heldCounts`
(`:738-763`) starts it at 0. `scopeBlock` (`:836-848`) sets it from
`planned.belowTier.length`, the prose adds `N below the posting tier`, and the
JSON trailer carries `held.belowTier`. The trailer is compared byte for byte,
so two literals in `test/scope-block.test.mjs` gain `belowTier: 0` at their
end. `ZERO_HELD` at `:34` is deep-equalled at `:176` and `:289-294`, and the
sum at `:300` is unchanged by a zero. The held literal at `:135` is
stringified into the expected block at `:149` and compared at `:152`.

The idempotency key is taken from the payload (`post.ts:435`,
`verdict.ts:943-946`), so a review with findings withheld is a different post
from the same review with them shown. That is correct, not a leak, because
the posted comments differ. `record` runs before `verdict` and stores the whole
validated review, so `explain` still shows every finding and `outcomes`
follows only what was posted, as it does today. The validator is untouched;
the threshold applies after validation and recording, and the posted subset
keeps the validated order.

The tier never withholds a finding in a category no suppression may reach.
`planFindings` reads the `category` of the stored finding with the same
`findingId` in `run.findings`, and when `isSuppressionExempt` accepts it
(`src/scoring/score.ts:272-288`, the five S06 categories `security`,
`authorization`, `authentication`, `data_integrity` and `trust_boundary`) the
finding posts whatever its tier. Their derived tier alone does not protect
them. `data_integrity` derives `important` at local reach
(`src/scoring/severity.ts:115`), and `boundSeverityByEvidence`
(`score.ts:363-390`) holds a boundary finding at the analyst's requested tier
when the verifier found no exposure and keeps `trust_boundary` on the
ordinary traced-impact rule, so any of them can reach `minor` or `nit`. A
breach is not a noise preference. A verified finding with no recorded
category is placed by its severity alone.

### Part B. The reading guide

**Recording.** `src/store/runs.ts` gains, beside `RecordedChecks`
(`:427-436`):

```ts
/** The order the guide names kinds in. */
export const REMOVED_CONTROL_ORDER: Readonly<Record<RemovedControlKind, number>> = { guard: 0, refusal: 1, decorator: 2, middleware: 3, 'allowlist-entry': 4 };
export const RISK_MARKER_ORDER: Readonly<Record<RiskMarkerKind, number>> = { 'new-route': 0, 'lock-or-async': 1, 'string-built-query': 2, unsafe: 3 };

export interface RecordedFileSignals {
  path: string;
  /** True when every entry for the path came from a deleted file (`removedControls[].deletedFile`). */
  deletedFile: boolean;
  removedControls: Partial<Record<RemovedControlKind, number>>;
  riskMarkers: Partial<Record<RiskMarkerKind, number>>;
  /** The first crossing recorded for the path, or null. */
  sizeCrossing: { headLines: number; threshold: number } | null;
  /** Functions whose added decision points crossed the threshold. */
  branchGrowth: number;
  typeEscapes: number;
}

export interface RecordedStructure {
  /** Every changed path with at least one signal, sorted by path. Counts only; no source text. */
  files: RecordedFileSignals[];
  /** `StructureSignals.unmeasured.count`. */
  unmeasured: number;
}
```

A `Record` keyed by each closed union keeps the two in step. A kind added to
`risk-markers.ts` or `removed-controls.ts` without a place here fails the
typecheck. An array checked with `satisfies` would not, since `satisfies`
checks each element and not that every kind is present.
`recordedStructure(raw: unknown): RecordedStructure | null`
aggregates a manifest's `structure` (`StructureSignals` as JSON) into per-path
counts, one entry per `removedControls[]`, `riskMarkers[]`, `typeEscapes[]`
and `branchGrowth[]` element and one `sizeCrossing` per `sizeCrossings[]`
path, and returns null for a value that is not an object with those five
arrays. Counts and not the signals themselves, because the store keeps no
source text beyond a finding's own words (`removedControls[].text` is a
removed source line) and the guide needs none. `RecordRunInput` (`:363-420`)
gains `structure?: RecordedStructure | undefined` beside `checks` (`:418-419`),
`recordRun` writes it into `output_json` beside `checks` (`:726`),
`RunDetail` (`:751-783`) gains `structure: RecordedStructure | null`, and
`runDetail` reads it through a `storedStructure` shaped like `storedChecks`
(`:497-524`), null for an older row or a malformed value. `describeStructure`,
beside `describeChecks` (`runs.ts:526-537`), gives `explain` one line, `Structure N files with a signal, M unmeasured` or
`Structure not recorded`, printed after the Checks line (`cli.ts:4181`).

`recordCommand` reads it where it reads `complexity` from the manifest
(`cli.ts:3038-3042`) and warns `The structure signals in <files> are
malformed; recording without them.` when `manifest.structure` is present and
`recordedStructure` returns null, then passes `structure` to `recordRun`
beside `checks` (`:3374`). No new flag. The driver already passes `--files`
(`src/review/driver.ts:1001-1002`) and so does the interactive flow
(`commands/review.md:915`), so both origins record it.

**Rendering.** `verdict.ts` gains a pure `readingGuide(run: RunDetail): string`
next to `scopeBlock`, rendered from `run.structure` alone, every path through
`safeCheckName` (`:317-327`) and inside a code span, so a path named to close
the block renders as text, as the scope block's check names do.
`safeCheckName` also cuts a path past 60 code points with an ellipsis
(`MAX_CHECK_NAME`, `:311`); the guide accepts that rather than add a second
sanitiser, and calls it without the optional `max` that S15 adds. Files are
ordered by total removed controls descending, then total risk markers
descending, then a size crossing before none, then branch growth descending,
then type escapes descending, then path ascending; at most 20 are listed,
then one line `and N more files with a signal.` Each file line names its
parts in this fixed order, joined by `; `, omitting absent ones: `N removed
control(s) (<kinds>)`, `N risk marker(s) (<kinds>)`, `crossed T lines (now
H)`, `N function(s) grew past the branch threshold`, `N type escape(s)`. Kinds
are the distinct kinds present, in `REMOVED_CONTROL_ORDER` or
`RISK_MARKER_ORDER` order. A path whose signals all came from a deleted file
is followed by ` (deleted file)`. Shape:

```
<details><summary>Reading guide</summary>

Changed files by structural signal, most first. Lexical leads the CLI measured, not findings.

1. `src/auth/session.ts` (deleted file): 2 removed controls (guard, refusal)
2. `src/db/query.ts`: 1 risk marker (string-built-query); 3 type escapes
3. `src/api/routes.ts`: crossed 1000 lines (now 1042); 2 functions grew past the branch threshold

</details>
```

When `run.structure` is null the list is replaced by `Structure not
recorded.`; when it is recorded and `files` is empty, by `No structural signal
in this change.`; when `unmeasured` is above zero one more line reads `N
production files could not be measured.` A figure with no data says so and
never reads as zero. The guide has no JSON trailer; the scope block's trailer
remains the one machine-readable comment.

**Placement.** `computeVerdict` (`post.ts:441-442`) becomes: the findings
body, then the reading guide when `policy.readingGuide`, then the scope block
when `policy.scopeBlock`, each joined by `withScopeBlock` (`verdict.ts:884-886`),
then `withAnnotations`. Both blocks follow the idempotency key (`:435`), so
toggling either keeps the key, the scope block's trailer stays the last line
before any CI annotation (`test/scope-block.test.mjs:102-106` and `:356` rely
on it), and `replaceAnnotations`' suffix match (`verdict.ts:892-896`) is
unaffected. The guide is never an inline comment, never read by
`validate-output` and never a verdict input. It reads the recorded counts, not
the complexity assessment, so it never names the ADR 0012 cap or the reasons
ADR 0020 lets a signal add to it, which stay off the posted body. It is
bounded at 20 lines, so the word budget does not apply to it.

### Settings and documents

`verdict.min_posted_tier: nit` and `verdict.reading_guide: false`, the second
read through `enabled` (`load.ts:383-389`) into `VerdictPolicy.readingGuide`.
`test/verdict-policies.test.mjs` "config: each setting is read" (`:741-771`)
deep-equals the whole policy. Add `min_posted_tier: important` and
`reading_guide: true` to its yaml and `minPostedTier: 'important',
readingGuide: true` to its literal, beside the keys S15 and S22 added before
this spec; in "an invalid value warns" (`:773-795`)
add `min_posted_tier: critical` and `reading_guide: 3` and raise the expected
count at `:791` by two from its current value (7 on `main` at `b91a3e2`;
S14 adds one and S15 two before this spec, S22 none); the help test's key
list at `:800` gains both keys.

ADR 0028 gains a dated amendment (after the existing ones: the two at
`docs/adr/0028-*.md:63` and `:77`, then S15's and S22's) naming both keys, the tier table, the
approval cap for a withheld finding above a nit, the exempt categories, the
guide's placement, and that ADR 0016's lists stay local and ADR 0020's cap
reasons stay off the posted body;
`docs/adr/README.md:42` marks the row. `help.ts` (`:507-526`) and
`templates/config.example.yaml` (`:163-180`) document both keys with their
defaults, the example recommending `scope_block: true` beside a tier so the
withheld count is visible; `commands/draft-review.md` (`:58-68`) gains a
bullet for `belowTier`, the tier and the guide; `docs/ARCHITECTURE.md`
"Posting" (`:1132`) gains two paragraphs and "Structural evidence" (`:250`)
one sentence saying the signals are recorded as per-file counts and may post
as the reading guide.

### Order against the other market specs

S24 is last of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"), because
it extends what four of them change first:

- S15 adds `PlannedFindings.backing` to `planFindings`, `withEvidenceBlocks`
  to `computeVerdict` and the `max` parameter to `safeCheckName`.
- S17 adds the `challenger not run:` approval cap to `planFindings` and the
  optional `families` trailer key. `belowTier` severities join
  `heldSeverities` beside that cap, and they are not held findings in
  ADR 0024's sense.
- S19 adds the `issues` trailer key and edits the same
  `test/scope-block.test.mjs` literals, which then carry `issues` as well as
  this spec's `belowTier: 0`.
- S22 adds the path hold to `decide()` and the changed-path read to
  `computeVerdict`, and amends ADR 0028 before this spec. Its held queue does
  not list `belowTier` findings.

## Non-goals

- No change to `validate-output` or the findings contract; the tier applies
  after validation and recording.
- No GitHub write; both blocks ride on the existing review body under the
  existing confirm, idempotency key and audit rows (ADR 0010, ADR 0022).
- No prose in the guide beyond its fixed caption and state lines; no line
  numbers, function names or source text; no summary of what the change does.
- No default-on; the tier defaults to posting everything.
- No change to the Action's job summary or the watcher report; both see the
  new `VerdictOutput.belowTier` through `computeVerdict` and may render it
  later. S22's held queue there lists `score`'s held findings only.
- Open question for the owner: a verified finding above a nit that the tier
  withholds keeps an approval at COMMENT in this design, because approving
  past a known defect is worse than approving past an unchecked one. If the
  owner prefers a tier that approves silently, the `heldSeverities` join in
  Part A is the one line to change, and the summary line would then have to
  stop saying "No problems found".
- Open question for the owner: `question` ranks with `minor` for the tier. If
  the owner wants questions withheld at `minor`, the table gives `question`
  rank 3.
- Open question for the owner, as README decision 3 asks for S09: whether to
  turn `reading_guide` on for this repository's own pull requests once it
  lands.

## Acceptance criteria

Part A:

- AC-1. `planFindings` with `minPostedTier: 'important'` puts a verified
  `minor`, `question` and `nit` finding in `belowTier` and posts a verified
  `blocking` and `important`; with `'minor'` the question posts and the nit is
  withheld; with the default every verified finding posts and `belowTier` is
  empty; `held` holds only unverified findings in every case; a withheld
  `minor` keeps an approval at COMMENT with the summary "Not approving yet."
  and a withheld `nit` leaves APPROVE intact (`test/posting-tier.test.mjs`,
  new, in the shape of `test/scope-block.test.mjs`).
- AC-2. With the default tier, every existing body-equality test passes
  unchanged and `post` sends the same bytes as before (`test/verdict.test.mjs`,
  `test/verdict-policies.test.mjs` and the AC-2 test of
  `test/scope-block.test.mjs`, unedited apart from the literals named here);
  the three named edits in `test/verdict-policies.test.mjs` are made and pass;
  an unknown `min_posted_tier` warns with the specified text and keeps `nit`.
- AC-3. `verdict` output carries `belowTier` with the specified `reason`, the
  preview prints the `Below the posting tier, not posted` lines after the
  held lines, and with `scope_block` on the prose says `N below the posting
  tier` and the JSON trailer's `held.belowTier` equals it
  (`test/posting-tier.test.mjs`); the two held literals in
  `test/scope-block.test.mjs` (`:34`, `:135`) gain `belowTier: 0` and that
  file passes.
- AC-4. Under `min_posted_tier: blocking`, a verified `minor` finding
  recorded with each of `security`, `authorization`, `authentication`,
  `data_integrity` and `trust_boundary` posts, a verified `minor`
  `correctness` finding is withheld, and a verified `minor` finding recorded
  with no category is withheld (`test/posting-tier.test.mjs`).

Part B:

- AC-5. `record --files` with a manifest holding `structure` stores
  `RecordedStructure` with the aggregation specified (one deleted-file path,
  one path with two risk-marker kinds, one size crossing); `runDetail`
  returns it; an older row or a manifest without `structure` returns null and
  records without a warning; a malformed `structure` warns with the specified
  text and records null; `explain` prints the Structure line
  (`test/reading-guide.test.mjs`, new).
- AC-6. `readingGuide` renders the specified shape and order on a run with
  five files, cuts at 20 with the `and N more` line on a run with 25, renders
  `Structure not recorded.` for a null structure, `No structural signal in
  this change.` for an empty one and the unmeasured line when the count is
  above zero; a path containing backticks, U+202E and `</details>` renders
  inside a code span with the backticks and U+202E removed and `</details>`
  kept as text, the body has exactly one line that is `</details>` per
  block, and a 70-code-point path is cut at 60 with an ellipsis
  (`test/reading-guide.test.mjs`).
- AC-7. With `reading_guide: true` the body is findings, guide, scope block
  (when on), annotations, in that order; the idempotency key is identical
  with the guide on and off; a CI annotation swap still works; with the
  default off every existing body-equality test passes unchanged; the guide
  is never in `payload.comments` (`test/reading-guide.test.mjs`).
- AC-8. A test in `test/reading-guide.test.mjs` asserts that
  `docs/adr/0028-*.md` has a `## Amendment - 2026` section that names both
  `min_posted_tier` and `reading_guide` (S15 and S22 amend 0028 before this
  spec, so a count of headings proves nothing), and that
  `docs/adr/README.md` row 0028 names both keys; `help.ts`, `config.example.yaml` (which
  still loads with no warnings, `test/issues-config.test.mjs`),
  `draft-review.md` and `docs/ARCHITECTURE.md` ("Posting" and "Structural
  evidence") document both settings (reviewer-checked).
- AC-9. `npm run verify` passes with the rebuilt bundle committed.

Stop point for a two-run split: run one is the posting tier (AC-1 to AC-4,
AC-9, with the ADR amendment covering the tier); run two is the reading guide
(AC-5 to AC-8, AC-9, extending the same amendment).

## Allowed paths

`plugins/review-voice/src/publish/verdict.ts`, `plugins/review-voice/src/publish/post.ts`,
`plugins/review-voice/src/store/runs.ts`, `plugins/review-voice/src/policy/load.ts`,
`plugins/review-voice/src/cli.ts` (`record`, `explain`), `plugins/review-voice/src/help.ts`,
`plugins/review-voice/templates/config.example.yaml`,
`plugins/review-voice/commands/draft-review.md`, `docs/adr/0028-*.md`,
`docs/adr/README.md`, `docs/ARCHITECTURE.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`. Once S12 has moved the
handlers, the `src/cli/` modules that hold `recordCommand` and
`explainCommand` (`plugins/review-voice/src/cli/record.ts` and
`plugins/review-voice/src/cli/explain.ts` in S12's layout) take the place of
`cli.ts`.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S24-reading-guide-and-posting-threshold.md
in this repository. S01, S06, S09, S10 part A and S11 part one are already on
the base branch, as are S15, S17, S19 and S22, whose changes to planFindings,
computeVerdict, decide, safeCheckName and the scope block this spec builds on,
and S12 may have moved cli.ts into src/cli/, so locate code
by function name. Read the spec first, then docs/adr/0028-verdict-policies-are-configurable.md
(every amendment, S15's and S22's included), docs/adr/0020-structural-signals-may-opt-into-human-review.md,
plugins/review-voice/src/publish/verdict.ts (planFindings, PlannedFindings,
decide's held-back reason, HeldCounts, scopeBlock, withScopeBlock,
renderPreview, safeCheckName), plugins/review-voice/src/publish/post.ts
(computeVerdict, where the policy is read, the key is taken and the scope
block is appended), plugins/review-voice/src/store/runs.ts (RecordRunInput,
RecordedChecks, recordedChecks, storedChecks, RunDetail, runDetail),
plugins/review-voice/src/policy/load.ts (readVerdictPolicy and its choice and
enabled helpers), the record and explain handlers in plugins/review-voice/src/cli.ts,
plugins/review-voice/src/diff/structure.ts (StructureSignals),
plugins/review-voice/src/scoring/score.ts (isSuppressionExempt,
boundSeverityByEvidence) and test/scope-block.test.mjs (the fixture shape to
reuse).

Outcome: verdict.min_posted_tier (one of blocking, important, minor, nit;
default nit) is read into VerdictPolicy.minPostedTier and applied in
planFindings through the spec's tier table, moving verified findings below the
tier into a new PlannedFindings.belowTier unless their recorded category is
one isSuppressionExempt accepts, never posting them, keeping them in
the record, joining their severities to the held-back approval rule, listing
them in the preview and in VerdictOutput.belowTier, and counting them in the
scope block's prose and JSON as belowTier; the two held-back reason strings
drop the word unverified. record --files aggregates the manifest's structure
signals into a RecordedStructure of per-file counts (no source text) stored
with the run and returned by runDetail, explain prints one Structure line,
and verdict.reading_guide (default false) appends a pure, deterministic
"Reading guide" block built from the recorded run alone, ordered and shaped
as the spec gives, before the scope block and after the idempotency key, with
every path through safeCheckName. ADR 0028 is amended and the documents
updated. All nine acceptance criteria in the spec must hold. If one run cannot
hold everything, stop at the spec's stop point with every check green and say
which half is next.

Scope: only the paths the spec lists under "Allowed paths". Do not touch
validate-output, the findings contract, the lanes or the scanners under
src/diff, and add no GitHub write. Nothing new is on by default; the tier's
default posts every finding. The only existing tests you may edit are the
three named edits in test/verdict-policies.test.mjs and the two held literals
in test/scope-block.test.mjs (ZERO_HELD and the one in the AC-3 test), each
gaining belowTier: 0 as its last key. Do not edit action.yml, scripts/,
.github/, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
