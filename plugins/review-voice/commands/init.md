---
description: Set up Review Voice — identity, repository allowlist, and baseline policy
allowed-tools: Bash(node:*), Bash(gh:*), Read, Write
---

<!-- Status: scaffold. M1 implements local setup; M2 adds GitHub ingestion. -->

# Initialise Review Voice

Run `${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs init`.

Consent is the point of this command. In order:

1. Identify the authenticated GitHub account (`gh api user`). **Never assume an
   identity** — the owner reviewer is whoever is running this, not a name baked
   into the plugin.
2. Show the repositories the authorization can reach.
3. Require an explicit allowlist. Scanning everything accessible is never the
   default.
4. Confirm the owner reviewer identity.
5. Offer a historical bootstrap target (default: 250 eligible review events).
6. Present the exact data collection scope — repositories, artifact types,
   retention window, where data is stored — **before** any sync begins.
7. Require confirmation before downloading or indexing anything.
8. Generate a proposed policy from `policies/baseline-global.yaml`.
9. Require explicit approval before the policy becomes active.

Stop at any step the user declines. A partial setup is a valid outcome; an
unconsented sync is not.
