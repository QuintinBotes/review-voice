# S18. An external benchmark run: one public set imported offline, run once, published with its rule

**Phase:** 6 (market additions, after the program's phases 0 to 5).
**Depends on:** S04 parts A and B (`materializeFixture`, `normalisePatch`,
`selectFixtures`, `readRecallResults`, `summariseResults`, the exported
`AGREEMENT_LINE_TOLERANCE` and the `recall` command). **Size:** part A about
300 source lines and 380 test lines; part B about 140 test lines and one
documentation section; two Orbit runs (part A, part B) with one run by a
person between them. **Risk:** low for the code. Nothing on the review path
changes, nothing is posted and the importer never touches the network. The
run spends API credit and reads third-party code, so a person starts it, and
no imported code or prose is committed. **Blocked on the owner:** D1 and D2
before part A, D3 and D4 before the run (see "Decisions for the owner").
Baseline `11e6f69` (`main` after S03). S04 is not on this base, so its names
come from its branch (`35b2a0a` to `1d51fe9`) and are located by function
name; after S12, locate command handlers by name too. Verified against the
code on 2026-11-08.

## Why

Recall is measured on the repository's own fixtures only. S04's `recall`
scores twenty synthetic positives (twenty-three after S10), written beside
the prompts they test. S04's "Fixture recall" section in `docs/EVALUATION.md`
says the frozen set must not be tuned against, but nobody outside the
repository can check that against a set the same hands wrote. The market
research report of 2026-11-08 names the gap (section 4.2, item 6) and ranks
an external run fifth of its ten additions (section 5, item 5). Qodo, Augment
and Macroscope publish benchmark data, and cubic, Greptile and CodeRabbit
compete on Martian's open bench (section 2.25). The program README already
calls S04's materialiser "the local version of that method and the step
before running Review Voice against a public set" (README, "What the field
does").

Most of the harness exists after S04:

- `recall --fixtures <dir>` takes any directory of `<class>/<name>/`
  fixtures, not only `fixtures/` (`selectFixtures` in
  `plugins/review-voice/src/evaluate/recall.ts`, which skips a class
  directory that is absent).
- `materializeFixture` (`src/evaluate/fixtures.ts`) builds a two-commit
  repository from a patch, refuses a path that leaves the repository
  (`confinedPath`) and names the fixture in every error.
- `runRecall` records into a temporary store, sets `REVIEW_VOICE_NO_COMMANDS=1`,
  removes every `GIT_` variable, and stands in for GitHub with a shim that
  refuses every write (`pullRequestShim`). No configured command runs, nothing
  posts and nothing reaches the operator's store, so `calibrate` never sees a
  benchmark run.
- `scoreFixture` (`src/evaluate/recall-results.ts`) scores a hit by path and
  line within `AGREEMENT_LINE_TOLERANCE` (3), and `readRecallResults` refuses a
  results file whose summary does not follow from its fixtures.

Three things are missing.

1. An importer. A public set is a file of pull requests and the issues found
   in them, not `case.yaml` and `diff.patch` directories, and it carries no
   licence or version in a form `recall` records.
2. A rule for where imported items live. `CONTRIBUTING.md` rule 1 says
   "Never commit real review data. Every fixture must be synthetic", and
   `fixtures/README.md` calls the rule absolute. `test/fixtures.test.mjs:70`
   rejects external URLs and real addresses under `fixtures/`. A public set is
   real pull requests, and its issues may be prose taken from real reviews, so
   no imported item can live in the repository.
3. A place and a rule for publishing. The identity guard scans every text
   file git would publish, the `.json` and `.md` files under `docs/` included
   (`scripts/guard-identity.mjs`, `TEXT`), and third-party prose easily holds
   a real address or an em dash it rejects. Whatever is committed must be
   Review Voice's own output.

Nobody has opened any set's file. The report read the public descriptions
only. Its one source for Martian's MIT licence is a third-party post (section
2.25), and it gives no licence for Qodo's data or Augment's scripts. The
program README says the published evaluations score "a comment at the right
lines", while the report says Martian's offline set is "scored by semantic
match". S04's scorer needs a file and a line for every issue. These are facts
about files a person must download, so they are decisions D1 to D3, and the
importer reads only a file that person downloaded.

## Outcome

`review-voice import-benchmark` turns one public set, downloaded by a person,
into recall fixtures outside the repository, one per located issue. Each
fixture records its source, its licence and the set's version, and an item
whose licence is unknown is refused. A person runs `recall` over the imported
fixtures once. The two raw outputs, the import manifest and the results file,
carry identifiers, figures and the run's own messages, never the set's code
or prose, and are committed under `docs/benchmarks/`. `docs/EVALUATION.md` publishes the per-item results, the
match rule and the caveats. Nothing is tuned against them.

## Design

### Part A. The importer

#### The command

```
review-voice import-benchmark --from <file> --set-version <version> --set-licence <spdx> --out <dir>
                              [--licences <file>] [--diffs <dir>] [--first <n>]
```

- `--from <file>` is the set's file as the person downloaded it. It is read
  once, and its SHA-256 is recorded.
- `--set-version <version>` is the tag or commit the file was downloaded at.
  It must match `^[A-Za-z0-9._-]{1,64}$`, because it names a directory under
  `docs/benchmarks/`.
- `--set-licence <spdx>` is the set's own licence, as the person read it from
  the set's licence file (D3).
- `--out <dir>` is absent or an empty directory, outside any git working tree
  (below).
- `--licences <file>` is a JSON object from a repository, spelled as the set
  spells it, to an SPDX id. A person writes it when the set does not record
  each upstream project's licence (D3).
- `--diffs <dir>` holds one `<slug>.patch` per item, for a set that names
  pull requests and ships no diffs (D2). The person makes them offline from
  their own clones; the importer never fetches one.
- `--first <n>` imports only the first `n` items in the set's own order, before
  any check, and records `n` (D4).

The work is pure and lives in a new `plugins/review-voice/src/evaluate/benchmark.ts`,
which exports `readSet`, `importBenchmark`, `isKnownLicence` and
`REFUSAL_REASONS`. The handler sits beside `recallCommand` in `cli.ts` (or
where S12's layout puts command handlers) and parses flags the way
`recallCommand` does (known and valued flag sets, exit 2 on anything else).
It exits 0 when at least one fixture was written and 1 when every item was
refused (the manifest is still written). It exits 2 for a bad invocation,
which is a missing required flag, an unreadable file, a document that is not
the shape D2 recorded, a bad `--set-version`, an unknown `--set-licence`, or
an `--out` that is not empty or is inside a git working tree.

#### What the importer reads from the set

`readSet(text: string): BenchmarkItem[]` is the set's adapter, the only code
that knows the set's format. It maps the downloaded file onto the fields
below. The right-hand column is filled in by D2, in a spec fix made after the
download and before part A runs. Until then it says "record on download", and
part A does not start.

| Field | Meaning | When it is missing | Where the set keeps it (D2) |
|---|---|---|---|
| `id` | the set's own id for the pull request | exit 2, naming the item index | record on download |
| `repository` | the upstream repository, as the set names it | exit 2 | record on download |
| `pullRequest` | the set's reference to the pull request | recorded as null | record on download |
| `licence` | the upstream code's SPDX id | taken from `--licences`, else `unknown-licence` | record on download |
| `diff` | the change as a unified diff | read from `--diffs`, else `no-diff` | record on download |
| `description` | the pull request description | no `pr-body.md` | record on download |
| `issues` | the issues the set lists for the item | exit 2 when not a list; `no-issue` when empty | record on download |
| `issues[].path` | the issue's file, repository-relative | `no-location` | record on download |
| `issues[].line` | the issue's line on the new side | `no-location` | record on download |
| `issues[].severity` | the set's own label for the issue | recorded as null | record on download |

A document whose items lack `id`, `repository` or an `issues` list is not the
shape D2 recorded. The command exits 2 naming the first missing field and its
item index, so a wrong mapping fails loudly instead of importing nothing. The
other fields are facts about one item or one issue, and their absence refuses
only that item or issue. If D2 finds that the set's lines are old-side lines,
the adapter does not translate them; it maps no `line`, and every issue is
`no-location`.

#### Checks, in order

Each item, in the set's order (after `--first`), stops at its first failure:

1. **Id.** The slug is the id lower-cased, each run of characters outside
   `[a-z0-9]` replaced by `-`, leading and trailing `-` removed, cut to 60
   characters. An empty or repeated slug, or an id, repository or pull-request
   reference longer than 200 characters or holding a line break, is
   `bad-id`. Every string the manifest copies from the set is an identifier,
   never prose.
2. **Licence.** The set's `licence` and the `--licences` value for the item's
   repository are compared. Both present and different is `licence-conflict`.
   The one present must pass `isKnownLicence`, else `unknown-licence`.
   `isKnownLicence` accepts a trimmed SPDX identifier or a simple expression
   of identifiers joined by `AND`, `OR` or `WITH`, optionally in one pair of
   parentheses, and rejects an empty value and `NOASSERTION`, `NONE`,
   `UNKNOWN`, `OTHER` and `UNLICENSED` in any case. An identifier is a run of
   letters, digits, `.`, `-` and `+` (the SPDX short-identifier characters),
   so free text with a space is refused. The check is on shape, because the
   plugin ships no copy of the SPDX list and adds no dependency; D3 (c)
   decides whether a listed identifier is required. The manifest records
   `licenceFrom: "set"` when the set records the licence, both sources
   agreeing included, else `"owner"`.
3. **Diff.** The set's `diff`, or else `<diffs>/<slug>.patch` when that is a
   regular file (a link is refused), else `no-diff`. The `no-diff` detail
   names the file the importer looked for.
4. **Build.** The diff is written as the only file of a temporary probe
   fixture and built once with `materializeFixture` into a temporary
   directory, both removed afterwards. Any error, an unsafe path included, is
   `does-not-build`. A recall run therefore never fails on materialisation,
   which would put an error quoting third-party code into the committed
   results.
5. **Issues.** An empty list is `no-issue`.

Each issue of an item that passed, numbered by its 1-based position in the
set's list so that a refusal never renumbers the rest:

- `no-location` when `path` is not a string or `line` is not a positive whole
  number.
- `unsafe-path` when `path` holds a double quote, a backslash or a control
  character. `recall` reads `case.yaml` line by line and strips one pair of
  quotes without unescaping (`scalar` in `recall.ts`), so a path with any of
  them would not read back as written.
- `off-diff` when no added line or deletion site of `path` in
  `parseHunks(normalisePatch(diff))` lies within `AGREEMENT_LINE_TOLERANCE` of
  `line`. A finding off the diff is sent back to the analyst, so such an issue
  cannot be hit by design. It is refused and counted, never scored as a miss,
  and the count is published so a reader can compute the stricter figure.

`REFUSAL_REASONS` is the closed list of the nine codes above. The detail of
each refusal goes to stderr for the person; the manifest records the code
only, because the detail can quote third-party code (a materialisation error
quotes the line that did not match).

#### What it writes

For each accepted issue, `<out>/positive/<slug>-<n>/` holds `diff.patch`,
the item's diff byte for byte (the materialiser normalises its own copy),
`pr-body.md` when the item has a description, and `case.yaml` (values
illustrative):

```yaml
name: "bench-0007-2"
asserts: "Issue 2 of benchmark item bench-0007"
source:
  set: "<the slug D1 records>"
  set_version: "v1.0"
  set_sha256: "<SHA-256 of the --from file>"
  set_licence: "MIT"
  item: "bench-0007"
  repository: "example/service"
  pull_request: "https://example.com/example/service/pull/7"
  licence: "Apache-2.0"
  licence_from: "owner"
  issue: 2
expect:
  min_findings: 1
  path: "src/orders/refund.ts"
  line: 41
```

Every string is written with `JSON.stringify`, which is a valid YAML
double-quoted scalar. `selectFixtures` reads `expect.path` and `expect.line`
from the two-space indented `expect` block and ignores `source`. No `config.yaml`
is written, so the base commit carries S04's default configuration (the
structure lane on), and no `context/` is written, so the base is rebuilt from
the patch with filler as for the synthetic fixtures.

`<out>/import.json` is the manifest (values illustrative):

```json
{
  "set": "<the slug D1 records>",
  "setVersion": "v1.0",
  "setSha256": "<hex>",
  "setLicence": "MIT",
  "importedWith": "1.23.0",
  "firstItems": null,
  "items": [
    { "fixture": "positive/bench-0007-2", "item": "bench-0007", "issue": 2,
      "repository": "example/service", "pullRequest": "https://example.com/example/service/pull/7",
      "licence": "Apache-2.0", "licenceFrom": "owner",
      "path": "src/orders/refund.ts", "line": 41, "severity": "high" }
  ],
  "refused": [
    { "item": "bench-0007", "issue": 1, "reason": "off-diff" },
    { "item": "bench-0009", "issue": null, "reason": "unknown-licence" }
  ],
  "counts": { "items": 2, "issues": 2, "fixtures": 1, "refusedItems": 1, "refusedIssues": 1 }
}
```

The keys are fixed. Every key above is always present, `null` where there is
no value, and no other key appears. `importedWith` is `pluginVersion()`.
`items` counts the items considered, `issues` the issues on items that passed
the item checks, so `fixtures + refusedIssues === issues`, `fixtures` is the
length of `items`, and `refusedItems` and `refusedIssues` count the refused
entries with and without an issue number. A severity label longer than 200
characters or holding a line break is recorded as null.

#### Nothing imported enters the repository

The importer refuses an `--out` inside a git working tree. It runs
`git rev-parse --is-inside-work-tree --is-inside-git-dir` in the nearest
existing ancestor of `--out`, with every `GIT_` variable removed as
`runRecall` removes them, and exits 2 when git prints `true` for either (git
exits 128 outside any repository, which means outside), with a message saying that imported items are
third-party code under their own licences and `CONTRIBUTING.md` rule 1 keeps
real review data out of the repository. It writes nothing outside `--out`
apart from the temporary directories it removes. `fixtures/README.md` gains
one sentence saying an external benchmark is imported outside the repository
(`docs/EVALUATION.md`, "External benchmark") and never placed under
`fixtures/`.

### The run, by a person, between part A and part B

Neither Orbit run can do this. It needs the downloaded file, the licence
judgement of D3, and the API spend of D4, and the agent runner needs the
person's own Claude Code credentials.

1. Download the set D1 chose, at a tag or commit, into a directory outside
   this repository. Record its version, read its licence file, and record what
   D2 and D3 found in this spec, in a spec fix of its own.
2. When the set records no licence per item, write the `--licences` map from
   each upstream project's licence file at the pull request's base. When it
   holds no diffs, write `<slug>.patch` per item from a local clone; the
   importer's `no-diff` detail names each expected file.
3. Run `review-voice import-benchmark` with the flags above and an `--out`
   outside any repository.
4. Price the run (D4) from the importer's fixture count. If the budget does
   not cover it, import again with `--first <n>` into a fresh `--out`. Never
   choose a subset after seeing a result.
5. Run `review-voice recall --fixtures <out> --out docs/benchmarks/<set>/<set-version>/<plugin-version>/results.json`
   once, with the default runner (`claude`) and the default mode (`auto`).
   A failed run stays in the file; the command exits 1 and still writes it.
6. Copy `<out>/import.json` beside `results.json`, then run
   `npm run guard:identity`. Read every `error` value in `results.json`,
   because a failed run's message comes from the review driver and can quote
   a line of the diff. If the guard rejects either file, or an `error` quotes the set's
   code or prose, do not edit it. Both are raw outputs. File an issue and
   stop.
7. Open a pull request holding those two files and nothing else. A person
   merges it, and part B starts from that base.

### Part B. The published results

#### Where the raw outputs live

`docs/benchmarks/<set>/<set-version>/<plugin-version>/` holds `import.json`
and `results.json` exactly as the two commands wrote them. A published run
directory is never edited or removed. A run with another plugin version, set
version or mode is a new directory beside it. `readRecallResults` already
refuses a summary that no longer follows from its fixtures, so an edited
figure fails the content test.

#### The match rule

The set's issues are scored by S04's rule and nothing else. An issue counts
as found when one validated finding of its run is on the issue's file within
`AGREEMENT_LINE_TOLERANCE` (3) lines of its line. Category, severity and
wording are not compared, and no model judges a match. Findings that match no
listed issue are not scored, because a finding on an unlisted line may be a
real defect the set did not list, so the set yields recall and no precision.
Each issue is its own run of its item's diff, so two issues of one item are
two samples, which keeps S04's scorer, results file and reader unchanged.

#### The section in `docs/EVALUATION.md`

A new `## External benchmark` section after "Fixture recall" holds:

- How the items were imported. The set, its version and SHA-256, the set
  licence, what D2 and D3 found about the format and the licences, one fixture
  per located issue, the base rebuilt from the patch with no upstream
  repository context, and S04's default configuration.
- The match rule above, with the tolerance written as "within 3 lines".
- Per run directory, a heading `### <set>, version <set-version>, plugin <plugin-version>`,
  the directory path, the runner and mode from `results.json`, and three
  tables:
  - figures, `| Figure | Value | Basis |`, with rows `Key-bug recall`,
    `Causal-line hit`, `Clean silence` and `Failed runs`; a ratio to two
    decimals, `no data` when the summary has null (clean silence is `no data`
    for a set with no clean items, and the section says so);
  - refusals, `| Refusal | Count |`, one row per reason with a non-zero count,
    or the line `Refusals: none.` in its place when nothing was refused;
  - per item, `| Fixture | Repository | Licence | Severity | Result | Line delta | Findings |`,
    one row per fixture, with `Result` one of `hit`, `miss` or `failed` and
    `-` for a null line delta or severity.
- The caveats, as sentences. One run per issue is a sample, and the
  candidate-set agreement figure already in this document (0.25 to 0.60)
  says a figure moves between runs with no change to the plugin. The figures
  are not comparable to the set's own leaderboard or to any vendor's, which
  use their own matching rules and review the whole repository. The figures
  are goals, never gates.
- The rules that keep the set clean. Imported items never enter the
  repository. Benchmark runs never reach the operator's store. A published
  run is never edited. No change to a prompt, policy, threshold or scorer
  cites a benchmark item or figure as its reason. The section says the set is
  "never tuned against".

#### The content test

`test/benchmark-results.test.mjs` finds every `docs/benchmarks/*/*/*/`
directory and asserts:

- at least one exists, and each holds `import.json` and `results.json`;
- `readRecallResults` reads `results.json` without error, its `pluginVersion`
  is the third path segment, and the manifest's `setVersion` and `set` are the
  second and first;
- the manifest has exactly the documented keys at every level, every `reason`
  is in `REFUSAL_REASONS`, `setLicence` and every item `licence` pass
  `isKnownLicence`, and the counts hold the invariants above;
- the fixture names in `results.json` and the manifest's `items[].fixture` are
  the same set;
- `docs/EVALUATION.md` has the `## External benchmark` section, the run's
  heading and path, the figures table equal to the summary (two decimals or
  `no data`), the refusals table equal to the manifest (or
  `Refusals: none.` when it refused nothing), one per-item row per
  fixture whose repository, licence and severity equal the manifest and whose
  result, line delta and findings equal `results.json`, and the phrases
  `within 3 lines` (built from `AGREEMENT_LINE_TOLERANCE`), `is a sample` and
  `never tuned against`.

### Order against the other market specs

S18 is fourth of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"), and
nothing else in the phase depends on it. It changes no shared function: it
adds one command to `cli.ts` and `help.ts`, and one sentence to
`fixtures/README.md`, which S16 (two fixture rows, before) and S20 (the
`sarif/` row, after) also edit. When D1 to D4 are still open at its turn, S19
runs next and S18 resumes once they are settled. S23's `evaluate --html
--recall <file>` renders a benchmark `results.json` as it renders any recall
file, under the `fixture_` metric names.

## Non-goals

- No semantic match and no model judge. A set whose issues carry no file and
  line is out of reach of this spec (D2), and a judged match would be a
  separate decision.
- No precision figure from the set, and no comparison table against vendors'
  published figures.
- No change to S04's scorer, `results.json` shape, `readRecallResults` or the
  `fixture_*` metric names; `evaluate --recall <file>` prints a benchmark file
  under those names with its basis.
- No download, fetch or GitHub read in any code. The person downloads.
- No whole-repository base. The reviewer sees the diff over a rebuilt base,
  as for the synthetic fixtures; seeding `context/` from a local clone is a
  possible follow-up.
- No second set in this spec, and no multi-issue scorer (D4 names it as the
  alternative to running once per issue).
- No CI job. The run costs money and the set is not in the repository.
- No imported item under `fixtures/`, and no change to the synthetic rule.
- No ADR. This is evaluation tooling and the review path does not change.

## Decisions for the owner

There is no default for D1 or D2. Both are facts about a file nobody has
opened, so part A does not start until a person has downloaded the set and
recorded both here in a spec fix (GOAL.md, step on spec defects). D3 and D4
must be settled before the run.

- **D1. Which set.** The candidates are Martian's offline set (50 curated pull
  requests, MIT according to a third-party post, part of the bench cubic,
  Greptile and CodeRabbit cite) and Qodo's open benchmark data; Augment's
  published scripts over its own golden set are a third. The recommendation
  is the first of these whose downloaded file passes D2 and has a licence
  file, Martian's first if both pass. D1 records the set's slug, which names the
  `docs/benchmarks/<set>/` directory and the manifest's `set`.
- **D2. The file's shape.** Cannot be known until the file is opened. Is it
  one JSON document, JSON Lines, or a directory? Does every issue carry a file
  path and a new-side line? (The report's "scored by semantic match" for
  Martian suggests its issues may be prose without a line; the README's "a
  comment at the right lines" suggests otherwise. Neither was checked.) Is the
  diff in the file or only a pull-request reference? Does each item record
  its upstream licence? What tag or commit anchors the version? The answers
  fill the right-hand column of the field table; a set that is a directory
  also changes `--from`, its SHA-256 and `readSet`'s signature in the same
  spec fix. If no candidate set records a file and a line per issue, this
  spec stops at D2.
- **D3. Licences.** (a) The set's own licence, read from its licence file at
  the downloaded version, and whether it covers the issue annotations as well
  as the code. (b) Each upstream project's licence, when the set does not
  record it, written into the `--licences` map by a person from the project's
  licence file at the pull request's base. (c) Which known licences are
  acceptable. The default is any known SPDX id, because the code is reviewed
  locally, never committed, and the committed files carry no code or prose; an
  allowlist (for example OSI-approved licences only) would be a small
  follow-up flag.
- **D4. Budget and who runs it.** The run costs one review per located issue,
  not per pull request. The estimate is the importer's fixture count times
  the mean `costUsd` of the repository's own fixture run (S04's `recall` over
  `fixtures/`, which GOAL.md AC-5 asks for); with no such run there is no
  estimate. The owner approves the spend, runs it with their own credentials,
  and chooses `--first <n>` before seeing any result if the budget does not
  cover the whole set. The alternative to one run per issue is a follow-up
  spec that scores every issue of an item from one run, which changes S04's
  results file.

## Acceptance criteria

Part A (`test/benchmark-import.test.mjs`, over a synthetic set document in
the D2 shape under `test/fixtures-benchmark/`):

- AC-1. An item with two located issues becomes `positive/<slug>-1` and
  `positive/<slug>-2`, each with the `case.yaml` the spec gives (quoted
  `expect.path`, `expect.line`, `min_findings: 1` and the full `source`
  block), the item's diff byte for byte as `diff.patch`, and `pr-body.md`
  only when the item has a description. `selectFixtures` over `<out>` returns
  each fixture's path and line exactly, with no category and no skip, and
  `materializeFixture` builds each one.
- AC-2. An item whose licence is absent, empty, `NOASSERTION`, `none`,
  `UNKNOWN`, `OTHER`, `UNLICENSED` or free text is refused `unknown-licence`;
  a set licence and an owner licence that differ are `licence-conflict`; an
  owner licence fills a missing set licence and is recorded with
  `licenceFrom: "owner"`; an unknown `--set-licence` exits 2 and writes
  nothing.
- AC-3. Each of `bad-id` (empty slug, repeated slug, an id over 200
  characters), `no-diff` (including a link in `--diffs`), `does-not-build`,
  `no-issue`, `no-location`, `unsafe-path` and `off-diff` (a line four lines
  from every added line and deletion site, against a line within three) is
  refused by its own synthetic case; a refused item or issue writes no
  fixture, appears in `refused` with its code only, and is detailed on
  stderr; issue numbers of the accepted issues are unchanged by a refusal.
- AC-4. `import.json` has exactly the documented keys at every level (the
  test compares key sets), counts that hold the stated invariants,
  `setSha256` equal to the SHA-256 of the `--from` file, `importedWith` equal
  to `pluginVersion()`, and `firstItems` equal to `n` with `--first <n>`,
  which imports only the first `n` items in the set's order. Exit 0 with at
  least one fixture; exit 1 when every item is refused, with the manifest
  written; exit 2 for a missing `--from`, `--set-version`, `--set-licence` or
  `--out`, a malformed document (the message names the field and item
  index), a `--set-version` outside `^[A-Za-z0-9._-]{1,64}$`, an `--out` that
  is not empty, and an `--out` inside a scratch git repository.
- AC-5. The importer works offline. The test reads the import lines of
  `benchmark.ts` and finds no `node:http`, `node:https`, `node:net` or
  `../github/` import and no `fetch(` call, and runs the command in process
  with `globalThis.fetch` replaced by a function that throws; nothing is
  written outside `--out` and the temporary directories it removes.
- AC-6. `help.ts` carries an `import-benchmark` entry in the `recall` entry's
  shape (synopsis line, Flags, `Reads:`, `Writes:`, `Exit codes:`);
  `test/issue-52-command-help.test.mjs` and
  `test/issue-132-command-list-help.test.mjs` pass unchanged;
  `fixtures/README.md` carries the sentence on imported items
  (reviewer-checked).

Part B (`test/benchmark-results.test.mjs`):

- AC-7. At least one `docs/benchmarks/<set>/<set-version>/<plugin-version>/`
  directory holds the `import.json` and `results.json` a person committed;
  `results.json` passes `readRecallResults`; the path segments match the two
  files; the manifest has the documented keys only, known licences only and
  valid counts; the two files name the same fixtures.
- AC-8. `docs/EVALUATION.md` has the `## External benchmark` section with,
  per run directory, the heading, the path, and the figures, refusals and
  per-item tables equal to the two files, as the content test specifies.
- AC-9. The section states the match rule with `within 3 lines`, the
  single-run caveat with `is a sample`, and the rule that the set is
  `never tuned against` (tested); what D1 to D3 found about the set's format
  and licences, the rebuilt-base limitation and the non-comparability with
  published leaderboards are stated (reviewer-checked).
- AC-10. `npm run verify` passes with the rebuilt bundle committed.

Stop point. Part A ends at AC-1 to AC-6 and AC-10. The person's run sits
between the parts. Part B ends at AC-7 to AC-10.

## Allowed paths

Part A may change `plugins/review-voice/src/evaluate/benchmark.ts` (new),
`plugins/review-voice/src/cli.ts` (the `import-benchmark` dispatch and its
handler only; after S12, the one new command module its layout gives and the
dispatch entry), `plugins/review-voice/src/help.ts`, `fixtures/README.md`,
`test/benchmark-import.test.mjs` (new), `test/fixtures-benchmark/**` (new,
synthetic), `plugins/review-voice/dist/review-voice.mjs`.

Part B may change `docs/EVALUATION.md` (the new section only) and
`test/benchmark-results.test.mjs` (new).

`docs/benchmarks/**` is written by a person in their own pull request and
edited by neither run. Neither part touches `action.yml`, `scripts/`,
`.github/`, the manifests, `CHANGELOG.md` or any existing test.

## Orbit goal, part A

```
Implement part A of docs/agent-handoffs/professionalisation/S18-external-benchmark-run.md
in this repository. S04 parts A and B are already on the base branch. First
check that the spec's field table has a filled right-hand column and that D1
names the set's slug; if the column still says "record on download", stop
and report that decisions D1 and D2 are open. Then read the spec, then
plugins/review-voice/src/evaluate/fixtures.ts (materializeFixture,
normalisePatch, confinedPath), plugins/review-voice/src/evaluate/recall.ts
(selectFixtures, readExpectation, scalar, the GIT_ handling in runRecall),
plugins/review-voice/src/evaluate/metrics.ts (AGREEMENT_LINE_TOLERANCE),
plugins/review-voice/src/diff/hunks.ts (parseHunks, FileHunks), recallCommand
and realExistingPath in plugins/review-voice/src/cli.ts, the recall entry in
plugins/review-voice/src/help.ts, CONTRIBUTING.md rule 1 and fixtures/README.md.

Outcome: a `review-voice import-benchmark` command reads one downloaded set
file through a readSet adapter that maps the fields the spec's table records,
and writes one positive/<slug>-<n> recall fixture per located issue (case.yaml
with quoted expect.path, expect.line, min_findings: 1 and the source block;
the diff byte for byte; pr-body.md when there is a description) plus an
import.json manifest with exactly the documented keys and counts; it runs the
item and issue checks in the spec's order and refuses with the nine codes in
REFUSAL_REASONS, recording only the code in the manifest and the detail on
stderr; isKnownLicence implements the licence rule; it builds each item once
with materializeFixture in a temporary directory; it refuses an --out that is
not empty or is inside a git working tree; it never touches the network;
help.ts documents the command; fixtures/README.md gains the sentence on
imported items. Acceptance criteria AC-1 to AC-6 and AC-10 of the spec must
hold, proved by test/benchmark-import.test.mjs over a synthetic set document
under test/fixtures-benchmark/.

Scope: only the part A paths the spec lists under "Allowed paths". Do not
change S04's scorer, results file, readRecallResults or recall's flags. No
network module, fetch, gh or GitHubClient in the importer. Test data stays
synthetic (example.com hosts, no real names or addresses). Do not edit
scripts/, .github/, action.yml, CHANGELOG.md or the manifests. Add no
dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style of recall.ts and
recallCommand; comments explain why; no em or en dashes anywhere (the identity
guard rejects them); no hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```

## Orbit goal, part B

```
Implement part B of docs/agent-handoffs/professionalisation/S18-external-benchmark-run.md
in this repository. Part A and a person's benchmark run are already on the
base branch, so at least one docs/benchmarks/<set>/<set-version>/<plugin-version>/
directory holds import.json and results.json. If none exists, stop and report
that the run has not been committed. Read the spec first, then both files,
plugins/review-voice/src/evaluate/recall-results.ts (readRecallResults,
summariseResults, tallyResults), plugins/review-voice/src/evaluate/benchmark.ts
(isKnownLicence, REFUSAL_REASONS) and docs/EVALUATION.md ("Fixture recall"
and the candidate-set agreement figures).

Outcome: docs/EVALUATION.md gains an "External benchmark" section after
"Fixture recall" that states how the items were imported and what decisions
D1 to D3 found, the match rule with "within 3 lines", and per run directory a
heading of the form "### <set>, version <set-version>, plugin <plugin-version>",
the directory path, the runner and mode, a figures table, a refusals table
and a per-item table built from the two committed files, then the caveats
("is a sample", not comparable to published leaderboards, goals not gates)
and the rules that keep the set "never tuned against". A new
test/benchmark-results.test.mjs checks the two files and the section exactly
as the spec's "The content test" lists. Acceptance criteria AC-7 to AC-10 of
the spec must hold.

Scope: only docs/EVALUATION.md (the new section) and the new
test/benchmark-results.test.mjs. Never edit, regenerate or remove anything
under docs/benchmarks/; those are raw outputs. Write every figure from the
files, never from a run of your own. Do not edit scripts/, .github/,
action.yml, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow the voice of docs/EVALUATION.md (no data, never zero;
goals, not gates); sentence case headings; no em or en dashes anywhere (the
identity guard rejects them); no hardcoded identities.

Proof: run `node --test test/benchmark-results.test.mjs`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
