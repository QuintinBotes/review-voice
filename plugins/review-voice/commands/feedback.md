---
description: Record feedback on a finding — keep, dismiss, rewrite, or never flag
argument-hint: "<finding-id> <keep|dismiss|rewrite|raise-severity|lower-severity|repo-specific|never-flag> [--reason <text>]"
allowed-tools: Bash(node:*)
---

<!-- Status: scaffold. Implemented in M1. -->

# Record feedback

Run `${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs feedback $ARGUMENTS`.

This is the highest-weight signal the system has. Explicit owner feedback
outranks anything inferred from history.

| Action | Meaning |
|---|---|
| `keep` | Useful and correctly framed |
| `dismiss` | Not useful, not correct, or out of scope |
| `rewrite` | Right problem, wrong wording |
| `raise-severity` / `lower-severity` | Impact was mis-stated |
| `repo-specific` | Valid only under this repository's conventions |
| `never-flag` | Suppress this class of finding |

A finding with no response stays **unlabeled**. Silence is never a negative
label — do not record one.
