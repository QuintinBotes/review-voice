# Architecture

## The one decision everything else follows from

The specification describes a ten-stage review pipeline but does not say which
stages are deterministic. That is the load-bearing call, because it decides what
is testable, what costs tokens, and what can run in CI.

**Deterministic work lives in the bundled CLI. Judgment lives in Claude Code
agents. A command file orchestrates them.**

| Stage | Owner | Why |
|---|---|---|
| Diff acquisition | CLI | git plumbing |
| Context resolution | CLI | config and policy layering is pure logic |
| Static evidence collection | CLI | runs configured tools, emits JSON |
| Convention discovery | CLI | which files exist is a fact |
| Candidate generation | `diff-analyst` | genuine judgment |
| Evidence verification | `evidence-verifier` | genuine judgment |
| Precedent retrieval | CLI | an index query |
| Preference scoring | CLI | **arithmetic - never ask a model to do this** |
| Dedup and ranking | CLI | deterministic |
| Concise editing | `concise-editor` | wording |
| Schema and style validation | CLI | **this is what enforces the limits** |

### Why this matters in practice

The specification sets targets of 100% word-limit compliance and 100% exact
no-findings compliance. Those are unreachable if a prompt is the only thing
holding the line, and trivial if a validator rejects non-compliant output and
forces a re-edit. The output contract is code.

A second consequence: the plugin needs no API key. It runs inside the user's
existing Claude Code session.

## Components

```
Claude Code command  (commands/review.md - orchestration)
  ├── CLI    (dist/review-voice.mjs - deterministic stages, storage, audit)
  └── Agents (agents/*.md - candidate generation, verification, editing)
```

### The CLI

TypeScript in `plugins/review-voice/src/`, bundled by esbuild into a single
committed `dist/review-voice.mjs`.

**Zero runtime dependencies.** Plugins install by git clone with no install
step, so users must never run `npm install`. Third-party packages are
devDependencies inlined at build time. JSON Schema validation uses Ajv
standalone codegen, so schemas compile to plain functions with no runtime Ajv.

Storage is Node's built-in `node:sqlite` - no native modules. It is experimental
on Node 22 and stable on Node 24; the experimental warning is filtered at
startup because it concerns a dependency choice the user never made.

The committed bundle is a real risk: it can drift from source. CI rebuilds and
diffs on every push, so a stale bundle cannot ship.

### Diff acquisition

`review-voice diff` emits the change under review as JSON: base and head, every
changed file with its status, language and classification, and a unified diff
restricted to the files worth reviewing.

Two decisions are worth stating.

**Untracked files are included.** `git diff` does not show them, but a
brand-new file is exactly where defects hide. They are diffed against
`/dev/null` rather than staged with `git add -N`, because Review Voice is
read-only and that includes the user's index.

**A truncated read says so.** Pull requests are fetched up to GitHub's own
3000-file ceiling, and the count is compared against the `changed_files` the
API reports. Reviewing part of a change and presenting it as the whole is the
one failure a reviewer cannot recover from, because nothing downstream can tell
that anything is missing.

The cap sits *above* classification, not below it. Applying it first meant a
pull request that is mostly generated code could exhaust the budget before
reaching a single source file - reviewing the wrong part of the change, and
saying nothing about it.

**Every exclusion carries a reason.** Lock files, generated output, vendored
code and binaries are dropped by default, and each one reports why. A silent
omission is indistinguishable from a bug, and `--include-generated` brings them
back for the case where the dependency change *is* the review.

### Retrieval

No embedding model ships with the plugin. A downloaded model would break
zero-install; a remote one would break the local-only default.

Default retrieval is SQLite FTS5 lexical matching plus structural filters
(category, repository, path glob, language), ranked by the owner-weighted
scoring in the specification. Offline, deterministic, unit-testable.

The tradeoff is real: lexical retrieval misses paraphrases. An
`EmbeddingProvider` interface exists so a provider can be swapped in if the
evaluation harness shows precedent recall is the binding constraint. See
[adr/0001-embedding-implementation.md](adr/0001-embedding-implementation.md).

### Recall with triage, not omission

The contract originally capped a review at five findings. Real use showed that
was the wrong mechanism: a count cap and a word budget do the same job, and on
tight findings the count discards ones the budget would have allowed - pure
loss, for no gain.

Volume is now bounded by the word budget alone, and that budget scales with the
size of the change. What protects the reader is **ordering**: blocking,
important, minor, nit, question. A reader who stops halfway has seen everything
more serious than where they stopped, so nothing needs to be dropped to keep
the top of the list useful. The validator checks the ordering.

`nit` and `question` are tiers rather than banned words. Writing "Nit:" into
prose says the same thing but cannot be sorted, counted, or suppressed by
category - the label carries information the prose only implies.

### The output validator

`review-voice validate-output` reads a rendered review on stdin and exits
non-zero with a structured list of violations. It validates what the user will
actually see, not an intermediate structure, because that is the artifact the
contract is about.

It reports **every** violation in one pass. The validator exists to drive a
retry, and an editor that fixes one problem only to be rejected for the next
burns a round trip per fix.

Word counting measures the prose after the separator. The severity tag and the
`path:line` location are excluded because the editor cannot shorten them, and
counting them would give a finding in a deeply nested directory a smaller
explanation budget than one at the repository root - punishing the finding
rather than the writing.

The no-findings case is compared exactly. Accepting near-misses would make the
"silence is meaningful" guarantee unmeasurable, and it is one of the two
properties the specification asks to hold 100% of the time.

Exit codes distinguish a failed review (1) from a bad invocation (2), so a
caller never mistakes a broken pipeline for a non-compliant one.

### Weighting

Evidence weight is base × recency × specificity × context.

Dismissals are negative and at least as strong as keeps: being told not to say
something is a clearer instruction than being told a comment was fine, and
suppression should be easier to learn than propensity.

The owner multiplier applies to magnitude, so a dismissal is amplified exactly
as much as a keep. Amplifying only the positives would make the reviewer
progressively louder - which is the failure mode this product exists to avoid.

An owner comment whose outcome is unknown still carries real weight. It is
owner judgement; the fact that nobody recorded what happened next does not
unmake it.

Retrieval indexes redacted text only, and triggers keep the index in step with
the corpus - an index left behind after a purge would keep surfacing evidence
the user deleted.

### Storage layout

Outside the repository, in the platform data directory:

```
review-voice.db      normalised redacted events, feedback, policies, runs, audit
embeddings/          retrieval index
policies/            versioned artifacts, plus archived/
audit/events.jsonl   append-only local audit log
exports/             explicit exports only
```

### Finding identifiers

Ids are positional - `rv_01` is the first finding displayed - and are assigned
when a review is recorded, not printed alongside the findings. The output
contract permits no text beyond the findings themselves, and a visible id would
spend characters the writing needs more. `review-voice status` lists the ids of
the last review when someone needs them.

### Static evidence

Commands run only when declared in `.review-voice/config.yaml` and
`enabled: true`. Detection may suggest; configuration enables. Auto-running a
project script would be arbitrary code execution in a repository the tool
otherwise treats as untrusted.

Adapters are parsers, not runners: they map TypeScript, .NET, Python and ESLint
diagnostics onto signals carrying the verbatim tool output, so a claim stays
attributable. The adapter is chosen from the user's own name for the check as
well as the command, because real projects point a named check at a wrapper
script. Unrecognised output produces no signals rather than guessed ones - the
exit code is still evidence.

A check that did not run is reported as such. The reviewer must never imply a
check passed when it never executed.

### Severity is derived, not requested

Ordering is severity-first, so an unstable tier moves a finding up and down the
page between identical reviews. Asking for one produced `minor` at confidence
0.90 and `important` at 0.85 for the same finding on a byte-identical diff: the
evidence barely moved and the tier jumped.

`score` derives it from the category alone. Blast radius is a property of the
kind of defect rather than of how the reviewer felt about it on the day, and the
requested severity is recorded beside the derived one so a divergence can be
audited.

Confidence deliberately plays no part. A first version weakened one tier below
0.85, and that turned out to be the whole remaining instability: on two runs of
an identical diff the category matched both times and the tier differed anyway,
at 0.82 against 0.90 and at 0.85 against 0.80. Everything that can ship already
sits in `[0.8, 1.0]` because the confidence gate says so, and run to run
variance is around 0.08, so any boundary drawn inside that band gets crossed.
One free judgement had been removed from this path and a second left in with a
hard edge in the middle of it.

The tiers are a step quieter than a first reading suggests, which is what pays
for dropping the weakening: `correctness` and `user_visible_behavior` carry
`minor`, not `important`. Reach depends on circumstances the scorer cannot see,
and the quieter tier is the right default for a reviewer whose purpose is not to
overstate. The wording carries the consequence either way.

A missing category is not defaulted. It used to become `correctness` before the
derivation saw it, which gave an unlabelled finding a real tier and recorded
nothing about the substitution; absent and unrecognised now both take the middle
tier and say so.

Because the tier rests entirely on this field, the analyst prompt lists the
twenty-two valid categories and settles the confusable pairs, which it did not
before: the prompt only referenced the schema, and the schema only reached it
through a `$ref`. On one pull request half the findings used `testing` and
`documentation`, plausible words outside the enum, and both took the fallback.

A short alias table catches the rest. It lists unambiguous synonyms only. An
alias into a `blocking` tier is the riskiest kind, so a genuinely ambiguous word
is left to the middle-tier fallback rather than guessed at, and any substitution
is named in the reason string.

What remains of RV-08 is category drift: the tier is stable given the category,
and the category is a judgement that can still move. The same comment was
`maintainability` on one run and `correctness` on the next, which is one tier
apart. That is a narrower problem than the one this replaced, and a category is
easier to argue about than a severity.

`question` is preserved rather than derived. It says the reviewer could not
establish the answer and the author can, which is a kind of finding rather than
a level of consequence, and no category implies it.

### Claims of absence

"X does not exist" is the cheapest claim in a review to check and the most
damaging to get wrong, because the fix proposed on top of it tells the author
to break working code. On one pull request the analyst asserted at confidence
0.90, and 0.93 on a re-run, that four files were absent. All four were present.

`score` extracts the symbols such a claim names and runs `git grep` for each,
against the ref passed as `--base`. If the repository contains any of them the
candidate is rejected outright, before alignment or novelty are weighed, and
the breakdown names what was found.

The ref matters more than it looks. A working tree 179 commits behind the pull
request base genuinely lacks the files the base contains, so the first version
of this check reported `found: []` with `inconclusive: false` for two files
that exist, which reads as the guard corroborating the claim rather than
failing to evaluate it. Every result now names the tree that answered, and a
`--base` that does not resolve is an error rather than a silent fallback.

A search that cannot run concludes nothing: a failed search is not evidence of
absence, and certainly not evidence of presence.

The check only contradicts specific assertions. A claim naming nothing
searchable is left alone, because this grades falsehood rather than vagueness.

It reads the claim and never the failure mode. The two were concatenated, which
handed the sentence explaining the consequence a vote on whether the assertion
was scoped: the same invented claim was checked or ignored depending on how its
impact was worded, and a symbol named in the mechanism could be reported as one
the claim said was absent.

A claim naming somewhere this repository cannot answer for returns
`inconclusive: true`. "Absent from the localisation catalogue" is a true and
useful finding about a sibling repository, and `git grep` here speaks only for
this one. Answering anyway gave the worst outcome available: at the base ref it
returned `found: []`, which reads as corroboration, and at the head ref it found
the symbol the diff itself adds and deleted the finding with a sentence that was
false about the claim.

### Whose confidence the gate reads

Eligibility used to be gated on `technical_confidence`, a number the analyst
writes about its own output and the one input in the pipeline with no evidence
behind it. In a real run both rejections read "technical confidence 0.75 is
below 0.8" on candidates the `evidence-verifier` had just rated high, and the
precedent-derived signals rejected nothing at all. An analyst returning 0.9 on
everything would have faced no gate.

The verifier is the only stage that checks a claim against the repository, so
its confidence supersedes the analyst's and the breakdown records which was
used. Verification is no longer a stage that costs a full agent run and then
changes nothing but which candidates arrive.

Two things cap that confidence below every default gate, whatever either stage
claims: context the verifier needed and could not obtain, and an admission in
the candidate's own evidence that the claim could not be checked. The second
was observed verbatim - "No local key catalogue exists in the repo, so the
keys' existence cannot be verified here", filed at 0.8 - and is exactly how a
review comment ends up retracted.

`evidenceQuality` scored specificity as "names a line **or** is longer than 40
characters". Analyst evidence is always longer than 40 characters, so the term
returned 1.000 for every candidate in that run: fifteen percent of the score
carrying no information. Specificity now requires an actual anchor.

### Reporting an empty corpus

`lastSync` only ever returns finished runs, so a sync that began and died left
the same `corpus 0 event(s)` as one that never ran, and only a hand-written
query told them apart. They need different actions, so `status` names an
unfinished run, which repositories it covered, and that nothing it read was
stored.

A run started within the last half hour is reported as neither dead nor
complete. A sync in flight writes exactly the same row as one that crashed, and
a recent start is not yet evidence of anything.

### Repository conventions

`RV conventions` collects the repository's own `CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md` and `.claude/skills/*/SKILL.md`, and both the analyst and the
verifier receive them.

Precedent cannot reach this. Retrieval learns what the owner values from the
comments they wrote, and the better a convention is observed the fewer comments
it generates, so the rules a team has genuinely internalised leave the least
evidence behind. A documented rule is also stronger ground for a finding than
an inferred preference, because the author had it available.

Rule and skill directories are searched at the root and in every directory the
diff touches, because a monorepo keeps a package's rules beside the package.
Selection is ordered by relevance before the budget applies: directory-scoped
files nearest the change, then rules from the touched subtrees, then the
repository files, then root rules whose own name appears in the changed paths,
and only then the rest. Ordering alphabetically instead sent
`add-image-asset` and `build-form` to every review and cut the one document the
change was actually about. Each document reports the `reason` it was selected.

The trust boundary does not move. These documents are supplied as evidence
about the repository, never as instructions to the reviewer, and both agent
prompts say so. Text addressed to a reviewer rather than describing the code
raises a warning and the document is still returned: dropping it would hide the
attempt from the person running the review, which is the one outcome worse than
showing it.

They are also not more authoritative than the code. A skill document asserted
that a missing localisation key renders the raw key, when the provider supplies
a humanised default, and the analyst repeated that claim for four consecutive
runs. Both prompts now say source wins a factual conflict, and the verifier
resolves it correctly once told the documents are fallible.

Selection ranks on the globs a document declares. A repository that writes
`paths: ["**/*.tsx"]` in a rule's frontmatter is saying when the rule applies,
which is a better signal than how close the file sits: ranking by proximity
alone sent a 14 KB semaphore guide and a 9.6 KB routing guide to a pull request
with neither, while every rule whose glob matched the changed files was dropped
for budget. A stub whose whole content is `@.agents/rules/routing.md` is
followed to the document that holds the rule, rather than spending budget to
say where it lives.

The budget buys information rather than bytes. Ranking by proximity alone let
four large skill documents take 96% of it, truncating a 29 KB page guide into a
review of something else while all 32 rule files were dropped, one of them 553
bytes and decisive. Within a relevance tier the short documents are read first,
and no single document may take more than a quarter of the budget. Proximity
still decides among directory-scoped files, where closeness is the whole
signal.

### Second-pass verification

The built-in `evidence-verifier` is a Claude subagent checking a Claude
subagent's findings, which shares the analyst's blind spots: asked whether a
plausible-sounding defect is real, a same-family verifier agrees more often
than it should. Breaking that correlated error needs a different model.

So there is an optional second pass, configured like static-evidence commands:

```yaml
# .review-voice/config.yaml
verification:
  enabled: true
  name: codex
  command: codex exec -s read-only
  timeout_seconds: 90
  # A rejection at or above this confidence drops the finding. Below it, the
  # finding is downgraded instead: an unsure verifier should not be able to
  # delete evidence.
  drop_threshold: 0.8
```

The command reads one finding as JSON on stdin and writes a verdict to stdout,
read-only. A verifier that cannot run never confirms a finding, and verification
may only weaken a severity, never raise one.

It is opt-in, and a config written before it existed has no block for it at all,
so `RV context` reports whether yours does.

a command that receives one finding as JSON and returns a verdict. Off by
default, because requiring an external binary would break the zero-install
promise for everyone who does not have one.

Three rules keep it from becoming a worse version of the problem it solves:

- **A confident rejection drops; an unsure one downgrades.** An unsure verifier
  should not be able to delete evidence.
- **A verifier may weaken a severity, never strengthen one.** Its job is to
  doubt, not to escalate.
- **A verifier that could not run has not agreed.** Missing or unparseable
  output leaves the finding exactly as it was, and is reported as `didNotRun`.

Every verdict is recorded, including the ones that change nothing, and
`explain` lists what was suppressed and why. A verifier that silently deletes
findings is the finding cap in a different coat - the failure has to be
visible, or a bad verifier is indistinguishable from a clean diff.

### Scoring and activation

The eligibility formula is arithmetic and lives in the CLI. Asking a model to
compute it would make the thresholds unfalsifiable, and the point of a
threshold is that it can be checked.

Novelty is measured against findings already kept in this review, not against
all candidates - two findings about one root cause spend two-fifths of the
budget saying one thing. Evidence quality rewards specificity rather than
volume: three vague observations are not better evidence than one naming a line.

A negative precedent lowers a candidate's score but cannot refute a verified
defect. Precedent adjusts preference; it never manufactures or unmakes truth.

Rules are compiled by finding **category**, not by file path. "Suppress
maintainability findings unless they name a concrete failure mode" is a rule;
"suppress things like the ones in src/a.ts" is an observation about wherever
you happened to be working that week.

Category cannot be recovered from the rendered output - the contract permits no
text beyond the finding - so it arrives alongside, via `record --candidates`.
Feedback recorded without it still counts toward precision but cannot become a
rule. Inventing a category from the wording would be manufacturing evidence.

A proposed rule is stored **inactive**. Generation and activation are separate
operations by construction rather than by discipline. Activation requires three
corroborating signals including at least one from the owner, with nothing from
the owner contradicting - and approval refuses any rule that has not met that
bar, because approving anyway would make the bar decorative.

Old versions are retained rather than overwritten: rollback is only possible if
the thing being rolled back to still exists, and rollback refuses a version
that was never approved, since activating something nobody agreed to is worse
than refusing.

## Policy resolution

```
global → repository → path → language → current session
```

An explicit session instruction wins. An explicit narrow rule beats an inferred
broad one. A suppression beats a propensity to flag. And a candidate must still
pass technical verification even when history favours it - precedent adjusts
preference, it never manufactures truth.

### Layer resolution in practice

A narrower layer may **tighten** a limit but never loosen one. A repository
cannot grant itself a bigger finding budget than the product promises, or the
promise means nothing. Suppressions and forbidden phrases accumulate: a
narrower layer can add something not to say, never license something a broader
layer banned.

`.review-voice/config.yaml` is the user's own file in their own checkout and is
trusted. `.review-voice/policy.yaml` is repository content and is not: it is
parsed, hashed and reported as pending approval, never applied. Editing an
approved file changes its hash and re-proposes it, so a quiet edit cannot
inherit an old approval.

### The GitHub client

Two constraints are enforced in the client rather than documented, because v1
promises both and a promise a caller can bypass is not a promise: only GET
requests are issued, and only allowlisted repositories are addressed. Both
throw before any network call, and both are tested.

The allowlist matters more than it looks. The credential comes from `gh` and
carries whatever scopes the user already had - almost always broader than
Review Voice needs. So the allowlist, not the token, is what actually bounds
access.

Rate limiting is retried with backoff; a 403 that is *not* rate limiting fails
immediately, because retrying a permissions error only burns the user's quota.
Pagination is bounded so a large repository cannot run away with the budget.

### Reviewer roles

Owner, team, external, bot. The owner is whoever is running the plugin,
resolved at init and never hardcoded. Teammates are recognised from GitHub's
author association, since OWNER, MEMBER and COLLABORATOR are the people with
standing in a project; drive-by contributors are external and cannot establish
global rules.

A bot is a bot even when it is also a collaborator: automated output would
teach the reviewer to sound like a linter, so it is excluded from voice
learning regardless of permissions.

### Incremental sync

Sync is incremental at the **pull request** level, not the HTTP level. GitHub's
`updated_at` is compared against a watermark recorded after the events from
that pull request were stored.

An earlier design used HTTP conditional requests, and it was wrong twice over.
The collector re-derives everything from each response body and never kept one,
so a `304` - "you already have this" - was false. And an empty `304` page
carries no `Link` header, which silently truncated pagination at whichever page
happened to be unchanged.

Worse, a dry run populated that cache while storing nothing, so the real sync
that followed received `304`s and imported almost nothing: one report projected
250 events and stored 6. Because the consent flow asks the user to approve a
sync on the strength of the dry-run figures, that made the approval meaningless.

Watermarks are therefore written only after the events are stored, and a dry
run writes no state at all.

### Corpus ingestion

Redaction happens in the collector, before an event is returned, so the
original text never exists anywhere a caller could persist it by accident. The
schema reinforces that: there is no column for unredacted text, and a test
asserts there is not.

Three sources are collected: inline review comments, submitted review
summaries, and - behind a flag - pull-request conversation comments. Measured
against a real repository, review summaries outnumbered inline comments
roughly two to one and some pull requests had no inline comments at all, so
collecting only inline comments captured a minority of the evidence.

Eligibility asks "does this carry review judgement", not "is this a comment". A
corpus padded with LGTMs and pull-request checklists teaches nothing while
making every retrieval noisier. Bot output is excluded outright - it would
teach the reviewer to sound like a linter.

Template detection measures the *proportion* of structural lines rather than
the presence of one. The earlier rule discarded fourteen review summaries with
a median length of 2,400 characters and structure ratios between 0.18 and 0.30
- substantive reviews that happened to contain a checklist.

Identity is content plus location, not the GitHub comment id. A rebase
resurfaces the same comment under a new id, and the same words at a different
line are different evidence.

Selection is newest-first under a per-repository share cap, so one busy
repository cannot define the global policy. The cap is relaxed rather than
under-filling the corpus: a smaller corpus is a worse outcome than a slightly
lopsided one. Shortfalls are reported exactly - claiming a full scan when the
history ran out would misrepresent how much the policy rests on.

Owner evidence is exempt from both the target and the share cap. It is around
one percent of what a sync discovers, so under newest-first selection a dozen
repositories fill the target inside a fortnight and every older owner comment
is evicted by volume from repositories the owner never reviewed. The scarcest
signal, and the one retrieval weights highest, was the first one recency threw
away.

The target and the cap both scale with the allowlist. A fixed target reads
sixty pull requests per repository and then discards most of what it found; a
fixed half-share stops being a diversity control once a fair share is five
percent. The target is sixty events per repository between 250 and 1500, and
the cap is twice a fair share between 0.15 and 0.5.

### Posting

ADR 0007 gates posting on measured quality. `evaluatePostingGate` reads what
was actually measured - precision at 0.80 or better over at least 20 labelled
findings, with full contract compliance - rather than a configuration flag. A
boolean in a config file is a promise the user makes to themselves; this gate
has to hold when they would rather it did not, so it takes no override
argument.

The minimum sample matters as much as the threshold: five keeps and no
dismissals is 100% precision and tells you nothing.

The draft's preview is rendered from the payload that would be sent. A preview
generated separately from what gets posted is a mock-up. The idempotency key
combines repository, pull request and diff hash, so a retry after a timeout
cannot double-post while a re-review after a force-push is correctly a
different post.

The posting call itself is not implemented. The gate has never opened.

## Trust boundary

Everything read from a repository or from GitHub is **untrusted data**: source,
comments, markdown, PR titles and descriptions, issue comments, historical
review comments, fixtures. It is wrapped in delimited data blocks, never
interpreted as instruction, and can never alter tool permissions or workflow
order.

The authoritative inputs are the owner-approved policy and the plugin's own
prompts. Nothing else.

See [THREAT-MODEL.md](THREAT-MODEL.md).
