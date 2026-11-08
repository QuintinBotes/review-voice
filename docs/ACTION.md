# Run Review Voice in CI

The GitHub Action runs one review for each pull request event, in your CI, with
your keys (ADR 0031). There is no hosted service.

## Minimal workflow

```yaml
name: Review Voice
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: review-voice-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: QuintinBotes/review-voice@review-voice--v1.22.0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          post: false
```

Pin the action to a release tag. Tags are named `review-voice--v<version>`; the first release with the action is 1.19.0, and 1.22.0 is the first ready for the GitHub Marketplace. Pin a full commit SHA instead if your organisation requires it.

Pin both actions by commit SHA in your own repository.

Add one secret, `ANTHROPIC_API_KEY`, under your repository's Actions secrets. The action has no key of its own: every review it runs is paid for by the key of the repository that runs it.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | Cost mode: `auto`, `fast`, `standard` or `thorough` |
| `post` | `false` | Post the review to the pull request |
| `anthropic-api-key` | none | Required for a review; empty means the action skips |
| `github-token` | the workflow token | Reads the pull request and authors a posted review |
| `claude-code-version` | pinned | Version of Claude Code to install |
| `config` | `.review-voice/config.yaml` | A repository-relative path, read from the pull request's base commit |
| `fail-open` | `false` | Pass the job when the review is unavailable on a low-risk change (`failed_open`) |

## Which configuration a review reads

A review never reads the `.review-voice/config.yaml` of the pull request it is
reviewing, because the author could loosen the review bar in the same change.
The run uses `--config`, else an absolute `REVIEW_VOICE_CONFIG`, else the
file at the pull request's **base commit**. The base commit must be in the
clone, which is why the examples check out with `fetch-depth: 0`; when it is
missing, or has no config file, the review runs with the built-in defaults and
says so in its notes.

The `config` input follows the same rule. A repository path other than the
default is read from the pull request's base commit, written to a private file
under `RUNNER_TEMP`, and passed to the review as `--config`, so a pull request
that edits that file does not change its own review. When the base commit has
no file at that path, as in the pull request that adds it, the review runs with
the built-in defaults and the job summary says so. When the base commit is not
in the clone, the step stops with an error asking for `fetch-depth: 0`.

The input must be a plain repository-relative path, such as
`ci/review-voice.yaml` or `./ci/review-voice.yaml`. An absolute path, a `.` or
`..` component, a doubled slash, or a leading dash stops the step with an
error, because resolving such a path on disk is how a link or an alias could
reach the head's copy. To use a file from outside the repository, such as one
an earlier step wrote, set `REVIEW_VOICE_CONFIG` to its absolute path in the
job's `env` and leave `config` at its default.

## Posting

Posting needs both `post: true` in the workflow and
`writes.github_posting_enabled: true` in the repository config, plus
`pull-requests: write`. The review is authored by the token's identity. With
`post: false` the review is computed and written to the job summary only.

## Forks

Pull requests from forks get no secrets. The action sees an empty key, writes a
skip line to the job summary and exits 0, so the check does not fail.

## Cost

Each run is one review on your API key. `mode: auto` runs a cheap review when
only tests, documentation or configuration changed and a deeper one for large
or complex changes. The store is cached between runs, so earlier decisions
carry over.

## Why `pull_request_target` is refused

`pull_request_target` runs with secrets and write access. If the workflow also
checks out the pull request head, an attacker's code runs with those secrets.
The action exits 1 in that case. Use `pull_request`.

## Exit codes

The action exits with the review command's code, except that a moved head (3)
and pending or rerun-needed CI (4, 6) exit 0 with a line in the summary.

## When the review is unavailable

Exit 7 means an agent failed twice, so no review exists. The report's
`failure.mode` says whether that matters: `failed_open` for a change assessed
as normal risk (such as documentation only), `failed_closed` for a high-risk
change, one whose risk was never assessed, or a follow-up to a pull request an
earlier run assessed as high. By default the action exits 7 for both, so a
required check stays red. With `fail-open: true` a `failed_open` review
passes the job, with a line in the summary saying the review was unavailable
on a low-risk change; a `failed_closed` review still exits 7 whatever the
input says. Prefer it to `continue-on-error: true` on the step, which lets a
`failed_closed` change through as well. Nothing about a failure is ever
posted to the pull request.

## Provenance

Every review the action runs is recorded with the origin `action`, which
`explain`, `status` and the report's `Provenance` line show, so an Action
review can be told apart from a local `review --pr`.
