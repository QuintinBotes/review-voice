---
description: Show corpus coverage, policy versions, retention, and pending proposals
allowed-tools: Bash(node:*), Read
---

# Review Voice status

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs" status` and show its
output. It reports the data directory, review runs, audit events, feedback
totals, owner precision, and the finding ids of the last review.

<!-- Corpus coverage, policy versions and retention arrive with M2. -->

Once GitHub ingestion lands this will also report:

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
