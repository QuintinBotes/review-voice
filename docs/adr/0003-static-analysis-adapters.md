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

2026-11-08, issue 279. Configured commands no longer inherit the reviewer's
environment. Every `static_evidence` command, its `version` command and the
`verification` command run with `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`,
`CI` and `TERM` when set, and nothing else unless the configuration lists it
by name under `static_evidence.env_passthrough` or
`verification.env_passthrough`. So the author's code a command delegates to no
longer receives the reviewer's tokens (`GITHUB_TOKEN`, `GH_TOKEN`,
`ANTHROPIC_API_KEY`) or Review Voice's own `REVIEW_VOICE_*` variables, unless a
repository lists them. A passed-through value of eight characters or more that a command prints, in a diagnostic, a version line or a verifier's reason, is replaced by `[redacted:NAME]` before the report is stored or handed to the agents. This is environment scrubbing, not filesystem isolation. The command still
runs as the reviewer, so one that runs the author's code can still read any
file the reviewer can, including credential files under `HOME` such as a
registry's `.npmrc` or the GitHub CLI's hosts file. For that the defences are
unchanged: list no command for a head you do not trust, keep
`REVIEW_VOICE_NO_COMMANDS` on a watcher, and the confined runner S16 specifies. A command that needs a variable, such as a private registry's token, keeps
working once the repository lists that variable; until then it runs without
it. The lists are read from the same configuration as the commands, the base
commit's for a pull request, so a pull request cannot widen what its own
checks receive.

## Amendment - 2026-11-09

A configured reproduction runner (`reproduction.runners`, S16) is
configuration like a static check. Detection suggests nothing for it, and its
`run` string, with `{file}` replaced by a single-quoted path the CLI chose, is
the only command text that runs. The file it runs is a reproduction the
evidence-verifier wrote for one blocking or important finding, in thorough
mode only, when the base commit's configuration turns the block on. It runs
only inside the confined runner (`src/evidence/reproduce.ts`), only after a
probe through the same wrapper has shown that the network, a write outside
the reproduction's own throwaway copy of the head worktree and its scratch
directory, an overwrite of the runner's own files and a read of the run
directory are all refused, and never on a platform where that cannot be
shown, so on macOS nothing runs until issue #321. Its exposure is the runner's
stated limits. It can read the user's other files (read-only on Linux), its
output reaches the challenger's model after redaction, code under review can
sense the sandbox and pass on purpose, and it can spend its time limit. A
reproduction that does not fail holds its finding as
`reproduction-did-not-fail`, except in a category no suppression may reach
([0032](0032-approved-policies-are-enforced-at-scoring.md)), where it is
recorded and shown but never holds. `REVIEW_VOICE_NO_COMMANDS` turns it off
like every other command. "Ship an execution sandbox" stays rejected for
anything broader than one configured command running one verifier-written file
through one platform mechanism behind a probe.

## Amendment - 2026-11-10

A configured runner, `runners.<family>.command`, is a configured command in
the sense of this record (S17). It runs an agent, the second pass or the
challenger, on another model family, `codex` or `gemini`, as an argv list and
never a shell string; `{schema}`, `{output}` and `{cwd}` are the only tokens
Review Voice replaces. Its sandbox is the external CLI's own, chosen by the
flags the configuration names, which the runner cannot narrow. The exposure is
that an external agent may run repository code or reach the network whenever
those flags allow it, so the configuration names a read-only, no-network
sandbox and the operator checks it against the installed version. It runs only
when named in configuration, in the detached head worktree, with the minimal
environment of issue 279 plus the names `runners.<family>.env_passthrough`
lists, and never under `REVIEW_VOICE_NO_COMMANDS=1`. A second-pass runner that
is refused or cannot run does not hold. The second pass is skipped, or its
verdicts are unverified, and the findings go on unchanged, as with a shell
verification command. Its answer counts only with exit status 0. A runner that
exits with any other status, is killed by a signal or times out did not run,
whatever it printed, so a CLI that failed cannot drop a finding. Its answer is
read from stdout, or from `{output}` when the command names it, and never from
stderr, so a verdict a CLI logs there while reading the tree under review
decides nothing. A shell
`verification.command` keeps its old exit-status reading and still reads both streams. A configured challenger that cannot run holds the
challenged findings rather than passing them, and so does a `runners.use`
value that names no family, which is never read as Claude. No incremental or
interdiff review releases such a hold, whether or not it read the file. A
full review (`review --full`) re-checks the finding once the runner works
(ADR 0024).

Unlike the other configured commands, `runners:` is read only from the
operator's own configuration: the file `--config` names, an absolute
`REVIEW_VOICE_CONFIG`, or the Action's `config` input, which arrives as
`--config`. A `runners:` block in a repository's own file, at a pull request's
base commit or in a checkout, is ignored with one warning that names the rule,
because a runner is a command the operator's machine executes and a repository
must not choose it. The source is stated, never inferred from a path being
passed. `loadConfig` takes it beside a path, and a path with none is
repository content. Whoever hands a file to another process through
`REVIEW_VOICE_CONFIG` sets `REVIEW_VOICE_CONFIG_SOURCE` beside it. `watch`
states `flag` only for its own `--config`, `env` for an operator
`REVIEW_VOICE_CONFIG` and `checkout` otherwise, and the review driver keeps an
inherited source and states its own for `--config`, the base commit or the
defaults. An absolute `REVIEW_VOICE_CONFIG` with no source beside it is the
operator's own environment.
`doctor` reports whether `codex` and `gemini` are on `PATH` as information and
never runs a configured command: detection suggests, configuration enables.
