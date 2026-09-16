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

Bot comments are excluded from voice learning by default. Forks are excluded
unless you opt in.

## What it stores, and where

In your platform's application data directory — **never in your repository, and
never anywhere we control**:

| Path | Contents |
|---|---|
| `review-voice.db` | Normalised, redacted events; feedback; policies; audit |
| `embeddings/` | Retrieval index |
| `policies/` | Versioned policy artifacts, including archived versions |
| `audit/events.jsonl` | Local audit log |
| `exports/` | Anything you explicitly export |

Linux uses `~/.local/share/review-voice/`; macOS and Windows use their
platform-appropriate equivalents.

Everything is redacted before it is persisted, indexed, logged, or placed in a
prompt. See [SECURITY.md](SECURITY.md) for the limits of that.

## Retention defaults

| Data | Default |
|---|---|
| Original, unredacted text | **Never stored.** Redaction happens on download; only the cleaned copy is written to disk. |
| Redacted normalised text | Until you purge it |
| Derived policy rules | Until superseded or purged |
| Audit logs | 180 days |
| Embeddings | Deleted with the event they derive from |

All configurable in `.review-voice/config.yaml`.

## Deleting your data

```
/review-voice:purge --repo your-org/your-repo
/review-voice:purge --before 2026-01-01
/review-voice:purge --all
```

Each shows exactly what will be deleted before deleting it. `--all` asks twice.

## What leaves your machine

Diffs and a bounded amount of retrieved, redacted precedent text are sent to
Claude as part of the review — this is a Claude Code plugin, so the review
itself happens through your existing Claude Code session and is governed by
Anthropic's terms for that session.

Nothing else leaves. Remote embeddings are off by default
(`privacy.allow_remote_embeddings: false`) and must be explicitly enabled.
