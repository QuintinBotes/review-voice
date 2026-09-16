# 0003 — Static analysis adapter strategy

**Status:** Accepted · **Date:** 2026-09-16

## Context

Findings are stronger when backed by a type checker, linter, or test run. The
question is how Review Voice gets that output: auto-detect and run project
commands, require configuration, or ship per-ecosystem adapters.

Auto-running detected commands is the convenient answer and a security hole.
`npm test` in a hostile repository is arbitrary code execution, and Review Voice
is explicitly designed to be pointed at repositories whose contents it does not
trust. A tool that treats repository content as untrusted in prompts but
executes it in a shell has not taken the threat seriously.

## Decision

**Detection suggests. Configuration enables. Never both.**

Review Voice detects likely commands for the ecosystem and offers them during
`init`, with the exact command shown. Nothing runs until it is listed in
`.review-voice/config.yaml`:

```yaml
static_evidence:
  enabled: false
  commands:
    - name: typecheck
      run: npm run typecheck
      timeout_seconds: 120
```

Execution constraints: no shell interpolation of repository content, a per
command timeout, captured output only, and failures degrade the review rather
than aborting it.

Adapters are thin output parsers — `tsc`, `eslint`, `pytest`, `go vet` and
similar — mapping tool output to evidence objects. They are not runners.

## Consequences

- No arbitrary code execution from a clone. The one-time configuration cost is
  the price, and it is worth it.
- Reviews run with less evidence until a user configures commands. Confidence
  scores drop accordingly, which is the honest behaviour.
- **When a check did not run, the review never implies it passed.** No generic
  warning about missing checks either, unless the absence creates a specific
  review concern.
- Adapters are independently testable against recorded tool output.

## Alternatives considered

**Auto-run detected commands.** Rejected on security grounds above.

**Ship an execution sandbox.** Rejected: large scope for a plugin, and
imperfect sandboxes invite the risk they claim to remove.

**No static evidence at all.** Rejected: it materially improves finding
precision, which is the entire product.
