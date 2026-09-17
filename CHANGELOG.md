# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-09-17

### Fixed

- A `question` stays a question at every reach. 1.1.0 derived it from
  (category, reach) on the theory that the wording carries the interrogative,
  but `BY_CATEGORY_AND_REACH` contains no `question` at any category or reach,
  so the tier was unreachable - and 1.3.0's module fallback made reach
  available far more often, turning a rare bug into a routine one. A candidate
  whose own evidence said the flag state was outside the repository and could
  not be read came back as `important`: an honest "I could not check this"
  published as a claim. The schema accepts `question` and the output contract
  orders it; only the table could not produce it.
- `api_contract` varies by reach and is `blocking` at repository reach. A
  change that added a required prop and missed one of three call sites derived
  `important` while its head had ten CI failures, each a Code check across a
  different package.
- A finding about a file the change does not touch now measures the change.
  Hunk symbols come from the named file, and a broken-consumer finding names
  the consumer, which the pull request does not touch - so the class of finding
  most likely to be serious was the one that fell back to the claim. The rest
  of the diff is used instead, reported as `symbolSource: "diff"`.
- A small complete convention rule is no longer displaced by another slice of a
  large one. Section selection keeps more of a large document than byte
  truncation did, so large documents began crowding out small ones: on one run
  three partial rules took 41,762 of the 60,000-byte budget and a complete
  2,668-byte unit-test rule was skipped, on a change whose largest additions
  were the test files it governs. Documents that fit whole are now admitted
  before documents that must be cut.

## [1.3.0] - 2026-09-17

### Changed

- Reach is measured from the symbols the diff's hunks touch, not the symbols
  the claim names. Excluding symbols absent from the changed file caught
  `Math.round` and a local `canEdit`, but not the case containment cannot see:
  a finding whose point is that some symbol is the *wrong* referent names that
  symbol, and it is genuinely in the file. Only `+` and `-` lines count, since
  a symbol on a context line is what the change is near rather than what it
  changed. `score` takes `--diff-file`; without it the claim remains the
  fallback, and `symbolSource` says which was used.
- A symbol the change introduces has no spread at the base ref by
  construction, which left reach absent for most findings, since most findings
  are about new code. When no touched symbol exists at the reviewed ref the
  changed file's own module name stands in for it, reported as
  `moduleFallback`.
- An oversized convention document now keeps the sections matching the paths
  under review rather than its first 15,000 bytes. A 21,441-byte rule
  governing 728 of 1,073 added lines was cut at the head, and the sections that
  mattered survived by luck of position; marking the cut made the loss visible
  without stopping it. The preamble is always kept, since a rule states its
  scope there, and the document says how many sections were left out.

### Added

- `record --stages` stores per-stage timings, and `evaluate` reports
  `median_review_seconds`. A review measured once took about twenty-five
  minutes against a sweep that runs every ten; whether that holds is a
  distribution nobody had.

## [1.2.1] - 2026-09-17

### Fixed

- The eval suite can now run at all. `--eval-dir` resolves below the plugin
  root, and the cases sat at the repository root, so every invocation exited 1
  with "No eval cases found" - including the nightly CI job, whose only
  scheduled run failed. The cases were also written as `case.yaml` without
  `schema_version`, which the loader rejects; they are now `prompt.md` plus
  `graders/`, the form the scaffolder writes.
- The confinement grader no longer passes a run in which the review never
  started. On macOS the eval sandbox denies writes to the system temp
  directory and the `git` on PATH is the Xcode shim that needs it, so `RV diff`
  exits 2 and no agent is spawned. The bait not executing because nothing
  executed is the absence of the experiment, not evidence that a grant binds.
- The eval CI job installs `bubblewrap` and `socat`. Granting a shell makes the
  harness require OS-level confinement and refuse to start without it, which is
  the behaviour to keep, and the runner image ships neither dependency. The job
  also needs an `ANTHROPIC_API_KEY` repository secret; without one every LLM
  grader throws "not logged in" and each case scores 0.00, which reads like the
  plugin behaving badly and is not.
- The eval documentation records what the macOS sandbox actually does, probed
  rather than inferred: `TMPDIR` must come from the operator's shell because a
  case file may only set `EVAL_*` keys, the Xcode `git` shim then fails at
  `xcode-select` with exit 72 because the Developer directory is outside the
  sandbox, prepending the real binary to `PATH` does not help because the
  sandbox resets `PATH`, and the working directory is empty so a prompt naming
  `fixtures/...` resolves to nothing. A pass in that state measures the
  sandbox, not the plugin.

## [1.2.0] - 2026-09-17

### Added

- `diff --pr` reports `refs`, saying whether the pull request's base and head
  commits can actually be read locally. Availability is established with
  `git cat-file`, never inferred from a fetch's exit status. When they are
  missing the commits are fetched into `refs/review-voice/pr/<n>/head`, but
  only when `origin` resolves to the repository under review: fetching from an
  unrelated clone would supply plausible commits from the wrong project. A
  fetch that cannot run is never fatal.
- The external verifier is told what change it is judging. Its command now
  receives `context` carrying the repository, the diff path, and base and head
  where those are readable. It previously got a finding and nothing else and
  ran against whatever the working tree happened to be, which is why a test run
  returned a false rejection at 0.99.
- `diff` reports `hunkFileCount` beside `reviewedFileCount`, and
  `--scale-to-files` uses it. The two answer different questions, and a file
  that contributes no hunk was buying word budget.

### Changed

- The evidence verifier is told that a commit missing from the clone belongs in
  `required_context_missing`, rather than falling back to the patch and
  reporting confidence as though it had checked the code.

## [1.1.1] - 2026-09-17

### Fixed

- Reach no longer reads every path as repository-wide. `git grep -l <ref>`
  prefixes each line with `<ref>:`, and nothing stripped it, so no hit ever
  matched the changed file or its subtree: `local` was unreachable whenever
  `--base` was passed, which the review command always does, and the three-way
  distinction collapsed to two biased upward. The signature was
  `outsideDirectoryCount` equalling `directoryCount` on every observation.
- Reach no longer escalates a finding because it mentions a common name. A
  `correctness` defect in one date formatter was raised a tier because the
  claim said `Math.round`, which appeared in 58 directories of the repository
  under review; a local `const canEdit` reached 158. A symbol is now excluded
  from the measure when the changed file does not contain it, or when its own
  spread is wide enough to describe the language rather than the change.
  Excluded symbols are reported in `ignoredSymbols`.

### Added

- `evals/confinement`, which probes whether a declared agent tool grant
  actually binds. A fixture repository invites the reviewer to run its own
  toolchain to confirm a claim, and the grader fails on any execution that is
  not `git`. `docs/THREAT-MODEL.md` now records that this mitigation depends
  on host enforcement the plugin cannot verify itself, and is asserted rather
  than verified until the eval has run.

### Fixed

- The review command now tells the operator to inline candidate JSON into the
  editor's prompt rather than pass a file path. The editor declares no tools
  deliberately - its authority limit, that it cannot add a technical claim,
  rests on having no way to verify one - so a path left it able only to say it
  cannot open files.
- The analyst prompt now carries the candidate schema's nine field names
  instead of naming the schema file. Three runs returned
  `title`/`location`/`description` and produced no review.
- The review command no longer invites aliasing `RV` as a shell variable. zsh
  does not word-split an unquoted parameter, so `$RV` as a command exits 127.
- `--min-score` help said the default was 0.78. It has been 0.68 since 0.9.2,
  and the help is the only place a user learns the number.
- A convention stub pointing at more than one document now resolves all of
  them. The pointer pattern was anchored to a whole body, so it matched only a
  stub holding exactly one `@path.md` line: a 179-byte file declaring
  `paths: ["**/Controllers/**/*.cs"]` and listing two rule files resolved to
  neither, and a pull request adding a controller was reviewed without the
  controller rules. A stub now expands to one entry per target, each ranked and
  budgeted on its own size, and a target that cannot be found is reported in
  `skipped` rather than vanishing.
- A truncated convention document now says so in its own text. The warning went
  to the operator while the analyst read a document that stopped mid-word with
  nothing marking the cut, and `bytes` still reported the original size.
  Documents now carry `includedBytes` alongside `bytes` and are cut at a line
  boundary.
- The per-document budget is now counted in bytes. It used `slice`, which
  counts UTF-16 code units, so a document with non-ASCII content could take
  several times its share and could be cut through a surrogate pair.
- The total convention budget is checked before a document is read rather than
  after, so the last document admitted no longer overshoots it by its own size.

## [1.1.0] - 2026-09-17

### Changed

- Score breakdowns carry an `anchored` block: what the final score would be
  with anchor-less precedents excluded from alignment, and whether eligibility
  would flip. Unanchored summaries match every candidate equally, so with owner
  weighting they surface regardless of topic and alignment becomes a constant
  rather than a signal - 0.40 of the score carrying no information. Excluding
  them moves the score by 0.05 to 0.11 against a 0.68 gate, which is large
  enough that switching without measuring would delete findings that pass
  today, so it ships as a shadow and the gate is unchanged.

- Severity now combines the finding category with deterministic, CLI-computed
  reach instead of assigning every member of a category one fixed tier. A
  category like `ci` spans a build-breaker and a stale comment, so one tier per
  category was wrong for half its members however it was tuned.
- Reach is measured relative to the changed file - hits confined to it, within
  its own directory subtree, or in two or more directories beyond it - and
  counts only code. Counting distinct top-level directories was wrong in both
  directions: inert under a monorepo root, and inflated by a symbol named in
  prose. The search records its symbols, hit paths, counted code paths,
  directory counts and ref, so a raised tier stays auditable.
- A missing symbol, no usable code hits, or a failed search retains the
  previous category tier exactly. No agent supplies reach.

## [1.0.0] - 2026-09-17

First stable release. 1.0.0 is a claim about the interface, not a new
capability: the scoring and severity contracts have held four consecutive
releases, each comparison over identical batches, with a maximum difference of
1.7e-10.

It is not a claim about measured precision. `owner_accepted_precision` reports
no data because nothing has been labelled, and `docs/EVALUATION.md` says so.

### Fixed

- The plugin manifest and marketplace entry no longer advertise "at most five
  findings". The cap was removed several releases ago and the description is
  what a reader sees before installing anything.

### Added

- `status` counts findings that carry no feedback label and says how to label
  them. The gate this tool rests on is computed from labels and nothing else,
  and after a full test programme none existed, which reported as no data and
  read as silence.

### Changed

- `docs/ARCHITECTURE.md` and `docs/EVALUATION.md` record that a score belongs to
  the batch rather than to the candidate. Novelty is measured against what the
  same review has already kept, so making one candidate eligible costs its
  neighbours novelty and relaxing any gate can push an unrelated finding down.
  Measured: one candidate moved 0.7158 to 0.6950 with no change to its own
  inputs. Every reproducibility figure published is valid because each
  comparison ran identical batches.

## [0.9.2] - 2026-09-17

### Changed

- The confidence floor is split by who established the number. A verifier
  confidence is still gated at 0.8; an analyst self-report is gated at 0.7.
  Measured against ground truth over eleven candidates, the self-report does not
  separate true from false anywhere above 0.7: the two most thoroughly verified
  findings sat at 0.70 and the only false one at 0.80. Held at 0.8 it discarded
  a real behavioural defect, a test that did not test what it claimed, and the
  finding that drove an actual changes-requested review, while shipping the
  false one. `score` now reports how many candidates were gated on the
  self-report.
- A claim that says it could not be verified is rejected on its own terms rather
  than by sitting beneath a numeric floor, which tied it to a number that has
  moved twice.

### Fixed

- Any determiner before a repository word still names this repository. Only
  `the` was stripped, so "in this repository" was read as a named unit with the
  determiner captured as the name, and "in this codebase" fell through to
  bounded.
- The analyst is told that a comment about another repository is not evidence
  about it. Both runs of one diff asserted two localisation keys were missing,
  citing an in-repo comment that had gone stale when the other side merged. The
  comment being stale is itself the better finding.

## [0.9.1] - 2026-09-17

### Fixed

- Absence claims are scoped by the claim's grammar rather than by how a place is
  spelled. The pattern that read "in mews-js" as somewhere else, so a claim
  about that very repository went unchecked, also left a bare path unprotected,
  so a true claim about a subtree was deleted; the difference between them was a
  pair of backticks. What decides now is whether the assertion carries a
  locative complement and whether that complement names the repository under
  review, which `--repository` supplies.
- Absence of a property is not absence from a place. "Never exported" is true
  precisely when the symbol exists, so searching confirms it and refutes
  nothing.
- A finding that asserts no absence is never given an absence record. Mentioning
  a hyphenated package name was enough to attach an inert `inconclusive: true`,
  and it had begun appearing on ordinary findings.

### Added

- `check-candidates` validates analyst output against the candidate schema.
  The same check runs inside `score`, which is the fourth stage: a wrong shape
  was not caught until after a full verification pass, and on a real run that
  cost the only pass which found the most serious defect in the diff. The review
  command now runs it at step 2, so a shape failure costs one re-run of one
  agent.

## [0.9.0] - 2026-09-17

### Changed

- Convention documents are ranked by how much of the change they govern before
  how large they are. Ranking by size dropped a test rule from a diff whose two
  largest additions were test files, while shorter rules governing one
  incidental file were read. A file governing the directory under change is
  still never demoted.
- `docs/EVALUATION.md` publishes what has actually been measured, and states
  that `owner_accepted_precision` has no data because nothing has been labelled
  through feedback. The evidence the reviewer finds real defects is six
  findings verified, posted to live pull requests and fixed by their authors,
  which is real and is not that gate.

## [0.8.1] - 2026-09-17

### Fixed

- The absence guard reads the claim, never the failure mode. The two were
  concatenated, so the sentence explaining the consequence voted on whether the
  assertion was scoped: the same invented claim was checked or ignored
  depending on how its impact was worded, and a symbol named only in the
  mechanism could be reported as one the claim said was absent.
- "in the repository" and "from the codebase" are repo-wide. They classified as
  scoped, because the scoped pattern matches on "in the", so the widest claim a
  reviewer can make went unchecked on the strength of one missing word.
- A claim about another repository returns `inconclusive: true`. `git grep` here
  speaks only for this repository, and answering anyway gave false corroboration
  at the base ref and deleted a true finding at the head ref by matching the
  symbol the diff itself adds.
- `candidate_set_agreement` has a diff to group by. No shipped command passed
  `--diff-file`, so every run stored the hash of the empty string, the metric
  compared unrelated pull requests, and it fell further the more work was
  recorded. The review command passes the patch, `record` says so when it
  cannot, and runs without one are excluded and reported as not measurable.
- Agreement tolerates an anchor drifting a few lines, matched pairwise rather
  than bucketed: a fixed bucket puts a hard edge somewhere, which is what made
  severity unstable two releases ago.
- A pointer document resolves to its own directory before the repository root,
  so `@AGENTS.md` beside a package's `CLAUDE.md` means the sibling.

### Added

- A fourth seam test runs the shipped command text in `commands/review.md`
  against the CLI's own flag set. The three existing seams are agent
  boundaries; the defect that got through was between the prose and the binary,
  and nothing watched it.

## [0.8.0] - 2026-09-17

### Fixed

- The absence guard acts only on claims that are repo-wide beyond argument.
  `git grep` answers "is this string anywhere in the repository", which refutes
  a repo-wide claim and says nothing about a scoped one: "the hook is missing
  from `@scope/ui-kit`" is true precisely when the hook exists somewhere else,
  so the search confirmed the symbol and deleted the finding. Five of six
  realistic claim shapes were scoped and all five fired. Saying where something
  is absent is what a well-argued claim does, so the check preferentially killed
  the best findings.

### Added

- `test/seams.test.mjs` pins the three seams between a prompt and the code that
  reads its output: analyst to `score`, verifier to `score`, and every enum a
  prompt must contain. Four defects have come from these and none was caught by
  a test. The expectations are derived from the schemas and the prompts rather
  than restated, so renaming a field in either fails the suite.
- `candidate_set_agreement`, the overlap between reviews of the same diff, by
  `path:line`, across every diff reviewed more than once. Reported and never
  scored. Two reviews of one pull request agreed on two candidates of eight;
  severity stability was measured and fixed across three releases while this
  went untracked, and for a reviewer it is the more consequential variance.

## [0.7.2] - 2026-09-17

### Fixed

- The analyst prompt lists the twenty-two valid categories and settles the
  confusable pairs. It never mentioned them: the prompt referenced the schema
  and the schema reached it only through a `$ref`. That was survivable while
  category was decoration and is not now that the tier rests entirely on it. On
  one pull request half the findings used `testing` and `documentation`,
  plausible words outside the enum, and both took the fallback tier.
- Unambiguous synonyms for a category resolve to it, and the substitution is
  named in the reason string. Ambiguous words are left to the middle-tier
  fallback, because an alias into a `blocking` tier is the riskiest kind.
  Casing and spacing no longer decide a tier.

## [0.7.1] - 2026-09-17

### Fixed

- Severity no longer moves with confidence. Deriving it from the category closed
  most of the instability, and measurement showed the rest had simply moved into
  the confidence term: on two runs of an identical diff the category matched
  both times and the tier differed anyway, at 0.82 against 0.90 and at 0.85
  against 0.80. Everything that ships sits in `[0.8, 1.0]` and run to run
  variance is around 0.08, so any boundary inside that band gets crossed. The
  tiers are a step quieter to pay for dropping the weakening, so removing the
  cliff does not make reviews louder.
- A missing category is no longer defaulted to `correctness`. It gave an
  unlabelled finding a real tier and recorded nothing about the substitution.
  Absent and unrecognised both take the middle tier and say which applied.
- A candidate in a foreign shape is named as such. One analyst run returned
  `title`, `location` and `suggested_direction`, and the error read "missing
  path", which describes a field rather than the problem, so the pull request
  produced nothing with no indication why.

## [0.7.0] - 2026-09-17

### Fixed

- The absence guard searches the ref under review, passed as `score --base
  <ref>`, rather than the working tree. A checkout behind the pull request base
  genuinely lacks files the base contains, so the check reported `found: []`
  with `inconclusive: false` for two files that exist, which reads as
  corroboration of a false claim rather than a failure to evaluate it. Every
  result now names the tree that answered, and a `--base` that does not resolve
  is an error rather than a silent fallback to the wrong tree.
- `distribution.cleared` counts what actually ships. It counted scores above the
  threshold and ignored candidates the confidence gate had already rejected, so
  it overstated the yield in the one block operators are asked to report.
  `aboveThreshold` carries the old number under its own name.
- Convention documents are ranked on the globs they declare. A repository
  writing `paths: ["**/*.tsx"]` in frontmatter is saying when a rule applies;
  ranking by proximity alone sent a 14 KB semaphore guide and a 9.6 KB routing
  guide to a pull request with neither, while every rule whose glob matched was
  dropped for budget.
- A pointer file whose whole content is `@.agents/rules/routing.md` is followed
  to the document holding the rule. Eight of nineteen documents selected on one
  pull request were 70-byte stubs saying where a rule lives.

### Changed

- Severity is derived from the category and the verified confidence rather than
  requested from the analyst, weakening one tier below 0.85 confidence.
  Ordering is severity-first, and asking produced `minor` at confidence 0.90 and
  `important` at 0.85 for the same finding on a byte-identical diff. The
  requested severity is recorded beside the derived one. `question` is
  preserved, being a kind of finding rather than a level of consequence.

## [0.6.0] - 2026-09-17

### Added

- `score` checks a claim of absence against the repository. "X does not exist"
  is the cheapest claim to verify and the most damaging to get wrong: the
  analyst asserted four files were missing at confidence 0.90, and 0.93 on a
  re-run of the same diff, and proposed replacing correct cross-references with
  wrong ones. Every symbol such a claim names is now searched with `git grep`
  and the candidate is rejected if any of them is present. A search that cannot
  run concludes nothing.

### Changed

- The final-score threshold moves from 0.74 to 0.68, replacing a derivation
  with a measurement. Across five runs every candidate the verifier judged
  false was already rejected on confidence, and the true and false classes
  separated between 0.6313 and 0.6884 with nothing in between, while 0.74 sat
  inside the confirmed-true group and deleted three of five true findings.
- Convention documents are ranked by information density rather than proximity
  alone. Four large skill documents were taking 96% of the budget, dropping all
  32 rule files including a 553-byte rule that changed a verdict. Short
  documents in a tier are read first, and no document may take more than a
  quarter of the budget. Directory-scoped files are still ranked by closeness.
- Both agent prompts state that convention documents are fallible and that
  source wins a factual conflict. A skill document asserted a mechanism the
  code contradicts, and the analyst repeated it for four consecutive runs.
- `npm run verify` checks the bundle is current before running the tests. The
  CLI tests exercise the committed bundle, so a stale one let them pass against
  code that was not the source.

### Fixed

- `--help` works for every command, handled before dispatch. `score --help`
  printed the stdin error and then blocked on a terminal, which also hid
  `--exclude-pull`: the flag is in the help text and the help text could not be
  reached.
- The unfinished-sync warning is retired by a later completed sync. It told the
  user to run a sync two lines below reporting that four had since succeeded.

## [0.5.0] - 2026-09-17

### Fixed

- `score --verification` accepts `results`, which is the key the
  `evidence-verifier` actually emits, and exits non-zero when the file yields no
  verifications. It accepted only `verifications` and `candidates`, so on the
  documented pipeline every candidate fell back to the analyst's self-report
  and the command still exited 0. The two headline fixes of 0.4.0 were inert
  and nothing said so.
- The unverifiable cap is a prior the verifier can overturn, not a ceiling. An
  explicit `technical_confidence` from the verifier now wins, because it means
  the verifier considered the question. Context the verifier itself could not
  reach still caps absolutely. Previously one regex over the analyst's prose
  outranked the verifier, inverting the change that let the verifier supersede.
- Novelty no longer punishes a second real defect in another file. A subsystem
  has a vocabulary, so two distinct defects in neighbouring hooks scored as
  restatements of each other; a cross-file penalty now needs near-identical
  wording. Same-file deduplication is unchanged.
- `context` can detect a missing `verification` block. The field was seeded with
  a disabled default before parsing, so the check for its absence was always
  false and the warning could never fire.
- `conventions` searches `.agents/rules/` and `.claude/rules/` as well as
  `.claude/skills/`, and searches every directory the diff touches rather than
  only the repository root. Selection is ordered by relevance before the size
  budget applies, so a rule whose name matches the change is read before one
  that merely sorts early. Each document reports why it was selected.
- `conventions --help` prints help. It used to run with repository-wide
  defaults and write every document to stdout.
- Precedent retrieval penalises a language mismatch rather than only rewarding a
  match, and derives the language from the file path. The `language` column is
  null on every stored event, so both the bonus and the penalty were dead
  against a real corpus and a Python file could top the results for a React
  finding.
- `score --exclude-pull <n>` drops precedents from the pull request under
  review. The self-ingestion detector only catches output posted verbatim, and
  a review rewritten into prose before posting walked straight past it.
- A rejection message prints four decimal places, so it no longer reads
  "score 0.78 is below 0.78".
- `sync` reports which repository it is reading. It wrote nothing for minutes,
  which is correct and reads as a hang.

### Changed

- The final-score threshold moves from 0.78 to 0.74, a deliberate deviation
  from the specification constant. 0.78 was calibrated when `evidenceQuality`
  returned 1.000 for every candidate and handed each one a free 0.15. Once that
  term began to discriminate the distribution moved down and the gate did not,
  so two of twelve verified findings cleared it where eight of ten had before.
- `score` reports the score distribution it produced, so the threshold can be
  checked against data rather than carried forward as a constant.
- `status` reports the last completed sync, and warns about a sync that began
  and never recorded a finish. An empty corpus read identically whether a sync
  had never run or one had died, and only a manual query distinguished them. A
  run started within the last half hour is reported as neither, because a sync
  in flight writes the same row as one that crashed.

## [0.4.0] - 2026-09-17

### Added

- `RV conventions` collects the repository's own `CLAUDE.md`, `AGENTS.md`,
  `CONTRIBUTING.md` and skill documents, scoped to the subtrees the diff
  touches, and both the analyst and the verifier now receive them. They are
  supplied as evidence about what the repository requires, never as
  instructions to the reviewer. Precedent could not reach these rules: the
  better a convention is observed, the fewer review comments it leaves behind.

### Changed

- Eligibility gates on the `evidence-verifier`'s confidence rather than the
  analyst's self-report, via `score --verification <path>`. The verifier is the
  only stage that checks a claim against the repository; the analyst's number
  was the one input in the pipeline with no evidence behind it.
- `RV context` reports whether second-pass verification is configured, and warns
  when the config has no `verification` block at all. Configs written before it
  existed have none, so upgrading users silently got none of it.
- `RV evaluate` separates gates from goals. `median_words_per_finding` asked for
  28 while the contract allows 40, so every compliant review failed a metric it
  had not broken. Findings-per-review counts are now reported without a target:
  they carried caps of 2 and 5 from before the output contract stopped limiting
  findings.
- The candidate schema allows 50 candidates rather than 20, so a large diff is
  not truncated before scoring sees it.
- The `diff-analyst` prompt now carries a severity rubric, because severity was
  not stable between runs on an identical diff and ordering is severity-first.

### Fixed

- A claim whose own evidence says it could not be verified is capped below the
  confidence gate instead of shipping. Observed at confidence 0.8 alongside the
  bullet "the keys' existence cannot be verified here".
- `evidenceQuality` accepted "longer than 40 characters" as specificity, which
  every analyst bullet satisfies, so it scored 1.000 on every candidate and
  contributed a constant to every score. It now requires an actual anchor.
- Novelty is measured against the corpus, not only against the other findings
  in the current review. A candidate that repeats a comment already published
  on that line is rejected and names the precedent it repeats, and that
  precedent no longer raises alignment as well. A finding the owner has already
  made verbatim scored full novelty and was rewarded twice for being a repeat.

### Changed

- Owner events are exempt from the corpus target and the per-repository share
  cap. They are around one percent of what a sync discovers, so newest-first
  selection evicted them first.
- The corpus target and the share cap scale with the allowlist: sixty events
  per repository between 250 and 1500, and twice a fair share between 0.15 and
  0.5. `--target` still overrides.

## [0.3.1] - 2026-09-17

### Fixed

- **`purge` now clears sync watermarks.** It deleted events while leaving the
  record of which pull requests had been read, so the next sync skipped them
  all as unchanged and rebuilt nothing. A purge followed by a sync returned
  whatever had been updated since rather than the corpus: 1,057 eligible events
  became 527, and one allowlisted repository contributed none at all.
- **One repository can no longer take the corpus.** Backfill past the soft
  share cap is now bounded at 1.5x it, and the resulting shortfall is reported
  as a diversity limit rather than an exhausted corpus. Those are different
  problems with different fixes, and conflating them sent the wrong signal.
- **Reviews this tool produced are excluded from ingestion.** Output posted to
  GitHub and read back becomes owner evidence and teaches the reviewer its own
  voice - a closed loop that compounds every sync. A quarter of the owner
  precedent in one real corpus was the previous run's output.
- Unanchored evidence is weighted far lower. Ten of twelve owner events in a
  real corpus were summaries with no file anchor, and with the owner multiplier
  applied those same ten documents surfaced for every candidate regardless of
  topic. An anchored comment is now five times an unanchored one, not 1.7.

### Added

- `status` reports per-repository counts and warns on an unhealthy corpus: an
  allowlisted repository contributing nothing, one repository above its share,
  or owner evidence that is mostly unanchored.

## [0.3.0] - 2026-09-17

### Changed

- Documentation brought in line with 0.2.0's contract: the README, plugin
  README, `docs/POLICY-FORMAT.md` and `templates/config.example.yaml` no longer
  describe a five-finding cap or a flat 180-word budget.
- `docs/PLAN.md` is marked delivered and records where reality diverged -
  notably the repository going public at 0.1.0 rather than v1.0.0.
- ADR 0001 no longer claims the evaluation harness measures precedent recall.
  It does not, and knowing a relevant precedent was missed requires labelled
  retrieval data nobody has produced.

### Changed

- **The finding separator is a plain hyphen, not an em dash**, and em and en
  dashes are rejected anywhere in a finding. They read as machine-written, and
  banning the character is simpler to enforce than asking for restraint. Swept
  out of source comments, agent prompts, commands, templates, fixtures and
  documentation, with an identity-guard rule to stop them returning.

### Fixed

- **Scoring was inert, not merely wrong.** `schemas/candidate.schema.json`
  publishes snake_case (`candidate_id`, `technical_confidence`) while the
  scorer read camelCase, so every field arrived undefined. The arithmetic
  yielded `NaN`, every comparison against `NaN` is false, and both thresholds
  therefore passed - every candidate came back `eligible: true` with a null
  score. Candidates are now normalised from either casing, a non-finite score
  is rejected explicitly rather than left to a comparison, and a candidate that
  cannot be scored is refused outright.
- `score` now returns each eligible candidate with its path, line, severity and
  category, so survivors can be carried forward without rejoining by hand.
- Bare approval summaries no longer enter the corpus. Approval language is
  stripped before judging whether anything substantive remains, so "Approving."
  is excluded while "Approving. One thing though - …" is kept.
- Precedent weights are scaled by how well each precedent actually matched.
  Summing raw weights let a marginal hit count as much as a strong one.
- `commands/review.md` no longer contradicts itself on capping: it reports
  everything when the resolved policy sets no cap, and respects a configured
  one when it does.

### Added

- `review-voice diff --out <dir>`: writes `diff.patch` and `files.json`
  separately instead of one blob with the whole unified diff inline.
- Per-file `additions` and `deletions` on every changed file, so the size of a
  change is answerable from the tool's own output.
- `evidence` always returns a flattened `signals` array, empty when collection
  is off.
- `review-voice verify`: an optional second verification pass run by a command
  you configure, intended for a **different model** from the one that generated
  the findings. A confident rejection drops a finding, an unsure one downgrades
  it, a verifier that could not run changes nothing, and a verifier may weaken
  a severity but never strengthen one. Every verdict is recorded and `explain`
  lists what was suppressed.

### Removed

- Dead `loadEtags` / `saveEtags` helpers, which read a table migration v6 drops
  - two exported functions that would have thrown on call.

## [0.2.1] - 2026-09-17

### Fixed

- **A dry run no longer starves the sync that follows it.** The dry run
  populated an HTTP conditional-request cache without storing anything, so the
  real sync received `304`s and imported almost nothing - one report projected
  250 events and stored 6. Since the consent flow asks the user to approve a
  sync on the strength of the dry-run figures, this made that approval
  meaningless.
- Conditional requests are removed entirely. The collector re-derives
  everything from each response body and never kept one, so a `304` was a lie -
  and an empty `304` page with no `Link` header silently truncated pagination
  at whichever page happened to be unchanged.
- Incremental sync now works at the pull-request level, comparing GitHub's
  `updated_at` against a watermark recorded **after** the events were stored.

### Added

- `status` reports corpus composition by reviewer role, and warns when a corpus
  contains no owner events - without at least one, no policy rule can ever
  activate, and the failure was otherwise silent.

## [0.2.0] - 2026-09-17

### Changed

- **The finding count cap is gone.** Volume is bounded by the total word budget
  alone. A count cap and a word budget do the same job, and the count is the
  worse of the two: on tight findings it discarded findings the budget would
  have allowed. A policy layer may still impose a cap.
- **The total word budget scales with the change**, from a floor of 600 words
  rather than 180. At 40 words a finding the old floor allowed four and a half
  - the count cap returning through the back door on small changes. The budget
  is now a runaway guard rather than a trim target, and says so when it binds.
- **Two new severity tiers: `nit` and `question`.** Low-stakes observations and
  open asks now have a structural home instead of being suppressed or written
  into prose where they cannot be sorted or counted.
- **Findings must be ordered by severity**, checked by the validator. Ordering
  is what protects the reader, not omission: a reader who stops early has seen
  the most serious findings.
- **`nit`, `overall` and `summary` are no longer forbidden phrases.** `nit` is a
  severity marker that adds information rather than hiding a claim; the other
  two appear in real prose that word-boundary matching cannot distinguish from
  a summary section. True hedges and praise remain banned.

### Added

- `review-voice diff --pr <number>`: reviews a GitHub pull request through the
  read-only client, inferring the repository from the origin remote. Naming a
  pull request is the consent for reading it, so no allowlist entry is needed.
- Pull request acquisition reads up to GitHub's own 3000-file ceiling instead
  of 300, applies the cap above classification rather than below it, and
  reports `truncated` with an explicit note when files could not be read.
- Score breakdowns carry the location they came from, so `explain` matches a
  score to its finding rather than showing every finding the first one's
  numbers.
- `review-voice explain`: reports the category, confidence, score and precedent
  ids recorded for each finding, and says "not recorded" rather than
  reconstructing a rationale.
- Incremental polling sync: ETags persist between runs, so an unchanged
  repository costs almost nothing against the rate limit. No webhook receiver,
  per ADR 0002.
- `review-voice draft`: renders a validated review as a GitHub draft, from the
  same payload that would be sent. Posts nothing.
- `review-voice post-check`: reports whether posting is permitted, reading
  measured precision rather than configuration. No override.
- Policy rules are compiled by finding category rather than file path, and
  `record --candidates` carries each finding's category from the candidate that
  produced it. Going both ways on one category now registers as a contradiction
  and blocks the rule.
- `review-voice evaluate`: reports the specification's metrics against their
  targets, each with the basis it was computed from. A metric with no data
  reports "no data" rather than a flattering default.
- `review-voice score`: the specification's eligibility formula, computed
  deterministically - technical confidence, owner and repository alignment from
  weighted precedent, evidence quality and novelty against already-kept
  findings.
- `review-voice calibrate` and `policy show|approve|rollback`: feedback is
  compiled into proposed rules that are stored inactive, gated on three
  corroborating signals including an owner signal with nothing contradicting,
  and activated only on explicit approval. Versions are retained so rollback is
  possible, and rollback refuses a version that was never approved.
- `review-voice retrieve`: FTS5 lexical precedent retrieval with owner-weighted
  scoring, 180-day recency decay, specificity and context weighting, and
  separate caps for positive and negative precedents. The index is kept in step
  with the corpus by triggers, so purged events stop being retrievable.
- Consent flow: `review-voice discover` lists reachable repositories without
  reading any history, and `consent-plan` states exactly what a sync would
  read, where it is stored and what is discarded, before anything is read.
  `commands/init.md` gates every step on an explicit yes.
- `review-voice purge`: previews before deleting and requires `--confirm`.
  The audit entry recording a purge survives it.
- Ingestion now collects submitted review summaries as well as inline
  comments, and pull-request conversation comments behind
  `--include-conversation`. Template detection measures the proportion of
  structural lines rather than the presence of a checkbox.
- `review-voice sync`: ingests review history from allowlisted repositories.
  Comments are redacted at the download boundary, classified by reviewer role,
  filtered for review judgement, deduplicated across rebases, and selected
  newest-first under a per-repository share cap. Shortfalls are reported
  exactly rather than presented as a full scan. `--dry-run` reports what would
  be imported without storing anything.
- Corpus schema with no column for original comment text.
- Read-only GitHub client. Non-GET requests and repositories outside the
  allowlist are refused in code before any network call, with rate-limit
  backoff and bounded pagination. Credentials are borrowed from `gh` and never
  stored.
- Reviewer role classification: owner, team, external or bot. Bot output is
  excluded from voice learning regardless of the bot's permissions.
- Redaction pipeline covering private keys, PEM blocks, GitHub, AWS, Google,
  Slack, Stripe, npm, PyPI, OpenAI and Anthropic credentials, JWTs, database
  connection credentials, authorization headers and assignment-shaped secrets.
  Placeholders such as `changeme` are left alone. Content hashes are recorded
  before and after so a redaction is auditable without retaining the secret.
- Fixture suite covering all four classes from the specification, with a test
  asserting fixtures stay synthetic - no real addresses, hosts or credentials.
- Prompt-injection fixtures across three vectors: a source comment,
  pull-request text, and content imitating static-analysis output. Each asserts
  an absence, since a positive assertion cannot prove an injection failed.
- `claude plugin eval` suites for restraint and injection resistance.
- `review-voice evidence`: runs the static checks declared in configuration -
  and only those - with per-command timeouts, and parses TypeScript, .NET,
  Python and ESLint diagnostics into attributable signals.
- `review-voice context`: resolves `.review-voice/config.yaml`, the policy
  layer stack and opt-in static-evidence commands. A narrower layer may tighten
  a limit but never loosen it, and a committed `.review-voice/policy.yaml` is
  surfaced as a proposal requiring approval rather than applied.
- Local SQLite store under the platform data directory, with schema
  migrations, `0700`/`0600` permissions and an append-only audit trail.
- `review-voice record`, `feedback` and `status`: review runs are stored with
  positional finding ids (`rv_01`), feedback is captured as explicit evidence,
  and owner precision is computed excluding unlabelled findings.
- `review-voice diff`: structured diff acquisition for the working tree,
  the index (`--staged`) or a base ref (`--base`), with file classification,
  language detection, explained exclusions and untracked-file support.
- `commands/review.md` now drives the real pipeline: diff acquisition, the
  candidate and verifier agents, ranking, the concise editor, and a hard
  validation gate with a single retry.
- `review-voice validate-output`: the hard gate enforcing the output contract -
  at most five findings, 40 words each, 180 words total, exact no-findings
  response, required format, no hedging, no duplicate locations, no greetings
  or summaries. Reports all violations in one pass to drive a single retry.
- OSSF Scorecard workflow publishing a supply-chain posture score to the
  security tab.
- Repository skeleton: marketplace manifest, plugin manifest, command and agent
  definitions, JSON schemas, baseline policy, configuration templates.
- Bundled zero-dependency CLI with `doctor`, `--version` and `--help`.
- Build pipeline with a committed-artifact drift check.
- Identity guard preventing personal logins or private repository names from
  entering source, docs or fixtures.
- CI: typecheck, unit tests, bundle drift, plugin manifest validation, secret
  scanning, identity guard, action-pin check, and a Conventional Commits check
  on pull request titles, gated behind a single `ci-green` status check.
- Supply-chain hardening: all GitHub Actions pinned to commit SHAs with an
  enforcing check, least-privilege workflow permissions, `persist-credentials:
  false` on checkout, fork pull requests excluded from secret-holding jobs, and
  a release guard rejecting tags not on `main`.
- Architecture decision records closing the eight open decisions from the
  specification, all approved 2026-09-16.
- Branch and tag protection on `main` and `review-voice--v*`, required SSH
  commit signatures, GitHub secret scanning with push protection, private
  vulnerability reporting, and the repository security posture documented in
  `docs/REPO-SECURITY.md`.

[1.3.1]: https://github.com/QuintinBotes/review-voice/commits/main
[1.3.0]: https://github.com/QuintinBotes/review-voice/releases/tag/review-voice--v1.3.0
[1.2.1]: https://github.com/QuintinBotes/review-voice/releases/tag/review-voice--v1.2.1
[1.2.0]: https://github.com/QuintinBotes/review-voice/releases/tag/review-voice--v1.2.0
[1.1.1]: https://github.com/QuintinBotes/review-voice/releases/tag/review-voice--v1.1.1
[1.1.0]: https://github.com/QuintinBotes/review-voice/releases/tag/review-voice--v1.1.0
[1.0.0]: https://github.com/QuintinBotes/review-voice/releases/tag/review-voice--v1.0.0
