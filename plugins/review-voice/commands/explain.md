---
description: Explain why the last review emitted or suppressed each finding
argument-hint: "[rv_NN] [--run <review-run-id>]"
allowed-tools: Bash(node:*), Read
---

# Explain a review

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs" explain $ARGUMENTS`.

Shows, per finding: its category, technical confidence, final score, and the
precedent ids that informed it.

## Report what was recorded, not what sounds plausible

If a field says `not recorded`, say so. Do not reconstruct a rationale after
the fact - an explanation invented at explain-time is a story about the
finding, not a record of how it was produced.

Scores are only present when the review passed `--scores` to `record`. A review
run before that, or run without scoring, will have findings but no numbers.
That is a gap in the recording, not something to paper over.

## Ids

Positional: `rv_01` is the first finding of the review being explained. Without
an argument, every finding is shown. `--run <id>` explains an older review.
