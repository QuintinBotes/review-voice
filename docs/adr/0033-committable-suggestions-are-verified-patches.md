# 0033 - Committable suggestions are verified patches

**Status:** Accepted · **Date:** 2026-11-08
**Relates to:** [0010](0010-review-verdict-posting.md) - a suggestion block is
text inside an inline comment of the one review write. The author applies it;
Review Voice still never pushes, and no request is added beyond one read.
**Amends:** [0029](0029-posted-findings-are-followed-to-an-outcome.md) - an
applied suggestion is a strong `fixed` outcome.

## Context

Other pull-request reviewers post committable suggestion blocks that the
author applies in one click. Review Voice already had the hard part. The
verifier judges a `suggested_fix` apart from the defect, and a fix renders
only when its verdict is `verified` and its confidence meets
`review.confidence_threshold`. Candidates are anchored on added lines.

What it did not have was the replacement text. `suggested_fix` is at most 300
characters of description, not code, and every stage between the analyst and
the writer dropped fields it did not know. A block the author commits is a
stronger act than a sentence they read, so the bar for rendering one has to be
at least the bar for the sentence, and checked against the code it replaces.

## Decision

**A suggestion block posts only for a patch the CLI checked against the diff,
the verifier verified at the prose fix's bar, and the head still matches. It
is off until a repository turns it on.**

- **The patch.** A candidate may carry `suggested_patch`: `start_line`,
  `end_line`, `original` and `replacement`. The range is at most five lines
  and ends at the candidate's line, so the comment stays on its anchor. Each
  string is at most 600 characters, the bound `score` cuts text at, and no
  line of either may start with three backticks, which would close the block.
  `normaliseCandidate` refuses any other shape.
- **The diff check.** `check-candidates --diff-file` refuses a range that is
  not all added lines of the anchored file, and an `original` that differs from
  their text, as an anchor failure. A transcription slip goes back to the
  analyst before the verifier reads it.
- **The verifier's bar.** With a patch present, the fix verdict judges that
  exact replacement: it removes the failure, breaks no served path, and
  compiles in context as far as reading shows. The block needs the finding's
  backing score to have `fix.render: 'fix'`, the same rule the prose fix
  meets.
- **The head check.** With `review.suggestions: true`, `computeVerdict` reads
  `GET /repos/{r}/contents/{path}?ref={head}` for each such finding and
  renders the block only when the lines still read `original`. A failed read,
  a different text, a fix that was not verified, or a finding moved since by
  the challenge or `reanchor` withholds the block: the prose posts alone and
  `withheldSuggestions` and the preview name the finding and the reason. The
  patch is recorded with the file and the candidate it came from, and posts
  only on that file, from that candidate's own verified fix in the same run,
  so two candidates at one location cannot lend each other a verdict.
  `score` writes the path the patch was checked on inside the patch, which
  nothing that moves a finding rewrites, so a finding moved to another file
  is withheld as an anchor move; `reanchor` also drops a moved candidate's
  patch. A patch whose replacement equals its original, line endings aside,
  is withheld as changing nothing.
  `verdict`, `post` and the watcher share this, so the preview is what is sent,
  and the idempotency key covers the block as it covers the prose.
- **The range.** A block over more than one line sends `start_line` and
  `start_side: RIGHT`; the writer refuses a range that does not end at the
  comment's line on the new side.
- **The editor writes no code.** The block comes from the candidate's field
  through the CLI, outside the validated prose and its word budget. The
  editor's input leaves `suggested_patch` out, so the code never reaches it.
- **The outcome.** When a finding's lines changed later, the comment as
  posted carried a block, and the current head has the replacement exactly
  where the reviewed head had the original, with every line above it
  unchanged and the same line after it, `outcomes` records `fixed`, strong, with evidence "suggestion
  applied". Matching the replacement alone is not enough: a shorter one can
  equal an untouched first line of the original. The file must also differ
  between the two heads, and the range must no longer read the original, so
  an unchanged file never counts, even beside a repeated line. An empty replacement,
  a deletion, cannot be recognised that way and falls to the existing rules,
  as does a file that cannot be read.

## Consequences

- An author can accept a short verified repair without retyping it.
- Each post with suggestions enabled costs one contents read per file with a
  candidate block. Nothing is read when the setting is off.
- A block is part of the review's identity. A read that fails once and succeeds
  later makes a different payload, and so a different key, for the same head.
  The inline comment is still sent once: an already-posted comment is matched
  by its location and prose, with the block left out, so a finding posted
  without its block is not posted again with it.
- A patch that becomes stale between recording and posting is withheld rather
  than posted against lines it no longer fits.

## Alternatives considered

**Let the concise editor write the code.** Rejected. The editor has no tools
and states only what the CLI hands it; code it wrote would be a repair nobody
verified.

**A block for a partial fix.** Rejected. A direction is what a partly verified
repair is reduced to, and a block the author commits is the opposite of a
direction.

**Blocks longer than five lines.** Rejected. A longer replacement is harder
for the verifier to judge and for the author to read before committing, and a
repair that size is a change to discuss, not to accept in one click.

**Push the fix as a commit.** Rejected, as in 0010: the one write is the
review, and the author decides what lands on their branch.
