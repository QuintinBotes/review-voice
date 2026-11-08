# 0032 - Approved policies are enforced at scoring

**Status:** Accepted · **Date:** 2026-11-08
**Relates to:** [0006](0006-team-governance.md) - a suppression is one line
away from "never mention authentication", so the categories that name a
breach stay out of its reach.

## Context

The learning loop was open at the end. Review Voice ingested history,
compiled proposals from the owner's feedback and asked the owner to approve
them, and an approved policy then changed nothing. Approved `policies` rows
were never loaded as a layer, no stage read the resolved policy, and the
rules themselves were prose in `suppressed_patterns`, keyed by nothing a
finding could be matched against. The README promised rules "you approve
before they take effect" and a policy version that can be rolled back. Both
were true and neither mattered until a rule could be applied.

A finding had a `category`, a `lane` and sometimes a claimed blocker class,
but no stable identity for the kind of finding it was. Without one, a
suppression could only be expressed as a sentence, and a sentence cannot be
applied or checked by arithmetic.

## Decision

**Approved suppressions are enforced in `score`, keyed by a stable rule id,
and a suppression never reaches the categories that name a security breach
or a trust boundary.**

- **Rule identity.** Every finding recorded from a candidate carries a
  `ruleId` of the form `category:lane`, or `category:lane:blocker_class`
  when the candidate claimed a blocker class. The lane is `diff` when a
  candidate has none. `record`, `explain` and `status` print it, and
  `evaluate --json` breaks posted outcomes down by rule in
  `posted_breakdown.by_rule`.
- **Structured artifact.** A policy carries a `suppressions` list beside the
  prose `suppressed_patterns`. Each entry names a `rule_id`, an optional
  `glob` that narrows it to matching paths (null means everywhere), and the
  `reason` the owner's signals formed the rule. Proposals are compiled by
  rule id, so dismissals of one category from two lanes form two rules, and
  provenance names the rule id and its category. The prose patterns stay for
  readers.
- **Loading.** `loadConfig` takes an optional store and, only then, loads
  the owner's active approved policies as layers between the baseline and
  the repository configuration. `context` shows the resolved suppressions,
  and a recorded run's `active_policy_versions_json` names the versions that
  were loaded for it. Without a store no policy rows are loaded.
- **Enforcement point.** After the verifier's verdict is applied and before
  a candidate is eligible, `score` holds a candidate whose rule id matches a
  resolved suppression, with the reason `policy-suppressed:<rule_id>`. It is
  listed in a new `suppressed[]` array with its rule id and policy version,
  and in that array only, so the driver holds it once with the held verdict
  `policy-suppressed`. `explain` shows it under "Held back" with the rule
  and the version. It is absent from the rendered review.
- **Preference, not truth.** A suppression holds a finding. It never deletes
  it from the record, and the owner can still post it: `score --promote`
  accepts a `suppressed[]` entry and records the promotion with
  `gate: 'policy'` and the rule id.
- **The carve-out.** A suppression never applies to `security`,
  `authorization`, `authentication`, `data_integrity` or `trust_boundary`,
  named in one exported constant, `SUPPRESSION_EXEMPT_CATEGORIES`.
  `approvePolicy` refuses a proposal whose suppression reaches one of them
  and names it, and `score` ignores such a row however it got into the
  store. `trust_boundary` is included although it can name a non-security
  control boundary, because removed-control leads are filed under it and a
  suppression that silenced them would defeat that check. This makes the
  warning in ADR 0006 structural rather than a comment.

## Consequences

- Approving a policy now changes what a review posts, which is the intended
  behaviour. Rolling back to a version without the suppression restores the
  earlier behaviour on the next `score`.
- Held findings stay visible locally with the rule and version that held
  them, so an owner can see what a policy is doing and promote a finding
  past it.
- One more category than the fixed boundary set is out of a suppression's
  reach. That is the cost of keeping removed-control leads unsilenceable.
- Findings recorded before rule ids existed are keyed by their category on
  the `diff` lane when their feedback is compiled, so older dismissals still
  form rules.

## Alternatives considered

**Feed suppressions to the analyst prompt.** Rejected. An instruction in a
prompt cannot be verified: nothing could show which candidate a suppression
removed, whether it removed the right one, or whether it removed anything
at all. Enforcement in `score` is arithmetic on a rule id, so every held
finding is named with the rule and version that held it.

**Keep rules as prose and match on category alone.** Rejected. A dismissal
of a category in one lane says nothing about the same category in another
lane or under a blocker class, and grouping by category alone formed rules
out of signals that were never about the same kind of finding.
