# 0021 - Agents run in a confined headless runner

**Status:** Accepted · **Date:** 2026-10-25
**Relates to:** [0022](0022-one-command-drives-a-review.md) - the driver is the
runner's only caller. No GitHub write is added or changed.

## Context

Every agent Review Voice uses is launched by the host. The `/review-voice:review`
command tells Claude Code to start a subagent, and a person or a long prompt
reads its answer back into the next command. Nothing in the CLI can start an
agent, so nothing in the CLI can run a review end to end. A watcher or a CI job
would need its own host, plus a copy of the review command's sequencing.

Headless Claude Code (`claude -p`) can run one agent per process. It takes a
system prompt file, a model, an allowed-tool list and a JSON Schema the final
answer must satisfy, and it prints a JSON envelope with the structured output
and the cost. In restricted mode it ignores user, project and local settings
files, drops code-running tools unless they are named, and confines file tools
to the working directories. A probe on 2026-10-25 confirmed the confinement for
file tools and for a denied `curl`. A second probe showed the limit of a
command allow rule. `Bash(git:*)` matches by prefix, and git's own options can
run an arbitrary command. A hook passed through `--settings` did not fire in
restricted mode, so it cannot filter them.

## Decision

**The CLI starts each agent as its own `claude -p --restricted` process with
read-only file tools only (Read, Grep, Glob), in a head checkout of the pull
request, and accepts only schema-valid output. Agents get no shell and no git.**

- **One interface.** `runAgent(spec, prompt, cwd) -> AgentResult`, in
  `src/agents/`. Callers never build a command line.
- **The `claude-cli` backend.** It runs `claude -p <prompt> --restricted
  --strict-mcp-config --no-session-persistence --system-prompt-file
  agents/<name>.md --model <model> --tools <tools> --allowedTools <tools>
  --add-dir <run dir> --json-schema <schema> --output-format json`, with a
  checkout of the pull request head as the working directory. It adds `--bare` when
  `ANTHROPIC_API_KEY` is set, because bare mode skips OAuth and keychain reads.
- **Tools come from the agent file, narrowed.** The runner reads the `tools:`
  frontmatter and keeps only Read, Grep and Glob. A declared `Bash(git:*)` is
  dropped, because the same files serve the interactive host. Any other tool is
  refused before the process starts. An agent that declares no tools gets none,
  and the editor's input is passed in the prompt.
- **What git used to provide is on disk.** The driver checks out the head (its
  own workspace clone, or a worktree in the run directory when it runs in the
  user's clone) and writes the base version of every changed file, and recent
  history for each, under the run directory. The prompt names those
  directories.
- **Schemas come from `schemas/`.** The JSON Schema given to the runner is the
  one the matching `check-*` command already enforces. The check still runs
  afterwards, because a schema cannot express anchor or intent rules.
- **Bounded.** One process per agent call. There is a timeout per call (default
  10 minutes) and a cap on parallel calls (default 4). A call that times out or
  returns an error counts as a failed attempt.
- **The `fake` backend.** `REVIEW_VOICE_FAKE_AGENTS=<dir>` serves canned output
  from `<dir>/<agent>.<n>.json`, so tests run every stage without a model.
- **Recorded.** Each call's model, seconds and cost go into `stages_json`
  beside the existing tool-call counts.

## Consequences

- `review` and `watch` can run anywhere Claude Code is installed and
  authenticated, including CI with an API key.
- PR content that injects a prompt meets an agent that can read files and
  nothing else. Its output still has to pass a check.
- Agents lose ad hoc history queries. The driver's prepared base copies and
  per-file history cover what the verifier used `git` for.
- The interactive command keeps using the host's agents. The agent files are
  shared, so both paths run the same prompts.
- Claude Code is a runtime dependency of `review` and `watch`, not of any other
  command. `doctor` reports whether `claude` is present and logged in.

## Alternatives considered

**Call the Messages API directly.** Rejected for now. It would mean
reimplementing the tool loop, file confinement and git access that Claude Code
already provides, and storing an API key.

**Keep agents in the host only, and have the CLI emit requests for the host to
fulfil.** Rejected. It still needs a host loop for every watcher and CI job,
which is the problem being solved.

**Run agents unrestricted with the user's settings.** Rejected. User hooks and
plugins would run against untrusted pull request content, and the probe showed
restricted mode costs nothing.

**Allow git through a narrower rule or a hook.** Rejected. Prefix rules cannot
exclude an option placed later in the command, and the hook did not run in
restricted mode. Removing the shell removes the whole class.
