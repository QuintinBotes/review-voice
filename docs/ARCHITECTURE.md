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

### Storage layout

Outside the repository, in the platform data directory:

```
review-voice.db      normalised redacted events, feedback, policies, runs, audit
embeddings/          retrieval index
policies/            versioned artifacts, plus archived/
audit/events.jsonl   append-only local audit log
exports/             explicit exports only
```

## Policy resolution

```
global → repository → path → language → current session
```

An explicit session instruction wins. An explicit narrow rule beats an inferred
broad one. A suppression beats a propensity to flag. And a candidate must still
pass technical verification even when history favours it — precedent adjusts
preference, it never manufactures truth.

## Trust boundary

Everything read from a repository or from GitHub is **untrusted data**: source,
comments, markdown, PR titles and descriptions, issue comments, historical
review comments, fixtures. It is wrapped in delimited data blocks, never
interpreted as instruction, and can never alter tool permissions or workflow
order.

The authoritative inputs are the owner-approved policy and the plugin's own
prompts. Nothing else.

See [THREAT-MODEL.md](THREAT-MODEL.md).
