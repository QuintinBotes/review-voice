# Professionalising Review Voice: the program

**Status:** proposed, 2026-11-07. **Baseline:** `main` at `919d0fd` (release
1.21.1), 1,718 tests green. **Implementation partners:** Orbit (driving the Claude CLI
as implementer and the Codex CLI as independent reviewer), one run per spec,
part or slice, configured in `.orbit/config.yaml`; Codex again as a
pre-pull-request reviewer of every branch; Muse Wonder Full for the S12
slices and as the fallback implementer. **Driver:** `GOAL.md` in this folder
is the goal a Claude Code session runs to implement the whole program with
those three tools and to file their feedback as GitHub issues.

This folder holds a gap analysis of Review Voice against three product
documents for a pull-request reviewer (a product specification, an
architecture and a set of decision records; the product's own name is
ignored throughout), and fourteen implementation specs that close the gaps
worth closing. Each spec ends with a paste-ready Orbit goal. Every spec was
checked against the code by an independent reader on 2026-11-07, and the
findings (wrong line references, tests that would break, files missing from
the allowed paths, criteria no check could prove) were folded back in.

## The goal of the program

Review Voice already does the hard things those documents ask for: a
deterministic and judgment split, verification of every finding by an agent
that did not write it, an independent challenger, severity derived by the CLI,
a single guarded GitHub write with idempotency, redaction before anything is
stored, an approval gate on learned policy, and honest evaluation documents.
What it lacks is mostly the connective tissue that makes those properties
visible, enforceable and measurable:

1. **A pull request cannot change how it is reviewed, and the reviewer says
   where it ran.** Config is read from the base commit, the protected globs
   cannot be removed, and every run records its origin and an independence
   label. (S01, S02, S13)
2. **Failure and retention are named.** A review that cannot complete fails
   open or closed by the change's risk, and run directories and audit events
   have an enforced retention that `PRIVACY.md` describes truthfully. (S03)
3. **Recall and latency are measured.** A fixture-driven recall harness and
   p95 latency, cost, hold-rate and rolling dismissed-rate figures replace
   "not automated". (S04, S05)
4. **The learning loop closes.** Approved policies are applied at scoring
   time, keyed by a stable rule id, with a carve-out for security and trust
   boundaries, and dismissals on the pull request become path-scoped
   proposals. (S06, S07)
5. **Evidence is visible.** Tool restatements are held, did-not-run checks are
   named, an opt-in scope block tells the reader what was and was not checked,
   and verified fixes can ship as committable suggestions. (S08, S09, S14)
6. **Risk reaches the router.** A deleted control, a new route or a lock
   becomes a lead the CLI measured, lanes can wake on it, and security and
   concurrency specialists ship. (S10, S11)
7. **The code stays readable.** The 5,300-line `cli.ts` becomes command
   modules, one green slice at a time. (S12)

Done means: every spec's acceptance criteria hold on `main`, `npm run verify`
is green, `docs/EVALUATION.md` reports fixture recall and p95 latency with
real readings, and a pull request that edits `.review-voice/config.yaml` to
disable its own caps is still held.

## Gap analysis

Each row names the rule in the source documents, what Review Voice does today
(verified by nine read-only investigations with file and line evidence on
2026-11-07), and the decision.

| Rule in the documents | Review Voice today | Decision |
|---|---|---|
| Evidence before models; tools first; models may not restate a tool hit | Static evidence is opt-in, parsed into signals, handed to the analyst only; nothing compares a candidate to a signal | Adopt: `restates-tool` held verdict (S08) |
| Two-model skepticism, validator blind to the proposer | Evidence verifier plus a challenger that never sees the verifier's reasoning (ADR 0024), optional second pass by another model | Already stronger than asked; keep |
| The bot never approves | Approves with head and CI re-read, capped by complexity, held findings, red CI (ADR 0010) | Keep the default; add `verdict.never_approve` for teams that want the advisory posture (S13) |
| Graph context, one hop of callers and tests | Lexical symbol references with a time budget; no test partition; no callers for new declarations | Keep lexical by decision (ADR 0009); add test references and head-side callers (S10 part B) |
| Learn locally by path and rule; approval before suppression | Proposals by category, approval gate, provenance; approved policies never loaded; no path scope; thread dismissals unused | Adopt: enforcement keyed by rule id (S06), path-scoped proposals from thread dismissals (S07) |
| Independence is a hard label | No origin recorded; interactive and headless runs indistinguishable | Adopt: provenance with `independent` or `not-independent` (S02), rendered in the scope block (S09) |
| Severity means user harm, blocking needs validator-high confidence | Derived from category and computed reach; escalation needs traced impact at 0.85; challenger must confirm with decisive lines | Already met; keep |
| Fail open only off the high-risk path | One `failed` status; exit code reds the CI check on every path; nothing recorded | Adopt: `failed_open` and `failed_closed` by assessed risk (S03) |
| Comment cap of eight, ordered by severity | No count cap; a word budget scaled to the change, ordering checked by the validator | Reject the cap: the repository measured that a count cap discards findings the budget allows (docs/ARCHITECTURE.md, "Recall with triage") |
| Do not edit the code; suggestions as comment text | Prose fixes, verified separately; no suggestion blocks | Adopt committable blocks for verified patches, opt-in (S14) |
| Summary comment with intent, versions, counts, residual risk, not-checked list | One summary line; everything else local | Adopt an opt-in collapsed scope block with a machine-readable trailer (S09); the human-review note stays off the pull request (ADR 0012) |
| Finding contract: trigger, guards checked, validator decision | Claim, failure mode, evidence, verifier fields, challenger's decisive evidence | Already covered in substance; a `guards_checked` field is deferred (see "Not taken") |
| Config merged org, repo, path; a lower file may tighten, not weaken | Global, repository, path, language layers; tighten-only for limits; `.review-voice/policy.yaml` proposal-only; but the Action reads the pull request's own `config.yaml` | Adopt: base-commit config and tighten-only protected globs (S01) |
| Deleted check, limit or allowlist is blocking; seeded suite at 100% | Nothing inspects removed lines; a wholly deleted file never reaches the diff | Adopt: `removedControls` signal with base-blob scan of deleted files, seeded fixtures (S10 part A), security lane and opt-in cap (S11) |
| Risk router chooses specialists from globs and diff signals | Lanes eligible by line count and path only; one shipped specialist | Adopt: `when.signals`, risk markers, security and concurrency agents (S11) |
| 400-line cap with a risk map | No size cap; complexity cap by decision points and sensitive paths | Reject by owner decision (ADR 0012: "a large mechanical change is easy to read") |
| Quality bar: key-bug inclusion, causal-line hit, clean-PR silence, p95 time | Fixture shape checks only; 27 of 39 fixture patches do not parse with plain `git apply`; median latency only; no recall figure | Adopt: recall harness with a normalising materialiser (S04), observability metrics (S05) |
| Observability: drop reasons, weekly sampling, alert on dismissed rate | `explain` shows drop reasons; no rolling rate, no alert | Adopt: rolling 30-day rate and a `status` warning (S05) |
| Retention: packs 30 days, audit a year | Run directories never deleted; audit retention stated, not enforced; `PRIVACY.md` lists an audit file nothing writes | Adopt: `retention` block, sweep in `watch` and `purge`, documents corrected (S03) |
| Praise tier | Forbidden by the output contract | Reject; the contract's silence is the product |
| GitLab | GitHub only; multi-provider out of scope in CONTRIBUTING | Not taken |

## What the field does

An external survey (web, 2026-11-07) of GitHub Copilot, CodeRabbit, Greptile,
Cursor Bugbot, Graphite, Qodo, Sourcery, Ellipsis, Augment, Anthropic's Claude
Code Review, Codex, Gemini, Devin and Sentry Seer found these to be table
stakes: a summary comment, committable suggestion blocks, a committed config
with path filters and natural-language rules, reading `CLAUDE.md` and
`AGENTS.md`, incremental re-review, a check run or status, severity labels and
effort tiers. Review Voice has all of them except suggestion blocks (S14) and
a summary that says anything beyond one line (S09).

Three findings matter for priorities:

- Only Cursor Bugbot, Claude Code Review and Ellipsis read review config from
  the base branch so a pull request cannot alter its own review. GitHub
  Copilot reads from the head. S01 puts Review Voice in the first group.
- Only Claude Code Review and CodeRabbit state per review what they did not
  check. S09 does.
- No surveyed vendor documents deleted-control detection or a deterministic
  severity derivation. S10 and S11 would be ahead of the field; the severity
  derivation already is.

Greptile measured that a model reviewing its own authored diffs loses about
eight points of high-severity recall (53.7% same-model against 62.0%
cross-model on 500 pull requests each). Review Voice's optional second pass by
another model and the `not-independent` label (S02) are the two levers that
address it.

Published evaluations (GitHub ReviewBench, Qodo's benchmark, Greptile's
reintroduced-bug set, Signal65's precision study, Martian) share one method:
real bug-fix pull requests reintroduced on a clean fork, scored on a comment
at the right lines. S04's fixture materialiser is the local version of that
method and the step before running Review Voice against a public set.

## Order and dependencies

```
Phase 0  S01 config trust   S02 provenance   S03 failure and retention   S13 never-approve (optional)
Phase 1  S04 recall (A then B)   S05 metrics
Phase 2  S06 enforce policies (needs S02)  ->  S07 thread dismissals
Phase 3  S08 tool findings  ->  S09 scope block (needs S02, S08)   S14 suggestions (optional)
Phase 4  S10 removed controls (A needs S04 A; then B)  ->  S11 risk-routed lanes (needs S10 A)
Phase 5  S12 cli split, slices 0, 1, 2, 3, 4, 5a, 5b, 6a, 6b, when nothing else is in flight
```

Within a phase the specs are independent and may run as separate Orbit runs
on separate branches, except that every spec edits `cli.ts`, so merge one
before starting the next, or expect a rebase. S12 moves `cli.ts` wholesale and
must not overlap with anything.

Twenty-four Orbit runs in all: S01, S02, S03, S04A, S04B, S05, S06, S07, S08,
S09, S10A, S10B, S11, S13, S14 and the nine S12 slices. S03, S06 and S11 each
name a stop point that may add one run.

## Running a spec with Orbit

Orbit is initialised in this repository (`.orbit/config.yaml`, written
2026-11-07 and reviewed). The config narrows `scope.allowed_paths` to the
plugin's source, agents, schemas, templates, policies, evals, the committed
bundle, tests, fixtures and docs; protects `scripts/`, `action.yml`, the
manifests, `CHANGELOG.md`, `.github/` and this folder; defines six checks
(`typecheck`, `unit-tests`, `build`, `dist-check`, `identity-guard`,
`action-pins`); and doubles the changed-file and changed-line limits because
the unminified bundle counts every source change twice. `orbit doctor` passes
with four warnings, all of them decisions for a person (below).

Before the first run, a person decides:

1. Done 2026-11-07 at the owner's instruction:
   `providers.codex.data_policy_eligible: true` in `.orbit/config.yaml`, so
   Codex reviews every run independently (the repository is public, MIT).
2. Export `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) and
   `CODEX_API_KEY` (or `OPENAI_API_KEY`) where the service can see them
   (`launchctl setenv` on macOS, then `orbit service install` again to
   reload), so workers run in the stronger sandbox tier. Still open: `orbit
   doctor` warns about both.
3. Done 2026-11-07: the background service is installed
   (`dev.orbit.controller.<key>`), so runs outlive the Claude Code session.
4. Commit this folder and `.orbit/config.yaml` to `main` through a pull
   request before the first run. Orbit refuses to start on a working tree with
   uncommitted changes (`.orbit/` runtime state is exempt), and `orbit doctor`
   warns about it until then.
5. The mode. The config says `autonomous` (a local `orbit/<run-id>` branch,
   nothing pushed). With `GH_TOKEN` exported, `--mode autonomous-delivery`
   pushes the branch and opens a draft pull request, which is how `main`'s
   protection expects changes to arrive.
6. For S03, add `PRIVACY.md` to `scope.allowed_paths` for that run, or make
   its `PRIVACY.md` edit by hand afterwards.
7. For S12, consider raising `scheduler.hard_limits.changed_lines` for those
   runs: a move counts both sides in `src` and in the bundle, and esbuild can
   relocate whole modules in the bundle when their last import moves. Slice
   0's run report is the measurement.

Then, for each spec, paste its "Orbit goal" block:

```
/orbit:run <the goal text, verbatim>
```

or in a terminal with the Orbit clone on the path:

```bash
orbit run --goal - --detach <<'ORBIT_GOAL'
<the goal text, verbatim>
ORBIT_GOAL
```

While it runs: `/orbit:status <run-id>`. A `BLOCKED` run has a question;
answer it with `/orbit:inquisition --run <run-id>` or `orbit decide`, then
`orbit resume`. A run blocked by its frozen policy needs a config fix and a new
run. When it ends, `orbit report <run-id>` prints the verdict per criterion and
the branch; review the branch as any pull request and merge it through the
repository's normal pull-request flow. Orbit never merges.

Three things every Orbit implementer must do, and every goal says so: run
`npm run build` after any change under `plugins/review-voice/src` (the
`dist-check` check compares the committed bundle byte for byte), run the test
files it touched with `node --test <file>` (the full suite, 1,718 tests in
about 55 seconds, is Orbit's check), and leave `CHANGELOG.md`, versions and
the manifests alone (the maintainer releases). Some watcher tests listen on a
loopback port; on macOS an Orbit worker may not listen, so those tests may be
refused inside the worker and pass in Orbit's check run, which is the proof
that counts.

## Conventions every spec inherits

- `CONTRIBUTING.md` rules: synthetic fixtures only, no hardcoded identity, no
  em or en dash anywhere (the identity guard scans `docs/` too), Conventional
  Commits in the pull-request title (the maintainer's job at merge).
- Comments explain why, in full sentences, at the density of the surrounding
  code.
- An accepted ADR is never rewritten. A change to a decision is a dated
  `## Amendment - <date>` section at its end, or a new ADR that supersedes it,
  and `docs/adr/README.md` marks the row.
- A setting that changes the posted review defaults to the current behaviour.
- Nothing new is posted to GitHub by default; the single write path and its
  guards (ADR 0010) are not widened.
- A figure with no data reports `no data`, never zero.
- Orbit judges a run by its six checks only. Each spec therefore puts the
  documentation it asks for behind a small content test where a criterion
  needs it, and marks the rest "reviewer-checked".

## Not taken, and why

- **A `guards_checked` list on every finding.** The verifier's
  `required_context_missing`, `impact_traced` and the challenger's
  `decisive_evidence` already carry the substance. A structured list is a
  prompt and schema change across three agents with no deterministic check
  behind it; revisit after S04 measures recall, when there is a number to
  move.
- **A whole-program symbol graph.** ADR 0009 and the architecture chose
  lexical evidence on purpose. S10 adds the two cheap wins (tests referencing
  a symbol, callers of a new declaration). A tree-sitter or LSP graph would be
  a new ADR with a language-support matrix.
- **An organisation policy trust root.** ADR 0006 defers it; nothing in this
  program needs it. S01's base-commit rule gives the maintainers of a
  repository authority over its review config, which is the trust model the
  documents describe for a single repository.
- **Changing the finding cap, praise tier or size cap.** All three were
  measured or decided against in this repository, and the documents' reasons
  do not outweigh those measurements.
- **GitLab.** Out of scope in `CONTRIBUTING.md`.

## Decisions for the owner before implementation

1. Approve the Orbit setup items above (Codex eligibility, keys, service,
   mode, the S03 and S12 scope and limit adjustments).
2. Confirm the layout for S12: `src/cli/<name>.ts` as specified (chosen so
   `commands/` keeps one meaning, the slash commands), or the existing
   `src/<area>/command.ts` precedent used by `queue` and `watch`.
3. Confirm the posture for S13 (ship the setting, default off) and whether to
   turn `verdict.scope_block` (S09) on for this repository's own pull requests
   once it lands.
4. Decide the protected-path follow-ups the specs leave to a person:
   `action.yml` (`REVIEW_VOICE_CONFIG` for the `config` input in S01,
   `--origin action` in S02, the `fail-open` input in S03) and the nightly
   recall job in `.github/workflows/eval.yml` (S04). `GOAL.md` files each as a
   GitHub issue.

## Sources

- The three product documents, read in full on 2026-11-07.
- `docs/ARCHITECTURE.md`, `docs/EVALUATION.md`, `docs/THREAT-MODEL.md`,
  `docs/PLAN.md`, `docs/WATCHER.md`, `PRIVACY.md`, ADRs 0001 to 0031, the
  agent prompts, schemas, baseline policy and config template.
- Nine read-only code investigations with file and line evidence at
  `919d0fd`, summarised in each spec's "Why", and fifteen independent reviews
  of the specs against the code, folded into the specs.
- An external survey of fourteen pull-request reviewers' documentation and
  published evaluations, 2026-11-07.
