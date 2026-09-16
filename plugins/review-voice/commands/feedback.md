---
description: Record feedback on a finding — keep, dismiss, rewrite, or never flag
argument-hint: "<rv_NN> <keep|dismiss|rewrite|raise-severity|lower-severity|repo-specific|never-flag> [--reason <text>] [--replacement <text>]"
allowed-tools: Bash(node:*)
---

# Record feedback

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs" feedback $ARGUMENTS`.

This is the highest-weight signal the system has. Explicit owner feedback
outranks anything inferred from history.

## Finding ids

Ids are **positional**: `rv_01` is the first finding of the most recent review,
`rv_02` the second. They are not printed alongside the findings, because the
output contract allows no text beyond the findings themselves.

If the user does not give an id, or gives one that does not exist, run
`review-voice status` to list the ids of the last review and show them the
findings so they can pick. Do not guess which finding they meant.

To address an older review, use `<review-run-id>:rv_NN`.

## Actions

| Action | Meaning |
|---|---|
| `keep` | Useful and correctly framed |
| `dismiss` | Not useful, not correct, or out of scope |
| `rewrite` | Right problem, wrong wording — requires `--replacement` |
| `raise-severity` / `lower-severity` | Impact was mis-stated |
| `repo-specific` | Valid only under this repository's conventions |
| `never-flag` | Suppress this class of finding |

A finding with no response stays **unlabeled**. Silence is never a negative
label — do not record one on the user's behalf, and do not prompt them to
label everything.
