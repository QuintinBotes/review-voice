---
description: Delete stored review data by repository, age, or entirely
argument-hint: "<--repo <owner/repo> | --before <date> | --all>"
allowed-tools: Bash(node:*)
---

<!-- Status: scaffold. Implemented in M2. -->

# Purge stored data

Run `${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs purge $ARGUMENTS`.

Deletion is irreversible. Before deleting, show exactly what will go: event
counts, affected repositories, derived policies, and index entries.

Then confirm. `--all` requires the user to confirm a second time.

Embeddings are deleted with the events they derive from unless the user has
chosen to retain derived-only artifacts.
