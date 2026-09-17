---
description: Set up Review Voice - identity, repository allowlist, and consent
allowed-tools: Bash(node:*), Bash(gh:*), Read, Write
---

# Initialise Review Voice

Let `RV` be `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs"`.

**Nothing is read from GitHub until the user has seen exactly what would be
read and said yes.** Every step below is a place they can stop.

## 1 - Identify the user

Run `gh api user --jq .login`. Show it and confirm this is the account whose
review judgement should be modelled. Never assume an identity; the owner
reviewer is whoever is running this.

If `gh` is not authenticated, say so and stop. Do not offer to work around it.

## 2 - Show what is reachable

Run `RV discover`. This lists repositories the credential can see. It reads no
review history.

Present them. Say plainly that listing is not selecting.

## 3 - Take an explicit allowlist

Ask which repositories to include. Require an explicit answer - there is no
"all of them", and no default.

The credential from `gh` is almost certainly broader than Review Voice needs,
so the allowlist is what actually bounds access.

## 4 - Show the consent plan

Run `RV consent-plan --owner <login> --repo <owner/repo> ...` and show the
result in full: what will be read, where it will be stored, what is discarded,
and that no write operation occurs.

Then ask. Format it like this:

```
Review Voice will read pull-request review history from:
  - <owner/repo>

It will read: inline review comments you or your teammates wrote, the diff
hunk each was attached to, the file and line, and the pull request number.

It will not read: comments from bots or outside contributors.
It will not write anything to GitHub, ever.

Secrets are removed before anything is written. The original text is never
stored. Everything stays at <storage location> on this machine.

Proceed? [y/N]
```

**Stop if the answer is anything other than yes.** A partial setup is a valid
outcome; an unconsented sync is not.

## 5 - Write the configuration

Write `.review-voice/config.yaml` from `templates/config.example.yaml` with the
owner login and allowlist filled in. Show the file.

## 6 - Offer a dry run first

Run `RV sync --dry-run`. It reports what would be imported - counts, per
repository, with exclusions - and stores nothing.

Show the numbers. If the corpus is small, say so plainly rather than implying
the policy rests on more than it does. Below roughly 30 events, tell the user
explicit feedback via `/review-voice:feedback` will matter more than history
for a while.

## 7 - Sync only on a second confirmation

Only after they approve the dry run, run `RV sync`.

Report the result honestly, including any shortfall. Never present a partial
scan as a complete one.
