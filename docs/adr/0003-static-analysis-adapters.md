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

One format adapter covers many tools. A `sarif` adapter, first in the list,
parses any configured command's output that holds a SARIF 2.1.0 document,
whatever the tool's name, so the adapters the decision lists (`tsc`,
`eslint`, `pytest`, `go vet`) are illustrative, not the set. The recorded
SARIF documents under `fixtures/sarif/` are the "recorded tool output" the
consequences name.

The adapter reads only what a configured and enabled command printed. A
version read from the document's own `tool.driver` is not a run of anything,
so "detection suggests, configuration enables" holds; a configured `version`
command's line still wins over it, and the document's stands in when that
command is not set or failed. The exposure is unchanged. The configured
scanner runs with the host's network, so a rule or database download
(`semgrep --config auto`, trivy's database) is that command's choice, and the
example configuration avoids both. A result's snippet, code flows, fixes,
fingerprints and properties are never copied, because a snippet is the
matched text and for a secrets scanner that is the secret. A passed-through
value is masked in a message before the adapter collapses, redacts and cuts
it, because a value changed or cut no longer matches, so the issue 279 mask
holds for SARIF output as it does for text.

Four rules followed from review. Text output is masked and redacted whole, as
printed, before its terminal sequences are removed and before an adapter takes
a line of it, because a sequence beside a secret is the word boundary its
pattern needs and a key block spans lines. A SARIF document is not cleaned as
text, which could break it, and its fields are cleaned once parsed. An
artifact location that names a `uriBaseId` is read under that base when the
run's `originalUriBaseIds` defines it with a uri and no base of its own, as it
stands when the run does not define it, and has no path when the base is
chained or has no uri. A `message.text` given with arguments is filled from
them as a referenced message is. Two results are one repeated only when the
tool wrote the same place, line, rule id and message, which is decided before
cleaning and the cut, by a digest that is not stored.

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

## Amendment - 2026-11-10

The macOS reproduction sandbox is hardened (issue #321), but macOS still
reports the sandbox unavailable, so nothing runs there. `probeSandbox` returns
mechanism `none` on darwin, without running the probe, with a reason saying
reproductions stay off until each run has an identity or environment of its
own. The profile, the probe with its notification check, and the System V IPC
check below are in place and tested, so turning macOS on is one change to
`probeSandbox`. `sandbox-exec` gets an allowlist profile in place of the
profile that started from `(allow default)` and denied what it named. The
profile starts from `(deny default)` and allows
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
ipc-sysv*)` included, stops that. So the CLI brackets each run instead. Before
the run and after it ends it lists the System V IPC objects (`ipcs -c`). An
object the user owns or created that is listed after the run, and was not
listed before it under any owner, appeared while the run lasted. The CLI
cannot tell one the run made from one another program of the same user made in
that window, and removing the latter could destroy that program's state, so
the CLI removes none of them. It records the run as not run with a reason
naming System V IPC that lists each such object's type and id and says it was
left in place, so a person can inspect it, and the run's result neither holds
nor clears a finding. A listing that fails, or leaves out a facility, also
records the run as not run. An object a run made stays until the user removes
it or the machine restarts. The check does not stop a run from using up, while
it lasts, the few objects the system holds (32 shared memory segments by default), so other
programs can fail to create one until a person removes them. An object another
program of the same user creates while a run lasts is named as if the run had
made it, and the run recorded as not run. Two limits remain. A process the run
leaves behind can create an object after the listing that follows the run,
which no check sees. And a stop signal that ends the CLI during a run ends it
before the listing after the run, so what that run made is neither seen nor
recorded. These limits, with the user identity a run shares with every other
program of the user, are why macOS reproductions should stay off until runs
execute under an identity or environment of their own. File reads of
terminal devices (`/dev/tty*`, `/dev/pty*`, `/dev/cu.*` and `/dev/ptmx`) are
denied after every read the profile allows, since a run, or a process it leaves
behind, could otherwise take what is typed into another session. The probe
keeps every check it had and adds one, a notification post, which a listener
outside the sandbox judges, since a refused post exits 0 too. The CLI starts
one listener, `notifyutil -w <escape> -1 <post> -1 <pre>`, for three fresh
random keys, and reads each line as the listener prints it. The three keys
share one port, and notifyd sends to it in the order it takes the posts while
the port has room. The listener runs without `-M`, which passes each
notification through a concurrent queue inside the listener: with it, two
notifications that waited together were printed in the wrong order in 12 of 150
trials on this Mac, and without it in none of 450. Before the probe the CLI
posts `<pre>` until the listener prints it. `<pre>` is the last key the
listener registers, because notifyutil registers its keys in the order given,
and one notified of a key while it still has others to register exits, crashes
or goes deaf: with `<pre>` posted without pause as the listener started, 61 of
200 listeners did so on this Mac when `<pre>` was registered first, and none of
300 when it was registered last. So `<pre>` printed, and nothing else, shows
the listener holds all three keys and hears; if that takes more than 5 seconds,
the listener ends first, or it has printed any other line, the probe fails. The
probe posts `<escape>` from inside. Once it is back the CLI posts `<post>` and
waits, up to 5 seconds, for the listener to print it. notifyd took the probe's
post first, so `<escape>` printed before `<post>` is the escape `notify`, and
`<post>` with no `<escape>` shows the post was refused. `<post>` counts only
when the listener prints it after the CLI began to post it: one that had
printed it already, before the probe or while it ran, has not shown that it
still heard once the probe was back, so the CLI does not post and the probe
fails. The order is not all the CLI relies on. A listener held still until its
port fills is sent what it missed newest registration first, which puts
`<post>` ahead of `<escape>`, so `<escape>` printed after `<post>` is the
escape `notify` as well. That order is not guaranteed once the port has been
full, and an `<escape>` line still to come when the listener is killed is lost,
so a second check rests on no order. The probe sets the state of `<escape>`
before it posts it. A key keeps its state only while some process holds it, so
the listener holds `<escape>` with `-w`, which lasts until it is killed, rather
than `-1`, which ends at the first notification. Once `<post>` is printed the
CLI reads that state from outside (`notifyutil -g <escape>`) while the listener
still runs, and any value but the default 0 is the escape `notify`, whatever
the listener printed. A state that cannot be read, a reply that is not
`<escape>` and a number, and a listener that ended before the read was answered
fail the probe. The CLI decides only after that read, so an `<escape>` line
the listener prints while the state is read is the escape `notify` too. The
probe passes only if its own attempt ran: the subprocess that sets and posts
`<escape>` must have started and exited 0, the status a refused attempt gives
under the real profile, where notifyutil prints that the call failed and still
exits 0. One that could not start, was killed, ran past 5 seconds or exited
with any other status has tested nothing, and the probe fails with `could not
test notifications` and the reason. Anything else fails the probe:
a listener that never prints `<post>`, one that printed `<post>` before the CLI
posted it, one that has ended, however it ended, while it still had `<escape>`
to wait for, or one that prints any other line. So no fixed wait decides the
answer, and a listener that died is never read as one that heard nothing. The
CLI never posts `<escape>` itself, and kills the listener with its process
group whatever happened. As before, a probe that fails means nothing runs.

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

To turn macOS on, each run has to execute under an identity or environment of
its own, such as a separate user account or a virtual machine, rather than the
user's. Every process and System V IPC object a run leaves behind then belongs
to that identity alone, so the CLI can list and remove them whole, which also
closes the two System V IPC limits above. Until then `probeSandbox` keeps
reporting macOS as `none`.
