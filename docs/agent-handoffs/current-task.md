# Current task — M1.1 Output contract validator

**Milestone:** M1 (Phase 1, fixed-policy concise reviewer)
**Risk:** medium — it defines the contract every later stage targets
**Baseline:** `main` at the time of branching

## Goal

Implement `review-voice validate-output`: the hard gate that enforces Review
Voice's output contract. It reads a review result as JSON on stdin, validates
it, and exits non-zero with structured, actionable errors when it fails.

This is deliberately first. It is the piece that turns the product's central
claims — at most five findings, 40 words each, 180 words total, exactly
`No actionable findings.` when nothing qualifies — from prompt requests into
enforced guarantees. The specification's own targets of 100% word-limit and
100% no-findings compliance are only reachable because this exists.

## Scope

Allowed files:

- `plugins/review-voice/src/contract/*.ts` (new)
- `plugins/review-voice/src/cli.ts`
- `plugins/review-voice/dist/review-voice.mjs` (rebuilt artifact)
- `test/contract.test.mjs` (new)
- `docs/ARCHITECTURE.md` (validator section only)
- `CHANGELOG.md`

## Non-goals

- Diff acquisition, context resolution, storage, agents, static evidence.
  Those are M1.2 onward and must not appear in this change.
- Any GitHub access.
- Any network access.

## Acceptance criteria

1. Rejects more than 5 findings.
2. Rejects any finding whose prose exceeds 40 words.
3. Rejects total prose exceeding 180 words.
4. Rejects a finding not matching ``[severity] `path:line` — text``.
5. Rejects an unknown severity.
6. Rejects forbidden hedge phrases, matched on word boundaries, case-insensitively.
7. Rejects two findings at the same `path:line`.
8. Requires the empty case to be exactly `No actionable findings.` — no
   trailing whitespace, no alternative wording, no markdown.
9. Reports every violation in one pass, not just the first: the editor agent
   needs the full list to retry usefully.
10. Exit 0 valid, 1 invalid, 2 malformed input.
11. Word counting is documented and total-word accounting is consistent with
    per-finding accounting.

## Commands

```
npm run typecheck && npm test && npm run build && npm run check:dist
```

## Return format

Files changed, tests run and outcomes, assumptions, risks, deviations.
