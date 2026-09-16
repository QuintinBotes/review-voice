---
description: Explain why the last review emitted or suppressed each finding
argument-hint: "[finding-id]"
allowed-tools: Bash(node:*), Read
---

<!-- Status: scaffold. Implemented in M3. -->

# Explain a review

Run `${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs explain $ARGUMENTS`.

For each finding show: status, technical confidence, preference score, the
applicable rules, the supporting precedent ids, suppression checks, and the
word count against its limit.

Show enough to audit the decision. Do not dump raw history to do it.
