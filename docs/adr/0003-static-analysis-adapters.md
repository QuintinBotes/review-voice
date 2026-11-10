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

Reproductions now run on macOS too (issue #321), through `sandbox-exec` with an
allowlist profile in place of the profile that started from `(allow default)`
and denied what it named. The profile starts from `(deny default)` and allows
only what a test runner such as `node --test` or `npm test` needs: process fork
and exec, sysctl reads, signals to processes in the same sandbox, file reads
outside the hidden locations, and file writes in the reproduction's copy, its
scratch directory, `/dev/null` and its own open descriptors by path
(`/dev/fd/<n>`, so `/dev/stdout` and `/dev/stderr` work), which grants no access
a descriptor did not already have. It allows one mach service,
`com.apple.system.opendirectoryd.libinfo`, because `os.userInfo`, git and
Python's `pwd` look up the user (getpwuid) and fail without it; the service
answers read-only user and group lookups and cannot change anything. Every
other mach service, the network, POSIX IPC, Apple events and preferences stay
denied by default. `(deny default)` does not reach IOKit properties, NVRAM or
process information, which would name the machine (its serial number and
platform UUID) and list other processes and their paths, so the profile denies
them by name: `(deny iokit-get-properties iokit-set-properties)`, `(deny
nvram*)`, and `(deny process-info*)` followed by `(allow process-info* (target
self))`, since a process reads information about itself. The sysctls under
`kern.proc` list every process too and give another process's command line,
which can carry a token passed as an argument, so `(deny sysctl-read
(sysctl-name-prefix "kern.proc"))` follows the sysctl reads the profile allows.
The kernel does not ask the sandbox before it creates a System V IPC object, so
a run can create a shared memory segment, a semaphore set or a message queue,
though it can neither use nor remove one, and no profile rule, `(deny
ipc-sysv*)` included, stops that. Such an object outlives the run until `ipcrm`
or a restart, and the CLI does not remove it; the system holds few of them (32
shared memory segments by default), so a run can use them all up. File reads of
terminal devices (`/dev/tty*`, `/dev/pty*`, `/dev/cu.*` and `/dev/ptmx`) are
denied after every read the profile allows, since a run, or a process it leaves
behind, could otherwise take what is typed into another session. The probe
keeps every check it had and adds one: the CLI starts `notifyutil -1` for a
fresh key outside the sandbox, the probe posts that key from inside, and any
output from the listener is the escape `notify`, since a refused post exits 0
too. The listener is always stopped. As before, a probe that fails means
nothing runs.

A process a reproduction starts can leave the process group and outlive the run
on macOS, where no pid namespace ends it. It inherits the CPU limit (`ulimit -t
<cpu_seconds>`), and at the limit the kernel ends a process that spins or keeps
making ordinary system calls. One that sleeps, handles SIGXCPU or keeps reading
its own CPU usage (getrusage, as Node's `process.cpuUsage` does) is not ended:
it stays until the user logs out, and in the last two cases keeps using CPU
until then. It stays confined by the profile: no network, no POSIX IPC, and no
write outside its own copy and scratch directory, which are removed after the
run, so nothing it writes reaches a later stage. Reads of the user's other
files stay allowed, read-only, outside the hidden locations, as on Linux.
`sandbox-exec` is deprecated by Apple, so a macOS release can change what it
enforces, and the probe before the first reproduction of each invocation is what
shows it still holds.
