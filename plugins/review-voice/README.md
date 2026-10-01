# Review Voice

A concise, precedent-aware code reviewer for Claude Code.

Every finding names a concrete failure mode, in forty words or fewer, ordered
worst-first, with the tier derived from the kind of defect rather than asked
for. Silence when nothing qualifies:

```
No actionable findings.
```

Suggested fixes are verified independently from defects. The concise editor has
no tools, so each eligible candidate and its fix rendering instruction must be
passed inline, never as a file path.

Candidate anchors are checked against the reviewed diff before verification.
They must name an added line or the right-side location of removed code; an
unchanged context line is rejected with the nearest changed line for the analyst
to re-anchor or withdraw. `thread --out` and `symbols --out` accept either a
file path or a directory, writing `thread.json` or `symbols.json` in a
directory.

Full documentation, install instructions and threat model live in the
[repository root](https://github.com/QuintinBotes/review-voice).

## Commands

| Command | Does |
|---|---|
| `/review-voice:review` | Review the current diff, staged changes, or a PR |
| `/review-voice:init` | Set up identity, allowlist and baseline policy |
| `/review-voice:feedback` | Keep, dismiss, rewrite or suppress a finding |
| `/review-voice:calibrate` | Approve or reject proposed policy changes |
| `/review-voice:policy` | Show, diff, roll back or export policies |
| `/review-voice:explain` | Show why a finding was emitted or suppressed |
| `/review-voice:draft-review` | Compute the verdict and post the review after one confirmation |
| `/review-voice:status` | Corpus coverage, policy versions, retention |
| `/review-voice:sync` | Pull new review history (read-only) |
| `/review-voice:purge` | Delete stored data by repo, age, or entirely |

## Requirements

Node 22 or newer. `git`. `gh` only if you enable GitHub history ingestion.

No `npm install` - the plugin ships a single pre-built bundle with zero runtime
dependencies.
