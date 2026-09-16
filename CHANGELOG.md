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
  scanning, identity guard.
- Architecture decision records closing the eight open decisions from the
  specification.

[Unreleased]: https://github.com/QuintinBotes/review-voice/commits/main
