# 0009 - Severity from category and computed reach

**Status:** Accepted · **Date:** 2026-09-17

## Context

Severity was derived from the finding category alone. Derivation itself was
sound and replaced asking an agent for a tier, which flapped: on two runs of a
byte-identical diff the same finding was `minor` at confidence 0.90 and
`important` at 0.85.

But one tier per category is wrong whenever a category's members vary in reach.
`ci` covers both a change that breaks every lint job and a stale comment in a
CI config. On a live run every finding in a review collapsed to `minor` or
`nit`, and a build-breaker rendered indistinguishably from a stale comment.
Severity is what decides whether a reader continues past the first finding, so
this is a reviewer-facing defect rather than a cosmetic one. Re-tuning the
constant for `ci` would only change which half of the category it is wrong for.

The obvious repair - let high confidence promote a tier - was already tried and
measured as the entire remaining instability. Everything that ships sits in
[0.8, 1.0] because the confidence gate says so, and run-to-run variance is
about 0.08, so any boundary drawn inside that band gets crossed.

## Decision

**Derive severity from (category, reach), where reach is computed by the CLI
and never supplied by an agent.**

Category supplies the kind of consequence; reach supplies its extent. Reach is
computed in `scoring/reach.ts` from literal symbol hits at the reviewed ref,
reusing `namedSymbols` and a path-returning `git grep` alongside the existing
`gitGrep`.

Computing rather than asking follows the rule `scoring/score.ts` already states
for the eligibility score: asking a model to compute this would make the
thresholds unfalsifiable, and the whole point of a threshold is that it can be
checked. It also removes the stability question entirely - a deterministic
search cannot flap between runs, so no appeal to an agent's consistency is
required.

**Reach is measured relative to the changed file, and counts only code.**

- `local` - hits confined to the changed file.
- `component` - hits within the changed file's own directory subtree.
- `repository` - hits in two or more directories beyond that subtree, or a
  repository-wide toolchain file.

**Absent reach reproduces the previous category tier exactly.** No searchable
symbol, no code hits, or a failed search retains the legacy tier. A failed
search is absent, never `local`, matching `checkAbsenceClaim`: a search that
could not run is not an answer.

## Consequences

- A `ci` finding that reaches the repository derives `blocking`; one confined
  to a file derives `nit`. Both are auditable: the search returns its symbols,
  hit paths, counted code paths, directory counts and the ref it searched.
- `question` stops short-circuiting and derives like anything else.
  `SEVERITY_ORDER` ranks it below `nit`, so a question about a build-breaking
  change was rendered under a nit. `severity.ts` already named the reason - a
  question is a speech act rather than a tier - and had no way to express it.
  The interrogative is carried by the wording, which the editor already handles.
- The output contract is unchanged. `SEVERITIES`, `SEVERITY_ORDER` and the
  validator's ordering rule are untouched.
- Reviews get louder for genuinely widespread defects and quieter for narrow
  ones. Whether that trade is set correctly is unmeasured; the boundary between
  `component` and `repository` is calibrated by guess and recorded as such in
  `docs/EVALUATION.md`.
- One `git grep` per named symbol per candidate, capped at twelve symbols, with
  a ten-second timeout.

## Alternatives considered

**Let verified confidence promote within a category.** Rejected on existing
measurement: a first version weakened one tier below 0.85 and that was the
whole remaining instability, at 0.82 against 0.90 and 0.85 against 0.80 on
identical diffs.

**Have the verifier report reach.** Rejected. It reintroduces an agent
judgement on the path severity depends on, and makes the tier unfalsifiable in
exactly the way the eligibility score is deliberately not. Category stability
was measured at 4 of 4 on one diff, which suggests a descriptive field can be
stable - but a computed one needs no such argument.

**Count distinct top-level directories.** Implemented first, then rejected on
measurement against this repository. It is wrong in both directions at once:
`GitHubClient`, referenced from seven code files, read as `component` because
every source file shares one top-level directory, while `deriveSeverity` read
as `repository` because a changelog entry supplied a third directory. Monorepo
layouts - which this reviewer is routinely pointed at - make the first failure
the common one, and prose mentions make the second. Measuring relative to the
changed file is layout-independent; counting only code removes the prose.

**Re-tune the per-category constants.** Rejected: it cannot express a category
whose members genuinely differ in reach, which is the actual defect.
