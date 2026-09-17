# Review Voice - Open Source Build & Release Plan

**Status:** delivered. M0-M4 shipped; see the milestone table below for what
each actually turned into. Kept as the record of what was planned and where
reality diverged, not as a live plan.
**Source spec:** `review-voice-plugin-specification.md` v1.0
**Target repo:** `github.com/QuintinBotes/review-voice`
**Decisions taken:** full spec (Phases 1-4) before first public push · bundled zero-install Node CLI · MIT · marketplace repo with `plugins/review-voice/`

---

## 1. What changes when this goes open source

The spec is written for one operator. Five things have to change before a line of code is written.

| Spec assumption | Open-source form |
|---|---|
| `owner_reviewer: QuintinBotes` hardcoded (§4.1, §10.2, §11, §25) | `owner_reviewer` resolved at `init` from `gh api user`, stored in the user's config. No identity in the repo. |
| Example allowlist names real private repos (§6.1, §11) | All examples use `your-org/your-repo`. A grep guard in CI fails the build on a hardcoded personal repo or login. |
| §25 "Initial Reviewer Policy" is *this owner's* policy | Ships as `policies/baseline-global.yaml`, a neutral default every user starts from and then calibrates away from. |
| Word/finding limits read as product constants | Config-driven defaults; enforcement is code, values are settings. **Changed in 0.2.0:** the finding cap was removed entirely and the word budget now scales with the change - a count cap discarded findings the budget would have allowed. |
| Fixtures could be drawn from real review history | 100% synthetic fixtures. Contributor rule in `CONTRIBUTING.md`; CI secret scan; corpus/DB paths are gitignored and live outside the repo. |

**Correction to the spec:** §12.3's `plugin.json` lists `commands` and `agents` arrays. Current Claude Code auto-discovers `commands/`, `agents/`, `skills/` and `hooks/hooks.json`. The manifest should carry metadata only (`name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`). Those array fields now mean *extra* search paths, not the canonical list.

**Command namespacing:** `/review` is a collision risk with other plugins and reads as a generic verb. Commands resolve as `/review-voice:review`, `/review-voice:init`, etc. The README teaches the namespaced form.

---

## 2. Architecture decision the spec leaves implicit

The spec's §16 pipeline mixes deterministic work with model work without saying which is which. This is the single most important call in the build, because it decides what is testable, what costs tokens, and what can run in CI.

**Deterministic work lives in the bundled CLI. Model work lives in Claude Code agents. The command file is the orchestrator.**

| §16 stage | Owner | Why |
|---|---|---|
| 1 Diff acquisition | CLI | git plumbing, fully testable |
| 2 Context resolution | CLI | config/policy layering is pure logic |
| 3 Static evidence collection | CLI | runs project tools, emits structured JSON |
| 4 Candidate generation | Agent (`diff-analyst`) | genuine judgment |
| 5 Evidence verification | Agent (`evidence-verifier`) | genuine judgment |
| 6 Precedent retrieval | CLI | index query, ranking is arithmetic |
| 7 Preference scoring | CLI | the §16.8 formula is arithmetic - never ask a model to compute it |
| 8 Dedup & ranking | CLI | deterministic, with an agent only for semantic near-duplicate calls |
| 9 Concise editor | Agent (`concise-editor`) | wording |
| 10 Schema & style validation | CLI | **this is what actually enforces the word limits** |

Consequence: `review-voice validate-output` is a hard gate that rejects non-compliant output and forces the editor agent to retry, rather than hoping a prompt holds the limit. It is also the thing that makes "100% word-limit compliance" and "exactly `No actionable findings.`" (§20.2) achievable rather than aspirational.

Second consequence: the plugin needs no API key of its own. It runs inside the user's Claude Code session.

---

## 3. Runtime and dependency strategy

Plugins are git-cloned. There is no install step, so users must never run `npm install`.

- **Source:** TypeScript in `plugins/review-voice/src/`.
- **Build:** esbuild → a single committed `plugins/review-voice/dist/review-voice.mjs`.
- **Runtime dependencies: zero.** Everything third-party (YAML parsing, etc.) is a devDependency inlined at build time. JSON Schema validation uses Ajv **standalone codegen** at build time, so the schemas in `schemas/` compile to plain functions with no runtime Ajv.
- **Storage:** built-in `node:sqlite` - verified working on Node 22.23 (experimental warning, suppressed at startup; stable on Node 24). No native modules, no `better-sqlite3`.
- **Invocation:** `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs" <subcommand>`.
- **Node floor:** `>=22`. Checked on first run with an actionable error message.
- **Committed-artifact risk:** CI rebuilds and fails if `dist/` differs from `src/`. A release cannot ship a stale bundle.

### Retrieval without breaking the local-only promise (closes Open Decision §27.1)

A downloaded embedding model contradicts both "zero install" and `allow_remote_embeddings: false`.

- **Default:** SQLite FTS5 lexical retrieval plus structural filters (category, repository, path glob, language) and the §9.1 weighting. No model, no download, fully offline, deterministic and unit-testable.
- **Optional:** a pluggable `EmbeddingProvider` interface. Users may opt into a remote provider; off by default, and the `embeddings` table in §13.2 already accommodates it.

This is a real quality tradeoff - lexical retrieval will miss paraphrases. Phase 3's evaluation harness measures it; if precedent recall is the binding constraint, the provider interface is already in place to swap in.

---

## 4. Repository layout

```
review-voice/
├── .claude-plugin/marketplace.json      # repo is its own marketplace
├── plugins/review-voice/
│   ├── .claude-plugin/plugin.json
│   ├── commands/                        # review, init, sync, status, feedback,
│   │                                    #   calibrate, explain, policy, purge
│   ├── agents/                          # diff-analyst, static-evidence-interpreter,
│   │                                    #   evidence-verifier, precedent-ranker,
│   │                                    #   concise-editor
│   ├── skills/review-voice-policy/       # policy authoring guidance
│   ├── src/                             # TypeScript: cli, git, evidence, store,
│   │                                    #   retrieval, scoring, policy, redact,
│   │                                    #   github, audit, validate
│   ├── dist/review-voice.mjs            # committed build artifact
│   ├── schemas/                         # 5 JSON Schemas from §12.2
│   ├── policies/baseline-global.yaml    # §25, de-personalized
│   ├── templates/                       # config.example.yaml, policy.example.yaml
│   └── README.md
├── fixtures/                            # synthetic only: positive, negative,
│                                        #   no-findings, prompt-injection
├── evals/                               # claude plugin eval suites
├── test/                                # node:test unit tests
├── docs/
│   ├── PLAN.md  ARCHITECTURE.md  POLICY-FORMAT.md
│   ├── THREAT-MODEL.md  EVALUATION.md
│   └── adr/0001..0008-*.md              # the eight §27 open decisions
├── .github/
│   ├── workflows/ci.yml  eval.yml  release.yml  codeql.yml
│   ├── ISSUE_TEMPLATE/{bug,feature,false-positive}.yml
│   ├── PULL_REQUEST_TEMPLATE.md  CODEOWNERS  dependabot.yml
├── README.md  LICENSE  CONTRIBUTING.md  CODE_OF_CONDUCT.md
├── SECURITY.md  PRIVACY.md  CHANGELOG.md  .gitignore
```

User install path:

```
/plugin marketplace add QuintinBotes/review-voice
/plugin install review-voice
/review-voice:init
```

---

## 5. Milestones

All four shipped. The repository went public earlier than planned - at 0.1.0
rather than v1.0.0 - because the private-repo Actions budget ran out and public
repositories get free unlimited Actions. A full history audit ran first; it
found two real leaks, both fixed before anything was served publicly. See
`docs/REPO-SECURITY.md`.

### M0 - Repo bootstrap
Skeleton, MIT licence, CI green on an empty build, docs frame, and **eight ADRs closing the §27 open decisions** (embeddings, GitHub auth, static-analysis adapters, outcome-inference limits, encryption, team governance, comment posting, policy sharing). Decisions get made once, in writing, before they leak into code.
*Done when:* `claude plugin validate --strict` passes and CI is green.

### M1 - Phase 1: fixed-policy concise reviewer (spec §23 Phase 1, build order 1-5)
Diff acquisition, context resolution, static-evidence adapters, the three review agents, output validator, feedback capture, SQLite + audit store.
*Done when:* reviews a local diff, emits findings within the word budget, never exceeds word limits, emits exactly `No actionable findings.` when nothing qualifies, and needs no GitHub access. Unit tests cover the validator, diff parser, config layering and audit writes.

### M2 - Phase 2: read-only GitHub bootstrap (build order 6-8)
Allowlist consent flow, historical collector with pagination and backoff, redaction, dedup, role classification, outcome labeling, the scaled corpus with §7.4 diversity caps, policy compiler and approval gate.
*Done when:* imports the accessible corpus **without over-claiming coverage** (§7.2 shortfall reporting is a test, not a doc promise), every active rule carries provenance, and the GitHub client is constrained **in code** to GET - with a test that asserts any non-GET throws.

### M3 - Phase 3: retrieval and learning loop (build order 9-10)
FTS5 index, precedent retrieval with the §9.1 weights and recency decay, the §16.8 score, feedback→evidence mapping, policy proposals with diff/approve/rollback, offline evaluator and regression suite.
*Done when:* dismissal rate drops against the M1 baseline on the held-out corpus, formatting compliance holds, and no global policy mutates without approval.

### M4 - Phase 4: team and GitHub review workflow
Optional webhook sync, draft PR-review rendering, policy dashboard, and GitHub comment posting behind exact-preview confirmation.
*Done when:* no write occurs without explicit confirmation, proven by test.

### M5 - Public launch (v1.0.0) - shipped
The repository is public, the threat model is written, and `SECURITY.md` has a live disclosure path. What 1.0.0 still means here is a stable interface rather than a feature: seven releases of real-world testing have moved the scoring threshold three times, changed how severity is assigned twice, and rewritten convention selection three times. 1.0.0 is the claim that those have settled.

*Done when:* a retest reports no change to the scoring or severity contract, the measured numbers are published rather than targets, and the pre-release notice comes off.

**Met.** The scoring and severity contracts held four consecutive releases, each comparison over identical batches, with a maximum difference of 1.7e-10, which is the retrieval's floating-point noise rather than anything moving. The measured numbers are in `docs/EVALUATION.md`. The notice is off.

What 1.0.0 claims is a stable interface. It does not claim a measured precision figure, and `docs/EVALUATION.md` says so in those words.

The middle clause originally said the README should carry those numbers. It says published instead, because the README is deliberately lean and `docs/EVALUATION.md` is where measurements belong. Noting the amendment rather than making it quietly: moving one's own bar is exactly the thing that should be visible.

One clause was never on that list, and it remains the honest limit of the release. `owner_accepted_precision`, the ≥ 80% gate, has no data: nothing has been labelled through `/review-voice:feedback`. The evidence that the reviewer finds real defects is six findings verified, posted to live pull requests and fixed by their authors, which is real and is not that gate. 1.0 claims a stable interface. It does not claim a measured precision figure, and `docs/EVALUATION.md` says so in those words.

---

## 6. CI and release engineering

| Workflow | Runs | Contents |
|---|---|---|
| `ci.yml` | every push/PR | lint, typecheck, `node --test`, esbuild, **dist-drift check**, `claude plugin validate --strict`, gitleaks, de-personalization grep guard. Matrix: Node 22 and 24, ubuntu + macos. |
| `eval.yml` | nightly + `run-eval` label | `claude plugin eval` over `evals/` - agent restraint, no-findings compliance, prompt-injection resistance. Token-budgeted and gated because it costs money. |
| `release.yml` | on tag | `claude plugin tag` consistency check, changelog extract, GitHub release. |
| `codeql.yml` | weekly | static analysis. |

Conventional Commits, Keep a Changelog, SemVer. `plugin.json` version and the marketplace entry must agree - `claude plugin tag` enforces this.

---

## 7. Security and privacy posture for a public repo

Publishing turns §15's internal requirements into public promises. They need hedging and tests in equal measure.

- **`SECURITY.md`**: private disclosure path, supported versions, and an explicit statement that secret redaction is **best-effort defence in depth, not a guarantee** - never run this against a repo whose contents you could not tolerate reaching a model.
- **`PRIVACY.md`**: exactly what is read, where it is stored (platform data dir, never the repo), retention defaults (§13.3), and how to purge.
- **`docs/THREAT-MODEL.md`**: all repository and PR content is untrusted input; the §18.1 preamble, delimited data blocks, strict schemas, and the standing rule that retrieved text can never alter tool permissions or workflow order.
- **Prompt-injection fixtures are public and runnable** - a genuine differentiator, and it invites contributed attacks rather than hiding from them.
- **Read-only is enforced by code**, not by documentation, through M3.

---

## 8. Risks

| Risk | Handling |
|---|---|
| Committed `dist/` drifts from source | CI rebuild-and-diff gate |
| `node:sqlite` experimental on Node 22 | Test on 22 and 24; suppress the warning; surface a clear error below the floor |
| Lexical retrieval underperforms embeddings | Measured in M3; `EmbeddingProvider` seam already present |
| GitHub rate limits during a corpus bootstrap | Conditional requests, pagination, exponential backoff, resumable sync |
| Eval workflow burns tokens | Label-gated and nightly, with a budget cap |
| Public claims of redaction create liability | Explicit non-guarantee language plus redaction unit tests |
| Long private build delays real-world feedback | The §20 evaluation harness substitutes until launch; M1 is dogfooded locally from week one |
| Solo-maintainer load after launch | Scope guard in `CONTRIBUTING.md`; a false-positive issue template that produces usable calibration data |

---

## 9. How this was built, in the end

All four build milestones shipped roughly as planned. What the plan did not
anticipate is where the remaining work went.

Seven releases after M4, the code that changed most was not the reviewer. It was
the scoring: an eligibility gate that turned out to be inert because the schema
and the internal type disagreed on casing, a novelty term that never looked at
the corpus, an evidence-quality term that scored 1.000 for every candidate
because its specificity test accepted "longer than 40 characters", and a
threshold calibrated against all three.

None of that was findable by writing tests against the design. It came from
running the reviewer on real pull requests and reading the numbers it produced,
which is a milestone the plan should have had and did not.
