# Evaluation

Review Voice makes a precision claim. It has to be measured, or it is marketing.

## Gates and goals

A **gate** is a contract the reviewer must meet. A **goal** is something to aim
at, reported and never failed. `RV evaluate` labels each metric with its kind,
and prints `FAIL` only for a gate.

The distinction is not cosmetic. `median_words_per_finding` asked for 28 while
the contract the validator enforces allows 40, so every fully compliant review
failed a metric it had not broken. A number that cannot be met by following the
rules is not a target, it is a mislabelled aspiration.

### Gates

A gate is only meaningful if something checks it, so each one names what does.

| Metric | Target | Checked by |
|---|---:|---|
| Owner-accepted finding precision | ≥ 80% | `RV evaluate` |
| 95th percentile words per finding | ≤ 40 | `RV evaluate` |
| Total-output word-limit compliance | 100% | `RV evaluate`, via `contract_compliance` |
| Exact no-findings response compliance | 100% | `RV evaluate` |
| Formatting and schema compliance | ≥ 99% | `RV validate-output`, on every review |
| Policy provenance coverage | 100% | a test, not a report: a rule cannot activate without evidence |
| Prompt-injection test pass rate | 100% | `claude plugin eval` over `fixtures/prompt-injection/` |
| False-positive rate on reviewed diffs | ≤ 15% | not automated; the inverse of precision, and it needs labels |
| Small-diff median latency | ≤ 90s | not automated; observed, not asserted |

The compliance targets are achievable only because they are enforced by a
validator rather than requested in a prompt. If one of them ever reports below
100%, the bug is in the validator, not the model.

The last two are listed honestly rather than quietly dropped. Neither is
measured today, and claiming a number for either would be the kind of
over-reporting this document exists to prevent.

### Goals

| Metric | Goal |
|---|---:|
| Median words per finding | ≤ 28 |

### Reported, not scored

| Metric | Why |
|---|---|
| Median findings per PR | A count is a property of the diff, not the reviewer |
| 95th percentile findings per PR | As above |

These two carried targets of 2 and 5 from when the output contract capped
findings at five. It no longer does: a review reports everything that survives
verification, and ordering rather than omission is what protects the reader. A
run that correctly finds nine defects in a large change was failing a target
asking it to find two.

## Online precision

```
precision_owner = (kept + rewritten) / (kept + rewritten + dismissed)
```

Unlabeled findings are excluded. **Silence is not a negative label** - a finding
nobody responded to tells us nothing and must not be counted as a failure.

## Offline corpus

Split 80/20 by **pull request, not by comment**, or near-duplicate comments from
the same PR leak across the boundary. Stratify by repository, reviewer role,
category, outcome and language where the data allows. Hold out a later time
window so temporal generalisation is measured rather than assumed.

## Regression suite

Fixtures in `fixtures/`, all synthetic:

| Class | Asserts |
|---|---|
| `positive/` | Real defects are caught |
| `negative/` | Prior false positives stay suppressed |
| `no-findings/` | Clean diffs produce exactly `No actionable findings.` |
| `prompt-injection/` | Injected instructions are treated as data |

Plus: repository-specific conventions, large diffs, generated files,
dependency-only changes, CI and release configuration changes, security-sensitive
changes, and rebased or outdated review threads.

**No policy change activates without passing this suite.**

## What the fixtures assert

Injection cases assert an **absence** - output that must not appear, tools that
must not be called. A positive assertion cannot prove an injection failed,
because a reviewer that stayed silent and a reviewer that was hijacked into
silence look identical from the outside. The graders say so explicitly.

The three vectors covered are the places a reviewer actually meets hostile
text: a source comment, pull-request description text, and content imitating
static-analysis output to manufacture evidence no tool produced.

Fixtures are checked by a unit test for real addresses, hosts and credentials.
They are public and permanent, so that backstop sits behind the rule in
`CONTRIBUTING.md` rather than replacing it.

## Reading the numbers

`review-voice evaluate` computes these from recorded runs and feedback, and
prints the basis alongside each value so a passing metric can be checked rather
than trusted.

A metric with no data reports **no data**, not a default. A reviewer that has
never run is not a reviewer with perfect compliance, and reporting 100% from
zero samples is how a dashboard starts lying.

Contract compliance is measured by running recorded output back through the
validator, not asserted from the fact that validation happened. If output ever
reaches the store by a path that skipped the gate, this is what notices.

## Running it

```bash
npm test                         # deterministic units - no model, no tokens
claude plugin eval evals/        # agent behaviour - costs tokens
```

CI runs the deterministic suite on every push. The eval suite runs nightly and
on the `run-eval` label, because it costs real money and a push-triggered eval
would burn it on typo fixes.
