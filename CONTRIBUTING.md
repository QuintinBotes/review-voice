# Contributing to Review Voice

Thanks for being here. A few things about this project are unusual, so please
read the first two sections before opening a PR.

## The most valuable contribution is a false positive

Review Voice exists to be quiet. A report that it said something not worth
saying is more useful than a report that it missed something, because precision
is the product and recall is a nice-to-have. There is a
[dedicated issue template](.github/ISSUE_TEMPLATE/false-positive.yml) for it.

Prompt-injection test cases are a close second. If you can make the reviewer
follow an instruction hidden in a diff, that is a bug worth a CVE-shaped
conversation, and we want it.

## Two hard rules

**0. Never commit anything credential-shaped.** GitHub push protection scans
this repository and will reject the push — it rejected the redaction test suite
on its first attempt. Tests that need credential-shaped strings assemble them
from fragments at runtime, so no literal matching a provider's token format
exists in any file. See `test/redact.test.mjs`.

**1. Never commit real review data.** Every fixture must be synthetic. Real
pull-request comments carry other people's words, other companies' code, and
occasionally credentials. CI runs a secret scan, but the rule holds regardless
of whether the scanner catches a particular case.

**2. Never hardcode an identity.** Review Voice models whoever runs it. No
GitHub login, personal repository name, or personal preference belongs in the
source, the docs, the policies, or the fixtures. `npm run guard:identity`
enforces this and CI runs it.

The guard hardcodes no names, because a guard that lists what it is hiding
publishes it. It checks structural patterns, and optionally reads extra terms
from `.identity-guard.local` — a gitignored file for anything specific to your
employer or private repositories.

## Getting set up

```bash
git clone https://github.com/QuintinBotes/review-voice.git
cd review-voice
npm install          # dev tooling only; the plugin itself ships zero deps
npm run verify       # typecheck, tests, bundle drift, identity guard
```

Try your working copy in Claude Code:

```
/plugin marketplace add /path/to/your/clone
/plugin install review-voice
```

## The build artifact is committed

`plugins/review-voice/dist/review-voice.mjs` is checked in, because plugins are
installed by git clone with no install step. **If you change anything under
`src/`, run `npm run build` and commit the result.** CI fails on a stale bundle.

Third-party packages are fine as `devDependencies` — esbuild inlines them. They
must never become runtime dependencies.

## Workflow and supply-chain rules

Every third-party GitHub Action is pinned to a full commit SHA with a version
comment:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
```

A tag is a mutable pointer; whoever controls the action's repository can move
it and run their code against this repository's tokens. `npm run check:pins`
enforces this and CI runs it. Dependabot keeps the SHAs current.

Workflows start from `permissions: {}` and each job opts into the minimum it
needs. Checkout always sets `persist-credentials: false`, so the workflow token
is not left in `.git/config` for a later step — or one of its dependencies — to
read. Jobs that hold a secret never run code from a fork.

## Architecture rule

Deterministic work belongs in the CLI; judgment belongs in agents. Concretely:
never ask a model to compute a score, count words, or enforce a limit. If you
find yourself writing a prompt that says "make sure this is under 40 words",
the logic belongs in the validator instead. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Scope

This is a focused tool with a small maintainer. Features that make it a general
code review platform — dashboards, multi-provider support, IDE integrations,
auto-fixing — are out of scope unless discussed in an issue first. The
[non-goals](docs/PLAN.md) are deliberate.

Significant design changes need an ADR in `docs/adr/`. Copy the format of an
existing one.

## Commits and PRs

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
`docs:`, `refactor:`, `test:`, `chore:`. Keep the diff scoped to what the PR
claims to do — unrelated refactors and formatting churn make review harder and
will be asked about.

Before pushing: `npm run verify`, and `npm run build` if you touched `src/`.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
