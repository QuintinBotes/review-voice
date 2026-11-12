# SARIF fixtures

Recorded tool output for the `sarif` adapter (`docs/adr/0003`, amendment of
2026-11-09). Each file is one SARIF 2.1.0 document, hand-written in the shape
the named tool version emits, and every one is synthetic. No real project,
path, host, identity or credential appears, and no `$schema`,
`informationUri` or `helpUri` key, because the parser reads none of them.
These are flat files, not case directories, because `test/fixtures.test.mjs`
treats every `fixtures/<group>/<name>/` directory as a review case.

`test/evidence-sarif.test.mjs` states, per file, the signal count and the
first signal's fields, worked out by hand from the mapping and level rules in
`docs/agent-handoffs/professionalisation/S20-sarif-static-evidence.md`, and
applies the forbidden patterns of the fixtures test to these files.

| File | Tool and version whose shape it follows | Command that produces it | Exercises | Confirmed against a real run |
|---|---|---|---|---|
| `semgrep.sarif.json` | Semgrep OSS 1.90.0 | `semgrep scan --config .semgrep --metrics=off --sarif --quiet .` | `Semgrep OSS` driver name, `semanticVersion` only, rule-level `defaultConfiguration` with no result `level`, one `note` rule, one `nosemgrep` suppression (`kind: inSource`, no `status`), snippets | no |
| `opengrep.sarif.json` | Opengrep 1.4.0 | `opengrep scan --config .opengrep --metrics=off --sarif --quiet .` | result-level `error`, `warning` and `note`, `uriBaseId: %SRCROOT%` left unresolved | no |
| `gitleaks.sarif.json` | gitleaks v8.21.2 | `gitleaks git --report-format sarif --report-path /dev/stdout --no-banner` | `partialFingerprints` with placeholder values, a snippet whose text is the word `redacted`, no result `level` (the tool sets none, so its results arrive as `warning`), `semanticVersion` `v8.0.0`, which the tool writes whatever its release, so a configured `version: gitleaks version` records the true one | no |
| `trivy.sarif.json` | Trivy 0.58.0 | `trivy fs --scanners vuln --format sarif --quiet .` | `originalUriBaseIds`, a lockfile location, a long multi-line message collapsed to one line, rule `properties`, `error`, `warning` and `note` | no |
| `codeql.sarif.json` | CodeQL 2.19.3 | `codeql database analyze db --format=sarif-latest --output=/dev/stdout` | rules under `tool.extensions[].rules` with the level in `defaultConfiguration`, `uriBaseId: %SRCROOT%`, one in-source suppression with no `status` | no |
| `ruff.sarif.json` | ruff 0.8.0 | `ruff check --output-format sarif .` | absolute `file:///work/repo/...` URIs made relative under the root, a percent-encoded path, `error` only (the tool emits no other level) | no |
| `golangci-lint.sarif.json` | golangci-lint 1.62.0 | `golangci-lint run --out-format sarif ./...` | a duplicate result kept once, `error`, `warning` and `note`, a result with no `locations` | no |

An unconfirmed row is a follow-up for a person, who runs the named command
over a synthetic repository and replaces the file with what the tool wrote,
keeping it synthetic under `CONTRIBUTING.md`.
