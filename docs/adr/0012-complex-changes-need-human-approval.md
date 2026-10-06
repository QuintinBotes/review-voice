# 0012 - Complex changes are raised for a human's approval

**Status:** Accepted, amended 2026-10-06 · **Date:** 2026-10-02
**Amends:** [0010](0010-review-verdict-posting.md) - the verdict mapping gains
one cap. Nothing else in 0010 changes, and no new GitHub write is added.

## Context

0010 maps a review to APPROVE when no verified finding rises above a nit. That
treats "nothing found" as evidence the change is sound. For most changes it is
fair evidence. For a change that adds a great deal of branching logic, or that
touches code where a mistake is expensive - CI workflows, migrations,
authentication - it is not: a single model pass is thin cover there, and an
approval from the tool can unblock a merge that no person has read.

The review already names a very large change in prose, from an instruction to
the command runner. Nothing deterministic measures it, nothing records it, and
it has no effect on the verdict.

## Decision

**A change assessed as high-complexity is never approved by Review Voice. The
review says so, and why, so a human picks it up.**

- **Assessed in the CLI, from the diff.** `diff --out` computes the assessment
  and writes it into `files.json` and its summary. Two signals, either one is
  enough:
  - *Added decision points*: a lexical count of branches (`if`, loops, `case`,
    `catch`, `&&`, `||`, ternaries) on lines added to reviewed source files,
    for the change as a whole and for its densest hunk. (Amended 2026-10-06:
    production source only; see the second amendment below.) Lexical, like
    changed-symbol context: no parser, no language left out, and a count that
    is wrong by a few on comments or strings is still the right order.
  - *Sensitive paths*: any changed path matching a configured glob, whether or
    not the file was reviewed - a path excluded from the review is no less
    sensitive for it.
- **Configured, with defaults.** `review.human_review` sets
  `max_decision_points`, `max_hunk_decision_points` and `sensitive_paths`.
  Built-in sensitive paths are `.github/workflows/**`, `**/migrations/**`,
  `**/auth/**` and `**/security/**`; a configured list replaces them, and an
  empty list turns the signal off.
- **Recorded with the run**, beside its scope, from the manifest. `verdict`
  and `post` read it from the recorded run, never from stdin or a flag, for the
  same reason the scope is stored: the run must keep saying what it read.
- **Sticky across a pull request.** A narrower later run (incremental,
  interdiff, unchanged) follows its prior runs, and if any of them was assessed
  high the pull request still is. Otherwise three easy commits after a complex
  one would earn the whole change an approval.
- **Effect on the verdict.** APPROVE is capped at COMMENT, before the CI guard,
  so pending CI does not turn it into a wait. `verdict --recheck` refuses: there
  is no approval to re-check. COMMENT and REQUEST_CHANGES are unchanged, since
  neither unblocks anything.
- **Raised in every case.** Whenever the assessment is high, the review
  command prints one line naming the reasons after the findings, outside the
  validated text, as it prints a scope note. (Amended 2026-10-06: the posted
  body no longer carries it; see below.)
- **Unknown is not high.** A run recorded before this record, or without a
  manifest, has no assessment and is not capped; `verdict` says the assessment
  is missing.

## Consequences

- Some sound changes will not be approved by the tool. That is the intended
  cost: the approval was the one thing a person needed to give anyway.
- Thresholds are numbers, and a team will want to tune them. They are in
  configuration for that reason; defaults sit high enough that routine changes
  pass.
- The prose-only "very large change" note in the review command stays. It
  answers a different question - how much a single pass covered - and is not
  part of the verdict.

## Alternatives considered

**Request a human reviewer on the pull request.** Raises it more loudly, but
adds a second GitHub write beside the one 0010 allows. Rejected for now; it can
be its own record if the line in the review proves too quiet.

**Map high complexity to REQUEST_CHANGES.** Blocks a merge on a measurement,
not a defect, which is the false block 0010 was careful to avoid.

**Use size (lines and files changed) as the signal.** Rejected by the owner:
a large mechanical change is easy to read, and a short one dense with new
branches is not.

## Amendment - 2026-10-06

The posted review no longer names human review. Its summary line is the
ordinary one ("No problems found." or "N nits."), and the note is not in the
body, an inline comment or the preview. The flag is local to the agent's
output: `diff`, `verdict` and `post` carry `humanReviewNote` (null unless the
change is high-complexity), and the commands tell the agent to print it and
tell the user the change needs a human reviewer, without adding it to the pull
request. The decision `reasons` still explain the cap locally. The APPROVE cap,
the `--recheck` refusal and the sticky assessment are unchanged.

## Amendment - 2026-10-06: decision points count in production source only

The count ran over every reviewed file the classifier called source, and that
included prose. A Markdown hunk read as 26 decision points, because prose is
full of `if`, `when` and `or`, and was named as the densest hunk of a change
whose source alone was over the limit: the verdict was right and the reason
was wrong.

Decision points now count only in production source. Reviewed files of these
kinds are left out of the count, not down-weighted:

- *Documentation and other non-code text*: Markdown, reStructuredText,
  AsciiDoc, plain text, CSV and the conventional extensionless names (`README`,
  `LICENSE`, `CHANGELOG` and the like). Configuration such as YAML stays
  counted: a workflow condition is a real branch.

The assessment carries `excluded`, a count of the files left out, so the agent
can say what the number did not measure; when the change is high, the note
names them. Sensitive-path matching is unchanged and still applies to every
changed path, excluded or not. An assessment recorded before this amendment
has no `excluded` block and reads as excluding nothing.
