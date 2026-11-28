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
      - uses: QuintinBotes/review-voice@review-voice--v1.30.0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          post: false
```

The `permissions` block grants `contents: read` and `pull-requests: write` only. With `review.linked_issues: true` in the repository config, a private repository's workflow also needs `issues: read`; without it every issue read fails, stays a local warning and the review goes on without the issues.

Pin the action to a release tag. Tags are named `review-voice--v<version>`; the first release with the action is 1.19.0, and 1.22.0 is the first ready for the GitHub Marketplace. Pin a full commit SHA instead if your organisation requires it.

Pin both actions by commit SHA in your own repository.

Add one secret, `ANTHROPIC_API_KEY`, under your repository's Actions secrets. The action has no key of its own: every review it runs is paid for by the key of the repository that runs it. Create the key inside a workspace in the Anthropic Console, ideally one with a spend limit: a key that is not scoped to a workspace is refused with "This API key is not scoped to a workspace", and the review then fails closed with exit 7. A failed review prints its reason as an error annotation in the job log as well as in the summary.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | Cost mode: `auto`, `fast`, `standard` or `thorough` |
| `post` | `false` | Post the review to the pull request |
| `provider` | `anthropic` | Where the model runs: `anthropic`, `bedrock`, `vertex` or `foundry`. See [Credentials](#credentials) |
| `anthropic-api-key` | none | With `provider: anthropic`, the key a review runs on |
| `claude-code-oauth-token` | none | With `provider: anthropic`, a token from `claude setup-token` in place of the key; with neither the action skips |
| `github-token` | the workflow token | Reads the pull request and authors a posted review |
| `claude-code-version` | pinned | Version of Claude Code to install |
| `config` | `.review-voice/config.yaml` | A repository-relative path, read from the pull request's base commit |
| `fail-open` | `false` | Pass the job when the review is unavailable on a low-risk change (`failed_open`) |

## Credentials

The workflow picks the provider with the `provider` input; nothing in the pull
request or the repository config can change it. The agents' process gets the
chosen provider's selection and the job's environment, and never
`GITHUB_TOKEN`, `GH_TOKEN` or `REVIEW_VOICE_*`.

| `provider` | Credential the gate looks for | Model host |
| --- | --- | --- |
| `anthropic` | `anthropic-api-key` or `claude-code-oauth-token` | `api.anthropic.com` |
| `bedrock` | `AWS_ACCESS_KEY_ID`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE` or `AWS_WEB_IDENTITY_TOKEN_FILE` | `bedrock-runtime.<region>.amazonaws.com` |
| `vertex` | `GOOGLE_APPLICATION_CREDENTIALS` | `aiplatform.googleapis.com` or its regional host |
| `foundry` | `ANTHROPIC_FOUNDRY_API_KEY` or `AZURE_CLIENT_ID` | `<resource>.services.ai.azure.com` |

With a cloud provider, the provider's own login step runs first and exchanges
the workflow's OIDC token for short-lived credentials, so no long-lived secret
is stored; the job needs `id-token: write`. Grant the role only model
invocation (docs: [Bedrock](https://code.claude.com/docs/en/amazon-bedrock#iam-configuration),
[Google Cloud](https://code.claude.com/docs/en/google-vertex-ai#iam-configuration),
[Foundry](https://code.claude.com/docs/en/microsoft-foundry)). The Anthropic
key and token are not passed to a cloud provider's review.

A review asks for the `haiku`, `sonnet` and `opus` aliases by cost mode, and
Claude Code resolves each to the provider's own model ID. Pin them with
`ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and
`ANTHROPIC_DEFAULT_OPUS_MODEL` in the job's `env` when your account offers
other IDs, such as a Foundry deployment's names. The action sets
`CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK=1` for a cloud provider, so a model
the account cannot use fails the review with the reason in the log instead of
switching to another model mid-review. The `Cost` line is the figure Claude
Code reports, or `n/a` when it reports none; the provider's bill is the
authority.

A Claude Code OAuth token runs on a Claude subscription:

```yaml
      - uses: QuintinBotes/review-voice@review-voice--v<version>
        with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Amazon Bedrock, through OIDC (the login step exports the credentials and
`AWS_REGION`):

```yaml
permissions:
  contents: read
  pull-requests: write
  id-token: write
# ...
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        if: github.event.pull_request.head.repo.full_name == github.repository
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
          aws-region: us-west-2
      - uses: QuintinBotes/review-voice@review-voice--v<version>
        with:
          provider: bedrock
```

Google Cloud's Agent Platform (Vertex AI), through Workload Identity
Federation:

```yaml
      - id: gcp
        if: github.event.pull_request.head.repo.full_name == github.repository
        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - uses: QuintinBotes/review-voice@review-voice--v<version>
        env:
          ANTHROPIC_VERTEX_PROJECT_ID: ${{ steps.gcp.outputs.project_id }}
          CLOUD_ML_REGION: us-east5
        with:
          provider: vertex
```

Microsoft Foundry, through an Entra application with a federated credential.
`azure/login` exports no variable, so set `AZURE_CLIENT_ID` on the step: a fork
run gets no secret and skips.

```yaml
      - if: github.event.pull_request.head.repo.full_name == github.repository
        uses: azure/login@a641126d1b8aa4d1fa005f4f92df94a3a4c4c906 # v3.1.0
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - uses: QuintinBotes/review-voice@review-voice--v<version>
        env:
          ANTHROPIC_FOUNDRY_RESOURCE: your-resource-name
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
        with:
          provider: foundry
```

The gate only sees variables, so a self-hosted runner whose cloud credentials
come from instance metadata alone skips; set `AWS_PROFILE` (or the provider's
variable above) in the job's `env`. Anthropic's own workload identity
federation (`ANTHROPIC_FEDERATION_RULE_ID`) is not supported yet: Claude Code
does not read it with `--bare`, and the review's parallel agents would each
exchange the single-use GitHub OIDC token.

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
`pull-requests: write`. To post an approval with the default workflow token,
the repository must also allow it: Settings, Actions, General, Workflow
permissions, "Allow GitHub Actions to create and approve pull requests". That
setting is off by default. Without it GitHub refuses the approval, so nothing
is posted, the job passes, and the log carries a warning naming the setting.
Comments and requests for changes post either way. The review is authored by
the token's identity. With
`post: false` the review is computed and written to the job summary only.
With `post: true` and posting off in the config the review reads (the base
commit's), the review still runs and the job passes: nothing is posted, and
the log carries a warning saying so. That is the state of the pull request
that adds the config, since the base commit has none yet.

## Following what the Action posts

The Action keeps its store on the runner, so a review it posts is not in your
local store and `outcomes` does not see it. `review-voice outcomes --recover`
reads GitHub for reviews by `github-actions[bot]` (or the logins in
`outcomes.recover_from`) on the allowlisted repositories' pull requests updated
inside `--since`, records each one whose inline comments are findings as a run,
and then follows them as usual: an owner's reply, a resolution or a change to
the lines becomes an outcome. It reads GitHub and writes only your local store,
and running it again records nothing twice (docs/adr/0042). A recovered run has
no category or scores, since the posted text does not carry them, and no reply
is offered under its threads.

## Forks

Pull requests from forks get no secrets and no OIDC token. The action sees no
credential for the chosen provider, writes a skip line naming what it looked
for to the log and the job summary and exits 0, so the check does not fail.
Guard a cloud login step with
`if: github.event.pull_request.head.repo.full_name == github.repository`, as
the examples above do, or it fails the job before the action can skip.

## Cost

Each run is one review on your API key or your provider's account. `mode: auto` runs a cheap review when
only tests, documentation or configuration changed and a deeper one for large
or complex changes. The store is cached between runs, so earlier decisions
carry over.

## Why `pull_request_target` is refused

`pull_request_target` runs with secrets and write access. If the workflow also
checks out the pull request head, an attacker's code runs with those secrets.
The action exits 1 in that case. Use `pull_request`.

## Exit codes

The action exits with the review command's code, except that a moved head (3)
and pending or rerun-needed CI (4, 6) exit 0 with a line in the log and the summary.

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

## The analytics report

`review-voice evaluate --html` renders the evaluation figures (the gates,
goals and reported figures with their bases, seconds by stage, posted-finding
outcomes, owner labels by lane and rule, and each active suppression since its
approval) as a static HTML fragment in the subset GitHub renders in a job
summary. The action does not write it, and it puts no `review-voice` command
on the runner. A workflow that wants it adds these steps after the review step.
They check out the plugin at the tag the review step pins (a release with
`evaluate --html`), run its bundle on Node 22, and set `REVIEW_VOICE_DATA_DIR`
to the action's own data directory, `${{ runner.temp }}/review-voice`, so the
figures cover the store the cache restored. Without that variable the bundle
opens an empty store on the runner and the summary reads `no data` throughout.

```yaml
      - uses: actions/checkout@v4
        with:
          repository: QuintinBotes/review-voice
          ref: review-voice--v<version>
          path: .review-voice-plugin
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - env:
          REVIEW_VOICE_DATA_DIR: ${{ runner.temp }}/review-voice
        run: node .review-voice-plugin/plugins/review-voice/dist/review-voice.mjs evaluate --html >> "$GITHUB_STEP_SUMMARY"
```

Leave it out unless everyone who can see the Actions run may see the lanes,
rule ids and globs of the repository's configuration. Locally,
`review-voice evaluate --html --out <path>` writes the same report as a
complete static page that loads nothing. See
[docs/EVALUATION.md](EVALUATION.md), "The rendered report".

## Provenance

Every review the action runs is recorded with the origin `action`, which
`explain`, `status` and the report's `Provenance` line show, so an Action
review can be told apart from a local `review --pr`.

## Configured runners

A `runners:` block names another model family for the second pass or the
challenge (ADR 0003, amended 2026-11-09). It is honoured only from a `config`
input other than the default, which the step passes as `--config`, or from an
absolute `REVIEW_VOICE_CONFIG` in the job's `env`; a block in the default
`.review-voice/config.yaml` read from the base commit is ignored with a warning,
because a runner is a command the job executes. The workflow must install the
binary the block names (`codex`, `gemini`) before the step. A configured
challenger that cannot run holds the challenged findings instead of passing
them. A second-pass runner that cannot run leaves its verdicts unverified and
the findings unchanged, as a shell verification command does. Either way the
review goes on.
