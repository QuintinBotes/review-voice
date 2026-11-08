# Policy format

Policies are YAML. They are meant to be read, diffed and argued with - if you
cannot tell why the reviewer said something by reading its policy, the format
has failed.

## Layers

```
global → repository → path → language → current session
```

### Precedence

1. An explicit current-session instruction wins.
2. An explicit repository, path or language rule beats an inferred global rule.
3. An explicit owner rule beats an inferred rule at the same scope.
4. A newer approved policy beats an older one at the same scope.
5. A `never_flag` or suppression rule beats any propensity to flag.
6. A candidate must still pass technical verification even when history favours
   it.

## Structure

```yaml
policy_version: 1
scope:
  type: global          # global | repository | path | language
  key: your-github-login

generated_at: 2026-09-16T00:00:00Z
approved_at: null       # null means not active. No exceptions.

source_window:
  target_events: 250
  eligible_events: 147
  imported_events: 147
  owner_weight_share: 0.62
  repositories: ["your-org/your-repo"]

voice:
  tone: [direct, calm, technical, concise]
  prohibited: [praise, generic_summary, hedging, speculative_language]
  max_findings: null        # no cap; a layer may impose one
  max_words_per_finding: 40
  max_total_words: 600      # floor; scales with the size of the change
  no_findings_response: "No actionable findings."

comment_contract:
  required: [precise_location, concrete_failure_mode, material_impact, practical_correction_when_known]
  reject_if: [style_only, not_diff_specific, lacks_evidence, duplicates_another_finding,
              could_be_linter_rule, restates_code, speculative, no_material_impact]

priorities:
  - category: correctness
    weight: high

suppressed_patterns:
  - "Readable naming alternatives without a concrete failure mode."

suppressions:
  - rule_id: maintainability:diff
    glob: null
    reason: "owner dismissed 3 of 3 in October 2026"

provenance:
  - rule: "Suppress naming-only comments unless they create a concrete ambiguity."
    rule_id: maintainability:diff
    category: maintainability
    evidence_event_ids: [evt_4f2a, evt_91bc, evt_c103]
    owner_signal_count: 7
    contradicting_signal_count: 0
    confidence: 0.91
    most_recent_evidence_at: 2026-09-07T00:00:00Z
```

## Path scopes and versions

`calibrate` groups proposals by scope, storing one `policies` row per scope
with its own version sequence. Suppression proposals use the longest common
directory of their dismissals as a path glob, or the global scope when that
directory is the repository root. Priority proposals stay global. A path
policy carries the scope and the same glob on its suppressions:

```yaml
policy_version: 1
scope:
  type: path
  key: "src/billing/**"

suppressions:
  - rule_id: maintainability:diff
    glob: "src/billing/**"
    reason: "owner dismissed 3 of 3 in November 2026"
```

Rules stay keyed by rule id. An approved rule's path scope only narrows where
it applies; the directory does not become the rule's identity. Active path
policies load after the global policy. A suppression without a glob in a path
policy inherits the policy's glob.

`policy show` lists every scope. Use `policy show --scope global` or
`policy show --scope 'path:src/billing/**'` to inspect one scope.
`policy rollback <version> --scope 'path:src/billing/**'` restores a previously
approved version in that scope only; omitting `--scope` selects global.
`policy approve <policy-id>` needs no scope because the id identifies the row.
Approving a path policy replaces only the active version in that row's scope,
leaving the global policy and other path policies unchanged.

## Suppressions

`suppressed_patterns` is prose for readers. `suppressions` is the structured
form of the same rules, and it is what `score` applies (see
[ADR 0032](adr/0032-approved-policies-are-enforced-at-scoring.md)). Each entry
has three fields:

- `rule_id` names the kind of finding the rule is about, in the form
  `category:lane`, or `category:lane:blocker_class` when the findings claimed
  a blocker class. The lane is `diff` for a finding with none. A suppression
  matches a candidate only when their rule ids are exactly equal, so a rule
  about one lane says nothing about the same category in another lane.
- `glob` narrows the suppression to candidates whose path matches it. A null
  or omitted glob inherits a path policy's scope; in other scopes it means
  everywhere.
- `reason` says why the owner's signals formed the rule, in the owner's terms.

A matched candidate is held at scoring time with the reason
`policy-suppressed:<rule_id>`, listed in `score` output under `suppressed`
with the policy version that held it, and shown by `explain` under "Held
back". A suppression is preference, not truth: it holds a finding rather than
deleting it from the record, and the owner can still post it with
`score --promote <candidate_id>`.

A suppression can never reach a category that names a security breach or a
trust boundary. The exempt categories are `security`, `authorization`,
`authentication`, `data_integrity` and `trust_boundary`. Approval refuses a
proposal whose suppression names one of them, and `score` ignores such an
entry however it got into the store. This is the structural form of the
warning in [ADR 0006](adr/0006-team-governance.md) that a suppression is one
line away from "never mention authentication".

## Compiler limits

The active policy must stay small enough to fit in a prompt without crowding
out the diff:

- 1,500 tokens maximum of active policy text
- 1,000 tokens maximum of retrieved precedents
- 3 positive and 2 negative precedents per candidate
- 20 active inferred rules per scope layer

The compiler turns repetitive evidence into **short rules**, not stored prose.
If a rule needs a paragraph to express, it is two rules or none.

## Activation

An inferred rule requires at least three corroborating signals including at
least one owner signal and no contradicting owner signal before it can be
approved. Explicit feedback and strong thread dismissals supply evidence;
weak outcomes and silence do not. `calibrate` creates inactive proposals.
Every scope requires explicit owner approval; no proposal activates automatically.

## Provenance is mandatory

Every inferred active rule carries the events that produced it, the owner signal
count, contradicting signals, a confidence score, and the date of its most
recent evidence. A rule that cannot show its evidence is a bug.

## Weighting

| Evidence | Weight |
|---|---:|
| Explicit owner keep | 1.00 |
| Owner rewrite | 1.00 |
| Owner comment with follow-up fix | 0.90 |
| Owner comment, outcome unknown | 0.45 |
| Team comment with follow-up fix | 0.55 |
| Team comment, outcome unknown | 0.25 |
| Explicit owner dismissal | −1.00 |
| Explicit owner never-flag | −1.50 |
| Bot comment | 0.00 |

Decayed by recency with a 180-day half-life, then adjusted for specificity
(exact file and line evidence) and context match (repository, path, language).
