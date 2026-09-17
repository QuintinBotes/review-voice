---
description: Delete stored review data by repository, age, or entirely
argument-hint: "<--repo <owner/repo> | --before <date> | --all>"
allowed-tools: Bash(node:*)
---

# Purge stored data

Let `RV` be `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs"`.

## Always preview first

Run `RV purge $ARGUMENTS` **without** `--confirm`. It prints exactly what would
be removed and deletes nothing.

Show those counts. Then ask.

## Then delete

Only after an explicit yes, re-run with `--confirm` appended.

For `--all`, ask a second time. It removes the corpus, every review run and all
feedback - the calibration history as well as the data.

Deletion is irreversible. There is no undo, and the data cannot be recovered
from anywhere else, because it never left this machine.

A purge also clears the sync watermarks for whatever it removed, so the next
sync rebuilds rather than tops up. Without that, sync would skip every pull
request it had already read as "unchanged" and the corpus would come back as
whatever happened to be updated since.

The audit entry recording the purge survives it. That is deliberate: deleting
the evidence that a deletion happened would make the audit trail useless
exactly when it matters most.
