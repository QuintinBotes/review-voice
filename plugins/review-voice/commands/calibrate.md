---
description: Review proposed policy changes and approve or reject them
allowed-tools: Bash(node:*), Read
---

# Calibrate policy

Let `RV` be `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs"`.

Run `RV calibrate`. It compiles explicit feedback into proposed rules and
stores them **inactive**.

## Show the evidence, not just the rule

For each proposal, present:

```
Proposed policy change

Scope: <scope>
Rule: <rule>

Evidence:
- <n> dismissals, <n> keeps, <n> rewrites
- <n> owner signals, <n> contradicting
- Most recent evidence: <date>

Confidence: <confidence>
Status: <activatable, or why it is blocked>
```

A rule the user cannot see the evidence for is a rule they cannot judge.

## Then stop and ask

**Never activate a proposal without an explicit yes.** Global policy changes
always require approval.

If `activatable` is false, say why and do not offer to approve it — the
evidence bar has not been met, and approving anyway would make the bar
decorative. The bar is three corroborating signals including at least one from
the owner, with nothing from the owner contradicting it.

To approve: `RV policy approve <policy-id>`.

## Weak signals

A merge with no visible fix, a thread resolved in silence, and no reply at all
are all consistent with a comment having been right, wrong, or simply unread.
None of them can create or suppress a rule. If a user asks why something has
not become a rule, that is usually the answer.
