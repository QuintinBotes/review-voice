# Review Voice

**A code reviewer for Claude Code where every finding names a concrete failure
mode - ordered worst-first, and silent when it has nothing worth saying.**

> ⚠️ **Pre-release.** Review Voice is being built to its full specification
> before its first public release. Interfaces will change. See
> [docs/PLAN.md](docs/PLAN.md) for the milestones.

---

## The problem

LLM code review tends to produce a wall of text: generic best practices,
naming suggestions, speculative risks, and diplomatic hedging around
observations nobody asked for. The signal is real but it is buried, and the
reviewer stops reading.

Review Voice answers exactly one question about a change:

> Is there a concrete, material problem here that **this reviewer** would
> actually want called out?

If the answer is no, the entire output is:

```
No actionable findings.
```

## What a review looks like

```
[blocking] `src/auth/session.ts:84` - The response returns the refresh token
before the transaction commits, so a retry can mint two valid tokens. Commit
before sending the response.

[important] `.github/workflows/release.yml:52` - The publish job can run after
a skipped verification job. Make verification a required dependency.

[nit] `src/api/types.ts:20` - Field is optional but every caller sets it. The
optionality is noise. Make it required.

[question] `src/db/migrate.ts:44` - Is the down migration exercised anywhere? A
rollback path that never runs is a rollback path that does not work.
```

No greeting. No summary. No praise. No process commentary.

Severity runs `blocking` → `important` → `minor` → `nit` → `question`, and the
ordering is checked. You can stop reading anywhere and know you have seen
everything more serious. There is no cap on how many findings you get - a real
finding is never dropped to hit a number.

The tier is derived from the kind of defect, not asked for. Two runs of the
same diff used to put the same finding in different tiers, which moves it up
and down a page ordered by severity.

## How it works

Review Voice draws a hard line between arithmetic and judgment.

**The bundled CLI does the deterministic work** - diff acquisition, config and
policy layering, static evidence collection, precedent retrieval, preference
scoring, deduplication, and output validation.

**Claude Code agents do the judgment work** - generating candidate defects,
verifying them against the diff, and wording the result.

This matters for one practical reason: the contract is enforced by a validator
that *rejects* non-compliant output and forces a re-edit, not by a prompt that
asks nicely. Word limits, hedge phrases, severity ordering and the exact
no-findings string are all checked rather than requested.

**It reads your repository's own rules.** `CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `.agents/rules/` and skill documents all reach the analyst
and the verifier, searched at the root and in every directory a diff touches.
Precedent cannot cover this ground: the better a convention is observed, the
fewer review comments it leaves behind, so the rules a team has most thoroughly
internalised are the ones its review history knows least about. They are supplied as evidence about
what the repository requires, never as instructions to the reviewer, and never
as more authoritative than the code itself.

**It checks claims that something is absent.** "This helper does not exist" is
the cheapest claim in a review to verify and the most damaging to get wrong,
because the fix proposed on top of it tells the author to break working code.
Every symbol such a claim names is searched in the ref under review, and the
finding is dropped if the repository contains it.

**A single run is a sample, not the answer.** Two reviews of the same diff
agreed on 2 findings of 8 in measurement, so the second run finding something
the first did not is expected rather than a defect. `RV evaluate` reports this
as `candidate_set_agreement`. It is published rather than targeted, because
there is no defensible target yet and a made-up one would be worse than the
number.

It learns through **retrieval plus policy compilation**, not model fine-tuning.
Your historical reviews are ingested, redacted, weighted, and compiled into
short, inspectable YAML rules that you approve before they take effect. Every
rule can show the evidence that produced it. Every policy version can be rolled
back.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

```
/plugin marketplace add QuintinBotes/review-voice
/plugin install review-voice
/review-voice:init
```

Then:

```
/review-voice:review
/review-voice:review --base origin/main
/review-voice:review --staged
/review-voice:review --pr 85
```

**Requirements:** Node 22 or newer, `git`, and `gh` only if you enable GitHub
history ingestion. There is no install step - the plugin ships a single
pre-built bundle with zero runtime dependencies.

### Second-pass verification

A finding is checked twice: once by the built-in `evidence-verifier` agent, and
optionally again by a command you configure. The second pass exists because the
built-in verifier is a Claude subagent checking a Claude subagent's work, which
is not an independent opinion.

It is opt-in, and a config written by an older `init` has no block for it at
all. `/review-voice:context` reports whether yours does.

```yaml
# .review-voice/config.yaml
verification:
  enabled: true
  name: codex
  command: codex exec -s read-only
  timeout_seconds: 90
  # A rejection at or above this confidence drops the finding. Below it, the
  # finding is downgraded instead: an unsure verifier should not be able to
  # delete evidence.
  drop_threshold: 0.8
```

The command reads one finding as JSON on stdin and writes a verdict to stdout.
It runs read-only. A verifier that cannot run never confirms a finding, and
verification may only weaken a severity, never raise one.

## Privacy in one paragraph

Review Voice is local-first and read-only. It reads only repositories you
explicitly allowlist, never everything your token can reach. Everything it
stores lives in your platform's data directory, never in your repository and
never on a server we control. Secrets are redacted before anything is persisted,
indexed, logged, or put in a prompt - as defence in depth, not as a guarantee.
It cannot post comments, approve pull requests, or change repository state.
Full detail in [PRIVACY.md](PRIVACY.md) and
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Contributing

Bug reports, false-positive reports and prompt-injection test cases are all
genuinely useful - a false-positive report is the highest-value issue you can
file. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

`main` is protected and every change goes through a pull request with CI
green - including the maintainer's. See
[docs/REPO-SECURITY.md](docs/REPO-SECURITY.md).

## Licence

[MIT](LICENSE).
