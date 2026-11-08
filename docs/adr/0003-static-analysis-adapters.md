# 0003 - Static analysis adapter strategy

**Status:** Accepted · **Date:** 2026-09-16

## Context

Findings are stronger when backed by a type checker, linter, or test run. The
question is how Review Voice gets that output: auto-detect and run project
commands, require configuration, or ship per-ecosystem adapters.

Auto-running detected commands is the convenient answer and a security hole.
`npm test` in a hostile repository is arbitrary code execution, and Review Voice
is explicitly designed to be pointed at repositories whose contents it does not
trust. A tool that treats repository content as untrusted in prompts but
executes it in a shell has not taken the threat seriously.

## Decision

**Detection suggests. Configuration enables. Never both.**

Review Voice detects likely commands for the ecosystem and offers them during
`init`, with the exact command shown. Nothing runs until it is listed in
`.review-voice/config.yaml`:

```yaml
static_evidence:
  enabled: false
  commands:
    - name: typecheck
      run: npm run typecheck
      timeout_seconds: 120
```

Execution constraints: no shell interpolation of repository content, a per
command timeout, captured output only, and failures degrade the review rather
than aborting it.

Adapters are thin output parsers - `tsc`, `eslint`, `pytest`, `go vet` and
similar - mapping tool output to evidence objects. They are not runners.

## Consequences

- No arbitrary code execution from a clone. The one-time configuration cost is
  the price, and it is worth it.
- Reviews run with less evidence until a user configures commands. Confidence
  scores drop accordingly, which is the honest behaviour.
- **When a check did not run, the review never implies it passed.** No generic
  warning about missing checks either, unless the absence creates a specific
  review concern.
- Adapters are independently testable against recorded tool output.

## Alternatives considered

**Auto-run detected commands.** Rejected on security grounds above.

**Ship an execution sandbox.** Rejected: large scope for a plugin, and
imperfect sandboxes invite the risk they claim to remove.

**No static evidence at all.** Rejected: it materially improves finding
precision, which is the entire product.

## Amendment - 2026-11-08

A configured `static_evidence.commands[].version` command is configuration,
so running it keeps "detection suggests, configuration enables". Review Voice
does not infer a version command from a tool's name. The optional command runs
with the check's working directory, timeout and output cap; its first stdout
line is sanitised and capped at 80 code points. A failed version command
records no version and does not change the check's signals or run status.

A candidate that restates a tool's signal at the same path within two lines
with overlapping wording is held as `restates-tool`. The held record keeps the
candidate's anchor and claim, names the tool, and gives the signal's line and
message as its reason, so `explain` can show why it was held.

Configured commands run in the pull request's head worktree (`evidence
--cwd`) while the configuration is read as ADR 0031 decides, from the base
commit. The head controls every file a command reads and the text it prints,
so a command that delegates to the tree, such as a project's own typecheck
script, runs the author's code with the reviewer's environment and
credentials; that is the exposure an owner accepts by listing a command, and
`REVIEW_VOICE_NO_COMMANDS` is the switch that keeps a watcher from it. The
head cannot change which commands run, their timeouts, their working
directory, their environment or the recorded tool name. A fresh worktree
holds no untracked installs, so a check that needs `node_modules` or a
virtual environment must install first or find its tool on PATH. The report
records the directory the commands ran in as `cwd`, and `check-candidates`
resolves a tool's absolute paths against it.
