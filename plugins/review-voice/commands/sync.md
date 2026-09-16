---
description: Incrementally sync new review history from allowlisted repositories
argument-hint: "[--repo <owner/repo>] [--full]"
allowed-tools: Bash(node:*), Bash(gh:*), Read
---

<!-- Status: scaffold. Implemented in M2. -->

# Sync review history

Run `${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs sync $ARGUMENTS`.

Read-only. Allowlisted repositories only. At most 50 new eligible events per
run by default. Deduplicate on stable GitHub ids and content hashes.

New evidence is **queued for calibration**. It never mutates an active policy
on its own — see `/review-voice:calibrate`.
