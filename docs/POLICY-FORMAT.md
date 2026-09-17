# Policy format

Policies are YAML. They are meant to be read, diffed and argued with — if you
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

provenance:
  - rule: "Suppress naming-only comments unless they create a concrete ambiguity."
    evidence_event_ids: [evt_4f2a, evt_91bc, evt_c103]
    owner_signal_count: 7
    contradicting_signal_count: 0
    confidence: 0.91
    most_recent_evidence_at: 2026-09-07T00:00:00Z
```

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

An inferred rule activates only if the owner approves it, **or** it has at least
three corroborating positive signals including at least one owner signal, no
contradicting owner signal, and it passes the regression suite.

Global changes always require approval.

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
