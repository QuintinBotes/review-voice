# Review Voice

A concise, precedent-aware code reviewer for Claude Code.

Every finding names a concrete failure mode, in forty words or fewer, ordered
worst-first, with the tier derived from the kind of defect rather than asked
for. Silence when nothing qualifies:

```
No actionable findings.
```

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
| `/review-voice:draft-review` | Render the last review as a GitHub draft |
| `/review-voice:status` | Corpus coverage, policy versions, retention |
| `/review-voice:sync` | Pull new review history (read-only) |
| `/review-voice:purge` | Delete stored data by repo, age, or entirely |

## Requirements

Node 22 or newer. `git`. `gh` only if you enable GitHub history ingestion.

No `npm install` - the plugin ships a single pre-built bundle with zero runtime
dependencies.
