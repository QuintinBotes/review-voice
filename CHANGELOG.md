# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Documentation brought in line with 0.2.0's contract: the README, plugin
  README, `docs/POLICY-FORMAT.md` and `templates/config.example.yaml` no longer
  describe a five-finding cap or a flat 180-word budget.
- `docs/PLAN.md` is marked delivered and records where reality diverged —
  notably the repository going public at 0.1.0 rather than v1.0.0.
- ADR 0001 no longer claims the evaluation harness measures precedent recall.
  It does not, and knowing a relevant precedent was missed requires labelled
  retrieval data nobody has produced.

### Added

- `review-voice verify`: an optional second verification pass run by a command
  you configure, intended for a **different model** from the one that generated
  the findings. A confident rejection drops a finding, an unsure one downgrades
  it, a verifier that could not run changes nothing, and a verifier may weaken
  a severity but never strengthen one. Every verdict is recorded and `explain`
  lists what was suppressed.

### Removed

- Dead `loadEtags` / `saveEtags` helpers, which read a table migration v6 drops
  — two exported functions that would have thrown on call.

## [0.2.1] — 2026-09-17

### Fixed

- **A dry run no longer starves the sync that follows it.** The dry run
  populated an HTTP conditional-request cache without storing anything, so the
  real sync received `304`s and imported almost nothing — one report projected
  250 events and stored 6. Since the consent flow asks the user to approve a
  sync on the strength of the dry-run figures, this made that approval
  meaningless.
- Conditional requests are removed entirely. The collector re-derives
  everything from each response body and never kept one, so a `304` was a lie —
  and an empty `304` page with no `Link` header silently truncated pagination
  at whichever page happened to be unchanged.
- Incremental sync now works at the pull-request level, comparing GitHub's
  `updated_at` against a watermark recorded **after** the events were stored.

### Added

- `status` reports corpus composition by reviewer role, and warns when a corpus
  contains no owner events — without at least one, no policy rule can ever
  activate, and the failure was otherwise silent.

## [0.2.0] — 2026-09-17

### Changed

- **The finding count cap is gone.** Volume is bounded by the total word budget
  alone. A count cap and a word budget do the same job, and the count is the
  worse of the two: on tight findings it discarded findings the budget would
  have allowed. A policy layer may still impose a cap.
- **The total word budget scales with the change**, from a floor of 600 words
  rather than 180. At 40 words a finding the old floor allowed four and a half
  — the count cap returning through the back door on small changes. The budget
  is now a runaway guard rather than a trim target, and says so when it binds.
- **Two new severity tiers: `nit` and `question`.** Low-stakes observations and
  open asks now have a structural home instead of being suppressed or written
  into prose where they cannot be sorted or counted.
- **Findings must be ordered by severity**, checked by the validator. Ordering
  is what protects the reader, not omission: a reader who stops early has seen
  the most serious findings.
- **`nit`, `overall` and `summary` are no longer forbidden phrases.** `nit` is a
  severity marker that adds information rather than hiding a claim; the other
  two appear in real prose that word-boundary matching cannot distinguish from
  a summary section. True hedges and praise remain banned.

### Added

- `review-voice diff --pr <number>`: reviews a GitHub pull request through the
  read-only client, inferring the repository from the origin remote. Naming a
  pull request is the consent for reading it, so no allowlist entry is needed.
- Pull request acquisition reads up to GitHub's own 3000-file ceiling instead
  of 300, applies the cap above classification rather than below it, and
  reports `truncated` with an explicit note when files could not be read.
- Score breakdowns carry the location they came from, so `explain` matches a
  score to its finding rather than showing every finding the first one's
  numbers.
- `review-voice explain`: reports the category, confidence, score and precedent
  ids recorded for each finding, and says "not recorded" rather than
  reconstructing a rationale.
- Incremental polling sync: ETags persist between runs, so an unchanged
  repository costs almost nothing against the rate limit. No webhook receiver,
  per ADR 0002.
- `review-voice draft`: renders a validated review as a GitHub draft, from the
  same payload that would be sent. Posts nothing.
- `review-voice post-check`: reports whether posting is permitted, reading
  measured precision rather than configuration. No override.
- Policy rules are compiled by finding category rather than file path, and
  `record --candidates` carries each finding's category from the candidate that
  produced it. Going both ways on one category now registers as a contradiction
  and blocks the rule.
- `review-voice evaluate`: reports the specification's metrics against their
  targets, each with the basis it was computed from. A metric with no data
  reports "no data" rather than a flattering default.
- `review-voice score`: the specification's eligibility formula, computed
  deterministically — technical confidence, owner and repository alignment from
  weighted precedent, evidence quality and novelty against already-kept
  findings.
- `review-voice calibrate` and `policy show|approve|rollback`: feedback is
  compiled into proposed rules that are stored inactive, gated on three
  corroborating signals including an owner signal with nothing contradicting,
  and activated only on explicit approval. Versions are retained so rollback is
  possible, and rollback refuses a version that was never approved.
- `review-voice retrieve`: FTS5 lexical precedent retrieval with owner-weighted
  scoring, 180-day recency decay, specificity and context weighting, and
  separate caps for positive and negative precedents. The index is kept in step
  with the corpus by triggers, so purged events stop being retrievable.
- Consent flow: `review-voice discover` lists reachable repositories without
  reading any history, and `consent-plan` states exactly what a sync would
  read, where it is stored and what is discarded, before anything is read.
  `commands/init.md` gates every step on an explicit yes.
- `review-voice purge`: previews before deleting and requires `--confirm`.
  The audit entry recording a purge survives it.
- Ingestion now collects submitted review summaries as well as inline
  comments, and pull-request conversation comments behind
  `--include-conversation`. Template detection measures the proportion of
  structural lines rather than the presence of a checkbox.
- `review-voice sync`: ingests review history from allowlisted repositories.
  Comments are redacted at the download boundary, classified by reviewer role,
  filtered for review judgement, deduplicated across rebases, and selected
  newest-first under a per-repository share cap. Shortfalls are reported
  exactly rather than presented as a full scan. `--dry-run` reports what would
  be imported without storing anything.
- Corpus schema with no column for original comment text.
- Read-only GitHub client. Non-GET requests and repositories outside the
  allowlist are refused in code before any network call, with rate-limit
  backoff and bounded pagination. Credentials are borrowed from `gh` and never
  stored.
- Reviewer role classification: owner, team, external or bot. Bot output is
  excluded from voice learning regardless of the bot's permissions.
- Redaction pipeline covering private keys, PEM blocks, GitHub, AWS, Google,
  Slack, Stripe, npm, PyPI, OpenAI and Anthropic credentials, JWTs, database
  connection credentials, authorization headers and assignment-shaped secrets.
  Placeholders such as `changeme` are left alone. Content hashes are recorded
  before and after so a redaction is auditable without retaining the secret.
- Fixture suite covering all four classes from the specification, with a test
  asserting fixtures stay synthetic — no real addresses, hosts or credentials.
- Prompt-injection fixtures across three vectors: a source comment,
  pull-request text, and content imitating static-analysis output. Each asserts
  an absence, since a positive assertion cannot prove an injection failed.
- `claude plugin eval` suites for restraint and injection resistance.
- `review-voice evidence`: runs the static checks declared in configuration —
  and only those — with per-command timeouts, and parses TypeScript, .NET,
  Python and ESLint diagnostics into attributable signals.
- `review-voice context`: resolves `.review-voice/config.yaml`, the policy
  layer stack and opt-in static-evidence commands. A narrower layer may tighten
  a limit but never loosen it, and a committed `.review-voice/policy.yaml` is
  surfaced as a proposal requiring approval rather than applied.
- Local SQLite store under the platform data directory, with schema
  migrations, `0700`/`0600` permissions and an append-only audit trail.
- `review-voice record`, `feedback` and `status`: review runs are stored with
  positional finding ids (`rv_01`), feedback is captured as explicit evidence,
  and owner precision is computed excluding unlabelled findings.
- `review-voice diff`: structured diff acquisition for the working tree,
  the index (`--staged`) or a base ref (`--base`), with file classification,
  language detection, explained exclusions and untracked-file support.
- `commands/review.md` now drives the real pipeline: diff acquisition, the
  candidate and verifier agents, ranking, the concise editor, and a hard
  validation gate with a single retry.
- `review-voice validate-output`: the hard gate enforcing the output contract —
  at most five findings, 40 words each, 180 words total, exact no-findings
  response, required format, no hedging, no duplicate locations, no greetings
  or summaries. Reports all violations in one pass to drive a single retry.
- OSSF Scorecard workflow publishing a supply-chain posture score to the
  security tab.
- Repository skeleton: marketplace manifest, plugin manifest, command and agent
  definitions, JSON schemas, baseline policy, configuration templates.
- Bundled zero-dependency CLI with `doctor`, `--version` and `--help`.
- Build pipeline with a committed-artifact drift check.
- Identity guard preventing personal logins or private repository names from
  entering source, docs or fixtures.
- CI: typecheck, unit tests, bundle drift, plugin manifest validation, secret
  scanning, identity guard, action-pin check, and a Conventional Commits check
  on pull request titles, gated behind a single `ci-green` status check.
- Supply-chain hardening: all GitHub Actions pinned to commit SHAs with an
  enforcing check, least-privilege workflow permissions, `persist-credentials:
  false` on checkout, fork pull requests excluded from secret-holding jobs, and
  a release guard rejecting tags not on `main`.
- Architecture decision records closing the eight open decisions from the
  specification, all approved 2026-09-16.
- Branch and tag protection on `main` and `review-voice--v*`, required SSH
  commit signatures, GitHub secret scanning with push protection, private
  vulnerability reporting, and the repository security posture documented in
  `docs/REPO-SECURITY.md`.

[0.2.1]: https://github.com/QuintinBotes/review-voice/commits/main
