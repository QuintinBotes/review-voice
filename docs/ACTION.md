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
      - uses: QuintinBotes/review-voice@review-voice--v1.19.0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          post: false
```

Pin the action to a release tag. Tags are named `review-voice--v<version>`; the first release with the action is 1.19.0. Pin a full commit SHA instead if your organisation requires it.

Pin both actions by commit SHA in your own repository.

Add one secret, `ANTHROPIC_API_KEY`, under the repository's Actions secrets.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | Cost mode: `auto`, `fast`, `standard` or `thorough` |
| `post` | `false` | Post the review to the pull request |
| `anthropic-api-key` | none | Required for a review; empty means the action skips |
| `github-token` | the workflow token | Reads the pull request and authors a posted review |
| `claude-code-version` | pinned | Version of Claude Code to install |
| `config` | `.review-voice/config.yaml` | A different path is copied over the default before the run |

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
