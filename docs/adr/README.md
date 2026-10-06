# Architecture decision records

Each record closes a design decision. They are numbered, dated, and immutable
once accepted - a reversal is a new record that supersedes an old one, not an
edit.

0001 to 0008 close the eight open decisions the specification left for
implementation, and were reviewed and approved by the owner on 2026-09-16,
which is the gate M1 was waiting on. Later records close decisions that arose
after that gate.

| # | Decision | Status |
|---|---|---|
| [0001](0001-embedding-implementation.md) | Embedding and retrieval implementation | Accepted |
| [0002](0002-github-auth-model.md) | GitHub authentication model | Accepted |
| [0003](0003-static-analysis-adapters.md) | Static analysis adapter strategy | Accepted |
| [0004](0004-outcome-inference-limits.md) | Outcome inference limits | Accepted |
| [0005](0005-data-encryption.md) | Data encryption at rest | Accepted |
| [0006](0006-team-governance.md) | Team and policy governance | Accepted |
| [0007](0007-comment-posting.md) | GitHub comment posting | Accepted, superseded in part by 0010 |
| [0008](0008-policy-sharing.md) | Policy sharing and export | Accepted |
| [0009](0009-severity-from-computed-reach.md) | Severity from category and computed reach | Accepted, amended 2026-10-06 |
| [0010](0010-review-verdict-posting.md) | Posting a review with its verdict | Accepted, amended by 0012, 0013 and 0017 |
| [0011](0011-severity-escalation-needs-traced-impact.md) | Severity escalation needs traced impact | Accepted |
| [0012](0012-complex-changes-need-human-approval.md) | Complex changes are raised for a human's approval | Accepted, amended 2026-10-06 (posted body; production-source count; would-have verdict and stale request for changes) |
| [0013](0013-ci-needs-rerun.md) | CI that needs a rerun holds every event | Accepted, amended 2026-10-06 |
| [0014](0014-verifier-tie-break.md) | A tie-break settles a disputed traced impact | Accepted, amended 2026-10-06 and by 0018 |
| [0015](0015-untraced-document-consumers.md) | A stale document may be reported untraced at nit | Accepted |
| [0016](0016-what-the-verifier-could-not-check.md) | What the verifier could not check | Accepted |
| [0017](0017-moving-a-verified-anchor.md) | Moving a verified candidate's anchor | Accepted |
| [0018](0018-cross-check-may-raise-through-tie-break.md) | A cross-check may raise a severity only through the tie-break | Accepted |
