---
description: Show, diff, roll back, or export review policies
argument-hint: "<show|diff|rollback|export> [version]"
allowed-tools: Bash(node:*), Read
---

<!-- Status: scaffold. Implemented in M3. -->

# Policy management

Run `${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs policy $ARGUMENTS`.

- `show` — the active policy stack, with provenance and confidence per rule.
- `diff` — what changed between two versions.
- `rollback <version>` — restore a previous approved version.
- `export` — write the approved policy for sharing or committing.

Every inferred rule must display the evidence that produced it. A rule that
cannot show its provenance is a bug, not a policy.
