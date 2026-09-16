# Repository security posture

What is enforced on this repository, and what is deliberately still pending.
[THREAT-MODEL.md](THREAT-MODEL.md) covers threats to Review Voice as a product;
this file covers threats to the repository that ships it.

## Enforced now

### `main` is protected

No bypass actors. The maintainer is subject to the same rules as a contributor,
which is the point — a protection the owner can walk past protects nothing.

| Rule | Effect |
|---|---|
| Pull request required | No direct pushes, including by the owner |
| `ci-green` required | Verified as blocking: a failing secret scan stopped a merge |
| Branches must be up to date | No merging against stale `main` |
| Conversation resolution required | Review comments cannot be merged past |
| Linear history, squash only | One reviewed commit per change |
| Force push blocked | History cannot be rewritten |
| Deletion blocked | The branch cannot be removed |
| Signatures required | Every commit is signed and attributable |

Approvals required is **0**, because a solo maintainer cannot approve their own
pull request and a rule nobody can satisfy is a rule that gets deleted. Every
other gate still applies. Raise this to 1 the moment there is a second
maintainer.

### Commits are signed

Every commit on `main` is SSH-signed and verified by GitHub. This matters more
here than in most repositories: `dist/review-voice.mjs` is committed and
executed directly by users, so being able to prove who produced each commit is
part of the chain that makes the bundle trustworthy.

Commits are authored under a personal address kept deliberately separate from
any employer's, so nothing about this project is attributable to an unrelated
organisation. A git log in a public repository is permanent and is harvested by
address scrapers; contributors who would rather not publish an inbox should use
their GitHub `users.noreply.github.com` relay, which verifies and attributes
identically.

### Release tags are protected

`review-voice--v*` cannot be deleted, updated, or force-pushed. A published
version therefore keeps meaning what it meant when it was published.

The release workflow additionally refuses to publish a tag whose commit is not
an ancestor of `main`, so a tag cannot smuggle unreviewed code into a release.

### Workflows run with least privilege

- The repository default workflow token is **read-only**, and workflows cannot
  approve pull requests.
- Every workflow starts from `permissions: {}`; each job opts into the minimum.
  Only the release job holds `contents: write`.
- `actions/checkout` sets `persist-credentials: false`, so the token is not left
  in `.git/config` for a later step — or one of its dependencies — to read.
- Jobs that hold secrets never run fork code. The eval workflow holds an
  `ANTHROPIC_API_KEY` and is restricted to branches in this repository; a label
  is not a substitute for trust.

### Actions are pinned to commit SHAs

A tag like `@v4` is a mutable pointer. Whoever controls an action's repository
can move it and run their code against this repository's tokens. Every action is
pinned to a full SHA with a version comment, and `npm run check:pins` fails the
build if a pin regresses to a tag — pinning rots silently without a check.

### Continuous scanning

| Control | Runs |
|---|---|
| gitleaks secret scan | Every push and pull request |
| Full OS matrix (Linux + macOS) | Pushes to main and releases; pull requests run Linux only |
| CodeQL | Weekly, and on demand |
| Dependabot alerts and automated security fixes | Continuous |
| Dependabot version updates | Weekly, grouped |
| Bundle-drift check | Every push and pull request |

The bundle-drift check is a security control, not just hygiene: `dist/` is
committed and executed by users, so CI rebuilds it from source and fails on any
difference. Malicious bytes cannot enter the artifact without also being in
reviewable source.

## Pending, and why

| Item | Blocked on | Notes |
|---|---|---|
| GitHub secret scanning and push protection | Repository being public | Not available on a private repository without Advanced Security. gitleaks covers the gap. Enable at launch. |
| Private vulnerability reporting | Repository being public | `SECURITY.md` already points at the advisory form; the link becomes usable to outside reporters at launch. |
| OSSF Scorecard | Repository being public | Results need a public repository to publish. |
| Required approvals ≥ 1 | A second maintainer | See above. |

## Launch checklist

When the repository goes public at v1.0.0:

1. Enable secret scanning and push protection.
2. Enable private vulnerability reporting.
3. Add the OSSF Scorecard workflow.
4. Re-read `SECURITY.md` against what the code actually does — every claim in it
   becomes a public promise on that day.
