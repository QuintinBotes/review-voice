# 0030 - Team profiles pool reviewers, and a new install starts from a baseline

**Status:** Accepted · **Date:** 2026-10-25
**Relates to:** [0006](0006-team-governance.md) - the owner stays the only
policy authority.

## Context

The voice and the precedent weights come from one owner's review history. A new
user has none, so their first reviews use the editor's defaults with no
precedent. A team that wants one shared voice has no way to pool history, since
`identity.owner_reviewer` names one login.

## Decision

**`identity.reviewers` lists the logins whose history forms the corpus, and a
store with no history uses the shipped baseline until `sync` fills it.**

- **Pooling.** `sync` collects review comments by every listed reviewer, with
  the same selection, redaction and repository share as today. Each event keeps
  its author, and retrieval weights them equally. `owner_reviewer` defaults to
  the first reviewer and stays the policy authority.
- **Cold start.** With an empty corpus:
  - the editor uses the baseline voice in `templates/voice.baseline.md`, which
    is short, direct, one or two sentences and names the fix;
  - scoring uses `policies/baseline-global.yaml`;
  - `status` and every review's report say that the baseline is in use.
- **Quick start.** `init --quick` runs a bounded sync, at most 50 events from
  the last 90 days, then `calibrate`, and prints what it learned. It needs the
  same consent plan as `sync`.
- **The Action** caches the store between runs (ADR 0031), so a team's corpus
  persists in CI.

## Consequences

- The first review is useful without setup, and the report says honestly that
  it is generic.
- A team gets one voice from several reviewers without sharing a policy
  authority.
- Pooled history can blur two very different voices. `explain` shows whose
  precedents shaped a finding.

## Alternatives considered

**Ship a pre-trained voice corpus.** Rejected. It would carry other people's
review text, which the privacy posture forbids.

**One profile per reviewer, chosen per pull request.** Deferred. It needs a rule
for who is "reviewing", and pooling covers the team case.
