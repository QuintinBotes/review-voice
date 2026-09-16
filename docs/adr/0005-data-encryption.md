# 0005 — Data encryption at rest

**Status:** Accepted · **Date:** 2026-09-16

## Context

The local store holds redacted review history and diff hunks. The specification
asks for platform-specific key storage with a fallback when no secure keychain
is available.

That fallback is the whole problem. Encrypting a database with a key stored
beside it on the same disk, readable by the same user, protects against nothing
except a casual `grep`. It produces a security claim without security.

## Decision

**No application-level encryption at rest in v1.** Review Voice relies on:

- The operating system's full-disk encryption, which is the default on modern
  macOS, Windows and most Linux installs.
- Restrictive permissions: `0700` on the data directory, `0600` on the database
  and audit log.
- **Storing no credentials at all** — the GitHub token stays with `gh`
  ([0002](0002-github-auth-model.md)).
- Redaction before persistence, so the highest-value secrets should never be in
  the store in the first place.
- Short raw retention: 30 days by default.

`PRIVACY.md` and `SECURITY.md` state this plainly rather than implying
protection that does not exist. `doctor` warns if the data directory has
permissive modes.

## Consequences

- A local attacker with the user's filesystem privileges can read the corpus.
  This is stated, not hidden, and is listed as out of scope in the threat model.
- No key management code, no keychain integration across three platforms, and no
  category of bug where a key is lost and the corpus becomes unreadable.
- If a future deployment genuinely needs encryption at rest, it needs a real key
  custodian — an OS keychain with no plaintext fallback — and that is a new ADR.

## Alternatives considered

**Encrypt with a key in the OS keychain, plaintext fallback when unavailable.**
Rejected: the fallback silently removes the protection while the documentation
keeps claiming it.

**Encrypt with a user passphrase.** Rejected: a prompt on every review is
unusable, and a cached passphrase reduces to the rejected option above.
