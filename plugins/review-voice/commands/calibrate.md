---
description: Review proposed policy changes and approve or reject them
allowed-tools: Bash(node:*), Read
---

<!-- Status: scaffold. Implemented in M3. -->

# Calibrate policy

Run `${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs calibrate`.

Show each proposed change with its scope, the rule, the supporting evidence
(counts of keeps, dismissals and rewrites, plus the most recent evidence date),
the expected effect on finding volume, and the regression suite result.

Then stop and ask. Never activate a policy change without explicit approval,
and never activate one that failed the regression suite.

A weak signal — a merge with no visible fix, a thread resolved without comment,
no reply at all — can never create or suppress a rule on its own.
