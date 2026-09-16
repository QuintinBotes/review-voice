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

Commits are authored through a GitHub `users.noreply.github.com` relay rather
than any real address. Attribution and signature verification are unaffected,
nothing ties the project to an unrelated employer, and no inbox is published in
a repository whose git log is permanent and routinely harvested by scrapers.

This is also what GitHub's own "Block command line pushes that expose my email"
setting enforces, so the relay is the path of least resistance as well as the
safer one.

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
| GitHub secret scanning | Continuous, with push protection blocking commits |
| gitleaks secret scan | Every push and pull request |
| Full OS matrix (Linux + macOS) | Every push and pull request |
| CodeQL | Every push, every pull request, weekly |
| Dependabot alerts and automated security fixes | Continuous |
| Dependabot version updates | Weekly, grouped |
| Bundle-drift check | Every push and pull request |

The bundle-drift check is a security control, not just hygiene: `dist/` is
committed and executed by users, so CI rebuilds it from source and fails on any
difference. Malicious bytes cannot enter the artifact without also being in
reviewable source.

### Reporting

Private vulnerability reporting is enabled, so the advisory link in
`SECURITY.md` works for outside reporters. Push protection blocks a commit
containing a recognised credential before it reaches the remote, which is the
one control that acts *before* publication rather than after.

## Pending, and why

| Item | Blocked on | Notes |
|---|---|---|
| OSSF Scorecard | Nothing — not yet added | A supply-chain posture score published to the security tab. Worth adding; no blocker. |
| Required approvals ≥ 1 | A second maintainer | See above. |

## Publication

The repository was made public on 2026-09-16, ahead of v1.0.0, because GitHub
Actions is free and unlimited for public repositories and the private-repo
Actions budget had been exhausted.

A full history audit ran first and found two real leaks, both fixed by
rewriting history before anything was served publicly:

1. **The identity guard published what it hid.** It enumerated four private
   repository names in a regex literal and allowlisted its own file, so it never
   flagged itself. It now hardcodes nothing and reads site-specific terms from a
   gitignored `.identity-guard.local`.
2. **A work email survived in commit message trailers.** An earlier rewrite had
   corrected author and committer headers but not message bodies, where GitHub
   had written `Co-authored-by` lines during squash merges.

The audit also confirmed no credentials in any commit, no absolute paths or
usernames in the committed bundle, no private registries in the lockfile, and no
files ever added and later deleted.

Rewriting history is only a real fix *before* publication. On a public
repository, force-pushed commits stay reachable by SHA through the API, which is
why the remaining launch item below is prevention rather than cleanup.

Still to do: re-read `SECURITY.md` against what the code actually does before
v1.0.0 — every claim in it is now a public promise.
