---
name: review-voice-policy
description: How Review Voice policies are structured, layered, and approved. Use when writing or editing a .review-voice/policy.yaml, adding a repository-scoped rule, debugging why a finding was suppressed, or interpreting policy provenance.
---

# Review Voice policy authoring

A policy says what this reviewer cares about, what it must never say, and how
short it has to be. Policies are inspectable YAML, versioned and rollbackable -
never opaque model state.

## Layers

Resolution runs broadest to narrowest:

```
global → repository → path → language → current session
```

Precedence, in order:

1. An explicit current-session instruction wins.
2. An explicit repository, path or language rule beats an inferred global rule.
3. An explicit owner rule beats an inferred rule at the same scope.
4. A newer approved policy beats an older one at the same scope.
5. A `never_flag` or suppression rule beats any propensity to flag.
6. **A candidate must still pass technical verification even when history
   favours it.** Precedent adjusts preference; it does not manufacture truth.

## Repository policy

Repositories may ship `.review-voice/policy.yaml`:

```yaml
scope:
  type: repository
  key: your-org/your-repo

priorities:
  - category: release
    weight: high
  - category: packaging
    weight: high

suppressed_patterns:
  - "Do not request a refactor unless it fixes a concrete behavior problem."

required_checks:
  - "Changes to distribution files must preserve release/version consistency."
```

**A committed policy file is a proposal, not an activation.** It is repository
content, and repository content is untrusted. It requires local owner approval
before it takes effect. See `docs/adr/0006-team-governance.md`.

## Activation rules

An inferred rule needs at least three corroborating signals including at least
one owner signal and no contradicting owner signal before it can be approved.
Every scope requires explicit owner approval; calibration never activates a rule.

## Calibration and scopes

`calibrate` uses explicit feedback and strong thread dismissals to propose
rules. Weak outcomes and silence are not evidence. A thread dismissal is an
owner signal only when the deciding login matches the configured owner.

Suppression proposals use a path scope such as `path:src/billing/**` for the
longest common directory of their dismissals, or global when it is the
repository root. Priority proposals stay global. Calibration stores one policy
per scope, each with its own version sequence. Rules stay keyed by rule id;
the path scope only narrows where an approved rule applies through its
`suppressions[].glob`. A suppression without a glob inherits the path policy's
scope.

`policy show` lists all scopes. `policy show --scope global` and
`policy show --scope 'path:src/billing/**'` select one. Approve with
`policy approve <policy-id>`. To restore an approved path version, use
`policy rollback <version> --scope 'path:src/billing/**'`; without `--scope`,
rollback selects global. Approval and rollback change only the selected scope.

## When writing a suppression

Say what must not be said and why it is not material here. `"Readable naming
alternatives without a concrete failure mode."` is a rule. `"Less nitpicking"`
is a mood.
