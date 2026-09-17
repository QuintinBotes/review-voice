---
description: Show corpus coverage, policy versions, retention, and pending proposals
allowed-tools: Bash(node:*), Read
---

# Review Voice status

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs" status` and show its
output. It reports the data directory, review runs, audit events, feedback
totals, owner precision, and the finding ids of the last review.

Then run `RV evaluate` and show the metrics table. Present a metric with no
data as "not yet measurable" rather than inventing a verdict — a reviewer that
has never run is not a reviewer with perfect compliance.

Corpus composition is reported by repository and reviewer role once a sync has
run. **A corpus with no owner events cannot produce a policy rule**, because
activation needs at least one owner signal — `status` says so explicitly rather
than leaving `calibrate` to return nothing forever.

Report coverage honestly. If the corpus holds 147 of a 250-event target, say so
and say why. Never present a shortfall as a complete scan.
