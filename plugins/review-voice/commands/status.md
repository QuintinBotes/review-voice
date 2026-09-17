---
description: Show corpus coverage, policy versions, retention, and pending proposals
allowed-tools: Bash(node:*), Read
---

# Review Voice status

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs" status` and show its
output. It reports the data directory, review runs, audit events, feedback
totals, owner precision, and the finding ids of the last review.

Then run `RV evaluate` and show the metrics table. Present a metric with no
data as "not yet measurable" rather than inventing a verdict - a reviewer that
has never run is not a reviewer with perfect compliance.

A metric carries a `kind`. Report a missed `gate` as a failure and a missed
`goal` as a goal not yet reached, and do not report a metric printed as
"reported, not scored" as either. A count of findings per review reflects the
diffs reviewed, not the reviewer.

Also run `RV context` and say so if `verification.configured` is false: the
second-pass verifier never runs without a `verification` block, and configs
written before it existed do not have one.

Corpus composition is reported by repository and reviewer role once a sync has
run. **A corpus with no owner events cannot produce a policy rule**, because
activation needs at least one owner signal - `status` says so explicitly rather
than leaving `calibrate` to return nothing forever.

Report coverage honestly. If the corpus holds 147 of its event target, say so
and say why. Never present a shortfall as a complete scan.

`last sync` and the warnings distinguish a corpus that was never built from one
whose build died. An empty corpus with a sync that never recorded a finish is
not the same problem as an empty corpus with no sync at all, and it does not
have the same fix. A sync started in the last half hour is reported as neither,
because it may still be running.
