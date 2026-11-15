# Review Voice

**A code reviewer for Claude Code where every finding names a concrete failure
mode - ordered worst-first, and silent when it has nothing worth saying.**

---

## The problem

LLM code review tends to produce a wall of text: generic best practices,
naming suggestions, speculative risks, and diplomatic hedging around
observations nobody asked for. The signal is real but it is buried, and the
reviewer stops reading.

Review Voice answers exactly one question about a change:

> Is there a concrete, material problem here that **this reviewer** would
> actually want called out?

If the answer is no, the entire output is:

```
No actionable findings.
```

## What a review looks like

```
[blocking] `src/auth/session.ts:84` - The response returns the refresh token
before the transaction commits, so a retry can mint two valid tokens. Commit
before sending the response.

[important] `.github/workflows/release.yml:52` - The publish job can run after
a skipped verification job. Make verification a required dependency.

[nit] `src/api/types.ts:20` - Field is optional but every caller sets it. The
optionality is noise. Make it required.

[question] `src/db/migrate.ts:44` - Is the down migration exercised anywhere? A
rollback path that never runs is a rollback path that does not work.
```

No greeting. No summary. No praise. No process commentary.

Severity runs `blocking` → `important` → `minor` → `nit` → `question`, and the
ordering is checked. You can stop reading anywhere and know you have seen
everything more serious. There is no cap on how many findings you get - a real
finding is never dropped to hit a number.

The tier is derived rather than asked for, so the same finding does not move up
and down a page ordered by severity between runs. It combines the kind of
defect with how far the affected code reaches - measured by the CLI from the
reviewed tree, not judged by a model. A defect in code the whole repository
depends on outranks the same kind of defect in one file, and neither answer
changes between runs of the same diff.

## How it works

Review Voice draws a hard line between arithmetic and judgment.

**The bundled CLI does the deterministic work** - diff acquisition, config and
policy layering, static evidence collection, precedent retrieval, preference
scoring, deduplication, and output validation.

**Claude Code agents do the judgment work** - generating candidate defects,
verifying them against the diff, and wording the result.

This matters for one practical reason: the contract is enforced by a validator
that *rejects* non-compliant output and forces a re-edit, not by a prompt that
asks nicely. Word limits, hedge phrases, severity ordering and the exact
no-findings string are all checked rather than requested.

**It reads your repository's own rules.** `CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `.agents/rules/` and skill documents reach the analyst and
the verifier, as evidence about what the repository requires and never as
instructions to the reviewer. Precedent cannot cover this ground: the better a
convention is observed, the fewer review comments it leaves behind.

**Every finding is verified before it ships**, optionally a second time by a
command you configure. A claim that something does not exist is checked with
`git grep` against the ref under review, because that is the cheapest claim to
verify and the most damaging to get wrong.

**A single run is a sample, not the answer.** Two reviews of one diff agreed on
2 findings of 8 when measured, so a second run finding something new is expected
rather than a defect. `RV evaluate` reports it as `candidate_set_agreement`,
published rather than targeted.

It learns through **retrieval plus policy compilation**, not model fine-tuning.
Your historical reviews are ingested, redacted, weighted, and compiled into
short, inspectable YAML rules that you approve before they take effect. Every
rule can show the evidence that produced it. Every policy version can be rolled
back.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

```
/plugin marketplace add QuintinBotes/review-voice
/plugin install review-voice
/review-voice:init
```

Then:

```
/review-voice:review
/review-voice:review --base origin/main
/review-voice:review --staged
/review-voice:review --pr 85
/review-voice:review --pr 85 --full
```

**Requirements:** Node 22 or newer, `git`, and `gh` only if you enable GitHub
history ingestion. There is no install step - the plugin ships a single
pre-built bundle with zero runtime dependencies.

### As a GitHub Action

To review every pull request in CI, add one workflow and one secret,
`ANTHROPIC_API_KEY`. The action is listed on the GitHub Marketplace.

```yaml
name: Review Voice
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: QuintinBotes/review-voice@review-voice--v1.25.0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          post: false
```

It runs in your CI with your key, reads its configuration from the pull
request's base commit, and posts only when both `post: true` and the
repository's `writes.github_posting_enabled` say so. Pin it by release tag or
commit SHA. Inputs, forks, cost and exit codes are in
[docs/ACTION.md](docs/ACTION.md).

## Privacy in one paragraph

Review Voice is local-first and reads before it writes. It reads only repositories you
explicitly allowlist, never everything your token can reach. Everything it
stores lives in your platform's data directory, never in your repository and
never on a server we control. Secrets are redacted before anything is persisted,
indexed, logged, or put in a prompt - as defence in depth, not as a guarantee.
Its one write is `RV post`: a review of verified findings, inline on their
lines, sent only with `--confirm` for that post, and an approval only while the
head is unchanged and CI is green (see
[ADR 0010](docs/adr/0010-review-verdict-posting.md)). The only other write is
`RV reply`, off unless posting is on: one templated reply under one of its own
inline comments that a person asked a question on, also sent only with
`--confirm` ([ADR 0035](docs/adr/0035-one-bounded-reply-per-own-finding.md)).
It never merges, dismisses reviews, resolves threads or sets a status.
`RV verdict` computes the full decision as JSON - event, action, reasons, CI,
complexity cap, held findings and payload preview - and never posts, so a loop
that drives reviews should call it instead of re-implementing the rules. Its
exit codes: 0 ready, 2 nothing to post, 3 head moved, 4 CI still running, 5 CI
red on a re-check, 6 CI needs a rerun
([ADR 0013](docs/adr/0013-ci-needs-rerun.md)).
Full detail in [PRIVACY.md](PRIVACY.md) and
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

### What reaches the network

Every outbound call, by command, for a host that has to list what leaves the
machine. GitHub means `https://api.github.com`, the only API host: the client
refuses to send its token anywhere else, and GitHub Enterprise is not
supported. The token is `GITHUB_TOKEN`, else `GH_TOKEN`, else `gh auth token`.
`origin` is the clone's own remote, fetched with your git credentials, and only
when it is `github.com/<the repository under review>`.

| Command | Reaches | What leaves the machine |
|---|---|---|
| `review --pr` | GitHub, `origin`, the model, configured commands | Everything `diff --pr`, `thread`, `config resolve` and `verdict` send. The diff, pull request description, thread, candidates and the files the agents read, to the model through `claude -p` (or a `runners:` CLI the operator configured). Static-evidence and second-pass commands run unless `REVIEW_VOICE_NO_COMMANDS=1`. With `--post`, one review write. |
| `review --base` | the model, configured commands | No GitHub call and no fetch. The diff and the files the agents read, to the model, as above. |
| `diff --pr` | GitHub, `origin` | Reads of the pull request, its files, the repository, a compare, your login and your own reviews. Fetches `pull/<n>/head`, the base, and the previous head. Without `--pr`, nothing. |
| `thread` | GitHub | Reads the description, inline comments, reviews, events, conversation and review threads (GraphQL); with `review.linked_issues`, up to five linked issues. |
| `config resolve` | GitHub | One read of the pull request, for its base commit. The configuration's bytes come from `git show <base>:.review-voice/config.yaml` in your clone (else `origin/<base branch>` when origin is the repository, else the defaults); the head's copy is never read. `--config` or an absolute `REVIEW_VOICE_CONFIG` takes its place. |
| `verdict` | GitHub | Reads the head, CI check runs and statuses and the thread; with `review.suggestions`, file contents at the head. |
| `post` | GitHub | The `verdict` reads, then with `--confirm` and posting enabled, one `POST /pulls/<n>/reviews` with the body, event, commit and inline comments. |
| `reply` | GitHub | The `outcomes` reads, then with `--confirm` and posting enabled, one reply under one of its own comments. |
| `outcomes` | GitHub | Reads pull requests, comments, threads, reviews, commits and, for a suggestion, the file at the head; with `--approvals`, a `reverts:` search. |
| `sync`, `discover`, `queue` | GitHub | Reads within the allowlist: history for `sync`, your repository list for `discover`, a pull request search for `queue` (`--settled` is local). |
| `watch` | GitHub, github.com, the model | What `queue` and `review` send, plus a clone and `pull/<n>/head` fetches. Configured commands are off unless `watch.run_repository_commands` is true. |
| `agent`, `recall` | the model | The prompt and the files the agent reads; `recall --runner fake` sends nothing. |
| `verify`, `evidence` | only through the commands you configure | Review Voice sends nothing itself; the configured command receives the candidates or runs in the checkout. |
| every other command | nothing | The local store, local git and files only. `reproduce` runs its command with no network, and `doctor` only runs `--version` on the tools it checks. |

The agents' process gets no `GITHUB_TOKEN`, `GH_TOKEN` or `REVIEW_VOICE_*`
variable. The only GitHub writes are `post` (including `review --post` and
`watch --post`) and `reply`, both behind `writes.github_posting_enabled`.

## Contributing

Bug reports, false-positive reports and prompt-injection test cases are all
genuinely useful - a false-positive report is the highest-value issue you can
file. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

`main` is protected and every change goes through a pull request with CI
green - including the maintainer's. See
[docs/REPO-SECURITY.md](docs/REPO-SECURITY.md).

## Licence

[MIT](LICENSE).
