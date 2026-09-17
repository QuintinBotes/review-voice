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
| Candidate set agreement | Measured, published, and not yet targeted |

#### Candidate set agreement

Two reviews of the same diff do not produce the same findings. `RV evaluate`
reports the Jaccard overlap by `path:line` across every diff reviewed more than
once, so this is measured rather than assumed.

The observed figure on a real pull request reviewed twice was **2 of 8, an
agreement of 0.25**: one run found six findings, the other four, and they
shared two. Severity stability was measured and fixed across three releases
while this went untracked, and for a reviewer it is the more consequential
variance. Which findings exist at all matters more than what tier they carry.

No target is set, because there is no defensible one yet and inventing a number
would be worse than publishing the measurement. What it means in practice:

**A single review run is a sample, not the answer.** Running a review twice on
a change that matters is a reasonable thing to do, and the second run finding
something the first did not is expected behaviour rather than a defect.

Location rather than wording is the identity, because the editor rewrites
prose: two runs naming the same defect at the same line are the same finding
however they phrase it. Lines within three of each other count as one location,
matched pairwise rather than bucketed, since a comment can anchor at 174 in one
run and 176 in the next and a fixed bucket puts a hard edge somewhere for that
pair to fall across.

A run recorded without `--diff-file` carries no diff identity and is excluded.
Every run the shipped pipeline recorded used to be in that state, all colliding
under the hash of the empty string, so the metric compared unrelated pull
requests and reported their disagreement as this reviewer's variance. It fell
further the more work was recorded, which is worse than no number at all.

These two carried targets of 2 and 5 from when the output contract capped
findings at five. It no longer does: a review reports everything that survives
verification, and ordering rather than omission is what protects the reader. A
run that correctly finds nine defects in a large change was failing a target
asking it to find two.

## What has actually been measured

Published so the claims can be checked rather than taken. These come from one
test campaign against three pull requests in a large private TypeScript
repository, across plugin versions 0.2.1 to 0.8.0. That is a real workload and
a small sample, and both halves of that sentence matter.

| Measurement | Result |
|---|---|
| Scorer reproducibility, same inputs, 0.7.2 against 0.8.0 | max difference 1.48e-10 over 14 candidates |
| Scorer noise, two runs of one version on identical input | up to 1.35e-7 |
| Category stability, two runs of one diff | 4 of 4 identical |
| Derived severity stability, same two runs | 4 of 4 identical, while the analyst's own requested severity differed on 3 of 4 |
| Category values outside the schema enum | 0 of 8 |
| Contract compliance | 5 of 5 outputs passed `validate-output` first try |
| Exact no-findings string | 3 of 3 |
| Candidate set agreement, two runs of one diff | 0.60 by location, 1.00 by finding identity |
| Scorer reproducibility, 0.9.1 against 0.9.2 | max difference 1.71e-10, four consecutive releases with no contract move |

Every reproducibility figure above compares **identical batches**. A score is not
a property of a candidate alone: novelty is measured against what the same review
has already kept, so making one candidate eligible costs its neighbours novelty.
A comparison over different batches would measure the batch rather than the
scorer.

The severity row is the one worth reading twice. Its historical category-based
derivation held the tier steady on the same diff even when the analyst's own
judgement of severity moved. The current derivation keeps that stable category
and adds deterministic CLI-computed reach rather than restoring an
agent-supplied severity judgement.

### Reach calibration

Reach is now computed by the CLI from literal symbol hits at the reviewed ref,
not reported by an agent. Spread is measured **relative to the changed file**:
hits confined to it are `local`, hits within its own directory subtree are
`component`, and hits in two or more directories outside that subtree are
`repository`. Repository-wide toolchain files are treated as wide regardless.

Two properties of that measure were established by measurement on this
repository rather than chosen:

| Symbol | Under top-level-directory counting | Relative to the changed file |
|---|---|---|
| `deriveSeverity` (6 hits, 2 of them prose) | `repository` - a changelog entry supplied the third directory | `component` |
| `GitHubClient` (8 hits, referenced from 7 code files) | `component` - everything shares one top-level directory | `repository` |

Counting distinct top-level directories was wrong in both directions at once.
It is inert in the monorepo layouts this reviewer is pointed at, where every
source file sits under one `packages/` or `plugins/` root, and it is inflated
by prose, where a symbol named in a changelog counts as spread. Only code is
counted now, and depth in the tree is never used.

Two limits are known and not yet closed.

**Reach is measured at the base ref**, which is right for a modified symbol -
its existing callers are what the change puts at risk - and empty for a new
one. The module fallback below covers the new-symbol case; absent reach still
never invents a tier.

**The symbol source is now the diff.** `namedSymbols` exists to find things to
check for absence, where a broad net is cheap, and reach wants the opposite.
Symbols are taken from the `+` and `-` lines of the changed file's hunks when
`score --diff-file` is given, and `symbolSource` records which source was used.
A symbol on a context line is what the change is near, not what it changed.

That closes the case containment could not: a finding whose point is that some
symbol is the wrong referent names that symbol, and it is genuinely in the
file, so "does the file contain it" cannot tell the two apart.

The base-ref limit is narrowed rather than removed. A symbol the change
introduces still has no spread at base, but when no touched symbol exists there
the changed file's own module name stands in - a new symbol in a widely
imported file carries that file's blast radius. Reported as `moduleFallback`.

The remaining boundary - that one neighbouring directory is a component
relationship and two or more is the repository - is **calibrated by guess**. No
run has measured it, so it is recorded here as a starting point rather than
presented as evidence. An unsearchable or failed search deliberately retains
the legacy category tier instead of guessing that a finding is local.

### Precedent alignment is close to a constant, and the fix is shadowed

`RV status` reports the problem itself: on one corpus 40 of 60 owner events had
no file anchor. An unanchored summary matches every candidate equally, and with
owner weighting applied it surfaces regardless of topic.

The consequence is not a weak signal but a constant one. `matchStrength` is
normalised to the best hit in each candidate's own result set, so when the same
unanchored summaries are retrieved for every candidate, every candidate gets the
same alignment. On a live run all eight findings drew the same three precedents
and the gate rejected nothing. Owner alignment carries 0.25 of the final score
and repository alignment 0.15, so 0.40 of it is a fixed addition compressing the
range available to the four terms that discriminate - the same shape as
`evidenceQuality` scoring 1.000 on every candidate, which was diagnosed and
fixed at a third of the weight.

Excluding anchor-less precedents is the fix, and it is **not yet live**.
Computed on the shapes these runs produced, it moves the final score by:

| Precedents | Alignment before | After | Final-score impact |
|---|---|---|---|
| 3 owner, weight 0.6 | 0.8581 | 0.5000 | −0.0895 |
| 3 owner, weight 1.0 | 0.9526 | 0.5000 | −0.1131 |
| 2 owner, weight 0.45 | 0.7109 | 0.5000 | −0.0527 |

Against a threshold of 0.68 that is large enough to delete findings that pass
today. The gate's own history is the argument for not guessing a new one: 0.74
was arithmetic about a distribution change and was wrong, and 0.68 was measured
and replaced it. A second round of arithmetic would repeat the mistake.

So every score breakdown now carries an `anchored` block - what the score would
be, and whether eligibility would flip - while the gate keeps using the current
computation. `/review-voice:explain` shows it. The switch is a measurement
waiting on real runs, not a decision waiting on an opinion.

### The headline gate has no data

`owner_accepted_precision`, the ≥ 80% target this document opens with, reports
**no data**. It is computed from findings labelled through
`/review-voice:feedback`, and nothing has been labelled.

What exists instead is weaker and worth stating exactly: during testing, six
findings were verified by hand, posted to live pull requests, and fixed by their
authors. That is evidence the reviewer finds real defects. It is not the
measured precision gate, because it counts no dismissals and was not collected
through the feedback loop that would.

Until findings are labelled in normal use, the precision claim is a design
intent with a measurement path, not a result. Reporting it as anything else
would be the over-claiming this document exists to prevent.

`RV status` now counts unlabelled findings and says how to label them, because a
gate that silently reports no data is indistinguishable from one that is passing.

This is the honest limit of version 1.0. Everything measured above was
established by hand, one pull request at a time, by a reader who read the code.
That does not scale, and a release that cannot tell you whether the next one
reviews better or worse is a real exposure. The instrument exists; it has no
readings yet.

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
