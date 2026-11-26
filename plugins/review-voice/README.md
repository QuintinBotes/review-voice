# Review Voice

A concise, precedent-aware code reviewer for Claude Code.

Every finding names a concrete failure mode, in forty words or fewer, ordered
worst-first, with the tier derived from the kind of defect rather than asked
for. Silence when nothing qualifies:

```
No actionable findings.
```

Suggested fixes are verified independently from defects. The concise editor has
no tools, so each eligible candidate and its fix rendering instruction must be
passed inline, never as a file path.

Candidate anchors are checked against the reviewed diff before verification.
They must name an added line or the right-side location of removed code; an
unchanged context line is rejected with the nearest changed line for the analyst
to re-anchor or withdraw. `thread --out` and `symbols --out` accept either a
file path or a directory, writing `thread.json` or `symbols.json` in a
directory.

Full documentation, install instructions and threat model live in the
[repository root](https://github.com/QuintinBotes/review-voice).

## Commands

| Command | Does |
|---|---|
| `/review-voice:review` | Review the current diff, staged changes, or a PR |
| `/review-voice:init` | Set up identity, allowlist and baseline policy |
| `/review-voice:feedback` | Keep, dismiss, rewrite or suppress a finding |
| `/review-voice:calibrate` | Approve or reject proposed policy changes |
| `/review-voice:policy` | Show, diff, roll back or export policies |
| `/review-voice:explain` | Show why a finding was emitted or suppressed |
| `/review-voice:draft-review` | Compute the verdict and post the review after one confirmation |
| `/review-voice:status` | Corpus coverage, policy versions, retention |
| `/review-voice:sync` | Pull new review history (read-only) |
| `/review-voice:purge` | Delete stored data by repo, age, or entirely |

## Run a review end to end

In a clone of the repository, one command runs every stage, agents included,
records the run and computes the verdict:

```
node dist/review-voice.mjs review --pr 123 --repository acme/api [--mode auto] [--post] [--json]
```

Agents run as confined headless Claude Code processes, so `claude` must be
installed and logged in. Each stage's files land in a run directory under the
data directory (or `--out`). `--post` posts through the same guards as
`/review-voice:draft-review`, and only when `writes.github_posting_enabled` is
true. It re-reads the thread first and holds any point someone else raised
during the run; `--no-recheck-thread` turns that off. `--expect-head <sha>`
stops with exit 3 unless the pull request is at that commit, and
`REVIEW_VOICE_NO_COMMANDS=1` skips the configured static evidence and
second-pass commands. Exit codes: 0 done, 2 refused, 3 head moved, 4 waiting on CI, 6 CI needs
a rerun, 7 an agent failed twice, 8 thread changed before posting.

## Keep watching

`review-voice watch` reviews every pull request the queue finds, once per
head, and remembers what it did. Run it in the repository that holds your
`.review-voice/config.yaml`:

```
review-voice watch --interval 2h --post   # loop in a terminal
review-voice watch --once --post          # one pass, from cron or launchd
```

Without `--post` it reviews and records but posts nothing. Clones live under
`watch.workspace`, never in your own working trees, and a second watcher on the
same data directory exits at once.

## Skip what does not concern your team

By default `queue` lists every pull request your team is asked to review. Set
`queue.relevance` and a team-only request that matches no signal is skipped
(rule `relevance`, with its reasons). It is off without that block, and a
personal request, an assignment, a follow-up or a dismissed review is never
filtered. The check reads only the files list and CODEOWNERS at the base
commit; no agent runs.

```yaml
queue:
  relevance:
    teams: [org/slug]          # default: queue.teams
    min_owned_share: 0.2       # share of changed lines in files the team owns
    ignore_owned_paths: []     # owned globs that do not count toward the share
    paths: []                  # any changed file matching one is a signal
    added_line_patterns: []    # case-insensitive regular expressions on added lines
    authors: []                # logins
    keywords: []               # whole words in the title or description
    discover: { updated_within_hours: 24, max_pulls: 50 }   # optional
```

`review-voice relevance --pr <n> [--repository owner/repo]` prints the result as
JSON (exit 0 whether or not it is relevant). With `discover`, recently updated
pull requests nobody requested are listed as `SURFACE` when they match. A
surfaced pull request is report-only: `watch` prints it and never reviews,
posts or records it. See [ADR 0038](../../docs/adr/0038-the-queue-reviews-what-concerns-the-team.md).

## Measure calibration against labels

Two `evaluate` subcommands check whether verifier confidence means what the
gates assume, using only the local store - no network, no model calls, no
writes to the store (except `--stability`, below):

```
node dist/review-voice.mjs evaluate label-sample --out sheet.json --n 40 --seed 1
# fill each row's label: TRUE, TRUE-NOT-WORTH, PARTLY, FALSE or UNCHECKABLE
node dist/review-voice.mjs evaluate calibration --labels sheet.json [--text]
node dist/review-voice.mjs evaluate calibration --labels sheet.json --thresholds proposed.yaml
```

`label-sample` draws a seeded, stratified sample of stored candidates (band
crossed with verified-or-rejected) and writes a blank labelling sheet. The
sheet is the labels format plus the context needed to judge each claim, so a
filled sheet goes straight back to `--labels`. `calibration` then reports
precision by band and by category with Wilson 95% lower bounds, how much
volume the recorded thresholds ship and what a proposed set would ship
instead, and how often the verifier rejected a finding a human calls true.
See [ADR 0040](../../docs/adr/0040-calibration-is-measured-against-labels.md).

`--stability <k>` measures how much the verifier disagrees with itself. It
re-verifies every labelled candidate k times (2 or more) with the
evidence-verifier, never from a cache, and reports per candidate the
confidence min, max and population standard deviation, plus the share of
candidates whose gate decision flips across runs under the current thresholds
and, with `--thresholds`, the proposed set. The decision is the scorer's own
gate logic with the stored final score held fixed. The candidates must share one
repository and head, and the working directory must be a checkout of that head;
otherwise it refuses before any call:

```
node dist/review-voice.mjs evaluate calibration --labels sheet.json --stability 5 [--thresholds proposed.yaml] [--text]
```

This calls a model, so it first prints `k x candidates` as the number of calls
it will make, and refuses (exit 2) above `evaluate.stability_max_calls`
(default 200) unless `--confirm` is passed.

## Requirements

Node 22 or newer. `git`. `gh` only if you enable GitHub history ingestion.

No `npm install` - the plugin ships a single pre-built bundle with zero runtime
dependencies.

To review every pull request in CI, see [the GitHub Action guide](../../docs/ACTION.md).
