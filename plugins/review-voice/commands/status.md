---
description: Show corpus coverage, policy versions, retention, and pending proposals
allowed-tools: Bash(node:*), Read
---

<!-- Status: scaffold. M1 reports local state; M2 adds corpus coverage. -->

# Review Voice status

Run `${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs status` and report:

- Allowlisted repositories.
- Corpus event counts by repository and reviewer role.
- Last sync time.
- Policy versions per scope, with approval status.
- Retention status and next expiry.
- Index version.
- Evaluation metrics.
- Pending policy proposals.

Report coverage honestly. If the corpus holds 147 of a 250-event target, say so
and say why. Never present a shortfall as a complete scan.
