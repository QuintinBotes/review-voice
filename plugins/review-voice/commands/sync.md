---
description: Incrementally sync new review history from allowlisted repositories
argument-hint: "[--repo <owner/repo>] [--full]"
allowed-tools: Bash(node:*), Bash(gh:*), Read
---

# Sync review history

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs" sync $ARGUMENTS`.

Read-only. Allowlisted repositories only. Deduplicated on content and location,
so a rebase does not create a second copy.

Use `--dry-run` first if anything about the scope has changed. It reports what
would be imported and stores nothing.

## Polling, not webhooks

Sync is incremental and safe to run often. Conditional requests mean an
unchanged repository costs almost nothing against the rate limit, and the ETags
persist between runs.

There is no webhook receiver by design: an endpoint would need hosting, which
`docs/adr/0002` declined to make this tool require. For a corpus that informs
policy, being hours out of date is irrelevant.

## After syncing

New evidence is **queued for calibration**. It never mutates an active policy
on its own — see `/review-voice:calibrate`.
