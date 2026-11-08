# Privacy

Review Voice is local-first. There is no server, no telemetry, and no account.

## What it reads

**Only what you allowlist.** There is no mode that scans every repository your
token can reach, and adding a repository always requires explicit confirmation.

With GitHub ingestion enabled, from allowlisted repositories only:

- Pull request metadata, titles and descriptions
- Inline review comments, review threads and submitted review summaries
- Pull request conversation comments (if enabled in config)
- Changed-file metadata and diff hunks
- Thread resolution metadata and commits following a comment
- Check runs and CI status

If you list several logins under `identity.reviewers`, their review comments are read and stored like the owner's, each with its author's login; you are choosing to pool those people's comments, so tell them. Bot comments are excluded from voice learning by default. Forks are excluded
unless you opt in.

**From the repository you are reviewing, locally:** the diff, whatever static
checks you configured, and the repository's own convention documents:
`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.agents/rules/*.md` and
`.claude/skills/*/SKILL.md`, from the root and from the directories the diff
touches. These are read from disk at review time and passed to the review
agents as evidence about what the repository requires. They are never stored,
and they are bounded so a large repository cannot flood the review.

Reviewing a pull request also runs `git grep` against the base ref to check
claims that something does not exist. That reads the repository you already
have checked out and nothing else.

## What it stores, and where

In your platform's application data directory - **never in your repository, and
never anywhere we control**:

| Path | Contents |
|---|---|
| `review-voice.db` | Normalised, redacted events; feedback; policies; the audit log (the `audit_events` table; there is no audit file) |
| `runs/` | One directory per pull request review: the diff, copies of the changed files at the base, the review thread and every stage's input and output, kept raw because they are the code under review |
| `clones/` | The watcher's clones of allowlisted repositories, reused between passes (`watch.workspace` moves them) |
| `embeddings/` | Retrieval index |
| `policies/` | Versioned policy artifacts, including archived versions |
| `exports/` | Anything you explicitly export |

Linux uses `~/.local/share/review-voice/`; macOS and Windows use their
platform-appropriate equivalents. The GitHub Action caches the whole data
directory between runs, `runs/` included.

Review history is redacted before it is persisted, indexed, logged, or placed
in a prompt. See [SECURITY.md](SECURITY.md) for the limits of that. The code
under review is not redacted: it is what the review is about.

## Retention defaults

| Data | Default |
|---|---|
| Review history text (comments, descriptions, summaries) | Redacted on download; the raw text is never stored |
| The reviewed pull request's diff, changed files and thread, under `runs/` | `retention.runs_days`, 30 days; a failed run is kept twice as long so it can be resumed |
| Redacted normalised text | Until you purge it |
| Derived policy rules | Until superseded or purged |
| Audit events | `retention.audit_days`, 180 days; the records of what was posted are kept until purged, because they stop a review being posted twice |
| Embeddings | Deleted with the event they derive from |

`watch` applies the two retention sweeps once per pass, and `purge --runs`
applies the run-directory sweep on demand; `review` never deletes anything.
Both figures are configurable in `.review-voice/config.yaml`, and `0` or
`null` turns a sweep off.

## Before anything is read

`/review-voice:init` shows a consent plan naming the concrete data categories -
not "review history" but the comments, diff hunks, file paths, line numbers and
pull request identifiers it would read. It lists where that is stored and what
is discarded. Nothing is read until you agree, and a dry run showing exact
counts comes before the first real sync.

Bot comments and outside contributors' comments are never stored.

## Deleting your data

```
/review-voice:purge --repo your-org/your-repo
/review-voice:purge --before 2026-01-01
/review-voice:purge --runs --before 2026-01-01
/review-voice:purge --all
```

Each shows exactly what will be deleted before deleting it. `--all` asks twice
and includes the run directories.

## What leaves your machine

Diffs, a bounded amount of retrieved and redacted precedent text, and the
convention documents described above are sent to Claude as part of the review.
This is a Claude Code plugin, so the review itself happens through your existing
Claude Code session and is governed by Anthropic's terms for that session.

If your `CLAUDE.md` or a rule file contains something you would not put in a
prompt, that is worth knowing before you enable this. `RV conventions` prints
exactly what would be sent, and takes no network access to do it.

Nothing else leaves. Remote embeddings are off by default
(`privacy.allow_remote_embeddings: false`) and must be explicitly enabled.
