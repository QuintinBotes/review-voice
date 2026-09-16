# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  commit signatures, and the repository security posture documented in
  `docs/REPO-SECURITY.md`.

[Unreleased]: https://github.com/QuintinBotes/review-voice/commits/main
