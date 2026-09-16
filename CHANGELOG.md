# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/QuintinBotes/review-voice/commits/main
