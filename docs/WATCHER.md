# Review Voice as a watcher: specification

**Status:** Accepted · **Date:** 2026-10-25
**Decisions:** [0021](adr/0021-agents-run-in-a-confined-headless-runner.md)
to [0031](adr/0031-a-github-action-runs-one-review-per-pull-request-event.md)

Review Voice reviews a pull request well once someone drives it. Today that
someone is a person or a long prompt. They run about fifteen commands in
order, launch five kinds of agent, and relaunch an agent when a check refuses
its output. They also keep their own list of which pull requests need a review
and which heads were already reviewed, and decide when to post. This
specification moves that work into Review Voice. Anyone can then point it at
their review requests and trust it to review, decide and post, every time,
with the same gates it applies today.

## Goals

1. **One command reviews one pull request end to end.** `review-voice review
   --pr <n>` runs every stage, agents included, validates each stage's output,
   records the run and computes the verdict. With `--post` it also posts.
2. **One command keeps watching.** `review-voice watch` finds every pull
   request that needs the owner's review, reviews each new head once, posts the
   verdict and remembers what it did. It can loop on an interval or run one pass
   for a scheduler.
3. **Nothing posts without an independent challenge.** A finding reaches GitHub
   only after the evidence-verifier verified it, `score` made it eligible, and a
   separate challenger that never saw the verifier's reasoning failed to refute
   it.
4. **Repositories add review lanes without code.** A second analyst, such as a
   structure lane, is a configured lane with its own prompt, eligibility rule
   and severity rule.
5. **Cost is a setting.** `fast`, `standard` and `thorough` choose which stages
   run and on which model. `auto` picks one from the change.
6. **It works on day one.** A new user gets a sensible voice and policy before
   any history is synced, and a team can pool several reviewers' history.
7. **It proves its precision.** Review Voice follows what happened to every
   finding it posted, and `evaluate` reports how many were fixed or dismissed.
8. **It runs in CI.** A GitHub Action runs one review per pull request event.

## Non-goals

- **A hosted service or GitHub App.** ADR 0002 keeps Review Voice local-first.
  The Action runs in the user's own CI with the user's own keys.
- **Changing what makes a finding postable.** The verifier, scoring, severity
  derivation, output contract and posting writer keep their rules. This
  specification adds a gate (the challenge). It removes none.
- **Organisation-wide policy authority.** ADR 0006 still applies. A team
  profile pools history, and the owner still approves policy.
- **Auto-merge, dismissing reviews, or writes other than the one review.** The
  writer's single endpoint is unchanged.

## Who uses it, and how

- **An individual reviewer** runs `review-voice watch --interval 2h --post` on
  their machine. It reviews their requests and follow-ups across the
  repositories they allowlisted, in their voice.
- **A team** adds the Action to a repository. Each pull request event runs
  `review --post` with the team profile. Prior runs are cached between events.
- **Anyone, once** runs `review-voice review --pr 123 --repository owner/repo`
  in a clone, reads the validated review on stdout and decides whether to post.
- **The interactive `/review-voice:review` command** keeps working. It runs the
  same stages with the host's agents. The driver and the slash command share
  the stage definitions, so they cannot drift.

## The data model

These shapes are the contract between the new commands. Field names are the
JSON names written to disk and stdout.

```ts
// A pull request the queue found, and what to do with it.
type QueueSource = 'requested' | 'assigned' | 'team' | 'follow-up' | 'dismissed' | 're-requested';
type QueueAction =
  | { kind: 'review' }                 // the head has no recorded run
  | { kind: 'verdict-only' }           // run recorded, no review posted for this head
  | { kind: 'recheck-ci' }             // posted as COMMENT only because CI was red
  | { kind: 'carry' }                  // scope unchanged since a recorded run
  | { kind: 'skip'; rule: string };    // a skip rule matched; `rule` names it
interface QueueEntry {
  repository: string;                  // owner/name, always inside the allowlist
  pull: number;
  head: string;                        // full sha
  author: string;
  sources: QueueSource[];              // every reason it is in the queue
  action: QueueAction;
  createdAt: string;                   // ISO; the queue orders oldest first
}

// What the watcher remembers per head. One row per (repository, pull, head).
type HeadStatus = 'reviewed' | 'posted' | 'carried' | 'waiting-ci' | 'held' | 'failed' | 'skipped';
interface WatchHead {
  repository: string; pull: number; head: string;
  runId: string | null;                // review_runs.review_run_id
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' | null;
  reviewUrl: string | null;
  status: HeadStatus;
  detail: string | null;               // the refusal, failure or skip reason
  attempts: number;                    // failed attempts on this head
  updatedAt: string;
}

// One agent invocation, as the runner sees it.
interface AgentSpec {
  name: string;                        // file stem under agents/, e.g. 'diff-analyst'
  model: string;                       // resolved from the mode
  tools: string[];                     // from the agent's frontmatter
  schema: object;                      // JSON Schema the output must satisfy
}
interface AgentResult { ok: boolean; output: unknown; costUsd: number | null; seconds: number; error?: string }

// A configured analyst lane.
interface Lane {
  name: string;                        // 'diff' is built in and always on
  agent: string;                       // agent file stem, e.g. 'structure-analyst'
  prefix: string;                      // candidate_id prefix, e.g. 'st_'
  when: { minChangedSourceLines?: number; paths?: string[]; excludeKinds?: ('test'|'docs'|'config'|'generated')[] };
  severity: { cap?: Tier; escalate?: { to: Tier; requires: 'blocker_confirmed' } };
}

// The plan a mode resolves to: which stages run, on which model.
type StageName = 'intent' | 'lanes' | 'verify' | 'second-pass' | 'tie-break' | 'challenge' | 'edit';
interface StagePlan { mode: 'fast' | 'standard' | 'thorough'; stages: Record<StageName, { run: boolean; model: string | null }>; reason: string }

// The challenger's answer for one eligible finding.
interface ChallengeVerdict {
  candidate_id: string;
  verdict: 'confirmed' | 'partly' | 'refuted';
  line_ok: boolean;                    // the anchor is the line the claim is about
  corrected_line?: number;             // when line_ok is false
  decisive_evidence: string[];         // path:line references the verdict turns on
  reason: string;
}

// What happened to a finding Review Voice posted.
type Outcome = 'fixed' | 'resolved' | 'dismissed' | 'open' | 'outdated' | 'unknown';
interface FindingOutcome {
  runId: string; findingId: string;    // rv_NN
  repository: string; pull: number; commentId: number;
  outcome: Outcome;
  strength: 'strong' | 'weak';         // ADR 0004 honesty rule
  evidence: string;                    // what decided it
  checkedAt: string;
}
```

`HeldVerdict` gains `challenge-refuted` and `challenge-partly`. The
verification schema gains an optional `blocker_confirmed`, read only for lanes
with an escalation rule.

## Configuration

Every new key is optional. A repository that sets none of them behaves exactly
as it does today, except that `review` and `watch` exist.

```yaml
identity:
  owner_reviewer: your-github-login
  reviewers: [your-github-login, a-teammate-login]            # ADR 0030: pooled history for a team voice

repositories:
  include: [acme/api, acme/web, acme-labs/*]   # ADR 0026: globs allowed

review:
  mode: auto                         # fast | standard | thorough | auto (ADR 0025)
  models:                            # optional per-stage overrides of the mode table
    analyst: sonnet
    challenge: opus
  lanes:                             # ADR 0023
    - name: structure
      agent: structure-analyst
      prefix: st_
      when: { min_changed_source_lines: 40, exclude_kinds: [test, docs, config, generated] }
      severity: { cap: minor, escalate: { to: important, requires: blocker_confirmed } }
  challenge:
    enabled: true                    # ADR 0024; on in standard and thorough
  human_review:
    cap_approval: true               # ADR 0028; false lets a clean complex change approve

verdict:                             # ADR 0028
  ci_pending: wait                   # wait | proceed
  ci_red: cap                        # cap | annotate
  ci_needs_rerun: hold               # hold | annotate
  carry_approval_on_unchanged: true
  recheck_thread_before_post: true

queue:                               # ADR 0026
  sources: [requested, assigned, follow-up, dismissed]
  teams: [acme/platform]             # adds team-review-requested
  max_per_pass: 20
  skip:
    authors: [carol]                 # never review these authors
    author_patterns: ['\[bot\]$', '-bot$', '^renovate', '^dependabot']
    allow_bots_when_requested: true  # a bot PR that requests the owner personally is reviewed
    assigned_to: [carol]             # skip PRs assigned to these logins
    approved_at_head_by: { logins: [release-bot], sources: [team] }
    drafts: true

watch:                               # ADR 0027
  workspace: ~/.local/share/review-voice/clones   # default: <dataDir>/clones
  interval: 2h
  post: false                        # --post overrides
  max_attempts_per_head: 2

writes:
  github_posting_enabled: false      # unchanged; still required to post
```

## Commands

### `review`

```
review-voice review --pr <n> [--repository owner/repo] [--mode M] [--post]
                    [--out <dir>] [--since <sha>] [--full] [--runner claude-cli|fake]
```

- Runs in a clone of the repository (the current directory, or the watcher's
  workspace clone).
- Writes every stage's input and output under `--out` (default a new
  directory under `<dataDir>/runs/<repo>-<n>-<sha8>/`), so a failed run can be
  read and resumed by hand with the existing commands.
- Prints one JSON document: `{ runId, head, scope, plan, findings, held,
  verdict, posted, reviewUrl, costUsd, seconds, stages[] }`.
- Exit codes follow `verdict` and `post`: 0 done, 2 refused or bad invocation,
  3 head moved, 4 waiting on CI, 6 CI needs a rerun, 7 an agent failed twice.

The stage graph, in order. A stage the plan turns off is recorded as skipped.

| # | Stage | Kind | On failure |
|---|---|---|---|
| 1 | `diff`, `thread`, `context`, `evidence`, `conventions`, `symbols`, `follow-ups` | CLI | stop, exit 2 |
| 2 | unchanged scope: `carry`, then `validate-output`, `record`, verdict | CLI | stop |
| 3 | `intent` (intent-extractor), then `check-intent` | agent | carry on without intent |
| 4 | `lanes`, every eligible lane in parallel, then merge and `check-candidates` | agent | relaunch once with the refusal, then exit 7 |
| 5 | `verify` (evidence-verifier), then `check-verification` | agent | relaunch once with the named ids, then exit 7 |
| 6 | `second-pass` (`verify` with the configured command) | CLI | as today |
| 7 | `tie-break`, once per `reconcile` dispute | agent | dispute stays unsettled |
| 8 | `score`, then lane severity rules | CLI | stop |
| 9 | `challenge`, one challenger per eligible finding | agent | the finding is held |
| 10 | `edit` (concise-editor), `validate-output` (one retry) | agent | relaunch once, then exit 7 |
| 11 | `record`, then `verdict` | CLI | stop |
| 12 | `post`, only with `--post` and posting enabled | CLI | per `post` exit codes |

### `queue`

```
review-voice queue [--json] [--source S]... [--max N]
```

Lists `QueueEntry` rows, oldest first, one per line (or a JSON array). It reads
GitHub search and the local store. It writes nothing.

### `watch`

```
review-voice watch [--once] [--interval 2h] [--post] [--mode M] [--max N] [--json]
```

Each pass runs `queue`, then for every entry:
- `review`: syncs the workspace clone and runs `review` (with `--post` when
  set).
- `verdict-only`: runs `verdict` and `post` on the recorded run.
- `recheck-ci`: runs `verdict --recheck` and posts the approval once CI is
  green.
- `carry`: runs the unchanged-scope path.
- `skip`: records the skip and does nothing else.

It then writes a `WatchHead` row and prints one report line per pull request,
in the format `owner/repo#n: <summary> (<status> <url>)`. A second watcher on
the same data directory exits at once (a lock file). `--once` runs one pass for
cron, launchd or a scheduled workflow.

### `challenge`

```
review-voice challenge --scores <scores.json> --candidates <checked.json> < verdicts.json
```

Validates challenger output and marks each eligible finding confirmed, held
(`challenge-refuted` or `challenge-partly`) or moved (`corrected_line`, through
the existing `reanchor` rules). `review` calls the same function. The command
exists so the interactive flow can use it too.

### `outcomes`

```
review-voice outcomes [--repository R] [--since 30d] [--json]
```

Reads the review threads of findings Review Voice posted, and the pull
request's later commits, and records a `FindingOutcome` for each. `evaluate`
reports the totals. `watch` runs it once per pass for the pull requests it
touched.

## Verdict policy

ADR 0028 makes five verdict behaviours configurable. The defaults keep today's
behaviour.

| Situation | Default | Opt-in |
|---|---|---|
| APPROVE, CI pending | wait (exit 4) | `ci_pending: proceed` approves now |
| APPROVE, CI red | post COMMENT | `ci_red: annotate` approves, body adds `Heads up: <checks> failing on this head.` |
| CI needs a rerun | hold every event (exit 6) | `ci_needs_rerun: annotate` posts the code verdict, body adds `Heads up: <checks> need a rerun.` |
| APPROVE, high complexity | post COMMENT (ADR 0012) | `human_review.cap_approval: false` approves; the local note stays |
| Unchanged scope, owner's approval still stands | post again | `carry_approval_on_unchanged: true` records `carried` and posts nothing |

`recheck_thread_before_post` re-reads the thread immediately before `post` and
holds any finding someone else raised at the same anchor or about the same
claim during the run. That is the same repeat rule `check-candidates` applies.

## Cost modes

| Stage | fast | standard | thorough |
|---|---|---|---|
| intent | sonnet | sonnet | sonnet |
| diff lane | sonnet | sonnet | opus |
| other lanes | off | sonnet, when eligible | opus, when eligible |
| verify | sonnet | sonnet; opus when a candidate is important or above | opus |
| second-pass | off | when configured | when configured |
| tie-break | sonnet | opus | opus |
| challenge | off | sonnet; opus for important or above | opus |
| edit | sonnet | sonnet | sonnet |

`auto` picks `fast` when no production source changed (documentation, tests,
configuration or generated files only), `thorough` when complexity is `high` or
more than 150 production lines changed, and `standard` otherwise. `fast` never
posts anything above a nit without a challenge. A minor or above finding found
in `fast` mode runs the challenge stage anyway.

## Outcomes and precision

ADR 0029. For each posted inline comment:
- **fixed (strong):** a later commit in the same pull request changed the
  anchored lines, and the thread is resolved or the author replied with
  agreement.
- **resolved (weak):** the thread is resolved with no change to the lines.
- **dismissed (strong):** the author or a maintainer replied with
  disagreement, or the owner recorded `dismiss` feedback.
- **outdated (weak):** the anchored lines changed and the thread is open.
- **open** or **unknown:** nothing decides it. Silence is never a negative
  label (ADR 0004).

`evaluate` adds `posted_fixed_rate`, `posted_dismissed_rate` and
`posted_findings_tracked`. Only strong outcomes count toward rates.
`owner_accepted_precision` keeps reading explicit feedback first.

## Security

The threat model's boundaries do not move.
- **Agents read untrusted input.** The runner starts `claude -p --restricted
  --strict-mcp-config` in a head checkout, with Read, Grep and Glob only, and
  output validated against a schema. No shell and no git: git's own options can
  run commands, so the driver writes base copies and history to disk instead.
  User settings, hooks and MCP servers are not loaded. A prompt-injected agent
  can produce bad JSON, which a check refuses. It cannot write, fetch or run
  commands.
- **Search is a read outside one repository.** ADR 0026 allows exactly one
  search endpoint, and every result is filtered against the allowlist before
  anything else reads it.
- **The writer is unchanged.** It still makes one request, to one endpoint.
  `watch` and the Action reach it only through `post`, with its idempotency key,
  head re-read and CI guards.
- **The Action** runs on `pull_request`, never `pull_request_target` with a
  checkout of the head. Fork pull requests get no secrets, so the Action
  reviews without posting there unless the maintainer opts in.

## Delivery

Each line below is one pull request with its own tests. They land in this
order, and each leaves `main` releasable.

1. This specification and ADRs 0021 to 0031.
2. Verdict policy knobs, the pre-post thread re-check and approval carry
   (ADR 0028).
3. The agent runner, with a `fake` runner for tests (ADR 0021).
4. Lanes, the structure-analyst agent, lane severity in `score` and
   `blocker_confirmed` (ADR 0023).
5. The challenger agent, the `challenge` command and the new held verdicts
   (ADR 0024).
6. Cost modes and the stage plan (ADR 0025).
7. The `review` driver (ADR 0022).
8. Allowlist globs, the search read and `queue` (ADR 0026).
9. `watch`, the `watch_heads` table and the lock (ADR 0027).
10. `outcomes` and the new `evaluate` metrics (ADR 0029).
11. Team profiles and cold start (ADR 0030).
12. The GitHub Action (ADR 0031).

## Testing

- Every agent stage is tested through the `fake` runner. It reads canned
  outputs from a directory keyed by agent name and call number, so a test can
  script a refusal and a relaunch.
- GitHub reads use the existing `fetchImpl` stub pattern. Search, check runs
  and review threads get fixtures.
- `review` gets an end-to-end test on a fixture repository with the fake
  runner. It covers a clean run, a run with one challenged finding, an
  unchanged scope and a moved head.
- `watch --once` gets a test that runs two passes and proves the second does
  nothing (idempotence).
- The Action gets a workflow lint and a dry-run job on this repository's own
  pull requests, with posting off.
