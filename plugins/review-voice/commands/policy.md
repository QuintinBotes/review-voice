---
description: Show, approve, or roll back review policies
argument-hint: "<show|approve <policy-id>|rollback <version>>"
allowed-tools: Bash(node:*), Read
---

# Policy management

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs" policy $ARGUMENTS`.

- `show` — every version, which is active, and the provenance of each rule.
- `approve <policy-id>` — activate a proposal. Refuses any rule that has not
  met the evidence bar.
- `rollback <version>` — reactivate a previously approved version. Refuses a
  version that was never approved, since activating something nobody agreed to
  is worse than refusing.

When showing policies, display each rule with its supporting evidence. A rule
that cannot show its provenance is a bug, not a policy.

Old versions are retained rather than overwritten — rollback is only possible
if the thing being rolled back to still exists.
