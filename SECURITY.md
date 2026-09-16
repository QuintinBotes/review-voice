# Security Policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/QuintinBotes/review-voice/security/advisories/new).
Please do not open a public issue for a security problem.

Expect an acknowledgement within 5 working days. This is a small project; if a
fix will take longer than that, you will be told so rather than left waiting.

## Supported versions

Pre-1.0: only the latest release is supported.

## What Review Voice does and does not promise

Review Voice reads source code and review history and puts some of it in front
of a language model. Being precise about the limits of that is more useful than
reassurance.

### Secret redaction is defence in depth, not a guarantee

Before anything is persisted, indexed, logged, or placed in a prompt, Review
Voice runs a redaction pass over it, covering API keys, OAuth tokens, SSH
private keys, PEM blocks, password-like assignments, JWTs, cloud provider
credentials, GitHub tokens, registry tokens, and database URLs containing
credentials.

**The original text is never written to disk.** Redaction happens at the
download boundary and only its output survives, so there is no window in which
unredacted review text sits in the store. Content hashes taken before and after
make a redaction auditable without retaining what was removed.

**This will not catch every secret.** Pattern-based redaction cannot recognise a
credential that does not look like one. Treat it as a second line of defence
behind not committing secrets in the first place — never as permission to run
Review Voice against a repository whose contents you could not tolerate reaching
a model.

If redaction misses a pattern it should have caught, that is a security bug and
we want the report.

### Repository content is untrusted input

Source code, comments, markdown, pull-request titles and descriptions, issue
comments, historical review comments and test fixtures are all treated as
**untrusted data**. Instructions found inside them are never followed. Retrieved
text cannot change tool permissions or workflow order. Commands found in
repository content are never executed.

This is enforced through delimited data blocks, strict output schemas, an
explicit safety preamble in every agent prompt, and a public regression suite of
prompt-injection fixtures in [`fixtures/prompt-injection/`](fixtures/prompt-injection/).
Contributed attack cases are welcome — an injection that defeats the suite is a
valuable bug report, not an embarrassment.

Prompt injection is an open research problem. These defences reduce risk
substantially; they do not eliminate it.

### Read-only

Through v1, Review Voice performs no GitHub write operations. This is enforced
in code — the GitHub client rejects any non-GET request — and covered by test,
not merely documented. It cannot post comments, approve or block pull requests,
merge, or modify repository state.

### Static analysis commands are opt-in

Review Voice will not execute a project script unless you have listed it in your
configuration. Auto-running scripts found in a repository would be arbitrary
code execution on untrusted content. See
[docs/adr/0003-static-analysis-adapters.md](docs/adr/0003-static-analysis-adapters.md).

### Local data is not encrypted at rest by the application

The corpus and policy store rely on your operating system's full-disk
encryption and restrictive file permissions, not application-level encryption.
The reasoning is in
[docs/adr/0005-data-encryption.md](docs/adr/0005-data-encryption.md). Review
Voice never stores your GitHub credentials — it borrows them from `gh`.
