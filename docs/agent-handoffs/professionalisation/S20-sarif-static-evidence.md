# S20. SARIF static evidence: one adapter for every tool that speaks it

**Phase:** 6 (market additions, after the program's phases 0 to 5; sixth of
the ten in `GOAL.md`'s order). **Depends on:** S08 (the
`restates-tool` hold, the did-not-run report and `CommandOutcome.version`).
**Size:** about 170 source lines, 280 test lines, seven fixture documents, one
ADR amendment; one Orbit run. **Risk:** low. The opt-in rule of ADR 0003 is
untouched. Nothing runs that the repository's configuration did not list, and
a signal stays a lead for the analyst, never a finding. Baseline `11e6f69`
(`main` after S03); line numbers are as of that commit. S08 is not on this
base, but S08 and S09 have since merged (`origin/main` at `c2b16a6`), and the
S08 names below (`sanitisedVersion` and `ConfiguredCommand.version` in
`src/evidence/run.ts`, `readSignals` and `matchSignal` in `src/cli.ts`) were
checked there. Verified against the code on 2026-11-08.

## Why

Review Voice parses four tool outputs. Each adapter is a regular expression
over text lines (`plugins/review-voice/src/evidence/parsers.ts:42-48`,
`:50-112`), chosen from the user's name for the check plus the command text
(`parsers.ts:118-122`). The market research report (section 4.1, item 5, and
section 5, item 7) ranks the gap. CodeRabbit runs more than fifty tools,
Codacy, Bito, DeepSource and Amazon Q bundle SAST, secrets and dependency
scanners, and a secrets or dependency hit is cheap, deterministic evidence
Review Voice cannot cite today.

Every tool the report names emits SARIF 2.1.0: semgrep and opengrep
(`--sarif`), gitleaks (`--report-format sarif`), trivy (`--format sarif`),
CodeQL (`--format=sarif-latest`), ruff (`--output-format sarif`) and
golangci-lint (its `sarif` output). One format parser covers all seven and
any tool that adopts the format later, where seven text parsers would each
need their own fixtures and their own drift.

Two things go wrong today when such a tool is configured:

- A `ruff` command that prints SARIF is claimed by the `python` adapter on
  its command text (`parsers.ts:81`), and `PYTHON` (`parsers.ts:45`) matches a
  JSON line whose string value looks like a diagnostic, so a signal is built
  with JSON punctuation in its path. The output is mis-parsed, not ignored.
- semgrep, opengrep, gitleaks, trivy, CodeQL and golangci-lint have no adapter
  at all, so their output yields nothing (`parsers.ts:114-122`), and the
  review cannot cite a secret, a vulnerable dependency or a taint finding the
  repository already pays a tool to find.

S08 makes signals matter beyond the analyst prompt (`src/review/prompts.ts:107`).
A candidate that restates one is held as `restates-tool`, and S09 posts the
counts. A candidate in a category that names a breach or a trust boundary is
never held that way (`matchSignal` returns early on `isSuppressionExempt`,
docs/adr/0032), so a `secret` or `vulnerability` signal can support a
security finding but never silence one. ADR 0003 says adapters are
"independently testable against recorded tool output"
(`docs/adr/0003-static-analysis-adapters.md:50`); SARIF fixtures are that
record. S08 records a tool version only when the configuration names
a version command; a SARIF document names its producer and version itself
(`runs[].tool.driver.name`, `.version`, `.semanticVersion`), so the audit
record can carry both without running anything more.

## Outcome

A configured check whose output is a SARIF 2.1.0 document yields signals
carrying the tool's own message (with any secret redacted), rule id, level,
path and line, whatever tool produced it, and the check records the producing
tool's name and version. Everything downstream is unchanged: the analyst reads
the signals as leads, S08 holds restatements and names checks that did not run, S09 counts
them. Nothing runs that the repository did not configure and enable.

## Design

### Detection and document extraction

`ADAPTERS` (`parsers.ts:50`) gains a `sarif` adapter placed first. It has to
come first because the per-tool adapters match on command text, and a `ruff`
or `eslint` command may now print SARIF. Its `matches(haystack, output)`
ignores the command and returns true when `output` matches both
`/"version"\s*:\s*"2\.1\.0"/` and `/"runs"\s*:\s*\[/`, a cheap test with no
JSON parse. The command text plays no part, so a wrapper script named
anything is covered.

`parse` finds the document in `output`, which is stdout followed by stderr
(`src/evidence/run.ts:62`); tools print progress and warnings to stderr, so
the parser takes the slice from the first `{` to the last `}` and
`JSON.parse`s it. A slice that does not parse, or parses to something without
`runs[]`, yields no signals, the same answer unrecognised output gives today
(`parsers.ts:114-122`), and the sarif adapter is still the one chosen, so the
`python` adapter cannot invent signals from JSON lines. This is a shortcut. A
tool that prints a brace outside the document defeats it, and the fix is the
user quieting the tool (`-q`), which the example configuration shows.

### Mapping

For each `runs[]` entry and each of its `results[]`, in document order:

| signal field | from the SARIF result |
|---|---|
| `tool` | the configured check's `name`, as every adapter does (`parsers.ts:17`, `run.ts:68`) |
| `kind` | `SarifKind`, a closed union chosen from the lower-cased `runs[].tool.driver.name`: a name containing `gitleaks` gives `secret`; `trivy` gives `vulnerability`; `semgrep`, `opengrep` or `codeql` gives `sast_finding`; `ruff` or `golangci-lint` gives `lint_error` (the eslint adapter's kind, `parsers.ts:106`); any other name gives `static_finding`. A lead for the analyst's category, not a classification |
| `path` | `locations[0].physicalLocation.artifactLocation.uri`, percent-decoded, with a `file://` scheme removed and a leading `./` stripped; an absolute path that starts with the repository root plus `/` is made relative to it (ruff emits absolute `file:///` URIs); any other absolute path is kept as it is. `uriBaseId` and `originalUriBaseIds` are not resolved: the seven tools emit paths relative to the directory they scanned, which is the repository root when the command runs there. No location gives `path: null` |
| `line` | `region.startLine` when it is a positive integer, else `null` |
| `claim` | `<ruleId>: <message>`, the existing `code: message` shape (`parsers.ts:61`), where `message` is `message.text`, else the rule's `shortDescription.text`, else nothing after the rule id |
| `evidence` | `[<message>]`, the tool's own words with runs of whitespace collapsed to one space, passed through `redact` (`src/redact/redact.ts`) and cut at 500 code points, so S08's one-line `reason` and `explain` stay one line. Redaction is there because a rule message may interpolate the text it matched (a semgrep `$VALUE`), which for a secrets rule is the secret; `claim` uses the same redacted message |
| `confidence` | `0.95` for `error` (today's constant, `parsers.ts:36`), `0.8` for `warning`; no code decides on a signal's confidence today (S08's `readSignals` only copies it), so the number is informative only and the comment says so |

The rule id is `result.ruleId`, else `result.rule.id`, else the id of
`tool.driver.rules[result.ruleIndex ?? result.rule.index]`; a result with none
of them is skipped. Rule metadata (the fallback level and description) is
looked up by id in `tool.driver.rules` and `tool.extensions[].rules`; a miss
costs nothing but the fallback. The repository root reaches the parser as a
new optional third parameter, `parse(output, tool, root?)`, which `parseOutput`
receives as its fourth and `collectEvidence` passes from `options.cwd`
(`run.ts:68`); the existing adapters ignore it. The `signal` helper
(`parsers.ts:20-39`) gains an optional trailing `confidence` parameter
defaulting to `0.95`, so its four callers are unchanged.

Nothing else from a result is copied. `region.snippet.text`, `codeFlows`,
`relatedLocations`, `fixes`, `partialFingerprints` and `properties` stay out
of `evidence.json`. A snippet is repository content, and for gitleaks it is
the secret itself, possibly from a commit the diff does not contain.
`PRIVACY.md` says `runs/` keeps the code under review raw and that the Action caches the
whole data directory between runs, so a copied snippet would put that secret
in a stored, cached file and in the analyst's evidence. The analyst has the
path and line and reads the file.

### Levels and what is dropped

The level is `result.level`, else the rule's `defaultConfiguration.level`,
else `warning`, the SARIF default. `error` and `warning` become signals;
`note` and `none` do not. The existing adapters drop warnings
(`test/evidence.test.mjs:108-118`, "warnings are not evidence of a defect"),
and the comment in the sarif adapter says why this one keeps them. Most
semgrep rules declare WARNING, which its SARIF writes as `warning`, and trivy
maps MEDIUM to `warning`, so
dropping warnings would make the adapter useless for the tools it exists for,
and a signal is a lead the analyst must still read (`prompts.ts:107`), not a
finding.

A result is skipped when its `kind` is present and not `fail` (`pass`,
`open`, `review`, `notApplicable`, `informational`), or when any
`suppressions[]` entry has no `status` or `status: accepted` (semgrep's
`nosemgrep` and CodeQL's in-source suppressions arrive this way; the tool
itself says the result is not to be reported). A result repeated at the same
`path`, `line` and `claim`, across runs or within one, is kept once, the
dotnet adapter's rule (`parsers.ts:77`).

There is no cap on the number of signals. The bound is the 16 MB `maxBuffer`
on the command's output (`run.ts:41`); output past it makes `spawnSync` fail
with `ENOBUFS`, so the check is recorded as not run with that reason, as
today. The example configuration tells the user to scope a scanner to the
repository's own files. A scanner run over a
vendored tree floods the analyst, and that is the configuration's problem to
fix, which the architecture note says.

### Tool and version

`Adapter` gains an optional `version?: (output: string) => string | undefined`
and `parseOutput` returns `{ signals: EvidenceSignal[]; version?: string }`
(its only caller is `run.ts:68`). The sarif adapter's `version` returns
`<driver.name> <driver.version ?? driver.semanticVersion>` from the first run,
or `undefined` when the driver has no version. `collectEvidence` records it as
`CommandOutcome.version` through `sanitisedVersion`, the sanitiser S08 adds to
`run.ts` for version commands (first line only, control, bidi and zero-width
characters stripped, 80 code points), and only when the configured `version`
command of S08 recorded nothing. A command the user wrote wins over a string
the tool printed. S09's
`staticRan[].version` then carries it with no change of its own. ADR 0003
gains a dated `## Amendment - <date>` after S08's, S16's and S17's, saying that one format
adapter covers many tools, that the list of adapters in the decision is
illustrative, and that a version read from the tool's own output is not a run
of anything, so "detection suggests, configuration enables" holds. It also
states the exposure, which is unchanged. The parser reads only what a
configured command printed, while the configured scanner runs with the host's
network, so a rule or database download (`semgrep --config auto`, trivy's
database) is that command's choice, and the example avoids both.
`docs/adr/README.md` marks the row `amended <date> (SARIF)`, the form
the 0028 row uses.

### Configuration and documentation

No new key. The commands the adapter serves are ordinary
`static_evidence.commands[]` entries (`src/policy/load.ts:739-756`), read from
the base commit for a pull request review as S01 arranged, and
`enabled: true` is still required (`run.ts:24-26`). `templates/config.example.yaml:179-182`
gains two commented entries after the `typecheck` example and one comment
line each, so the example still loads with no warnings
(`test/issues-config.test.mjs:38-47`):

```yaml
  # Any tool that prints SARIF 2.1.0 to stdout is parsed, whatever its name.
  # Use local rules with metrics off, so the scanner does not reach the
  # network, and scope the scan to your own files, since a scan of a vendored
  # tree floods the analyst with leads.
  #   - name: semgrep
  #     run: semgrep scan --config .semgrep --metrics=off --sarif --quiet .
  #   - name: ruff
  #     run: ruff check --output-format sarif .
```

`help.ts:197-207` (`evidence`) gains one line saying SARIF 2.1.0 output from
any tool is parsed and other output needs a known adapter.
`docs/ARCHITECTURE.md` "Static evidence" (`:442-457`) gets a paragraph: the
sarif adapter, the level rule, what is left out of a result and why, and the
version. `commands/review.md` step 1c needs no change; it already passes
`signals` through.

### Fixtures

`fixtures/sarif/<tool>.sarif.json`, seven flat files, for `semgrep`,
`opengrep`, `gitleaks`, `trivy`, `codeql`, `ruff` and `golangci-lint`, plus
`fixtures/sarif/README.md`. Flat files, not case directories, because
`test/fixtures.test.mjs:10-21` treats every `fixtures/<group>/<name>/`
directory as a review case that must carry `case.yaml` and `diff.patch`.
`fixtures/README.md` gains a row for `sarif/` saying what it asserts and that
its files are documents, not cases.

Every fixture is synthetic and hand-written in the shape the named tool
version emits (driver name and version field, rule placement, URI form, level
convention, suppression form); the README table records, per tool, the version
whose format the file follows, the command that produces it, what the file
exercises, and whether the shape was confirmed against a real run. An
unconfirmed row is a follow-up for a person (below). Each file carries one
`error` result, one `warning` and one `note` where the tool can emit each, and
these tool-specific shapes: ruff's absolute `file:///work/repo/...` URIs;
CodeQL's `uriBaseId: "%SRCROOT%"`, a rule under `tool.extensions[].rules`
and one suppressed result; semgrep's `Semgrep OSS` driver name,
`semanticVersion` only, rule-level `defaultConfiguration` with no result
`level`, and one `nosemgrep` suppression; gitleaks' `partialFingerprints`
with placeholder values and a snippet whose text is the word `redacted`;
trivy's `originalUriBaseIds`, lockfile location and a long message; one
result with no `locations` in whichever fixture's tool can emit one; and a
duplicate result in `golangci-lint`. No file carries a `$schema`,
`informationUri` or `helpUri` key or any other external URL, an email outside
`example.com`, a token-shaped string or a real identity; the parser reads none
of those fields, and the identity guard scans `.json`
(`scripts/guard-identity.mjs:70`). `test/fixtures.test.mjs` checks the
forbidden patterns only inside case directories, so the new test applies them
to these files itself.

### Tests

`test/evidence-sarif.test.mjs` imports `parseOutput` from
`../plugins/review-voice/src/evidence/parsers.ts` (the import style of
`test/reconcile-quality-confidence.test.mjs:16`) and reads each fixture. For
each tool it asserts the adapter is chosen with the tool's real command text
and again with the name `lint` and the command `./scripts/check`, the signal
count equals the fixture's unsuppressed `fail` results at `error` or
`warning`, the first signal's `kind`, `path`, `line`, `claim` and
`evidence[0]`, and the `version` string. Targeted cases cover stderr noise
around the document, an unparseable slice, the `semanticVersion` fallback, an
absent version, the absolute path made relative with `root` and kept without
it, `uriBaseId` left unresolved, percent-decoding, the null location, the
suppression and `kind` rules, the duplicate, the 500-code-point cut, the two
confidence values, a message carrying a token-shaped string built at run time
that comes back as `[REDACTED:...]` in both `claim` and `evidence[0]`, and
that the gitleaks fixture's snippet text and the trivy fixture's `properties`
values occur nowhere in `JSON.stringify(signals)`. One end-to-end case runs
the bundle as `test/evidence.test.mjs:27-28` does. It writes the ruff fixture
into the temporary repository with `/work/repo` replaced by the repository's
real path (`realpathSync`, because `repositoryRoot` uses
`git rev-parse --show-toplevel`, which resolves macOS `/var` to `/private/var`),
configures `{ name: 'ruff', run: 'cat ruff.sarif.json' }`, and asserts the
signals have repository-relative paths (so the root reached the parser and the
`python` adapter did not claim the output) and `commands[0].version` starts
with the driver name. A
second end-to-end case adds S08's `version: echo configured-tool 1.0` to the
same command and asserts the configured string wins. The fixture README is
checked by a test that lists `fixtures/sarif/*.sarif.json` and asserts each
basename appears in a table row of the README together with a version. The
documentation test follows `test/trusted-config-docs.test.mjs:26-38`.

### Order against the other market specs

S20 is sixth of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"):

- After S16 part A, which exports `spawnInGroup` from `src/evidence/run.ts`
  with an argv form; this spec then changes the `parseOutput` call in the
  same file. Both add to `help.ts`, `config.example.yaml` and
  `docs/ARCHITECTURE.md` "Static evidence".
- After S16 and S17, whose ADR 0003 amendments come before this one.
- S15's evidence block quotes a signal's first `evidence` entry and redacts it
  again, so a SARIF message reaches a posted block only redacted and cut.

## Non-goals

- No runner, no new configuration key, no network, nothing on by default. The
  adapter only parses what a configured and enabled command printed (ADR
  0003).
- No posting. S09's counts are the visible surface; the single write path is
  not widened.
- No new did-not-run cause. A tool that exits non-zero without printing a
  document is recorded as ran with its exit code and zero signals, exactly as
  today, and S03's `staticChecksOf` (`src/review/driver.ts:1028-1031`) lists
  it under `failed`; the exit code is the evidence. S08's exit 126 and 127
  stay did-not-run.
- No SARIF 2.0 or earlier, no `originalUriBaseIds` resolution, no code flows,
  fixes, snippets or properties.
- No per-tool adapters beyond the `SarifKind` table; a tool not in it still
  parses, with `kind: static_finding`.
- The existing `python` adapter keeps parsing ruff's text output; both forms
  work.
- Open question for the owner: the fixtures are hand-shaped because an Orbit
  worker has neither the seven tools nor the network to install them. Whether
  to replace each with a document recorded by running the real tool over a
  synthetic repository (still synthetic under `CONTRIBUTING.md`, more
  faithful to the tool) is a follow-up for a person, filed per unconfirmed
  README row when this spec merges.

## Acceptance criteria

- AC-1. The sarif adapter is chosen for every fixture whatever the check's
  name and command text, including `ruff` with its real command, and precedes
  the per-tool adapters in `ADAPTERS`; a document wrapped in stderr noise
  parses; a slice that does not parse yields no signals and no `python`
  signals; non-SARIF output still reaches the adapter it reached before
  (`test/evidence-sarif.test.mjs`; `test/evidence.test.mjs` passes
  unchanged).
- AC-2. For every fixture the signal count, the first signal's `kind`,
  `path`, `line`, `claim` and `evidence[0]` and the `version` equal literal
  values the test states per fixture, worked out by hand from the mapping and
  level rules in this spec; `note` results, results with a non-`fail` kind,
  suppressed
  results and duplicates produce no signal; a rule-level
  `defaultConfiguration.level` supplies a missing result level; a result with
  no message falls back to the rule description and then to the rule id alone
  (`test/evidence-sarif.test.mjs`).
- AC-3. Paths are percent-decoded, lose a `file://` scheme and a leading
  `./`, become relative under `root` and stay absolute without it;
  `uriBaseId` is left alone; a result without a location has `path: null` and
  `line: null`; snippet text and `properties` values occur nowhere in the
  signals; a token-shaped string in a message is redacted in `claim` and
  `evidence[0]`; a message is cut at 500 code points; `error` gives confidence
  0.95 and `warning` 0.8 (`test/evidence-sarif.test.mjs`).
- AC-4. `parseOutput` returns `{ signals, version }`; `version` is
  `<driver name> <version>` with `semanticVersion` as fallback and absent when
  the driver names none; through the bundle, `cat` of the rewritten ruff
  fixture yields repository-relative paths and records `commands[0].version`
  sanitised and starting with the driver name, and a configured S08 `version`
  command's result wins over it (`test/evidence-sarif.test.mjs`).
- AC-5. Seven fixture documents exist under `fixtures/sarif/`, each valid
  JSON with `version: "2.1.0"`, a driver name and a version field, free of
  `$schema`, `informationUri` and `helpUri` keys and of the forbidden
  patterns at `test/fixtures.test.mjs:73-78`, applied by the new test;
  `fixtures/sarif/README.md` lists each file
  with its tool version, command and confirmation status, and
  `fixtures/README.md` has the `sarif/` row (`test/evidence-sarif.test.mjs`;
  `test/fixtures.test.mjs` passes unchanged).
- AC-6. A test asserts `docs/adr/0003-*.md` contains a `## Amendment - 2026`
  heading whose text mentions SARIF, `docs/adr/README.md`'s 0003 row mentions
  SARIF, `docs/ARCHITECTURE.md` mentions SARIF in "Static evidence", and
  `commandHelp('evidence')` mentions SARIF; `config.example.yaml` carries the
  commented entries and still loads with no commands and no warnings
  (`test/evidence-sarif.test.mjs`; `test/issues-config.test.mjs`).
- AC-7. `npm run verify` passes with the rebuilt bundle committed.

## Allowed paths

`plugins/review-voice/src/evidence/**`, `plugins/review-voice/src/help.ts`,
`plugins/review-voice/templates/config.example.yaml`, `fixtures/sarif/**`
(new), `fixtures/README.md`, `docs/adr/0003-*.md`, `docs/adr/README.md`,
`docs/ARCHITECTURE.md`, `test/**`, `plugins/review-voice/dist/review-voice.mjs`.

This spec does not touch `cli.ts`, so it rebases past any other spec
without a conflict there. It shares `run.ts`, `help.ts`, `config.example.yaml`
and ADR 0003 with S08 and S16, and `help.ts` and `config.example.yaml` with
S09. S08 and S09 have merged (`c2b16a6`), and S16 lands before it in the
phase order. It imports `redact` from `src/redact/redact.ts` and does not
change it.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S20-sarif-static-evidence.md
in this repository. S08 is already on the base branch, as are S16 and S17,
so locate its version sanitiser (sanitisedVersion), CommandOutcome.version
and S16's exported spawnInGroup by name. Read the
spec first, then
docs/adr/0003-static-analysis-adapters.md (with every amendment, S08's,
S16's and S17's included),
plugins/review-voice/src/evidence/parsers.ts (the Adapter shape, the signal
helper, ADAPTERS and parseOutput), plugins/review-voice/src/evidence/run.ts
(where output is assembled and parseOutput is called),
plugins/review-voice/src/evidence/types.ts, test/evidence.test.mjs (the
bundle-driven test shape), test/fixtures.test.mjs (why the fixtures are flat
files) and docs/ARCHITECTURE.md "Static evidence".

Outcome: a sarif adapter placed first in ADAPTERS matches any output holding
a SARIF 2.1.0 document, extracts the document from stdout plus stderr, and
maps each unsuppressed fail result at error or warning onto a signal with the
closed SarifKind table, the path rules (percent-decoding, file scheme removed,
absolute paths made relative to the root passed through a new optional
parameter, uriBaseId unresolved), startLine, the `ruleId: message` claim, the
tool's message as evidence, redacted and cut at 500 code points, and
confidence 0.95 or 0.8 by level; notes, non-fail kinds, suppressed results
and duplicates
produce nothing; snippets, code flows, fixes, fingerprints and properties are
never copied; parseOutput returns { signals, version } and collectEvidence
records the driver's name and version as CommandOutcome.version through S08's
sanitiser only when no configured version command recorded one; seven
synthetic hand-shaped SARIF fixtures with a README that records tool versions
live under fixtures/sarif/ as flat files; config.example.yaml, help.ts,
docs/ARCHITECTURE.md and ADR 0003 (a dated amendment, the index row marked)
document it. All seven acceptance criteria in the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". No new
configuration key, no runner, no network, nothing on by default, no GitHub
write, no change to cli.ts, driver.ts or the analyst prompt. Fixtures stay
synthetic: no real names, hosts, emails outside example.com, URLs or
token-shaped strings, and no $schema, informationUri or helpUri keys. Do not
edit any existing test. Do not edit scripts/, .github/, CHANGELOG.md or the
manifests. Add no
dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
