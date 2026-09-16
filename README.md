# Review Voice

**A concise, precedent-aware code reviewer for Claude Code that learns your
review judgment — and stays quiet when it has nothing worth saying.**

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
[blocking] `src/auth/session.ts:84` — The response returns the refresh token
before the transaction commits, so a retry can mint two valid tokens. Commit
before sending the response.

[important] `.github/workflows/release.yml:52` — The publish job can run after
a skipped verification job. Make verification a required dependency.
```

No greeting. No summary. No praise. No process commentary.

## How it works

Review Voice draws a hard line between arithmetic and judgment.

**The bundled CLI does the deterministic work** — diff acquisition, config and
policy layering, static evidence collection, precedent retrieval, preference
scoring, deduplication, and output validation.

**Claude Code agents do the judgment work** — generating candidate defects,
verifying them against the diff, and wording the result.

This matters for one practical reason: the word limits are enforced by a
validator that *rejects* non-compliant output, not by a prompt that asks nicely.
The same goes for the exact no-findings string.

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
history ingestion. There is no install step — the plugin ships a single
pre-built bundle with zero runtime dependencies.

## Privacy in one paragraph

Review Voice is local-first and read-only. It reads only repositories you
explicitly allowlist, never everything your token can reach. Everything it
stores lives in your platform's data directory, never in your repository and
never on a server we control. Secrets are redacted before anything is persisted,
indexed, logged, or put in a prompt — as defence in depth, not as a guarantee.
It cannot post comments, approve pull requests, or change repository state.
Full detail in [PRIVACY.md](PRIVACY.md) and
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Contributing

Bug reports, false-positive reports and prompt-injection test cases are all
genuinely useful — a false-positive report is the highest-value issue you can
file. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[MIT](LICENSE).
