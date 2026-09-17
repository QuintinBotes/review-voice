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
| Candidate generation | `diff-analyst` | genuine judgment |
| Evidence verification | `evidence-verifier` | genuine judgment |
| Precedent retrieval | CLI | an index query |
| Preference scoring | CLI | **arithmetic — never ask a model to do this** |
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
Claude Code command  (commands/review.md — orchestration)
  ├── CLI    (dist/review-voice.mjs — deterministic stages, storage, audit)
  └── Agents (agents/*.md — candidate generation, verification, editing)
```

### The CLI

TypeScript in `plugins/review-voice/src/`, bundled by esbuild into a single
committed `dist/review-voice.mjs`.

**Zero runtime dependencies.** Plugins install by git clone with no install
step, so users must never run `npm install`. Third-party packages are
devDependencies inlined at build time. JSON Schema validation uses Ajv
standalone codegen, so schemas compile to plain functions with no runtime Ajv.

Storage is Node's built-in `node:sqlite` — no native modules. It is experimental
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
reaching a single source file — reviewing the wrong part of the change, and
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
tight findings the count discards ones the budget would have allowed — pure
loss, for no gain.

Volume is now bounded by the word budget alone, and that budget scales with the
size of the change. What protects the reader is **ordering**: blocking,
important, minor, nit, question. A reader who stops halfway has seen everything
more serious than where they stopped, so nothing needs to be dropped to keep
the top of the list useful. The validator checks the ordering.

`nit` and `question` are tiers rather than banned words. Writing "Nit:" into
prose says the same thing but cannot be sorted, counted, or suppressed by
category — the label carries information the prose only implies.

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
explanation budget than one at the repository root — punishing the finding
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
progressively louder — which is the failure mode this product exists to avoid.

An owner comment whose outcome is unknown still carries real weight. It is
owner judgement; the fact that nobody recorded what happened next does not
unmake it.

Retrieval indexes redacted text only, and triggers keep the index in step with
the corpus — an index left behind after a purge would keep surfacing evidence
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

Ids are positional — `rv_01` is the first finding displayed — and are assigned
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
script. Unrecognised output produces no signals rather than guessed ones — the
exit code is still evidence.

A check that did not run is reported as such. The reviewer must never imply a
check passed when it never executed.

### Scoring and activation

The eligibility formula is arithmetic and lives in the CLI. Asking a model to
compute it would make the thresholds unfalsifiable, and the point of a
threshold is that it can be checked.

Novelty is measured against findings already kept in this review, not against
all candidates — two findings about one root cause spend two-fifths of the
budget saying one thing. Evidence quality rewards specificity rather than
volume: three vague observations are not better evidence than one naming a line.

A negative precedent lowers a candidate's score but cannot refute a verified
defect. Precedent adjusts preference; it never manufactures or unmakes truth.

Rules are compiled by finding **category**, not by file path. "Suppress
maintainability findings unless they name a concrete failure mode" is a rule;
"suppress things like the ones in src/a.ts" is an observation about wherever
you happened to be working that week.

Category cannot be recovered from the rendered output — the contract permits no
text beyond the finding — so it arrives alongside, via `record --candidates`.
Feedback recorded without it still counts toward precision but cannot become a
rule. Inventing a category from the wording would be manufacturing evidence.

A proposed rule is stored **inactive**. Generation and activation are separate
operations by construction rather than by discipline. Activation requires three
corroborating signals including at least one from the owner, with nothing from
the owner contradicting — and approval refuses any rule that has not met that
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
pass technical verification even when history favours it — precedent adjusts
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
carries whatever scopes the user already had — almost always broader than
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
so a `304` — "you already have this" — was false. And an empty `304` page
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
summaries, and — behind a flag — pull-request conversation comments. Measured
against a real repository, review summaries outnumbered inline comments
roughly two to one and some pull requests had no inline comments at all, so
collecting only inline comments captured a minority of the evidence.

Eligibility asks "does this carry review judgement", not "is this a comment". A
corpus padded with LGTMs and pull-request checklists teaches nothing while
making every retrieval noisier. Bot output is excluded outright — it would
teach the reviewer to sound like a linter.

Template detection measures the *proportion* of structural lines rather than
the presence of one. The earlier rule discarded fourteen review summaries with
a median length of 2,400 characters and structure ratios between 0.18 and 0.30
— substantive reviews that happened to contain a checklist.

Identity is content plus location, not the GitHub comment id. A rebase
resurfaces the same comment under a new id, and the same words at a different
line are different evidence.

Selection is newest-first under a per-repository share cap, so one busy
repository cannot define the global policy. The cap is relaxed rather than
under-filling the corpus: a smaller corpus is a worse outcome than a slightly
lopsided one. Shortfalls are reported exactly — claiming a full scan when the
history ran out would misrepresent how much the policy rests on.

### Posting

ADR 0007 gates posting on measured quality. `evaluatePostingGate` reads what
was actually measured — precision at 0.80 or better over at least 20 labelled
findings, with full contract compliance — rather than a configuration flag. A
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
