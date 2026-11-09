# S16. Execution-based verification: reproductions run in a confined runner in thorough mode

**Phase:** 6 (evidence that runs). **Depends on:** S08 (`spawnInGroup`, the
`restates-tool` held-verdict pattern, `didNotRun` with reasons), S09
(`RecordedChecks` stored with the run, the held-verdict mapping with `other`),
S03 (run-directory retention). Independent of S10 to S14 in logic; S14 also
edits `agents/evidence-verifier.md`, so place the new section by its heading.
S15 posts the challenger's decisive lines and drops any that names a local
path, which is what keeps a cited reproduction copy off the pull request.
Once S12 has moved `cli.ts`, locate code by function name in `src/cli/`; the
#262 fix (`evidence --cwd`, branch `professionalisation/fix-262-evidence-in-head`)
changes `evidenceCommand` and the driver's `prep`, so locate those by name too.
**Size:** about 800 source lines (part A about 450, part B about 350), 650
test lines, two fixtures, one new section in two agent files, three ADR
amendments and one threat-model subsection; two Orbit runs (part A, part B).
**Risk:** high by nature, because the runner executes code from the pull
request, so every part of it is off by default, opt-in through configuration
read from the base commit, gated on a probe that proves the confinement before
anything runs, and recorded with its limits named. Baseline
`professionalisation/s11-risk-routed-lanes` at `3fb8443` (S01 to S11 and S13
present). Verified against the code on 2026-11-08.

## Why

Review Voice verifies by reading. The verifier has Read, Grep and Glob
(`plugins/review-voice/src/agents/tools.ts:9`; `runnerTools` at `:75-85` drops
`Bash(git:*)`), the challenger the same, and the only place repository code
runs is a configured static check (`src/evidence/run.ts:61-134`, ADR 0003).
The market research report of 2026-11-08 (section 4.2, item 1; section 5,
item 2) ranks execution-based verification second among the additions worth
making, because a reproduced failure is the strongest evidence a finding can
carry and the hardest thing for an author to dismiss. Codex, Copilot,
CodeRabbit (for security findings) and Baz run code; Review Voice does not.

ADR 0003 rejected "ship an execution sandbox" as large scope for a plugin, and
that still holds for an unbounded sandbox. What this spec adds is narrower.
The command that runs is configuration. The file it runs is a reproduction the
verifier wrote for one blocking or important finding. The runner is confined
by the operating system's own tools, and a probe refuses to run anything when
the confinement cannot be shown.

The pieces exist. `spawnInGroup` (`run.ts:156-175`) runs a command in its own
process group with a wall-clock timeout, SIGKILL and an output cap, and kills
what the group leaves behind. The driver's `prepareWorkspace`
(`src/review/driver.ts:538-586`) builds a detached head worktree under the run
directory with hooks, LFS filters, fsmonitor and submodule recursion off
(`SAFE_GIT`, `:523-530`) and removes it on exit (`:588-594`). `childEnv`
(`src/agents/claude-cli.ts:17-23`) shows the environment rule for a child that
reads untrusted input. The stage table (`src/review/stages.ts:30-61`) is where
a stage is added and `StagePlan` (`src/review/plan.ts:18-28`) is where thorough
mode decides what runs. The challenger's prompt is an allowlist of fields
(`src/verify/challenge.ts:81-121`), so one more fact is a small change. S08
showed how a new held verdict reaches the record and `explain` (`HeldVerdict`,
`src/store/runs.ts:119-154`; the held line at `cli.ts:4332`), and S09 how a
per-run fact is stored (`RecordedChecks`, `runs.ts:427-436` and `:782`).

What does not exist: confinement for any process that is not `claude`, a rule
for a reproduction that passes, times out or is flaky, a way for the
challenger to see an observed failure, and a threat-model statement that
covers a runner executing pull request code.

## Outcome

In thorough mode, when a repository has opted in, the verifier writes a
reproduction for each blocking or important candidate it verifies. The CLI
runs it twice on the head worktree inside a confined runner with no network,
no writes outside the worktree and its own scratch directory, and time, CPU and memory
limits, and records the exit codes and output. A reproduction that fails both
times is evidence the challenger reads. One that passes, or passes once, holds
the finding as `reproduction-did-not-fail` with a reason that says which. One
that could not run, or did not reach its assertion, changes nothing about the
finding and is recorded as not run with the reason. Nothing new is posted; the
hold only removes a finding from the posted set, and `evaluate` reports how
often it did.

## Design

### Part A. The runner

#### Configuration

A new top-level block in `.review-voice/config.yaml`, read by `loadConfig`
(`src/policy/load.ts`; `KNOWN_TOP_LEVEL` at `:694` gains `reproduction`, the
defaults near `:774` gain
`reproduction: { enabled: false, runners: [], linkPaths: [], memoryMb: 1024, cpuSeconds: 60 }`),
parsed beside `static_evidence` (the block beginning at `:822`, which skips a
malformed command silently), with a warning for each dropped entry as an
invalid lane gets one (`load.ts:275`):

```yaml
reproduction:
  # Off by default. In thorough mode the verifier may write a reproduction for
  # a blocking or important finding; the CLI runs it on the head worktree in a
  # confined runner (no network, writes only inside the worktree), and only
  # through a runner listed here. Running pull request code is the risk this
  # switch accepts (docs/adr/0003, docs/THREAT-MODEL.md).
  enabled: false
  runners: []
  # Example:
  #   - name: node-test
  #     run: node --test {file}
  #     extension: .test.mjs
  #     timeout_seconds: 120
  # Directories of your clone linked into the worktree so a reproduction can
  # import installed dependencies. The sandbox keeps them read-only. None by default.
  link_paths: []
  memory_mb: 1024
  cpu_seconds: 60
```

Rules. `runners[].name` matches `^[a-z][a-z0-9-]*$`. `run` is a string that
contains `{file}` exactly once and no other brace placeholder. `extension`
matches `^\.[A-Za-z0-9.]{1,15}$`. `timeout_seconds` is a whole number from 1
to 600, default 120. `link_paths` entries are single path segments
(`node_modules`, `.venv`), no slash, not `.` or `..`. `memory_mb` is from 64
to 16384 and `cpu_seconds` from 1 to 600. A runner failing a rule is dropped
with a warning naming it, as an invalid lane is. The `run` string is
configuration and the only command text the runner ever executes; `{file}` is
replaced with the single-quoted worktree-relative path the CLI chose (see
"Placing the file"), never with model or repository text. That keeps ADR 0003's
rule exactly. `init` proposes no runners; detection suggests nothing here.

`REVIEW_VOICE_NO_COMMANDS=1` turns the block off for a run, as it does static
evidence and the second pass (`driver.ts:210`, `cli.ts:2859-2863`), so `watch`
with `run_repository_commands: false` (the default) and `recall --fixtures`
never run a reproduction. The comment on `watch.run_repository_commands` in
`templates/config.example.yaml:263-266` gains "and reproductions". The
`context` command's payload (`cli.ts:942`, where `staticEvidence` is written)
gains `reproduction: { enabled, runners }`, so the driver can read the runners
from `context.json` the way it reads configured check names (`driver.ts:447-448`).

#### The `reproduce` command

`src/evidence/reproduce.ts` (new) holds the runner. `cli.ts` gains
`reproduce` beside `evidence` (`evidenceCommand`, `cli.ts:2851-2878`),
documented in `help.ts` after the `evidence` entry (`help.ts:200-214`):

```
review-voice reproduce --worktree <dir> --verification <file> --candidates <file> --out <file> --run-dir <dir>
review-voice reproduce --worktree <dir> --run-dir <dir> --probe
```

It loads the configuration the way `evidence` does
(`loadConfig(repositoryRoot(process.cwd()))`, which honours the driver's
`REVIEW_VOICE_CONFIG` resolution, so a pull request review reads the block
from the base commit as S01 requires). With `enabled: false`, no runner, or
`REVIEW_VOICE_NO_COMMANDS=1`, it writes
`{ enabled: false, sandbox: null, reproductions: [], skipped: <reason> }`,
exits 0 and spawns nothing, as `notRunReport` does (`run.ts:26-34`). Exit
codes: 0 ok (an outcome of any kind is a result), 2 bad invocation or
unreadable input.

For each `verifications[]` entry that carries `reproduction` and whose
candidate (from `--candidates`, read with `candidatesById`,
`challenge.ts:53-63`) has requested `severity` of `blocking` or `important`,
it runs the reproduction and appends a record. An entry on a candidate of
another tier is recorded as `did-not-run` with reason
`tier <severity>: reproductions run for blocking and important findings only`,
and nothing is spawned for it.

#### The record

`reproductions.json`, written to `--out`:

```ts
interface ReproductionReport {
  enabled: boolean;
  skipped?: string;
  sandbox: { platform: string; mechanism: 'sandbox-exec' | 'unshare' | 'none'; probe: 'passed' | string } | null;
  reproductions: ReproductionRecord[];
}
interface ReproductionRecord {
  candidateId: string;
  path: string;                 // the candidate's anchor, for explain and the held entry
  line: number;
  runner: string;               // the configured runner's name
  file: string;                 // worktree-relative path the reproduction ran from
  copy: string;                 // the copy kept under <run dir>/reproductions/<candidateId>/
  expected: string;             // the verifier's one-sentence expectation, for the record only
  outcome: 'reproduced' | 'did-not-fail' | 'did-not-run';
  reason?: string;              // did-not-fail: which run passed; did-not-run: why
  runs: { exitCode: number | null; durationMs: number; reached: boolean; output: string }[];
}
```

`output` is stdout then stderr, passed through `redact`
(`src/redact/redact.ts:37`) and capped at 8 KiB per run with the first bytes
kept, because a reproduction can print anything the worktree can read and the
record lives for `retention.runs_days` (S03). `sandbox.probe` is `passed` or
the first line of what failed. The report and the copies live in the run
directory, so the retention sweep removes them with the rest.

#### Placing the file

The verifier's `reproduction.path` is accepted only when it is relative, uses
forward slashes, has no `..` or empty segment, uses only letters, digits,
`.`, `_`, `-` and `/` (so the single quotes around `{file}` cannot be
closed), ends with
the chosen runner's `extension`, names a directory that already exists in the
worktree and, resolved through links with `realpathSync`, still lies inside
the worktree and not under a `link_paths` entry (a tracked symlink in the pull
request, or a linked `node_modules`, would otherwise make the CLI itself
write outside it), and names a file that is neither tracked at the head
(`git ls-files --error-unmatch` fails) nor present on disk. Anything else is
`did-not-run` with reason `path refused: <rule>`. The CLI writes `content`
there before each run, copies it to `<run dir>/reproductions/<candidateId>/<basename>`
before the first, runs, and removes the worktree file. Before and after each
run it takes `git status --porcelain --untracked-files=all --ignored=matching`
with `SAFE_GIT` (exported from `driver.ts`) and with `--git-dir` and
`--work-tree` pinned to the values resolved before the first run, so a
reproduction that rewrites the worktree's `.git` file cannot point git at a
configuration it wrote (a clean filter there would run outside the sandbox).
Ignored paths count because the pull request controls `.gitignore`. When
anything other than the reproduction file differs after a run, the record is
`did-not-run` with reason `the reproduction modified the worktree (<n> paths)`
and the worktree is restored with `git checkout -- .` and `git clean -fdxq`,
with an `-e` exclusion for each `link_paths` entry, both pinned the same way.
The challenger reads that worktree next, and a reproduction that edits it
could show the challenger code the author never wrote.

`link_paths` entries that exist in the clone the CLI runs in (`process.cwd()`)
and not in the worktree are symlinked into it before the first reproduction
and removed after the last. The sandbox decides what a reproduction may do
through the link: read, never write (below). Each link's target is allowed
for reading by name, because the watcher's clones sit inside the data
directory (`watch/command.ts:192`), which the sandbox otherwise hides.

#### Amendment 2026-11-09: a throwaway copy per reproduction

This amendment changes "Placing the file", the parts of "Confinement" that
name the worktree or the macOS mechanism, the first rule of "The reach marker
and the flaky rule", and every other part of this spec that has a reproduction
run on the head worktree, restores the worktree, or links `link_paths` into it
and removes them. Those are the Outcome, the comment in the Configuration
sample, "Tests for part A", AC-2, AC-3, AC-4 and the Orbit goal for part A, and
"Where the earlier text differs" below gives each as amended. Where they
differ, this amendment wins.

Why. On macOS a process that a reproduction starts with `setsid`, or with
Node's `detached: true` (posix_spawn with POSIX_SPAWN_SETSID), leaves the
process group. It outlives the run, the group kill and a stop signal. It stays
inside the sandbox, so it has no network and writes only where the run could,
but the run could write the head worktree, and so it could write that worktree
after the modification check, where the challenger reads next. Denying
`setsid` in the profile, a nested sandbox and a reaper inside the same sandbox
instance were each tried and none closes it. Linux is not affected, because
the pid namespace with `--kill-child` ends every descendant, but the design
below is the same on both platforms. The rule it keeps is that nothing a
sandboxed process can write is read by any later stage. The same process is
why the change check no longer runs git and the file is written only once,
since after a run nothing the CLI does in the copy may depend on what the copy
now holds.

What changed.

- macOS is off until issue #321, which hardens the sandbox-exec profile before
  macOS runs a reproduction. On darwin `probeSandbox` returns
  `mechanism: 'none'` with probe
  `sandbox-exec is not yet trusted to confine a reproduction (issue #321)`,
  before it writes or spawns anything, so every reproduction there is
  `did-not-run` with that reason and `reproduce --probe` prints it. The
  profile, the macOS wrapper, the probe's macOS escapes and their unit tests
  stay for #321; the probe body is `runProbe`, which a reproduction reaches
  only through `probeSandbox`. The tests that need a real sandbox run where
  the probe passes, which is the Linux CI job, and skip with the probe's
  reason elsewhere; every rule also has a test through the injected spawn on
  the Linux wrapper, which runs on every host.
- The head worktree is never writable by a reproduction. Each candidate's
  reproduction runs in its own throwaway copy of it, made with `cpSync`
  (recursive, `verbatimSymlinks`, `COPYFILE_FICLONE`, never overwriting), so
  APFS and reflink filesystems clone and others copy, and a relative link in
  the copy resolves inside the copy. A copy that cannot be made is
  `did-not-run` with reason `could not copy the worktree: <first line>`, and
  the next candidate still runs.
- Every execution gets a fresh directory,
  `<run dir>/reproductions/trees/<candidateId>-<random>/`, made with
  `mkdtempSync`, so a directory left from before is never used or removed.
  The copy sits at `tree` and the scratch directory (its HOME and TMPDIR) at
  `scratch`. `trees` is a reserved name. The sandbox may write only those two,
  never the directory that holds them, so a process one candidate leaves
  behind cannot reach another candidate's run. The `<scratch>` of
  "Confinement" is this per-execution directory. A second verification entry
  with a candidate id already seen in the invocation is `did-not-run` with
  reason `duplicate candidate id`, and nothing is spawned for it, since the
  kept copy of the file and the record are named by the id.
- Placement is checked in the copy, where the CLI writes. A tracked absolute
  link that points into the head worktree is refused with
  `its directory resolves outside the worktree`. `link_paths` are linked into
  each copy before its first run, and never into the head worktree. git runs
  in a copy only before its first run, for `rev-parse` and the placement
  rule's `git ls-files`, pinned per copy and with `GIT_OPTIONAL_LOCKS=0`,
  because the copy's `.git` names the head's git directory. After any
  reproduction has run in a copy, the CLI runs no git command in it.
- The file is written once, into the fresh copy, before run 1, never over an
  existing entry, and the CLI neither removes nor rewrites it between runs.
  No reproduction has run in the copy before that write (only the probe, the
  CLI's own script), so no directory check guards it, and there is no second
  write for a link left by run 1 to redirect.
- The change check is a walk of the whole copy that uses `lstat` and never
  follows a link, with each entry keyed by its path as raw bytes, so a name
  that is not UTF-8 never decodes to a sibling's name and is never read as
  that sibling. A file or a link records its mode, inode, size, mtime and
  ctime; a directory its mode and inode, its own times left out, since every
  name in it is an entry of its own. The links the CLI made and the
  reproduction's own file are entries like any other, so a link re-pointed or
  replaced and a change to the file are changes. The baseline is taken after
  the write. The check runs after run 1, again before run 2, and after run 2,
  so a change made after run 1 was checked (by a process run 1 left behind)
  keeps run 2 from starting. A walk is capped at twice the baseline's entry
  count plus 10000; a walk past the cap, or one that fails, is `did-not-run`
  with reason `the reproduction modified the worktree (<reason>)`, the reason
  being `more than <cap> entries` or `walk failed: <code>`.
- There is no restore. A run that changes anything is `did-not-run` with
  reason `the reproduction modified the worktree (<n> paths)`, and no further
  run happens in that copy. After a candidate's last run, after a throw, or on
  a stop signal, the copy and its scratch are removed; a removal that fails is
  named on stderr as `reproduce: could not remove <path>: <reason>` and never
  costs the report, and the retention sweep removes what is left. The
  execution's directory is first renamed to a dot-name,
  `.<candidateId>-<random>-<hex>`, which no profile allows and no candidate id
  can take, because Node's recursive delete reads each directory by its path
  and a process left behind could otherwise swap one for a link to anywhere
  while the delete walks it. The sandbox judges the path an operation names
  when it is made, so after the rename nothing confined can change the
  directory. One that cannot be renamed is left in place rather than walked.
- An exit status of 137 or 152 (SIGKILL or SIGXCPU, as a shell reports a child
  a limit ended) is `did-not-run` with reason
  `may have been stopped by a resource limit (exit <code>)`, beside the rule
  for a runner's own `signal: 'SIGXCPU'` or `signal: 'SIGKILL'` line, which is
  `may have been stopped at the <cpu_seconds>s CPU limit`. A limit stop proves
  no more than a timeout does.
- Signals, kept for #321. The macOS profile has `(deny signal)` followed by
  `(allow signal (target same-sandbox))`, so neither a reproduction nor a
  process it leaves behind can signal the CLI or any other process of the user.
  The macOS probe has a fifth escape, `signal`, which is seen when the probe
  can send signal 0 to the CLI's own pid (EPERM when the rule holds). The
  Linux probe does not try it: the pid namespace shows no outside process, and
  the CLI's host pid can name one of the namespace's own processes (a CLI that
  is pid 1 of a container), which would fail the probe for no escape.
  `reproduce --probe` uses the head worktree as its layout, since the probe
  writes nothing there.
- Preferences, kept for #321. The macOS profile also has
  `(deny user-preference-write)`. cfprefsd writes a named preference domain
  into the user's real `~/Library/Preferences` for the process that asks,
  whatever its `HOME`, and the sandbox checks that as a preference write,
  never as a file write of the process, so without the rule a reproduction
  could rewrite the preferences of any application. The macOS probe has a
  sixth escape, `preference`, seen when the probe can write a named domain
  with `/usr/bin/defaults`.
- The record is unchanged. `file` is the worktree-relative path and `copy` is
  `<run dir>/reproductions/<candidateId>/<basename>`, outside every writable
  place.

What part B relies on. The head worktree after `reproduce` is exactly as the
driver made it, so the challenger reads the head worktree and, for a
reproduction, the file at `copy`, and no stage reads anything a reproduction
could write. On macOS every record is `did-not-run` until #321, so part B
holds nothing there on a reproduction.

Where the earlier text differs.

- The Outcome. On Linux the CLI runs a reproduction twice in a throwaway copy
  of the head worktree, with no writes outside that copy and its own scratch
  directory. On macOS it runs none until #321.
- The Configuration sample. Its comment reads as it does in
  `templates/config.example.yaml`, which is the block AC-1 checks the template
  against. The CLI runs a reproduction in a throwaway copy of the head
  worktree, which it writes only inside and which is removed after, on Linux
  only until #321, and `link_paths` are linked into each copy.
- "Confinement". The macOS mechanism is kept as written for #321, and
  `probeSandbox` reports `mechanism: 'none'` on darwin until then.
- "The reach marker and the flaky rule". The first rule also covers an exit of
  137 or 152, with the reason above.
- "Tests for part A". The skipped report and the absent `reproductions`
  directory show that nothing was spawned. A touch-marker runner shows nothing
  now, because a confined run writes only inside its copy and its scratch
  directory, and both are removed with it. "`link_paths` linking and removal"
  reads "`link_paths` linked into each copy and never into the head worktree".
  The macOS wrapper and profile are checked as unit tests of `wrapperArgv` and
  `sandboxProfile`, and the runner's rules through the Linux wrapper.
- AC-2, as amended. `reproduce` with `enabled: false`, with no runner, or under
  `REVIEW_VOICE_NO_COMMANDS=1` writes the skipped report and spawns nothing
  (no `reproductions` directory is made); `reproduce --probe` prints the
  `sandbox` object and runs no reproduction.
- AC-3, as amended. With an injected `spawn`, the runner builds the platform
  wrapper argv, the `ulimit` line and the allowlisted environment as
  specified, substitutes `{file}` once with a single-quoted path, runs at most
  twice, and classifies every branch of the reach-marker and flaky rules into
  `reproduced`, `did-not-fail` and `did-not-run` with the specified reasons,
  an exit of 137 or 152 included; output is redacted and capped at 8 KiB per
  run; a path failing any placement rule is refused with its rule, a
  symlinked directory leaving the copy, an absolute link into the head
  worktree and a single quote included; a run that modifies its copy, an
  ignored path and its own file included, a change to the copy after run 1
  was checked, a walk past the cap and a walk that fails are each
  `did-not-run` with no further run, the head worktree untouched and the copy
  removed; the file is written once and run 2 meets the same file; no git
  runs in a copy after a run, and every git call before carries the pinned
  `--git-dir` and `--work-tree`; every execution gets a fresh directory, and a
  second entry for one candidate id is `did-not-run`; on darwin the probe is
  `none` and nothing is spawned; the macOS profile's only writable paths are
  the candidate's copy and its `<scratch>`; `link_paths` are linked into each
  copy before its first run and never into the head worktree
  (`test/reproduce.test.mjs`).
- AC-4, as amended. On macOS the probe reports the #321 reason, so the test
  takes the branch where the sandbox is unavailable; the probe-passed branch
  is proven on the Linux CI job, where `REVIEW_VOICE_REQUIRE_SANDBOX=1` makes
  the unavailable branch fail.
- The Orbit goal for part A. "on the head worktree" reads "in a throwaway copy
  of the head worktree", "sandbox-exec on macOS" reads "none on macOS until
  issue #321", and "only the worktree and <run dir>/reproductions/scratch are
  writable" reads "only that copy and its scratch directory, under a fresh
  <run dir>/reproductions/trees/<candidateId>-<random>/, are writable".

#### The reach marker and the flaky rule

A reproduction must print a line whose text, after any leading `#` and
whitespace, is exactly `RV_REPRO_REACHED <candidateId>`, immediately before
the assertion it expects to fail (`node --test` prefixes console output with
`# `). `reached` records whether a run printed it. The rules, in order:

- A run that could not start, was killed at the timeout or the output cap, or
  exited 126 or 127 (`SHELL_UNAVAILABLE_EXIT_CODES`, `run.ts:19`) makes the
  record `did-not-run` with that reason. A timeout is never a reproduction,
  because a slow test and a hang look the same from outside.
- A run that exits non-zero without the marker is `did-not-run` with reason
  `exited <code> before reaching its assertion`. A missing module or a syntax
  error fails the same way a real defect does, and must not count.
- Run 1 exits 0, marker or not, is `did-not-fail` with reason
  `run 1 exited 0`; there is no second run.
- Run 1 exits non-zero with the marker, so run 2 runs. Both non-zero with the
  marker is `reproduced`. Run 2 exits 0 is `did-not-fail` with reason
  `flaky: run 1 exited <code>, run 2 exited 0`. Run 2 in any `did-not-run`
  state makes the record `did-not-run` with that reason.

Two runs rather than one, because a single failure can be timing. Two passes
are not required, because a reproduction that passes once already fails to
show the defect is deterministic, which is what a posted blocking finding
claims.

#### Confinement

The runner never executes a reproduction without first running the probe once
per invocation, through exactly the wrapper the reproductions get. The
mechanism is chosen by `process.platform` and is the operating system's own
tool, so no dependency is added. Anything else (Windows, or a platform without
the tool) is `mechanism: 'none'`, `probe: 'no confinement mechanism on <platform>'`,
and every reproduction is `did-not-run` with that reason.

On both platforms the inner command is
`/bin/sh -c '<limits>; exec <run with {file} substituted>'`, where `<limits>`
is `ulimit -t <cpu_seconds>; ulimit -v <memory_mb * 1024>; ulimit -f 2097152`
(CPU seconds; virtual memory in KiB; a 1 GiB file-size cap in POSIX 512-byte
blocks), with the worktree as `cwd`, a wall-clock timeout of the runner's
`timeout_seconds` through `spawnInGroup` (exported from `run.ts` and given an
optional `args: string[]` parameter so an argv list runs without a shell), and
an environment built from an allowlist rather than by stripping: `PATH`,
`LANG`, `LC_ALL` and `TERM` copied from the CLI's environment;
`HOME=<scratch>/home` and `TMPDIR=<scratch>/tmp`, both created, where
`<scratch>` is `<run dir>/reproductions/scratch`; `CI=1`, `NO_COLOR=1`. No
token, no `REVIEW_VOICE_*` variable and no `GH_*` variable reaches it, so the
code under review is not told it is being reproduced. The worktree and `<scratch>` are the only
writable places. The profile, the probe script, the copies and
`reproductions.json` sit elsewhere under `<run dir>/reproductions/` and stay
read-only to every reproduction, because a run that could rewrite the profile
would unconfine the next one. Every path
written into a profile or a mount command passes through `realpathSync`
first, because macOS reaches `/private/var` through `/var` and the sandbox
matches real paths, and every string substituted into a `/bin/sh -c`
argument is quoted with the `'\''` rule at each level of nesting.

**macOS.** `/usr/bin/sandbox-exec -f <profile>`, with a profile the CLI writes
under `<run dir>/reproductions/` from a template with every path quoted:

```
(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath "<worktree>") (subpath "<scratch>") (literal "/dev/null"))
(deny file-write* (literal "<worktree>/.git"))
(deny file-read* (subpath "<data directory>") (subpath "<run dir>") (subpath "<clone>/.git")
  (subpath "<HOME>/.ssh") (subpath "<HOME>/.gnupg") (subpath "<HOME>/.aws") (subpath "<HOME>/.config/gh")
  (subpath "<HOME>/Library/Keychains")
  (literal "<HOME>/.netrc") (literal "<HOME>/.npmrc") (literal "<HOME>/.git-credentials"))
(allow file-read* (subpath "<worktree>") (subpath "<scratch>") (subpath "<each link_paths target>"))
```

`<data directory>` is `dataDirectory()` (`src/store/paths.ts:10`), `<clone>`
the clone the CLI runs in (its `.git/config` can hold a token in a remote
URL), and `<HOME>` the CLI's own home, not the scratch one above. The run
directory is denied by name because `review --out` can place it outside the
data directory. Later rules win in this profile
language, so the worktree, which sits inside the data directory as
`<run dir>/head`, is readable and writable while the rest of the data
directory, other runs and the corpus database included, is not. What this
gives: no network of any kind, no write outside the worktree and `<scratch>`,
no read of the listed credential locations or of Review Voice's own store. What it
does not give, stated in the record and the documents: reads of the rest of
the user's files are allowed (a reproduction can read `~/Documents`), because
a deny-by-default read profile needs a carve-out for every toolchain location
and one wrong carve-out turns every reproduction into `did-not-run`;
`ulimit -v` is set but macOS enforces RLIMIT_AS for some allocations only, so
the memory bound there is advisory and the CPU and wall-clock limits are the
bounds that hold; Apple marks `sandbox-exec` deprecated, it ships on every
supported macOS today, and the probe is what says when that stops being true.

**Linux.** `unshare --user --map-root-user --mount --net --pid --fork --kill-child /bin/sh -c '<setup>; <inner>'`
from util-linux, present on every mainstream distribution and on GitHub's
runner images. `<setup>` builds a read-only view of the filesystem inside the
new mount namespace, in this order, so that nothing it needs later is hidden
by an earlier step: mount a tmpfs on `/tmp` (inside the namespace only) and
create `/tmp/root` and the holding points `/tmp/hold/worktree` and
`/tmp/hold/scratch`; bind the worktree and `<scratch>` there and each
`link_paths` target to its own holding point; rbind `/` to `/tmp/root` and
remount it and every mount beneath it read-only (one
`mount -o remount,bind,ro` per entry of `/proc/self/mountinfo` under the new
root, which keeps each mount's locked flags as a user namespace requires);
inside the new root, mount an empty tmpfs over the data directory, the run
directory, `<clone>/.git` and each listed credential directory that exists,
and bind `/dev/null` over each listed credential file that exists (a tmpfs
cannot cover a file); create the original paths inside those tmpfs mounts and
bind the held worktree and `<scratch>` back writable, the link targets back
read-only, and the worktree's `.git` file read-only over itself; mount a fresh
`/proc` for the pid namespace; `pivot_root`; then
`exec` the inner command. `--net` leaves only a loopback that is down, so a
connection to anything, the host's own 127.0.0.1 included, fails.
`--pid --fork --kill-child` means the timeout's SIGKILL to `unshare` ends every
process it started. The limits are the same `ulimit` line, and RLIMIT_AS is
enforced on Linux; V8 reserves address space at start-up, so a low
`memory_mb` can stop `node` itself from starting, which the probe shows
because it runs `process.execPath` under the same line. What it does not give: nothing at all when unprivileged
user namespaces are refused (Ubuntu 24.04 restricts them through AppArmor for
binaries without a profile; Docker's default seccomp profile refuses them), in
which case the probe fails, the report says `unshare: operation not permitted`
and no reproduction runs. Reads of the user's other files are allowed here
too, read-only, with the data directory and the credential list hidden.

**The probe.** A script the CLI writes under `<run dir>/reproductions/probe/`
and runs through the wrapper with `process.execPath`. It must print exactly
`RV_PROBE_OK` for anything else to run, and prints which escape succeeded
otherwise. It tries four: connect to a 127.0.0.1 TCP port the CLI opened and
listens on for the probe's duration (must fail within two seconds); write
`<run dir>/reproductions/probe-escape`, outside the worktree and `<scratch>`
(must fail); overwrite the profile or, on Linux, the probe script itself
(must fail); read a canary file the CLI writes at `<run dir>/probe-canary`
for the probe's duration and removes after (must fail, EPERM on macOS,
ENOENT on Linux where the tmpfs hides it), because a file that might not
exist proves nothing. `spawnInGroup` is synchronous, so the CLI looks at its
listener only after the probe has returned and the event loop has run once;
a connection the kernel queued is seen then. The `sandbox` object tells two
failures apart. Either the wrapper could not start (`unshare: operation not
permitted`, no `sandbox-exec`), or an escape succeeded
(`probe: escaped by <write|read|connect|profile>`). A probe that passes is
cached for the invocation.
`reproduce --probe` runs the probe alone and prints the `sandbox` object, so
an owner can see what their machine gives before turning the block on.

#### Tests for part A

`test/reproduce.test.mjs`, deterministic, no model:

- Configuration: each rule above with its warning; `enabled: false` and
  `REVIEW_VOICE_NO_COMMANDS=1` write the skipped report and spawn nothing (a
  `touch`-marker runner, as `test/s08-tool-driver.test.mjs:47-49` does).
- The runner with an injected `spawn` (the seam `collectEvidence` has,
  `run.ts:63`): the wrapper argv per platform (first element
  `/usr/bin/sandbox-exec` with `-f` on darwin, `unshare` with the listed flags
  on linux), the `ulimit` line, the environment allowlist, `{file}`
  substitution with a single-quoted path and no other substitution, the
  two-run sequence, every branch of the reach-marker and flaky rules, the
  output cap and redaction, the worktree-modification rule (an ignored file
  counts, and every git call carries the pinned `--git-dir` and
  `--work-tree`), the profile text with the worktree and `<scratch>` as its
  only writable paths, `link_paths` linking and removal, and path refusal for
  each placement rule, a symlinked directory that leaves the worktree and a
  path holding a single quote included.
- Confinement, run for real through the bundle in a scratch repository with a
  runner whose `run` is `node --test {file}` and `process.execPath`'s
  directory first on `PATH`: the test opens a loopback listener and runs a
  reproduction that tries the probe's escapes, prints the marker and fails an
  assertion. When `reproduce --probe` reports `passed`, the test asserts the
  listener saw no connection, `probe-escape` does not exist, the profile is
  unchanged, the canary read failed, and the record is `reproduced` with two
  runs. When the wrapper could not start, the test asserts the report names
  the reason, every record is `did-not-run`, the file a reproduction would
  have written does not exist, and prints `sandbox unavailable: <reason>` as
  a diagnostic. A probe that reports an escape fails the test on every host,
  because that is a broken confinement rather than a missing one. With
  `REVIEW_VOICE_REQUIRE_SANDBOX=1` set, the unavailable branch fails too,
  so a CI job can insist on it. `fixtures/confinement/toolchain-bait/README.md`
  gains a paragraph naming this test as the runner's confinement proof and
  `evals/confinement` as the agents'.

The macOS caveat from the program README applies: a loopback listener may be
refused inside an Orbit worker, and Orbit's check run is the proof that
counts.

### Part B. The verifier, the challenger, the hold and the record

#### Plan and stage

`StageName` (`plan.ts:9`) and `StageId` (`stages.ts:7-19`) gain `reproduce`.
`PlanInput` gains `reproductionConfigured?: boolean`, optional and read as
false like `removedControls` (`:36-40`); `planCommand` sets it from
`config.reproduction.enabled && config.reproduction.runners.length > 0` beside
`secondPassConfigured` (`cli.ts:1357`). `resolvePlan` adds
`reproduce: { run: thorough && reproductionConfigured, model: null }` to
`stages` (`:87-100`); every other mode gets `{ run: false, model: null }`. The
`EXPECTED` table in `test/plan.test.mjs:30-43` is extended with
`reproduce: off` in all three modes (its loops never set
`reproductionConfigured`), and one new test asserts that `thorough` with
`reproductionConfigured: true` turns the stage on and `standard` does not.
The mode table in `docs/WATCHER.md:354-363` gains the row, and ADR 0025 gains
a dated amendment.

`STAGES` (`stages.ts:30-61`) gains
`{ name: 'reproduce', kind: 'cli', agents: [], commands: ['reproduce'], onFailure: 'the finding keeps its verification; the reproduction is recorded as not run' }`
between `verify` and `second-pass`, and `HANDLERS` (`driver.ts:1059-1072`) a
`reproduce` handler. The stage graph in `docs/WATCHER.md:260-275` gains the
row and renumbers. The test at `test/review-driver.test.mjs:482-488` compares
agents only, so `commands/review.md` needs no step; the interactive flow is a
non-goal below.

#### What the verifier writes

`verification.schema.json` gains an optional `reproduction` property,
`additionalProperties: false`, with required `runner` (string), `path`
(string, 1 to 300), `content` (string, 1 to 65536) and `expected` (string, 1
to 300). `verificationProblem` (`cli.ts:4449-4503`) refuses an entry whose
`reproduction` is present and not that shape, naming the field, so
`check-verification` sends the verifier back once while its context is warm,
as it does for every other field. The runner name and the path are checked
against the configuration and the worktree by `reproduce`, not here, because
`check-verification` has neither.

`verifierPrompt` (`prompts.ts:128-142`) gains, only when the plan's
`reproduce` stage runs, a paragraph listing the configured runners as
`name (run, extension)` and the rule: for each kept candidate whose `severity`
is `blocking` or `important`, add `reproduction` with a runner from the list,
a `path` beside the code it exercises (an existing directory, a new file name
ending with the runner's extension), `content` that imports the code under
test by relative path and prints `RV_REPRO_REACHED <candidate_id>`
immediately before the one assertion that fails on the defect and passes once
it is fixed, and `expected` in one sentence; no network, no writes except
under `$TMPDIR` (a write into the worktree makes the record `did-not-run`),
finished within the runner's time limit; when no listed runner
fits the language, omit the field and say so in `reason`. `RunFiles`
(`prompts.ts:70-74`) gains
`reproductionRunners: { name: string; run: string; extension: string }[] | null`,
which the driver fills from `context.json`. The name says "reproduction"
because S17's top-level `runners:` block, which lands after this spec, is a
different thing (agents on another model family).

`agents/evidence-verifier.md` gains a section
`## A reproduction, when asked for one` after "Verify the suggested fix
separately", stating the same rules, why the marker exists (a reproduction
that crashes before its assertion proves nothing about the claim), and that
the CLI runs the reproduction, never the verifier. The agent's `tools:` line
is unchanged, so `test/seams.test.mjs:324-325` stands.

#### The driver stage

The `reproduce` handler runs after `verify` (`driver.ts:741-764`) and before
`secondPass`. It skips with `off in this mode, or not configured` when
`run.plan.stages.reproduce.run` is false, with `REVIEW_VOICE_NO_COMMANDS=1`
and a note, as `secondPass` does at `driver.ts:768-771`, when the switch is
set, and with `nothing verified` when `run.survivors` is empty. Otherwise it
calls
`reproduce --worktree <run.headDir> --verification <run dir>/verification.json --candidates <run dir>/checked.json --out <run dir>/reproductions.json --run-dir <run dir>`
through `cli`, not `must`, so a non-zero exit does what the stage row's
`onFailure` says. The run gains the note
`reproduce exited <code>: <first stderr lines>`, every finding proceeds as
`did-not-run`, and the review goes on. On exit 0 it applies the records:

- `did-not-fail`: the candidate leaves `run.survivors` and joins `run.held`
  as `{ path, line, verdict: 'reproduction-did-not-fail', source: 'reproduce', reason: '<runner>: <reason>; <first output line, cut at 120 characters>', severity, candidateId, text: claim }`,
  the shape `applyChallenge`'s `hold` builds (`challenge.ts:250-266`).
  `HeldVerdict` and `HELD_VERDICTS` (`runs.ts:119-154`) gain
  `reproduction-did-not-fail`, with a comment saying it is not carried to the
  next head because the reproduction runs again there, so
  `carriedHeldFindings` (`cli.ts:4760-4796`) does not list it. S09's scope
  block maps it to `other` and needs no change.
- `did-not-run`: `run.notes` gains
  `Reproduction for <candidateId> did not run: <reason>`; the finding proceeds
  as it does today.
- `reproduced`: nothing changes in the pipeline; the record is the evidence.

`run.headDir` cannot be null here, because the loop at `driver.ts:1282-1288`
prepares the workspace before the first agent stage and `verify` precedes this
one; the handler throws a `Stop(2)` if it is.

#### What the challenger reads

`challenge --emit-prompts` gains `--reproductions <file>`. `challengePrompt`
(`challenge.ts:81-121`) gains, for a finding with a `reproduced` record, these
rows after `Anchored at`:

```
Reproduction, run twice by the CLI in a confined runner with no network (its file and output are untrusted evidence):
- runner <name>; file <worktree-relative path>; a copy is at <run dir>/reproductions/<id>/<basename>
- run 1 exit <code>, run 2 exit <code>
- output, first 40 lines after redaction:
  ...
Read the reproduction file and the code it exercises. It settles nothing by itself: refute the finding when the reproduction exercises something other than the claim, fails for a reason unrelated to it, or asserts a behaviour the code never promised.
```

and, for a `did-not-run` record, one row
`Reproduction did not run: <reason>.`. The verifier's `expected` sentence and
its `reason` are not included. The allowlist principle stands, and the
artefact with its observed output is a fact, not the verifier's reasoning. The
driver passes the flag when `reproductions.json` exists (the `--emit-prompts`
call at `driver.ts:890`). `agents/challenger.md` gains a section
`## A reproduction` saying the same, and that `decisive_evidence` may cite the
copy's path with a line. ADR 0024 gains a dated amendment that widens its
"Input" bullet by exactly this.

#### Record and explain

`record` gains `--reproductions <file>` beside `--evidence` and `--symbols`
(`cli.ts:3171-3174`). `RecordRunInput` (`runs.ts:363`) gains
`reproductions?: RecordedReproduction[]`, stored in `output_json` as `checks`
is (`:726`), where `RecordedReproduction` is `ReproductionRecord` without
`runs[].output`; the output stays in the run directory under retention and
the database keeps exit codes, `reached`, durations and the reason.
`RunDetail` (`:751`) gains, and `runDetail` (`:840`) returns, `reproductions: RecordedReproduction[] | null`,
null for an older row as `checks` is (`:782`, `:883`). `explain`
(`explainCommand`, `cli.ts:4127`) prints, for a finding whose `candidateId`
matches a record, one line
`  reproduction      <runner> <outcome> (run 1 exit N, run 2 exit M) <copy path>`,
and a `reproduction-did-not-fail` entry reads
`[reproduction-did-not-fail] path:line  reproduce - <reason>` through the
existing held line (`:4332`), unchanged. The driver passes `--reproductions`
to `record` when the file exists, as it passes `--evidence` and `--symbols`
(`driver.ts:1012-1014`). `help.ts` lists the flag on `record` and `challenge`.

#### Measurement

`computeMetrics` (`src/evaluate/metrics.ts:221`) gains one `Metric`,
`reproduction_hold_rate = didNotFail / (reproduced + didNotFail)`, read from
`output_json.reproductions[]` across runs, basis
`H held / C completed, N did not run, over R run(s)`, target `no target` and
kind `goal` as `challenge_hold_rate` has (`metrics.ts:353-360`), so the
every-metric tests find a basis and a target. When no reproduction completed
(`reproduced + didNotFail` is 0, which includes a store where every record is
`did-not-run`) it reports `no data`, never zero, like `challenge_hold_rate`
(S05). `docs/EVALUATION.md` "Reported, not scored" gains the row and a short
subsection saying what the figure is (how often a reproduction removed a
finding that would otherwise have posted) and what it is not (recall; a
`did-not-run` says nothing either way). The two every-metric tests in
`test/evaluate.test.mjs` pass unchanged because the value is `number | null`.

#### Documents

- ADR 0003 gains a new dated `## Amendment - <date>` section: a configured reproduction runner is
  configuration like a static check; the file it runs is a verifier-written
  reproduction of one finding; it runs only inside the confined runner this
  spec names, only after the probe passes, and the exposure is stated as the
  runner's limits above; "ship an execution sandbox" stays rejected for
  anything broader.
- `docs/THREAT-MODEL.md` section 4 gains a subsection "A reproduction runner"
  naming the attack (a pull request plants code that runs when the
  reproduction imports it), the mitigations (opt-in from the base commit,
  thorough mode only, configured command text only, the probe, no network,
  writes confined, credential paths and the store denied, environment
  allowlisted, limits, the worktree-modification check, output redacted and
  capped, the marker rule) and the residual risk (reads of the user's other
  files; what a reproduction prints reaches the challenger's model after
  redaction; code under review can still sense the sandbox and pass on
  purpose, which turns a real finding into a `did-not-fail` hold; nothing runs
  where the probe fails; `sandbox-exec` deprecation; a reproduction can still
  spend the time limit).
- `docs/ARCHITECTURE.md`: "The review driver" gains the stage, "Static
  evidence" a paragraph on the runner, "The independent challenge" the new
  input. `docs/WATCHER.md`: the stage row, the mode-table row and a
  `reproduce` entry after `challenge` (`:312-321`). `PRIVACY.md` "What it
  stores, and where" adds "reproduction files and their output" to the
  `runs/` row; the file is outside Orbit's `scope.allowed_paths`, so that one
  line is the integrator's, as S03's `PRIVACY.md` change was.
  `docs/adr/README.md` marks the 0003, 0024 and 0025 rows
  `amended <date> (reproductions)`.

#### Fixtures and tests for part B

- `test/reproduction-pipeline.test.mjs`, a driver test shaped like
  `test/s08-tool-driver.test.mjs` with fake agents and a `reproduction` block
  in the base commit's `config.yaml` whose runner is `node --test {file}`,
  run with `mode: 'thorough'`. A canned verification carrying a reproduction
  that reaches its marker and fails twice yields a `reproduced` record, a
  challenger prompt with the rows above (asserted by calling `challengePrompt`
  with the record), a recorded `reproductions` entry and the `explain` line.
  A canned reproduction that passes yields `reproduction-did-not-fail` in
  `held.json` and the record, with the candidate absent from `scores.json`. A
  canned reproduction that crashes before the marker yields `did-not-run`, a
  note, and the candidate scored as today. The same review in `standard`
  mode skips the stage and spawns nothing, and `REVIEW_VOICE_NO_COMMANDS=1` in
  thorough mode skips it with the note. When the probe does not pass on the
  test host, the test asserts the `did-not-run` path and the note for every
  case, as part A's test does.
- `test/plan.test.mjs` is extended as specified. A schema test asserts
  `verification.schema.json` accepts a well-formed `reproduction` and refuses
  one with an extra key, and a `verificationProblem` test covers each refused
  field.
- Two synthetic fixtures under `fixtures/positive/`, `reproduced-off-by-one`
  (a boundary error in a small pure function, with `agents/` canned outputs
  that include a reproduction) and `reproduction-passes-held` (the same shape,
  where the canned reproduction asserts something the code already does),
  each with `harness: skip` and
  `harness_reason: the recall harness runs with REVIEW_VOICE_NO_COMMANDS=1, so reproductions never run there`,
  used by the pipeline test above. `fixtures/README.md` lists them.
- A content test (`test/reproduction-pipeline.test.mjs`) asserts that
  `docs/adr/0003-*.md`, `docs/adr/0024-*.md` and `docs/adr/0025-*.md` each
  have a `## Amendment - <date>` section whose text names `reproduction`
  (0003 and 0025 already carry amendments, and S15, S17 and S20 amend 0003
  or 0024 too, so a heading count proves nothing), that the `docs/adr/README.md` rows for the
  three name reproductions, that `docs/THREAT-MODEL.md` contains
  `A reproduction runner`, and that both agent files contain `RV_REPRO_REACHED`.

### Order against the other market specs

S16 lands second of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"):

- After S15, whose evidence block drops a decisive entry with an absolute
  path, so a challenger that cites the reproduction copy never posts it.
- Before S17. Both change the driver around the challenge. This spec adds the
  `reproduce` stage, renumbers the `docs/WATCHER.md` stage table, adds
  `--reproductions` to `challenge --emit-prompts` and adds the challenger's
  reproduction rows; S17 then runs that same prompt on a configured family.
  Both amend ADR 0003 and ADR 0024, and both extend the comment on
  `watch.run_repository_commands` in `config.example.yaml`; this spec adds
  "and reproductions" first. `reproduction.runners` here and S17's top-level
  `runners:` are different settings.
- Before S19. Both edit `agents/evidence-verifier.md`, `agents/challenger.md`
  and `challengePrompt`. This spec's sections come first, and S19 adds its
  paragraphs beside them.
- Before S20. Both change `src/evidence/run.ts`. This spec exports
  `spawnInGroup` with an argv form, and S20 changes the `parseOutput` call.
- S21's reply drops an absolute `decisive_evidence` path, so the copy path
  never reaches a reply either. S22's held queue lists
  `reproduction-did-not-fail` entries with no promote command. S23 shows
  `reproduction_hold_rate` in its "Reported, not scored" table, since its
  target is `no target`.

## Non-goals

- No posting change. Nothing about a reproduction reaches GitHub, the scope
  block included (S09 counts the hold under `other`). Whether the block should
  name reproductions is a later decision, once `reproduction_hold_rate` has
  data.
- No scoring change. A reproduced finding keeps the verifier's confidence and
  the derived tier. Whether reproduction should raise evidence quality or feed
  ADR 0011's escalation is an owner decision for a later spec.
- No base-side control run. A reproduction that also fails on the base shows a
  pre-existing defect and touches the not-diff-specific rule; the reach marker
  is the deterministic rule this spec ships instead.
- No reproductions in the interactive `/review-voice:review` flow, which has
  no cost mode and runs agents in the host. `review --pr` only.
- No reproductions for `minor`, `nit` or `question` candidates, and none
  outside `thorough`.
- No dependency installation. `link_paths` links what the clone already has;
  a reproduction that needs more does not reach its marker and is recorded as
  not run.
- No `bwrap`, container or other optional mechanism. One mechanism per
  platform, and `none` elsewhere.
- Open question for the owner: is `sandbox-exec`, which Apple marks
  deprecated, acceptable as the macOS mechanism? The spec proceeds with it
  because it is the only tool the OS provides, it is probe-gated, and
  `mechanism: 'none'` is the fallback when it goes.
- Open question for the owner: should the Linux test job in
  `.github/workflows/ci.yml` (a protected path) set
  `REVIEW_VOICE_REQUIRE_SANDBOX=1`, so a sandbox regression fails the build
  rather than printing a diagnostic?
- Open question for the owner: turn `reproduction.enabled: true` on for this
  repository's own pull requests once it lands, with a `node-test` runner and
  `link_paths: [node_modules]`?
- Open question for the owner: may a verifier-written reproduction reach the
  challenger at all? ADR 0024 keeps the verifier's reasoning, confidence and
  evidence from the challenger, and the file is the verifier's work even
  though its output is observed. The spec proceeds with the amendment above;
  the alternative is that the challenger judges blind and a `reproduced`
  record only adds a line to `explain`.
- Open question for the owner: may a passing reproduction hold a finding in
  a category S06 exempts from suppression (security, trust boundary)? A
  passing test can be a badly written test, and code under review can sense
  the sandbox and pass on purpose; the spec as written holds it.

## Acceptance criteria

Part A:

- AC-1. `loadConfig` reads the `reproduction` block with every rule above,
  warns about and drops an invalid runner, and defaults `enabled` to false;
  `test/reproduce.test.mjs` proves each rule; `config.example.yaml` carries
  the block as shown and still loads with no warnings
  (`test/issues-config.test.mjs`).
- AC-2. `reproduce` with `enabled: false`, with no runner, or under
  `REVIEW_VOICE_NO_COMMANDS=1` writes the skipped report and spawns nothing (a
  touch-marker runner leaves no file); `reproduce --probe` prints the
  `sandbox` object and runs no reproduction.
- AC-3. With an injected `spawn`, the runner builds the platform wrapper argv,
  the `ulimit` line and the allowlisted environment as specified, substitutes
  `{file}` once with a single-quoted path, runs at most twice, and classifies
  every branch of the reach-marker and flaky rules into `reproduced`,
  `did-not-fail` and `did-not-run` with the specified reasons; output is
  redacted and capped at 8 KiB per run; a path failing any placement rule is
  refused with its rule, a symlinked directory leaving the worktree and a
  single quote included; a run that modifies the worktree, an ignored path
  included, is `did-not-run` and the worktree is restored; every git call
  after a run carries the pinned `--git-dir` and `--work-tree`; the profile's
  only writable paths are the worktree and `<scratch>`; `link_paths` are
  linked before and removed after (`test/reproduce.test.mjs`).
- AC-4. Through the bundle in a scratch repository, either the probe passes,
  its escapes fail (no connection on the listener, no `probe-escape`, the
  profile unchanged, the canary read refused) and a marker-reaching failing
  reproduction is `reproduced` with two runs, or the wrapper could not start,
  the report names the reason, every record is `did-not-run`, nothing the
  reproduction would have written exists, and the test fails only with
  `REVIEW_VOICE_REQUIRE_SANDBOX=1`. A probe that reports an escape fails the
  test on every host (`test/reproduce.test.mjs`).
- AC-5. `help.ts` documents `reproduce`, and `fixtures/confinement/toolchain-bait/README.md`
  names the test as the runner's proof (reviewer-checked).

Part B:

- AC-6. `resolvePlan` turns `reproduce` on only for `thorough` with
  `reproductionConfigured: true`; `plan` sets it from the configuration;
  `test/plan.test.mjs:30-43` is extended as specified; `STAGES` has the row
  between `verify` and `second-pass` (`test/plan.test.mjs`).
- AC-7. `verification.schema.json` and `verificationProblem` accept the
  `reproduction` shape and refuse a wrong one naming the field; the verifier
  prompt lists the runners and the rule only when the stage runs; both agent
  files carry their sections and `RV_REPRO_REACHED`; `test/seams.test.mjs`
  passes unchanged (`test/reproduction-pipeline.test.mjs`).
- AC-8. The driver test proves the three outcomes end to end as specified,
  the `standard` skip, the `REVIEW_VOICE_NO_COMMANDS` skip, a `reproduce`
  that exits non-zero leaving a note and every finding as before, the held entry
  `reproduction-did-not-fail` (in `HELD_VERDICTS`, not listed by
  `carriedHeldFindings`), the challenger prompt rows for `reproduced` and
  `did-not-run`, and that a `reproduced` finding's score and tier are
  unchanged (`test/reproduction-pipeline.test.mjs`).
- AC-9. `record --reproductions` stores the records without output;
  `runDetail` returns them and null for an old row; `explain` prints the
  reproduction line and the held line; `evaluate` reports
  `reproduction_hold_rate` with its basis, and `no data` both on a store
  without records and on one whose every record is `did-not-run`; the
  every-metric tests pass unchanged (`test/reproduction-pipeline.test.mjs`).
- AC-10. The content test holds for the three ADR amendments, the index rows,
  the threat-model subsection and the agent files; `docs/ARCHITECTURE.md`,
  `docs/WATCHER.md`, `docs/EVALUATION.md`, `help.ts` and
  `fixtures/README.md` are updated as specified (reviewer-checked).
  `PRIVACY.md` is the integrator's follow-up below.
- AC-11. `npm run verify` passes with the rebuilt bundle committed.

Stop point for the two-run split: part A is AC-1 to AC-5 and AC-11; part B is
AC-6 to AC-11.

## Allowed paths

`plugins/review-voice/src/evidence/**`, `plugins/review-voice/src/policy/load.ts`,
`plugins/review-voice/src/cli.ts` (`reproduce`, `context`, `plan`,
`check-verification`, `challenge`, `record`, `explain`), and the
`plugins/review-voice/src/cli/` modules that hold those commands once S12 has moved them,
`plugins/review-voice/src/review/driver.ts`, `plugins/review-voice/src/review/stages.ts`,
`plugins/review-voice/src/review/plan.ts`, `plugins/review-voice/src/review/prompts.ts`,
`plugins/review-voice/src/verify/challenge.ts`, `plugins/review-voice/src/store/runs.ts`,
`plugins/review-voice/src/evaluate/metrics.ts`, `plugins/review-voice/src/help.ts`,
`plugins/review-voice/schemas/verification.schema.json`,
`plugins/review-voice/agents/evidence-verifier.md`, `plugins/review-voice/agents/challenger.md`,
`plugins/review-voice/templates/config.example.yaml`, `docs/adr/0003-*.md`,
`docs/adr/0024-*.md`, `docs/adr/0025-*.md`, `docs/adr/README.md`,
`docs/THREAT-MODEL.md`, `docs/ARCHITECTURE.md`, `docs/WATCHER.md`,
`docs/EVALUATION.md`, `fixtures/**`,
`test/**`, `plugins/review-voice/dist/review-voice.mjs`.

Follow-ups for a person. `REVIEW_VOICE_REQUIRE_SANDBOX=1` on the Linux test
job in `.github/workflows/ci.yml` (a protected path), if the owner says yes to
the open question above. The one `PRIVACY.md` line, which sits outside
`.orbit/config.yaml`'s `scope.allowed_paths`.

## Orbit goal, part A

```
Implement part A of docs/agent-handoffs/professionalisation/S16-execution-based-verification.md
in this repository. S03, S08 and S09 are already on the base branch; locate
code by function name, in src/cli/ for commands S12 has moved. Read the
spec first, then docs/adr/0003-static-analysis-adapters.md (the decision and
every amendment), docs/adr/0021-agents-run-in-a-confined-headless-runner.md,
docs/THREAT-MODEL.md section 4, plugins/review-voice/src/evidence/run.ts
(spawnInGroup, notRunReport, the spawn seam), plugins/review-voice/src/evidence/types.ts,
plugins/review-voice/src/review/driver.ts (SAFE_GIT, prepareWorkspace,
removeWorktree, noCommands), plugins/review-voice/src/agents/claude-cli.ts
(childEnv), plugins/review-voice/src/policy/load.ts (the static_evidence
block), the evidence command in plugins/review-voice/src/cli.ts,
plugins/review-voice/src/redact/redact.ts (redact) and test/s08-tool-driver.test.mjs
(the touch-marker runner shape).

Outcome: loadConfig reads an opt-in `reproduction` block (enabled false by
default, runners with name, run containing {file} once, extension and
timeout_seconds, link_paths, memory_mb, cpu_seconds) with the rules and
warnings the spec gives; the `context` payload carries its enabled flag and
runners; a new src/evidence/reproduce.ts and a `reproduce` command run each
verifier-written reproduction for a blocking or important candidate on the
head worktree, through the configured runner's command only, inside the
platform's confinement (sandbox-exec on macOS, unshare namespaces with a
read-only root on Linux, none elsewhere) after a probe that must show the
network, a write outside the worktree and the scratch directory, a profile
overwrite and a canary read are refused; only the worktree and
<run dir>/reproductions/scratch are writable, so the profile, the probe and
the copies are not; the runner applies the ulimit line, the allowlisted
environment, the placement rules (realpath inside the worktree, a safe
character set), the worktree-modification check (ignored paths counted, git
pinned to the --git-dir and --work-tree resolved before the first run),
link_paths, the reach marker and the flaky rule exactly as specified and
writes reproductions.json with redacted, capped output; spawnInGroup is
exported with an optional argv form; REVIEW_VOICE_NO_COMMANDS=1 and
enabled:false spawn nothing; help.ts documents the command; the confinement
test passes in both the probe-passed and the wrapper-could-not-start branch,
fails the second only under REVIEW_VOICE_REQUIRE_SANDBOX=1, and fails on any
reported escape. Acceptance criteria AC-1 to AC-5 and AC-11 of the spec must
hold.

Scope: only the paths the spec lists under "Allowed paths", and in this part
only src/evidence/**, policy/load.ts, the reproduce, context and help entries
in cli.ts and help.ts, the SAFE_GIT export in review/driver.ts,
templates/config.example.yaml, fixtures/confinement/toolchain-bait/README.md,
test/** and the rebuilt plugins/review-voice/dist/review-voice.mjs. Do not touch the driver's stage graph, the plan, the prompts,
the agents or the schemas; those are part B. Nothing is posted to GitHub.
Add no dependency and no mechanism beyond the two the spec names. Do not edit
scripts/, .github/, CHANGELOG.md or the manifests.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them); no
hardcoded identities; fixtures and test repositories stay synthetic.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree. A loopback listener may be refused inside the worker; Orbit's
check run is the proof that counts.
```

## Orbit goal, part B

```
Implement part B of docs/agent-handoffs/professionalisation/S16-execution-based-verification.md
in this repository. Part A is already on the base branch; locate code by
function name, in src/cli/ for commands S12 has moved. Read the spec first,
then docs/adr/0024-an-independent-challenge-gates-every-posted-finding.md,
docs/adr/0025-cost-modes-choose-stages-and-models.md,
docs/adr/0016-what-the-verifier-could-not-check.md,
plugins/review-voice/src/review/stages.ts, plugins/review-voice/src/review/plan.ts,
plugins/review-voice/src/review/prompts.ts (verifierPrompt, RunFiles,
challengerPrompt), plugins/review-voice/src/review/driver.ts (verify,
secondPass, challenge, record, HANDLERS), plugins/review-voice/src/verify/challenge.ts
(challengePrompt, the hold shape in applyChallenge),
plugins/review-voice/src/store/runs.ts (HeldVerdict, RecordRunInput,
RecordedChecks, runDetail), verificationProblem, challengeCommand,
recordCommand and explainCommand in plugins/review-voice/src/cli.ts,
plugins/review-voice/src/evaluate/metrics.ts (challenge_hold_rate),
plugins/review-voice/agents/evidence-verifier.md, plugins/review-voice/agents/challenger.md
and test/plan.test.mjs.

Outcome: a `reproduce` stage sits between verify and second-pass in the stage
table and the plan, on only in thorough mode when the block is configured;
verification.schema.json and verificationProblem accept and check an optional
`reproduction` (runner, path, content, expected); the verifier prompt and
agent file ask for one per blocking or important candidate, with the
RV_REPRO_REACHED marker rule, only when the stage runs; the driver runs
`reproduce` through cli rather than must (a non-zero exit is a note and the
review goes on), holds a did-not-fail candidate as reproduction-did-not-fail (a
new HeldVerdict, not carried to the next head), notes a did-not-run, and
passes --reproductions to `challenge --emit-prompts` and to `record`; the
challenger prompt gains the specified rows and the challenger agent file its
section; the record stores the reproductions without output, runDetail
returns them, explain prints them, and evaluate reports reproduction_hold_rate
with its basis, target `no target` and no data when no reproduction completed;
ADR 0003, 0024 and 0025 are amended, the threat model gains "A reproduction
runner", and the documents the spec lists are updated (PRIVACY.md is not
yours; the integrator adds its line); two synthetic fixtures with harness: skip exist and
the pipeline test proves the three outcomes end to end in both probe
branches. Acceptance criteria AC-6 to AC-11 of the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". No scoring
change, no posting change, no change to the agents' tools lines, no change
to the interactive flow. The only existing test you may edit is
test/plan.test.mjs as the spec says. Do not edit scripts/, .github/,
CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; agent file
sections follow the shape of the sections around them; comments explain why;
no em or en dashes anywhere (the identity guard rejects them); no hardcoded
identities; fixtures stay synthetic.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
