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
| Stated-intent extraction | `intent-extractor`, quotes checked by CLI | judgment, held to verbatim quotes of the description and, with `review.linked_issues`, of the issues it closes |
| Candidate generation | `diff-analyst` | genuine judgment |
| Evidence verification | `evidence-verifier` | genuine judgment |
| Verifier tie-break | `tie-breaker` | genuine judgment, only on a dispute |
| Independent challenge | `challenger`, verdicts checked by CLI | genuine judgment, blind to the verifier |
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
committed `dist/review-voice.mjs`. The slash commands are `commands/*.md`; the
CLI handlers are `src/cli/*.ts`, one module per command or paired family, and
`src/cli.ts` keeps only the dispatch switch, `main`, `runInProcess` and the
review command.

**Zero runtime dependencies.** Plugins install by git clone with no install
step, so users must never run `npm install`. Third-party packages are
devDependencies inlined at build time. JSON Schema validation uses Ajv
standalone codegen, so schemas compile to plain functions with no runtime Ajv.

Storage is Node's built-in `node:sqlite` - no native modules. It is experimental
on Node 22 and stable on Node 24; the experimental warning is filtered at
startup because it concerns a dependency choice the user never made.

The committed bundle is a real risk: it can drift from source. CI rebuilds and
diffs on every push, so a stale bundle cannot ship.

### Agent runner

`src/agents/` starts one agent per process: `runAgent(spec, prompt, cwd,
addDirs)` runs `claude -p --restricted --strict-mcp-config` in the pull
request's head checkout, with `agents/<name>.md` as the system prompt, the
agent's JSON Schema, and `--add-dir` for each extra directory it may read,
such as base copies of changed files (docs/adr/0021). Agents get read-only
file tools only: `Read`, `Grep` and `Glob`. A `Bash(git:*)` in an agent's
frontmatter serves the interactive host and is dropped here, because git
options can run arbitrary commands and a tool prefix cannot narrow them.
Any other tool is refused before a process starts. So an injected
instruction meets an agent that can read files and do nothing else, and the
runner appends a fixed note to every prompt saying which tools exist.
The schema is passed with `$schema` and `$id` removed and each sibling-file
`$ref` inlined, because claude's validator cannot load either; a `$ref` it
could not follow is refused first. `--safe-mode` keeps CLAUDE.md, skills, commands and agents in the checkout
from loading, the prompt always goes on stdin after the runner's note, and
the child's environment drops GitHub tokens and `REVIEW_VOICE_*` settings.
`runAgents` caps the calls in flight (default 4) and keeps results in input
order. Each call has a timeout (default 10 minutes, at most an hour) and a
32 MiB output cap, either of which kills its whole process group, and
SIGINT or SIGTERM to the CLI kills every live group before it exits. A
SIGKILL cannot be caught, so each claude runs under a small node wrapper that
leads its group and kills it within two seconds of the CLI's pid going away.

`REVIEW_VOICE_FAKE_AGENTS=<dir>` swaps in canned answers from
`<dir>/<name>.<n>.json`, counting calls on disk so separate CLI processes in
one test share the numbering. `review-voice agent` runs a single call, which
is how the runner is exercised on its own.

A configured runner is the seam's second backend (ADR 0021, amended
2026-11-09). `AgentSpec.runner` names a `runners.<family>` block from the
operator's configuration: `codex` or `gemini`, an argv list with `{schema}`,
`{output}` and `{cwd}` replaced and never a shell string. The command backend
in `src/agents/command-cli.ts` runs it under the same watchdog, process group,
timeout and output cap, with the minimal environment of configured commands
plus the block's `env_passthrough`, the agent file's body and
`COMMAND_RUNNER_PREAMBLE` on stdin ahead of the prompt, and the last JSON
object of `{output}` or stdout as the answer. The sandbox is the external CLI's
own, and the preamble states the confinement the configured flags enforce.
`REVIEW_VOICE_NO_COMMANDS=1` fails such a call instead of running it, and the
fake backend records the family and label. `runners:` is read only from
`--config`, an absolute `REVIEW_VOICE_CONFIG` or the Action's `config` input,
never a base commit or a checkout. The source is stated, never inferred from a
path being passed. `loadConfig` takes it beside a path (a path with none is
repository content), and a process that hands a file on through
`REVIEW_VOICE_CONFIG` sets `REVIEW_VOICE_CONFIG_SOURCE` beside it, which the
next loader reads. An absolute `REVIEW_VOICE_CONFIG` with no source beside it is
the operator's own environment. `doctor` reports whether `codex` and `gemini`
are on `PATH` as information only.

### The review driver

`review-voice review --pr <n>` runs a whole review in a clone
(docs/adr/0022). `src/review/stages.ts` is the stage table: prep, carry,
intent, lanes, verify, reproduce, second-pass, tie-break, score, challenge,
edit, record and post, each naming its commands and agents. `src/review/driver.ts` walks it
in order. Every CLI step and every check is the existing command, run in the
same process with its output captured (`runInProcess` in `src/cli.ts`), so the
driver holds no review logic of its own; it moves files between stages and
applies the failure rules. A refused agent output goes back once with the
refusal, and a second refusal stops the run with exit 7 and nothing recorded.
Only failing candidates go back to their lane to re-anchor. A failed intent
call carries on without intent, an unsettled dispute stays unsettled, and a
challenger that fails holds its finding.

Before the static checks when a configured command is about to run, else
before the first agent, the driver adds a detached worktree of the head under the run directory
as the agents' working directory, with hooks, LFS filters, fsmonitor and
submodule recursion turned off so the checkout runs no code from the pull
request. The `evidence` command runs the configured checks in that worktree
(`--cwd`), so the signals describe the tree the analysts read rather than the
caller's checkout, while the configuration that names the commands still comes
from the base commit as the trusted-configuration section describes. The
second-pass `verify` command runs there too (`--cwd`), building the worktree
if no stage before it did, since it judges findings about the head. A
configured command therefore runs on the pull request's files, which is what
ADR 0003 accepts when an owner lists a command and what
`watch.run_repository_commands` keeps opt-in, but not with the reviewer's
environment, as the static evidence section describes. It writes the base version of each changed file to
`base/` and its recent history to `history/<URI-encoded path>.txt`, since
agents get no shell; a write that would clash with another path is skipped
with a note. The worktree is removed on every exit. While a review runs, the
driver owns SIGINT and SIGTERM: it stops every agent through the runner's
`stopAll`, removes the worktree, then exits 130 or 143. Every stage's
input and output stays in the run directory, with each command and its stderr
in `commands.log`, so a stopped run can be continued by hand. The head is read
at the start and again before `record`; a move is exit 3. In `fast` mode a nit
or question skips the challenge, so the driver challenges the rest and puts
those findings back in render order; they stay eligible in the score list the
challenge reads, so a corrected line cannot land on one. The driver reads the
Claude Code version once per run (`claudeBin` with `--version`; any failure is
unknown) and passes it, its `--origin` (`driver` unless `watch` or the Action
said otherwise) and the plan's mode to `record` for the run's provenance. Each
agent call's token count (input plus output, from the envelope's `usage`) is
summed into its stage; a stage whose calls reported none has no `tokens`, never
zero. `src/review/prompts.ts` holds each agent's
prompt and output envelope; a test holds `commands/review.md` to the agents in
the stage table.

In prep, after `thread` and before `plan`, the driver writes `authorship.json`
(`src/review/authorship.ts`, ADR 0034). It keeps the pull request's author
login and type from the same response that names the head, and reads the
`Co-authored-by` trailers of the commits over `base..head` with SAFE_GIT, at
most 500 of them; with no readable base none are read and the evidence says
so. A trailer or a `Bot` author naming a family in the shipped table marks the
change agent-authored by that family, `other` when a bot names none. `plan
--authorship` reads the file, and the plan's `families.challenge` names the
family the challenger runs on, echoing the configured `runners` blocks so the
driver needs no second configuration read. The slash command passes no
authorship; its origin is `interactive` already. Each agent call records its
stage's `family`, `claude` unless a configured runner ran it.

The `reproduce` stage (S16) runs only when the plan turns it on, which is
`thorough` with the `reproduction` block enabled and a runner configured, and
not under `REVIEW_VOICE_NO_COMMANDS=1`. Then the verifier's prompt lists the
runners and asks for a reproduction of each blocking or important finding it
verifies, and after `verify` the driver calls `reproduce --worktree <head>`
through `cli`, so a failing `reproduce` is a note and every finding goes on as
before. It applies each record to the verified candidates
(`applyReproductions`). A reproduction that did not fail, on the first run or
the second, holds its finding as `reproduction-did-not-fail`
(`source: reproduce`), except in a category no suppression may reach
(`SUPPRESSION_EXEMPT_CATEGORIES`, which holds security, authorization,
authentication, data integrity and trust boundary). There a passing test may be
badly written, or code under review may have sensed the sandbox, so the record
is kept and shown to the challenger and in `explain`, the finding is not held,
and a note says so. The hold is not carried to the next head, since the
reproduction runs again there. A record that did not run leaves a note and
changes nothing; a reproduced one changes no score or tier and is evidence the
challenger reads. The driver passes `reproductions.json` to
`challenge --emit-prompts` and to `record` when the stage wrote it, and
`record` keeps each record without its output.

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

### Incremental re-review

A later review of the same pull request may read only the commits added after a
previous completed review. The stored run supplies the earlier `head_ref` and
the time it was recorded; the pull-request thread does not. A thread can be
edited, reordered, or contain comments that never represented a completed
review, while the recorded head is the boundary that was actually read.

The happy path is deliberately smaller than the fallback path. A missing prior
run, unchanged head, truncated file list, unavailable local objects, rewritten
history, a merge, or a range that touches none of the pull request's reviewed
files all produce a full review with a named cause. The implementation can
prove only a simple descendant range is safe; every other shape is cheaper to
read again than to explain away after it omits author work.

A range diff across a merged base or a rebase cannot separate base-branch
updates from the author's changes. When the base commit is readable, the
reviewed head is instead replayed onto the new merge base with
`git merge-tree`, giving what the reviewed pull request would look like had it
branched there, and the head is read against that, over the pull request's
files. Base changes are
on both sides and cancel out; what remains is the author's new commits and any
rewrite of their own code while resolving the merge. A file whose replay
conflicts has only conflict markers to compare with, so it is read between the
reviewed head and the current head, with matching base edits removed. Matching
uses edit content and positions in the shared comparison tree, never overlap
through context lines. An edit is subtracted only when the base's own history
also makes it, so withdrawing reviewed code remains visible. When some part of
the resolution meets no own-diff hunk, the scope note names this two-head
fallback. An inherited base edit that shares a hunk with the author's is taken
out of that hunk, its added lines left as the context they now are. Only an
edit the two sides made to the same or adjacent lines, which the diff records
as one run, is kept whole, and the scope note names the file, because the
author wrote those lines while resolving; a diff that cannot be read hunk by
hunk, such as a mode change or a rename, falls back to a full read with the
file named. An unchanged own-diff
hunk is never substituted for an actual change between the heads. A file the
reviewed head changed that the base now changes the same way drops out of the pull request;
it is listed as `absorbedByBase` and printed after the findings. Without the
base commit, a merge or a rewritten history still falls back.

The resulting scope is written beside the patch and printed after the findings
when it is incremental. In particular, `No actionable findings.` then means no
new issue in the added commits, not that the earlier pull request remains
clear. The visible boundary is what keeps a useful optimization from becoming
an accidental claim about the whole change.

### Changed-symbol context

`review-voice symbols` keeps the distinctive identifiers a hunk adds or
removes, then puts a bounded list of code paths with the same literal name next
to the patch. It gives the analyst and verifier likely consumers to inspect
without asking either agent to remember to find callers.

The evidence is deliberately lexical, not a call graph. A literal match can be
a declaration or an unrelated construct, and unfamiliar languages do not get a
made-up parser; it is a reading hint, never proof of a call site. A failed grep
marks that file inconclusive rather than empty, because a search that did not
answer cannot establish that a changed symbol has no consumers.

Hits are split with the repository's configured `review.human_review.test_paths`
(the default test globs when none is configured). `references`,
`referenceCount` and `downstreamFiles` count production code only; before this
split they also counted test consumers, so a repository's numbers can drop.
`testReferences` and `testReferenceCount` list the tests that mention the
symbol, with the same cap of eight paths, and are present only when at least
one test path matched. The analyst reads them for the test-adequacy check.

The collection has a time budget (`--max-ms`, default 60 seconds) that the
process enforces itself: it is checked before every search, and each search is
capped to what is left. It sits on the critical path before the analyst, so a
large diff must not stall the review. A file the budget did not reach is listed
as inconclusive with `reason: "time-budget"`, and the files finished so far are
still written.

Added-line functions and methods also receive lexical `declared` context. Their
names are split into meaningful tokens; names with fewer than two are omitted,
while the two longest tokens drive one same-line fixed-string grep. A hit is a
possible existing helper only when its declaration shares at least two tokens
at Jaccard 0.5 or higher. There are at most eight declarations per file and
three helpers per declaration. These searches run after reference collection
under the same budget; a failed query or exhausted budget is inconclusive, not
evidence that no helper exists.

`symbols --head <ref>` (validated like `--base`; an unknown ref exits 2) adds
callers. Each `declared[]` entry then carries `callers`, at most eight code
paths at the head that mention the new name, sorted, with the declaring path
and test paths left out, and `callerCount`, the full number. A new name has no
hits at the base by definition, which is why this search runs at the head. The
hits are lexical, not a call graph. `callersInconclusive: true` marks callers
that are unknown: no `--head` was given, the budget ended first, or the search
failed. Zero callers is `callerCount: 0`, a different fact. The driver passes
`--head` only when `summary.refs.head.available` is true, and the interactive
flow passes it for a local head commit. The analyst treats `callerCount === 1`
as a lead for one maintainability nit, never a verdict input.

### Structural evidence

`diff --out` also writes a `structure` block to `files.json` and its summary:
facts about the shape of the change that a reader pays for and the CLI can
measure. The first is `sizeCrossings`, the production files the change grows
from at most `review.structure.max_file_lines` (default 1000) to more. Each
entry carries both line counts and an anchor, the first added line past the
threshold, so a finding about it lands on code the change wrote.

Both sides are read with one `git cat-file --batch`. The base is the commit the
change starts from, the same one `.gitattributes` is read at, and a renamed
file is measured at its previous path. A follow-up review starts from the head
it last reviewed, so a crossing an earlier push made is not raised again, and
a deleted file has no size crossing. The head is the working tree, the index
or the head commit, depending on the mode. A side that cannot be read, such as
a pull request whose head was not fetched, puts the file in `unmeasured`
instead of treating it as small. "Production" means what the decision-point
count means by it, from the same classification: tests, documentation and
generated files are left out.

This is a fact about a file, not aggregate diff size. By default it plays no
part in the verdict. A repository may opt in with
`review.human_review.structure.file_line_crossing`; then a nonempty
`sizeCrossings` list joins the [ADR 0012](adr/0012-complex-changes-need-human-approval.md)
APPROVE cap. The analyst still gets it as a lead and has to name a seam the
added code could be split along, so "this file is large" on its own is never a
finding.

The second is `branchGrowth`: declarations that exist at the base and gain at
least `review.structure.max_added_branches_per_function` (default 3) decision
points, summed over the change and net of the ones it removes from them, so a
rewrite that swaps one branch for another is not growth. The decision-point counter of
[adr/0012](adr/0012-complex-changes-need-human-approval.md) attributes each
added branch to its enclosing declaration the way git names one in a hunk
header: the header's context, then any context line inside the hunk that
starts in the first column with a letter, `_` or `$` and is not a statement
keyword. Both come from the base side, so the declaration already existed.
Names are cut at 80 bytes, as git cuts them in a header, so one function is one
name however it was found. An added line of that shape starts something new,
and branches after it are not attributed, unless it replaces a declaration the
hunk removed, such as a changed signature, which keeps the base name. Branches
in a hunk without header context are not attributed either. There is no
parser, so an indented method is attributed to the class or function around
it, as git would; the analyst is told to check. One counter serves both uses,
so the complexity assessment and this signal cannot disagree about what a
decision point is. By default it is evidence only; a repository can opt in
with `review.human_review.structure.branch_growth` to make a nonempty
`branchGrowth` list join the same ADR 0012 cap.

These switches and `removed_controls` below default to false. Enabling one
changes only an otherwise APPROVE verdict to COMMENT. It does not raise a
maintainability tier, create a REQUEST_CHANGES event, add a new GitHub write,
or put the structural reason in the posted review. The signal is named only in the existing local
`humanReviewNote` and decision data.

The third is `typeEscapes`: `{ path, line, kind }` for each escape from the type
system on a line the change adds to production source, found by a small
per-language pattern table in `diff/type-escapes.ts`. TypeScript and JavaScript
get `any`, `double-cast`, `non-null`, `ts-ignore`, `ts-expect-error` and
`lint-disable` (an `eslint-disable` that names a `@typescript-eslint/` rule or
no rule); C# gets `null-forgiving`, `dynamic`, `object-cast` and
`nullable-disable`; Python gets `type-ignore`, `cast` and `any`. Only added
lines count, at their new-side line numbers, at most 20 per file, earliest
first. Each line is split into code and comment by a scanner that tracks quotes
and comment markers, so a pattern in a string never matches, code patterns
ignore comments, and directives are read from comments only. It works a line at
a time and does not follow multi-line strings. A file with any other extension
gets no entries rather than a guess. The analyst treats an entry as a lead and
needs to name the hidden invariant and the type that would carry it.

The fourth is `removedControls`: `{ path, line, kind, text, deletedFile? }`
for control-like lines removed from production source. Its five lexical kinds
are `guard` (a conditional naming an access, validation or limit check),
`refusal` (a throw, raise or return naming a refusal status or message),
`decorator` (an access-control attribute or decorator), `middleware` (a route
or middleware registration naming a control), and `allowlist-entry` (one
element in a file or enclosing declaration named as an allowlist). The scanner
shares quote and comment handling with `typeEscapes`. Guard keywords,
decorators and middleware match code; guard conditions, refusals and list
elements can use string contents. Comment-only lines and keywords confined to
comments do not match. This is a line-by-line lexical signal, with no parser
or tracking of multiline strings and block comments.

A removed line whose text, with whitespace collapsed, is added back anywhere
in the diff is netted out as a move, including additions in other files.
Entries use the new-side deletion anchor, trim the text to 120 characters and
keep at most 20 per file, earliest first. Wholly deleted production files are
read from the base blob because they are absent from the reviewed patch;
their entries use line 1 and `deletedFile: true`, as do the entries of a file
emptied of every line, since neither has a surviving line to anchor on. Deleted
files are skipped when the base side is unavailable or its blob cannot be read. Configured test paths and
generated files are excluded by the same classification as other structural
signals. The manifest and summary carry the same array. By default an entry
is evidence only. The analyst must read the surrounding code and search the
head for a re-established check, and the verifier must confirm its absence.
A check found elsewhere yields no finding; an untraced consequence yields a
question. A repository may opt in with
`review.human_review.structure.removed_controls: true` to make a nonempty
`removedControls` list join the same approval cap as size crossings and branch
growth. This holds an otherwise APPROVE at COMMENT with a local
`humanReviewNote`, adds no finding or posted text, and defaults to false.

A change that only deletes a guarded file has no reviewed file, so its patch
is empty, yet its `deletedFile` entries are leads like any other (#265). The
review still runs: the slash command stops early only when nothing was reviewed
and `removedControls` is empty, and the driver never stops early.
Given `--base` and `--head`, `check-candidates` and `score` accept a candidate on
a file the change deletes, asked of git rather than of any manifest: the file
is at the base and absent at the head, it is a path a review reads, and the
cited line is one its base copy has. The score carries `deletedFile: true`,
the posting plan and `anchors` put such a finding in the review body, since
the file has no new side for an inline comment, and the driver writes the
deleted file's base copy into `base/` for its agents, which have no shell. A nonempty `removedControls` also makes the change high risk for the
failure mode, so a review that could not run on it is `failed_closed` and a
`fail-open` setting cannot pass it.

The fifth is `riskMarkers`, always present as an array of `{ path, line, kind }`
in the manifest and summary. It lists added production-source lines in four
kinds, `new-route`, `lock-or-async`, `string-built-query` and `unsafe`.
`diff/risk-markers.ts` scans lexically with no parser, sharing the quote and
comment handling of `typeEscapes`. Route, lock and unsafe patterns inside a
string or comment do not match. A query marker needs a SQL keyword in a quoted
segment with concatenation or interpolation on the same line; a plain SQL
string does not match. At most 20 entries per file are kept, earliest first,
with head-side line numbers and no source text. Scanning is line by line,
without tracking multiline strings or block comments. Every marker is a lead
for an analyst to investigate, never a finding or a verdict by itself.

`review.structure.simplify` defaults to `false`. When it is `true` (or a review
is invoked with `--simplify`), the review command runs one additional analyst
pass only after ordinary verification. It may propose at most one
`maintainability` restructuring, and must list every concrete changed
`path:line` that would disappear plus the existing abstraction it uses. A
separate verifier checks each listed location is in the diff, that behaviour is
preserved, and that the suggestion removes concepts rather than merely moving
code. A rejection produces nothing.

The verified result is stored separately from ordinary candidates and scores.
It is appended only to the GitHub review body, never sent as an inline comment,
and never participates in validation, scoring, or the review event. With the
option off, no extra agent call or stored/output artifact is made; the normal
review is unchanged.

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
runs/                one directory per review run: the raw diff, changed files and thread
clones/              the watcher's partial clones, one per repository
exports/             explicit exports only
```

The audit log is the `audit_events` table in `review-voice.db`; no file holds
it. `watch` (each pass) and `purge --runs` enforce the `retention` block:
`runs/` entries older than `retention.runs_days` (default 30) and audit events
older than `retention.audit_days` (default 180) are removed, with 0 or null
turning a sweep off. Posting records (`review_post_*`) stay until `purge`,
because they stop a review being posted twice. `review` never deletes.

Each `review_runs` row has a nullable `provenance_json` column (migration 12):
`origin` (`driver`, `interactive`, `watch` or `action`), an `independence`
label, the plugin version, the Claude Code version (first line of
`claude --version`, null when unknown), the cost mode (null for the slash
command) and the active approved policy rows at record time, the same rows
`active_policy_versions_json` holds. The label is derived from `origin` alone
and recomputed on every read: `interactive` is `not-independent`, because that
review ran inside the host session that may have written the change; every
other origin starts fresh agents on a committed head and is `independent`. A
run recorded with `--carried-from` keeps the provenance of the run it carries
from, because nothing re-reviewed those findings; only a source from before
the column leaves the caller's flags in force.
`explain` prints it as a `Provenance` line, `status` appends the origin to its
last-review line, and the review driver report prints the same line. A row
recorded before the column, or with unreadable JSON, reads as not recorded.
Beside the provenance in the same column, a `families` key records which model
family ran the second pass (`codex`, `unknown` when verdicts name none, null
without one) and the challenge (`claude` when the stage names no family, null
without one), derived at record time from the verdicts and the `challenge`
stage and never trusted from a caller. `record` prints it as a top-level key,
and `explain` and the driver report print a `Families` line. A row from before
it reads as not recorded, and the independence label keeps its two values.

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

A candidate that restates a static signal at the same path within two lines
with overlapping wording is held as `restates-tool`. Its held record keeps
the candidate's anchor and claim and names the tool, signal line and message.
The evidence report names what did not run in `didNotRun` and why, through a
command's `unavailable` reason or the report's `skipped` reason when commands
are disabled by the environment. An optional configured `version` command
records the tool's sanitised first stdout line, capped at 80 code points.

A configured command, its `version` command and the second-pass verification
command run with a minimal environment, never the review process's own
(`commandEnvironment` in `src/evidence/run.ts`, issue 279). They get `PATH`,
`HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `CI` and `TERM` when set, plus the names
the configuration lists under `static_evidence.env_passthrough` or
`verification.env_passthrough`. A command that delegates to the pull request's
tree runs the author's code, and that code has no claim on `GITHUB_TOKEN`,
`GH_TOKEN`, `ANTHROPIC_API_KEY` or a `REVIEW_VOICE_*` setting, so none of them
is passed unless a list names it. The lists come from the same configuration as
the commands, the base commit's for a pull request, so a pull request cannot
widen what its own checks receive. A passed-through value of eight characters or more that a command prints, in a diagnostic, a version line or a verifier's reason, is replaced by `[redacted:NAME]` before the report is stored or handed to the agents. This is environment scrubbing, not filesystem isolation. The command still
runs as the reviewer, so one that runs the author's code can still read any
file the reviewer can, including credential files under `HOME` such as a
registry's `.npmrc` or the GitHub CLI's hosts file. For that the defences are
unchanged: list no command for a head you do not trust, keep
`REVIEW_VOICE_NO_COMMANDS` on a watcher, and the confined runner S16 specifies.

That confined runner is `reproduce` (`src/evidence/reproduce.ts`). It runs a
reproduction the verifier wrote, and only through a runner the `reproduction`
block configures, whose `run` string is the only command text it executes. Each
reproduction runs twice at most, in its own throwaway copy of the head
worktree, after a probe through the same wrapper has shown that the network, a
write outside the copy and its scratch directory, an overwrite of the runner's
own files and a read of the run directory are refused. On Linux the wrapper is
`unshare` with user, mount, network and pid namespaces and a read-only root; on
macOS nothing runs until issue #321; elsewhere there is no mechanism and
nothing runs. The environment is an allowlist, never the reviewer's, and CPU,
memory, file-size and wall-clock limits apply. A run counts only when it printed
`RV_REPRO_REACHED <candidate id>` before its assertion. Two failing runs are
`reproduced`, a pass on either run is `did-not-fail`, and anything else,
including a timeout, a limit, a crash before the marker or a change to the
copy, is `did-not-run` with its reason. Output is redacted and capped at 8 KiB a run in
`reproductions.json`, which stays in the run directory under retention.

### Severity is derived, not requested

Ordering is severity-first, so an unstable tier moves a finding up and down the
page between identical reviews. Asking for one produced `minor` at confidence
0.90 and `important` at 0.85 for the same finding on a byte-identical diff: the
evidence barely moved and the tier jumped.

`score` derives it from the category **and computed reach**. The category says
what kind of consequence a claim carries; reach says how far the affected code
spreads. The requested severity is recorded beside the derived one so a
divergence can be audited. An owner may explicitly lower a reported tier with
`score --severity <candidate_id>=<tier>` when that reach overstates the case;
the command records the override in the score reason. It refuses an
increase, except for a verified finding whose reach is unknown, which may rise
to the tier the analyst requested, within its lane's cap and never for a
question-framed claim or an untraced stale consumer: only the owner can say
that a broken shared build reaches everyone (#216).

One tier per category was the first version, and it was wrong whenever a
category's members vary in reach: `ci` covers both a change that breaks every
lint job and a stale comment in a CI config, so on a live run a build-breaker
rendered indistinguishably from a stale comment.

Reach is computed by the CLI from literal symbol hits at the reviewed ref, never
supplied by an agent - the same rule the eligibility score follows, since a
number a model supplies cannot be checked. It is measured relative to the
changed file and counts only code: hits confined to the file are `local`, hits
inside its own directory subtree are `component`, and hits in two or more
directories beyond it are `repository`. Counting distinct top-level directories
was tried first and measured wrong in both directions - inert under a monorepo
root, and inflated by a symbol named in a changelog. See
[adr/0009](adr/0009-severity-from-computed-reach.md).

When no symbol is searchable, no code hit is found, or the search fails, reach
is absent and the category's own tier is used unchanged. A failed search is
absent, never `local`: a search that could not run is not an answer.

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

`trust_boundary` is the exception to a category being severe by nature. It can
name a non-security control boundary, such as a gate selecting the wrong path,
so it rises above the requested tier only when the verifier traced impact beyond
the changed code at the escalation confidence. `security`, `authorization` and
`authentication` remain inherent boundary tiers. A verifier's
`impact_class: "no-exposure"` holds any of those boundary findings at the
requested tier because it traced that the boundary still holds elsewhere.

`question` is preserved rather than derived. It says the reviewer could not
establish the answer and the author can, which is a kind of finding rather than
a level of consequence, and no category implies it.

### Analyst lanes

A lane is a configured analyst: an agent file, an eligibility rule, a
candidate id prefix and a severity rule (ADR 0023). The `diff` lane
(`diff-analyst`, `cand_`) is built in and always runs; `review.lanes` adds
others, such as the shipped `structure` lane (`structure-analyst`, `st_`).
`lanes` prints eligibility and its reason for each lane. Without
`when.signals`, a lane is eligible when its changed lines reach
`min_changed_source_lines`, or always when the minimum is absent.
`productionChange` counts them. By default it leaves out tests, documentation,
generated files and configuration (a kind only this count has, so the
decision-point count is unchanged). A lane's `exclude_kinds` replaces that
list, and its `paths` narrow it.

`when.signals` accepts a closed list of `removed-controls`, `risk-markers`,
`type-escapes`, `branch-growth` and `size-crossing`, read from the corresponding
arrays in the manifest's `structure` block. An unknown signal drops the lane
with a warning. A lane with signals is eligible when any listed signal has an
entry within its `paths` (all paths when omitted), or when an explicitly set
line minimum is met. An absent minimum is not zero for a signal lane. A
missing `structure` block or listed key counts as no signal, and the reason
names whichever clause held.

Two more analysts ship, both off by default. `security-analyst` uses `sec_`
and categories `security`, `authorization`, `authentication` and
`trust_boundary`. Its blocker classes are `removed-control`,
`missing-object-authorization`, `string-built-query` and `fail-open-default`.
`concurrency-analyst` uses `cc_` and category `concurrency`, with blocker
classes `unguarded-read-decide-write`, `lock-order` and
`missing-cancellation`. Their checklists require a cited search for the guard;
the verifier defines and independently checks each class. The example config
shows both as commented entries, leaving only the built-in diff lane active.

Lane candidates are merged before `check-candidates`, which refuses a
candidate whose `lane` is not configured or
whose id lacks that lane's prefix. In `score` the lane rule runs last, on the
tier already derived and bounded: `cap` only lowers it, and `escalate` raises
it only when the verifier set `blocker_confirmed` and the traced-impact bar
above holds, so a lane cannot raise a tier further than any other finding could
rise. Every score entry names its `lane`.

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

Scope is read from the claim's grammar, not from how a place is spelled. A list
of name shapes could not work: the pattern that read "in acme-web" as somewhere
else, so a claim about that very repository went unchecked, also left a bare
path unprotected, so a true claim about a subtree was deleted. The difference
between the two was a pair of backticks. What decides now is whether the
assertion carries a locative complement and whether that complement names the
repository under review, which `--repository` supplies.

Absence of a property is not absence from a place. "Never exported" is true
precisely when the symbol exists, so a search confirms it and refutes nothing,
and it names no location for grammar to read.

A claim naming somewhere this repository cannot answer for returns
`inconclusive: true`. "Absent from the localisation catalogue" is a true and
useful finding about a sibling repository, and `git grep` here speaks only for
this one. Answering anyway gave the worst outcome available: at the base ref it
returned `found: []`, which reads as corroboration, and at the head ref it found
the symbol the diff itself adds and deleted the finding with a sentence that was
false about the claim.

A name can be missing from every tracked file and still exist, because a build
step writes it: a localisation key behind a `.resx` designer class, Android's
`R`, a Flutter `l10n` accessor. When nothing is found and the repository tracks
resource sources (`*.resx`, `*.resw`, `*.po`, `*.xlf`, `*.xliff`, `*.arb`, a
`locales/` or `i18n/` directory), or the name is shaped like a generated
accessor, the check returns `inconclusive: true` with a `reason` saying the name
may be generated, rather than corroborating the absence. Finding the sources
costs one `git ls-files`, and only when the search found nothing.

### A score belongs to the batch, not to the candidate

Novelty is measured against what has already been kept in the same review, which
is what stops two findings spending the word budget on one root cause. The
consequence is that `finalScore` is not a property of a candidate alone: making
one candidate eligible costs its neighbours novelty, so relaxing any gate can
push an unrelated finding down.

Measured, not theorised. Between two releases one candidate moved from 0.7158 to
0.6950 with no change to its own inputs; scored alone it was 0.715821 on both,
and lowering a different candidate's confidence until it was cut returned the
first to 0.7158 exactly.

This qualifies every reproducibility number in `docs/EVALUATION.md`. They are
valid because each comparison ran identical batches through both versions. A
comparison over different batches would measure the batch.

### Two confidence floors, because they measure different things

The verifier checked the claim against the repository. The analyst reported how
it felt about its own output. Holding both to 0.8 treated those as the same
measurement, and one of them has now been checked against ground truth.

Over eleven candidates verified or refuted by hand against the code, the
self-report did not separate true from false anywhere above 0.7: the two most
thoroughly verified findings sat at 0.70 and the only false one at 0.80. Held at
0.8 it discarded a real behavioural defect, a test that did not test what it
claimed, and the finding that drove an actual changes-requested review, while
shipping the false one. It is unstable at the boundary too: the same finding on
an identical diff scored 0.75 and then 0.80, which decided whether it reached
the author.

A verifier-established confidence is still held at 0.8. An analyst-only one is
held at 0.7, which is where the labelled data puts it: below that the signal
does carry, since candidates at 0.50 and 0.65 were weak or wrong, and above it
the number is noise. `score` reports how many candidates were gated on the
self-report, because a run scored without verification has no precision defence
beyond precedent and that should not have to be inferred from a missing flag.

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
review comment ends up retracted. Only context the claim depends on caps it:
the verifier can mark an entry `cosmetic` when it would only sharpen the
wording, and a candidate the cap held back is listed locally as `unverified`
rather than lost (ADR 0016).

A `question` is the one candidate that can be eligible without a verified
claim. It is eligible when its premises are verified, even if its answer is
not: it skips the confidence gates, since low confidence in an answer is what a
question is, and is stopped instead by `premises_verified: false` from the
verifier, by owner precedent against asking it, or by the cap of two questions
per review.

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
`asset-guide` and `blank-forms` to every review and cut the one document the
change was actually about. Each document reports the `reason` it was selected.

On a pull request the documents come from the base commit (`--ref`), the same
trusted side the configuration comes from, never from the checkout. In the
GitHub Action the checkout is the head, so reading the disk handed the review
the author's own `CLAUDE.md`, and a head that weakened a convention was
reviewed against the weaker one. The tree is listed once with `git ls-tree`
and a document is read from its blob only when its content is needed; a
symbolic link in it is not followed, because its target would be read from
the checkout or from outside the repository. Working-tree and staged reviews
still read the checkout, which is the change.

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
read-only. The driver runs it in the head worktree (`verify --cwd`), the tree
the findings are about, while the command itself still comes from the base's
configuration. It runs with the same minimal environment as the static checks,
plus the names `verification.env_passthrough` lists, so a verifier that needs
its own API key gets it only by name. A verifier that cannot run never confirms
a finding, and verification may only weaken a severity on its own; a stronger
tier it traced is a proposal the tie-break settles.

`verification.runner: codex` runs the second pass on a `runners.<family>` block
instead of a shell string: the argv runs without a shell, `{schema}` holds the
verdict schema, `{output}` is read in place of stdout, and every verdict
carries the family. Its stderr is never read for a verdict, with or without
`{output}`, since a CLI logs there what it read from the tree under review.
Its answer counts only with exit status 0. Any other
status, a signal or a timeout means the second pass did not run for that
finding. The finding goes on unchanged and is never dropped. Its verdict is
`unverified` with the reason `verifier did not run`, and `didNotRun` lists the
verifier's name, not the finding. A shell string keeps its old reading, where
an exit status of any value still reads the answer. `verification.family`
labels a hand-written command the same way, so verdicts can be grouped by
family.

It is opt-in, and a config written before it existed has no block for it at all,
so `RV context` reports whether yours does.

a command that receives one finding as JSON and returns a verdict. Off by
default, because requiring an external binary would break the zero-install
promise for everyone who does not have one.

Three rules keep it from becoming a worse version of the problem it solves:

- **A confident rejection drops; an unsure one downgrades.** An unsure verifier
  should not be able to delete evidence.
- **A verifier may weaken a severity, never strengthen one by itself.** Its
  job is to doubt, not to escalate. A worse impact it traced, with the lines
  that show it, goes to the tie-break below, and the tier rises only when that
  upholds it with traced impact at the escalation confidence.
- **A verdict counts only when its fields agree with its label.** A `kept`
  that was rejected, a `downgraded` that does not lower the tier, or a
  proposal with no decisive lines is refused, not applied.
- **A verifier that could not run has not agreed.** Missing or unparseable
  output leaves the finding exactly as it was, and is reported as `didNotRun`.

Every verdict is recorded, including the ones that change nothing, and
`explain` lists what was suppressed and why. A verifier that silently deletes
findings is the finding cap in a different coat - the failure has to be
visible, or a bad verifier is indistinguishable from a clean diff.

`RV reconcile` applies the verdicts rather than the orchestrator applying them
by hand. When the evidence-verifier traced a finding's impact at 0.85 or more
and the second pass downgraded or dropped it, the two disagree about a fact in
the code, and one `tie-breaker` run on just that point settles it: upheld, the
evidence-verifier's finding stands; not upheld, the second pass's outcome does.
A second pass that proposed a stronger tier is settled by the same run, and the
second pass's decisive lines go to the tie-breaker as places to look. See
[ADR 0014](adr/0014-verifier-tie-break.md) and
[ADR 0019](adr/0019-cross-check-may-raise-through-tie-break.md).

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

Rules stay keyed by rule id. An approved rule's path scope only narrows where
it applies; it does not change what the rule is about. A suppression holds a
candidate only when both its rule id and path glob match, subject to the
security and trust boundary exemptions in
[ADR 0032](adr/0032-approved-policies-are-enforced-at-scoring.md).

### The independent challenge

The evidence-verifier and the second pass both start from the analyst's
framing. After `score`, each eligible finding goes to a `challenger` that is
given the claim, the failure mode, the location, the diff and the intent the
finding cites, and never the verifier's reasoning, confidence or evidence.
`RV challenge --emit-prompts` builds those prompts from an allowlist of fields,
so nothing added to a score later reaches the challenger by accident.
One input was added on purpose. With `--reproductions`, a finding whose
reproduction ran gets its runner, file, the path of the kept copy, the exit
codes and the first 40 lines of redacted output, or the reason it did not run,
labelled untrusted and with the rule that it settles nothing by itself. The
verifier's `expected` sentence and reasoning stay out (ADR 0024, amended).

`RV challenge` then applies the verdicts. A set that skips an eligible finding,
or a verdict whose label contradicts its fields, is refused, as `reconcile`
refuses a second-pass verdict. `confirmed` with the line confirmed passes;
`confirmed` with a corrected line moves through the same check `reanchor` uses;
everything else is held as `challenge-partly` or `challenge-refuted` and marked
ineligible in `scores`, so neither validation nor posting can match a rendered
finding to it. A challenger cannot raise a tier. Under `verdict.evidence_block`
its verdict and decisive lines are posted in each inline comment's Evidence
block, and its `reason` never is. See
[ADR 0024](adr/0024-an-independent-challenge-gates-every-posted-finding.md).

The challenger runs on the family the plan names (ADR 0034).
`runners.use.challenge` is the base, `claude` by default, and
`runners.use.agent_authored_challenge` moves the challenge of a change an agent
of the base family wrote to the configured alternative. For an external family
the driver hands `runAgent` the `runners.<family>` block as the spec's `runner`
and records the block's `label` as the stage's model. When that family cannot
run, because `REVIEW_VOICE_NO_COMMANDS=1` is set or no `runners.<family>`
block is configured (one the loader rejected included, since the selection keeps
the family named, with a warning, and never becomes Claude), every challenged
finding is held as `challenge-partly`
through the same path a failed challenger takes, with a reason starting
`challenger not run:` and one note on the run. A runner that starts and fails
twice on a finding holds that finding the same way, and a finding it judged
keeps its verdict. Nothing falls back to Claude. A `runners.use` value that
names no family (a misspelling, a list, or a `use` that is not a mapping) is
marked unreadable by the loader, the plan carries the reason as
`families.notRun`, and the driver holds the same way with that reason. An
unreadable `runners.use.challenge` or `use` holds every challenged finding,
and an unreadable `runners.use.agent_authored_challenge` holds the findings of
a change an agent of the base family wrote. `planFindings` then keeps the event at COMMENT at most, the one
held finding that changes it. The hold outlives every review
narrower than the pull request. A carry to an unchanged scope keeps it, and
`record` gives an incremental or interdiff review the holds of the prior run
its scope links, whether or not that review read the hold's file. Such a
review saw only its own hunks, which may be far from the held line, and the
driver challenges only a finding raised again, so a clean review of a later
commit cannot approve. Either drops a hold on a file the pull request no
longer changes, which the file list in `files.json` says (a renamed file
counts under both names), as do `scope.noLongerChanged` and
`scope.absorbedByBase`. A hold on a file the patch itself renames moves to
the new name, so a file renamed a second time is not read as one that left
the pull request, and a finding held again at the same path and line is
recorded once. `record` compares paths as the diff spells them, so a hold
written as `./src/app.ts` is one on `src/app.ts`. Otherwise only a full
review (`review --full`) ends the hold. It reads the whole pull request and
inherits nothing, and the finding, raised again, is verified and challenged
again, so a full review is what re-checks it once the runner works. With
`verdict.scope_block_models: true` the scope
block's origin sentence names a challenge family other than Claude and its
trailer carries `families`.

### Fixes are verified separately

A defect can be real while its suggested repair is unsafe. The verifier traces
the repair through the failure input and paths the current code already serves;
only a verified repair above the confidence threshold renders as a fix. A
partial repair may render a generic direction, and every other result renders
no fix. This decision never changes the defect's confidence, eligibility, or
severity.

The concise editor has no tools. Each eligible candidate, including its
deterministic `fix` instruction, is passed inline rather than as a path the
editor cannot open. It may state only the fix or direction that instruction
permits.

A verified fix can also post as a **committable suggestion block**, opt-in with
`review.suggestions` (default `false`, ADR 0033). The analyst gives
`suggested_patch` beside `suggested_fix`: the replacement for at most five added
lines ending at the anchor, with their `original` text. `check-candidates`
compares that text with the diff, `score`'s eligible list and `record` carry the
patch to the finding, and the verifier's fix verdict judges the exact
replacement. At posting, `computeVerdict` reads the file at the head through
the contents endpoint and adds the block after the prose only when the backing
score has `fix.render: 'fix'`, the finding still ends where the patch does, and
the lines still read `original`; otherwise the prose posts alone and the
preview says "suggestion withheld" with the reason. The editor never writes
code: the block comes from the candidate's field through the CLI, and `outcomes`
counts an applied one as a strong `fixed`.

Rules are keyed by **rule id** (category, lane and, when a candidate claimed
one, blocker class), not by file path, and an approved rule's suppressions are
applied in `score`. "Suppress maintainability findings from the diff lane
unless they name a concrete failure mode" is a rule; "suppress things like the
ones in src/a.ts" is an observation about wherever you happened to be working
that week. A dismissal in one lane says nothing about the same category in
another lane, so signals from two lanes form two rules. See
[ADR 0032](adr/0032-approved-policies-are-enforced-at-scoring.md).

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
trusted. A PR review (`review --pr`) is the exception: it reads the base
commit's config (or `--config`, or an absolute `REVIEW_VOICE_CONFIG`), never
the head's, so a pull request cannot loosen its own review. `.review-voice/policy.yaml` is repository content and is not: it is
parsed, hashed and reported as pending approval, never applied. Editing an
approved file changes its hash and re-proposes it, so a quiet edit cannot
inherit an old approval.

### The GitHub client

Two constraints are enforced in the client rather than documented, because v1
promises both and a promise a caller can bypass is not a promise: only GET
requests are issued, and only allowlisted repositories are addressed. Both
throw before any network call, and both are tested. The one non-GET request is
a GraphQL query, for review-thread state that REST does not expose. Only a
document that is exactly one of a fixed set of queries is sent, with only the
variables it declares and the repository from the allowlist; anything else is
refused before it is sent (ADR 0018).

Search is the one read that can name any repository, so it has its own door
(ADR 0026). `searchPullRequests` sends `GET /search/issues` with a query it
builds from a typed source (`requested`, `assigned`, `reviewed`, or
`team:<org>/<slug>` with both names checked), always with `is:pr is:open
draft:false`, at most five numbered pages. No caller text reaches the query,
and `get` refuses any search path, relative or absolute. Each result's
repository is matched against the allowlist before it is returned; one outside
it is counted and never read further. An allowlist entry is `owner/repo` or
`owner/*`, and only the queue's client accepts `owner/*`; every other client,
and any bare `*` or other glob, is refused when the client is built.

Every request path, relative or absolute, is resolved against the API root
before it is sent. Another origin is refused, so the token never leaves the API
host. A dot segment or an encoded dot, slash or backslash in the path is
refused, and the allowlist is checked on the resolved path. A pagination link
contributes only its query, applied to the path just read, because GitHub may
spell the next page as `/repositories/{id}/...`, which names no repository; a
request to that id form is refused.

The allowlist matters more than it looks. The credential comes from `gh` and
carries whatever scopes the user already had - almost always broader than
Review Voice needs. So the allowlist, not the token, is what actually bounds
access.

Rate limiting is retried with backoff; a 403 that is *not* rate limiting fails
immediately, because retrying a permissions error only burns the user's quota.
Pagination is bounded so a large repository cannot run away with the budget.

**Linked issues** (`review.linked_issues`, default `false`). With it on,
`thread` also reads the issues the pull request description closes, so the
intent extractor can quote the requirement a change was asked to meet, not only
what the author wrote about it. Which issues count is a decision recorded here.
Only a GitHub closing keyword (`close`, `fix` or `resolve` in any of their
forms, an optional colon, then `#N`, `owner/repo#N` or an issue URL) links an
issue; a bare `#N` mention does not, because "see #12 for background" is not a
requirement of this change; and the sidebar Development links are not read,
since they are visible only through GraphQL and would be a second query under
ADR 0018. Only the pull request's own repository is read, even when the named
repository is allowlisted, because naming a pull request is the consent for
reading it and nothing else; a reference elsewhere is named in a local warning
and never requested. At most five issues are read, each with one
`GET /repos/<owner/repo>/issues/<n>` through the same client, so the GET-only
rule holds (ADR 0002). One gap stays open. GitHub answers a transferred issue
with a 301 to its new repository, which the client's fetch follows with the
token before any allowlist check; the answer is discarded when it names another
repository or number, but the read happened. docs/THREAT-MODEL.md names the
residual. A result that is a pull request is skipped. Title and body are
redacted before the body is cut at 10000 characters, and a failed read, as
with the other optional reads, stays a local warning while the review goes on.
`check-intent` verifies each quote against the one source it came from and
records the issue number on the statement; the analyst may raise a requirement
an issue states and the change does not meet as a `question` at most, and the
verifier must find the quote in that issue and the behaviour absent at the head
before it is eligible.

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

`RV verdict` computes the posting decision and never writes. `RV post` repeats
it, applies more guards and, with `--confirm`, makes the review write. An
external loop should call these instead of re-implementing the rules.

**The event** comes from the severities of the findings that post
(`eventFor`, ADR 0010), never from model prose: a blocking or important finding
requests changes, a minor or question finding comments, anything else
approves. Only verified findings post. A finding is verified when a score at
its path, line and derived severity came from the verifier and cleared every
gate, matched one to one. The rest are held back and listed in the preview. An
unverified finding above a nit still keeps an approval at COMMENT, because
approving past a concern nobody checked is the false approval this design
exists to prevent.

**CI and the other caps** are applied by `decide()` in a fixed order: a moved
head refuses (exit 3); a standing owner approval on an unchanged scope is
carried when `carry_approval_on_unchanged` is on (nothing is posted); CI that
needs a rerun holds every event (exit 6, ADR 0013) unless `ci_needs_rerun` is
`annotate`; carried candidates not reviewed since cap an approval at COMMENT
(ADR 0017); `verdict.never_approve`, when on, caps an approval at COMMENT; a
high-complexity change caps an approval at COMMENT (ADR 0012)
unless `review.human_review.cap_approval` is false; then red CI caps an
approval at COMMENT, and pending CI makes an approval wait (exit 4). COMMENT and
REQUEST_CHANGES never wait on CI. `verdict --recheck` asks only whether the
approval can now be sent: head unchanged and CI green, else exit 4 (pending),
5 (red) or 6 (needs rerun), and exit 2 when there is no approval to re-check.
Exit codes: 0 ready, 1 failure, 2 nothing to post or refused, 3 head moved or
event changed, 4 CI running, 5 CI red, 6 CI needs a rerun, 8 the thread changed
(`post` only).

**Verdict policies** (ADR 0028) turn the pending, red, needs-rerun, complexity
and unchanged-scope rules into `verdict:` settings, whose defaults are the
rules above: `ci_pending` (`wait` or `proceed`), `ci_red` (`cap` or
`annotate`), `ci_needs_rerun` (`hold` or `annotate`), `never_approve`,
`carry_approval_on_unchanged` and `recheck_thread_before_post`. `annotate`
keeps the event and appends one line naming at most five checks to the body.
Check names are flattened to inline code so no markdown or mention renders.
`decide()` takes the settings as a `VerdictPolicy`; the head guard, the
writer's two checked paths and the idempotency key are not settings.

**Review scope.** `verdict.scope_block` (default `false`) appends a collapsed
Review scope block and an HTML comment containing JSON from the recorded run:
head, scope, cost mode, origin and independence, stages, static checks that ran
or did not run, unfinished symbol searches and held-claim counts. Missing
facts read `not recorded`. With `review.linked_issues` on, a `Linked issues`
line names the issues the thread read for intent, each number as inline code so
GitHub links nothing, and the JSON carries them as `issues` (`null` when the
run did not record its checks). ADR 0016's lists stay local; only their counts post.
The human-review note, would-have verdict, stale request for changes and carry
reasons stay local too. `verdict.scope_block_models` (default `false`) adds
model ids beside the stages. The block follows the findings, after the
idempotency key is taken and before CI annotations, so toggling it keeps the
same key and annotation replacement still works. `verdict`, `post` and the
watcher share the payload and preview through `computeVerdict`; the existing
review write carries the block (ADR 0028).

**Evidence block.** `verdict.evidence_block` (default `false`) ends each inline
comment, after any suggestion block, with a collapsed Evidence block that
`evidenceBlock` in `src/publish/evidence-block.ts` builds from the stored
finding and the score that verified it, both from the run that scored it, so a
carried finding describes its origin run. It says the evidence verifier
established the finding and what the challenger decided, with the anchor it
moved from when it moved, and lists the challenger's decisive `path:line`
references, a static check that flagged the same line (`toolSignal`, stored by
`record --evidence`), and a convention quote the cited document holds
(`conventionQuotes`, stored by `record --conventions`).
`verdict.evidence_block_precedents` (default `false`) adds how many retrieved
owner precedents favoured the finding. Every string is flattened through
`safeCheckName` into inline code and capped, and a decisive reference with an
absolute path or `..` is dropped. A static check named by a path on the
reviewer's machine is left out, and a convention quote shows only beside the
score of the candidate that cited it, so two candidates at one anchor cannot
mix their evidence. It never carries a reason any agent wrote, a
confidence, a model, a held or unverified claim, a precedent's excerpt, id or
login, or the human-review note. The block is appended after the idempotency
key is taken and the comments already sent are filtered out, and
`commentSignature` hashes the body without it, so the setting moves neither.
Every reader of a posted comment (`thread`, the outcome matcher) cuts it off
at its marker first. `evidenceBlocks` in the verdict, and on the
`review_post_attempted` row, counts the comments that carry one.

**Carry.** With `carry_approval_on_unchanged`, a run whose scope is `unchanged`
and that maps to a clean approval looks for the owner's latest deciding review.
If it is an approval of the commit the scope is unchanged since, the action is
`carry`: nothing is posted, the approval's link is reported, and a confirmed
`post` records only a `review_carried` audit row. A held finding, an uncovered
carry or a request for changes is news the standing approval does not cover, so
those post as usual.

**Idempotency.** The key is repository, pull request, head and a hash of the
whole payload before already-posted comments are filtered out, so the same
review of the same head is refused a second time even once its comments are all
on the pull request, while a new head or a different review is a different post.
Annotations are appended after the key is taken, so a CI change cannot make the
same review a second post. Inline comments already sent on this head by an
earlier post (a COMMENT while CI was red, then the approval) are not sent again.

**Guard order in `post`.**

1. `writes.github_posting_enabled` must be true, else exit 2.
2. With `--confirm`, `--event` must be one of the three events, else exit 2.
3. The verdict is computed fresh: the head is read live and compared with
   `--head`, and the review on stdin must be the recorded run for that head. A
   carry returns here. Anything but `post` refuses with the verdict's exit code.
4. The idempotency key must not be blocked: a key already sent, or attempted
   with no definite answer from GitHub, refuses. A 4xx answer does not block a
   retry.
5. Without `--confirm`, nothing is sent (exit 2). The confirmed event must equal
   the event now computed, else exit 3.
6. The run's repository must match the pull request's.
7. The thread re-check, with `--recheck-thread` or `recheck_thread_before_post`:
   the thread is read again and the payload's findings are matched with the rule
   `check-candidates --thread` drops a repeat by. A finding someone other than
   the token's user raised after the run was recorded refuses with exit 8,
   naming each. Replies to this tool's own inline comments are ignored, and so
   is a comment that only quotes the tool's earlier text (blockquote lines are
   dropped, and text contained in a review or comment the token's user posted is
   skipped). An unreadable thread refuses with exit 1.
8. For an approval only, head and CI are read again, the last read before
   sending. A moved head refuses (exit 3); CI that no longer allows an approval
   refuses (exit 4, 5 or 6); a changed CI state rewrites the annotation in the
   body and the preview without changing the key.
9. The key is claimed as an `review_post_attempted` audit row inside one
   transaction that rechecks the block, so two concurrent posts cannot both
   claim it.
10. The review write, `POST /pulls/{n}/reviews`, through the writer.

**Audit rows.** Every refusal writes `review_post_refused` with its reasons,
key, head and event. A claimed attempt writes `review_post_attempted`, then
either `review_post_sent` (key, attempt, head, event, inline comment
signatures, whether CI capped it, review id and URL) or `review_post_failed`.
A failure marks `uncertain` unless the request was refused in code or GitHub
answered with a 4xx, and an uncertain attempt blocks a retry until someone
checks the pull request. `review_carried` records a confirmed carry.

**The posting gate** (ADR 0007) is reported, not enforced. `evaluatePostingGate`
reads what was measured (precision at 0.80 or better over at least 20 labelled
findings, with full contract compliance) and `post` includes it in every result
as `postCheck`. Since ADR 0010, verification is the gate for a finding; the
measurement stays visible rather than binding. It takes no override argument.
The minimum sample matters as much as the threshold: five keeps and no
dismissals is 100% precision and tells you nothing.

The preview is rendered from the payload that would be sent. A preview
generated separately from what gets posted is a mock-up.

**Replies** (ADR 0035). `outcomes` reads every reply under every inline comment
this tool posted. `replyWanted` in `src/store/outcomes.ts` marks a thread as
awaiting a reply from those same reads: the thread state is known and open, no
reply under the root is by the poster, and the newest reply that is not a
bot's, the poster's or the owner's asks something (a `?` outside a blockquote),
whether as a question or as a disagreement. `checkOutcomes` returns these as
`questions` beside the outcomes, and `outcomes` prints one line per question in
text mode. `RV reply --pr N` runs that check for one pull request and hands the
questions to `postReplies` in `src/publish/reply.ts`. Guard order:

1. `writes.github_posting_enabled` must be true, else one `review_reply_refused`
   row and exit 2, before any read of the store.
2. The question's run must exist and be of the pull request's repository.
3. `renderReply` builds the body from the recorded run alone, from the score
   that backed the posted finding and the candidate it scored, naming the first
   seven characters of the head and the challenger's `decisive_evidence` when
   its verdict is `confirmed`, else the `path:line` citations in the candidate's
   evidence, at most four, deduplicated, each dropped when its path is unsafe
   for inline code or when it alone breaks a property below. No reference,
   no reply. The body is one fixed template, at most 600 characters, with none
   of the validator's forbidden phrases, and `classifyReply` reads it as
   `other`, so the outcomes reader never takes the tool's own reply for a
   dismissal or an acknowledgement. It is redacted before those checks, so the
   preview is the payload sent.
4. The key `reply:<repository>#<pr>:<root comment id>` must not be blocked: a
   key already sent, or attempted with no definite answer, refuses. A 4xx does
   not block a retry.
5. Without `--confirm`, the body is previewed and a `review_reply_refused` row
   says so.
6. The key is claimed as a `review_reply_attempted` row in one transaction.
7. The second write, `POST /pulls/{n}/comments/{id}/replies`, through the same
   writer, with exactly that `{ body }`; the writer's allowlist is
   the run's repository. `review_reply_sent` or `review_reply_failed` follows,
   with the uncertainty rule a review has.

No reply to a reply, no second reply on a thread, no model in the path, no
resolving or editing of anything. The GitHub Action never replies.

### The watcher

`watch` (ADR 0027) adds no review or posting rule of its own. Each pass builds
the queue and handles one entry at a time: a new head runs `review` as a child
process in the repository's clone under `watch.workspace`, and a recorded run
goes through `computeVerdict` and `postReview` in process, with the thread
re-read before the post. The review step is an injected function, so tests
replace it. The watcher never replies under a comment. Nothing under
`src/watch/` reaches `postReplies` or `replyToComment`, and there is no setting
to turn on (ADR 0035), so a pending question waits for `reply --pr N --confirm`.

The clone is repository content, so its `.review-voice/config.yaml` must not
decide posting or the allowlist (ADR 0006). `loadConfig` reads
`REVIEW_VOICE_CONFIG` instead when it is an absolute path. `watch` copies its
config to `<dataDir>/watch-config.yaml` at the start of every pass, reads the
copy, and points every review child at it, so an edit or a branch switch in
the operator's checkout mid-pass changes nothing, and a change to posting, the
allowlist or a policy takes effect at the next pass. The child also gets
`REVIEW_VOICE_CONFIG_SOURCE`: `flag` when the watcher's own `--config` named the
file, `env` for an operator `REVIEW_VOICE_CONFIG`, `checkout` for the checkout's
file. The driver keeps that source for its stages, so a checkout's `runners:`
block never runs, however many hops it takes. Before posting a recorded
run, the watcher checks the run's repository against the current allowlist.

The child runs in its own process group with `--expect-head` (the driver exits
3 when the pull request moved before it started) and `--recheck-thread` when
posting. Unless `watch.run_repository_commands` is true it also gets
`REVIEW_VOICE_NO_COMMANDS=1`: the driver's config loading, `evidence` and
`verify` must then run no configured repository command, since nobody is
watching what they do. After `watch.review_timeout`, or when the watcher is
interrupted, the group gets SIGTERM and, ten seconds later, SIGKILL, or at
once when the review itself exits, while its group id cannot have been reused;
the
review settles on the child's exit or at the end of that grace period, never
only on its pipes closing, which a stray descendant can delay forever. Git lock
files older than ten minutes, which a killed fetch leaves, are removed from the
clone before the next review. Agents run in process groups of their own
under the runner's watchdog, which kills them when their parent dies, so
ending the review's group ends them too. The copy is written to a fresh
`.tmp-<pid>` file (mode 0600, exclusive, not following symlinks), synced and
renamed over the old one.

`watch_heads` holds one row per repository, pull request and head. The row is
written only after the action returns: a crash leaves no row, the next pass
redoes the head, and `post`'s idempotency key stops a second send. The queue
reads the rows through its store seam (`queue/store.ts`). A head the watcher
posted, carried, skipped or held, or that failed `watch.max_attempts_per_head`
times, counts as sent and drops out before `max_per_pass` is applied, so stuck
heads cannot crowd out new ones. A COMMENT sent only because CI was red stays
in the queue as `recheck-ci` until the approval goes out. A moved head (exit 3)
leaves no row.

One watcher runs per data directory, and the kernel enforces it: the watcher
listens, exclusively, on a 127.0.0.1 port derived from the data directory
(49152 plus the SHA-256 of its real path modulo 16000; `watch.lock_port`
overrides). Only one process can listen, and the port is freed when that
process exits or dies, so there is no stale lock to judge and no takeover. A
second watcher that finds the port in use sends a one-line probe: a watcher
answers with its pid and data directory, and anything else is reported as
another program on the port. `watch.lock` holds the pid for people to read and
decides nothing. The lock is released on exit, and on SIGINT or SIGTERM after
any running review has been stopped. Passes run one after another; a pass that runs past the
interval delays the next rather than overlapping it.

## Trust boundary

Everything read from a repository or from GitHub is **untrusted data**: source,
comments, markdown, PR titles and descriptions, issue comments, historical
review comments, fixtures. It is wrapped in delimited data blocks, never
interpreted as instruction, and can never alter tool permissions or workflow
order.

The authoritative inputs are the owner-approved policy and the plugin's own
prompts. Nothing else.

See [THREAT-MODEL.md](THREAT-MODEL.md).
