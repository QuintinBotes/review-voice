# S19. Ticket intent from linked GitHub issues

**Phase:** 6 (market additions, from the 2026-11-08 research report, section
5 item 6). **Depends on:** S09 (the scope block and `RecordedChecks`), and
through it S02 and S08. **Size:** about 180 source lines, 240 test lines,
four agent prompts; one Orbit run, two with the stop point below. **Risk:**
low while off; medium once a repository turns it on, because a second
untrusted text enters the intent extractor, held to the same verbatim-quote
check as the description. Baseline `professionalisation/specs-2` on `main`
after S03 (`11e6f69`); line numbers are as of that commit. S08 and S09 have
since merged (`origin/main` at `c2b16a6`), and the S09 names below
(`RecordedChecks`, `recordedChecks`, `storedChecks`, `describeChecks` in
`src/store/runs.ts`, `scopeBlock` in `src/publish/verdict.ts`,
`test/scope-block.test.mjs`) were checked there. Verified against the code on
2026-11-08. Where S09 or S12 has moved a function, locate it by name
(`threadCommand`, `checkIntentCommand`, `recordCommand`, `scopeBlock`).

## Why

The review reads what the author wrote about the change and nothing about
what the change was asked to do. `readThread` fetches the pull request and
keeps its description as a thread comment of kind `description`
(`plugins/review-voice/src/diff/thread.ts:132-138`); `descriptionOf` pulls it
back out (`src/intent.ts:208-216`); the `intent-extractor` quotes it and
`check-intent` refuses any quote that is not a whole sentence of it
(`intent.ts:139-148`, `src/cli.ts:4293-4330`). A pull request that says only
"Closes #12" has, for the extractor, no intent at all. The requirements live
in issue 12, which nothing reads.

A requirement gap is the defect a diff cannot show. The research report's
section 4.1 item 9 lists ticket intent as table stakes, and six surveyed
reviewers (Rovo, Bito, Qodo, CodeAnt, Baz, Sourcery) check acceptance
criteria or linked tickets. All of them read Jira or Linear as well as GitHub.
The owner's decision today is GitHub only (ADR 0002, `CONTRIBUTING.md`), so
this spec reads only the issues a pull request closes in its own repository.

The seams exist. The client is GET-only inside the allowlist
(`src/github/client.ts:261-272`, `:236-255`), already reads the issue
endpoints of the pull request itself (`thread.ts:211-213`, `:231-233`), and
ADR 0002 names issues among the read scopes. `readThread` already treats an
optional read that fails as a local warning and goes on (`thread.ts:147-157`).
`parseIntent` already recomputes a CLI-owned field, `heading`, so re-checking
its own output passes and a made-up value never does (`intent.ts:245-250`).
`loadConfig` honours `REVIEW_VOICE_CONFIG`, so a setting read by the `thread`
command comes from the base commit on a driver run (S01, ADR 0031 amendment;
`src/policy/load.ts:672-679`, `src/review/driver.ts:271-291`).

## Outcome

With `review.linked_issues: true`, `thread` also reads the issues the
description closes with a GitHub closing keyword, in the same repository,
through the existing client, and writes them to `thread.json`. The
`intent-extractor` may quote a whole sentence of an issue body exactly as it
quotes the description; `check-intent` verifies every quote against the one
source it came from and records which issue it came from. A requirement an
issue states and the change does not meet surfaces as a `question` at most,
posted only when the verifier establishes its premises and the challenger
confirms it, as for every posted finding (ADR 0024). The scope block names
the issues read. Nothing else about the posted review changes, and with the
default `false` nothing changes at all.

## Design

### Setting

`review.linked_issues: false`, a boolean read in `loadConfig` beside the other
`review` readers (`load.ts:802-809`) into a new `LoadedConfig.linkedIssues:
boolean` (`load.ts:19-78`). A value that is not a boolean warns
`review.linked_issues must be true or false; using false.` and keeps the
default, the pattern `readVerdictPolicy`'s `enabled` uses (`load.ts:360-366`).
`templates/config.example.yaml` documents it under `review:` after `mode`,
as `linked_issues: false` with a two-line comment saying what is read and that
a quote from an issue is checked like one from the description, so the example
still loads with no warnings (`test/issues-config.test.mjs:38-47`).

### Reading linked issues

`src/diff/thread.ts` exports
`closingReferences(description: string, repository: string): { numbers: number[]; beyond: number[]; skipped: string[] }`.
It finds GitHub's closing forms in the description text, ignoring case: one
of `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`,
`resolves`, `resolved`, an optional colon, whitespace, then `#N`,
`owner/repo#N` or a URL whose path is `/owner/repo/issues/N`. A reference
whose `owner/repo` is not `repository` (compared without case) goes to
`skipped` as its matched text and is never requested, even when that
repository is allowlisted, because naming a pull request is the consent for
reading it and nothing else (`thread.ts:124-126`). `numbers` keeps first
mention order, drops duplicates and stops at 5; a same-repository number past
the fifth goes to `beyond`, in the same order, so the cap is named rather than
silent. A bare `#N` with no keyword is not a reference (open question below).

`readThread` gains `linkedIssues?: boolean` (default false). When true, after
the pull request GET at `thread.ts:132-138`, it runs `closingReferences` over
the redacted description body, so the CLI and the agent read the same text,
and for each number sends
`GET /repos/${repository}/issues/${n}` with `retryRateLimits: false`, as an
optional read. The result is kept as

```ts
interface LinkedIssue {
  number: number;
  /** Redacted, never quoted by the extractor; context only. */
  title: string;
  /** Redacted first, then cut at 10000 characters, so a cut never hides part of a secret from redaction. */
  body: string;
  state: string;
  url: string;
  truncated?: true;
}
```

written as `linkedIssues: LinkedIssue[]` on the thread file, after `reviews`.
A result carrying a `pull_request` key is a pull request, not an issue, and is
skipped silently (this also covers a description that closes its own number).
A result with no body, or an empty one, is kept with `body: ''` so the scope
block still names it as read. A GET that throws adds the warning
`Could not read issue #N (<message, cut at 160>); continuing without it.`
and is skipped; every `skipped` reference adds
`Skipped <text>: a linked issue outside <repository> is not read.`, and a
non-empty `beyond` adds `Read the first 5 linked issues; not read: #6, #7.`
All go where thread warnings go today, stderr and the `--out` summary
(`cli.ts:377`, `:386-396`), never to GitHub. When the option is false the
key is absent, so every existing thread assertion passes unchanged. Title and
body pass through `redact` exactly as every comment does (`thread.ts:106-109`).

`threadCommand` (`cli.ts:362-405`) passes
`linkedIssues: repositoryConfig()?.linkedIssues === true` (`cli.ts:1372-1378`)
and adds `linkedIssues: <count>` to the `--out` summary when the option is
on. No new flag, so `test/issue-52-command-help.test.mjs` is untouched; the
`help.ts` `thread` entry (`help.ts:72-86`) gains one line naming the setting.
The driver's `thread` call (`driver.ts:439`) and `commands/review.md` step 1a
(`review.md:197`) are unchanged, since the config decides.

### Quotes from an issue

`src/intent.ts` exports `linkedIssuesOf(thread: unknown): { number: number; body: string }[]`
beside `descriptionOf`, returning `[]` when the key is absent.
`parseIntent(value, description, issues = [])` builds one `Sentences` per
source with `sentencesOf`, the description first and then each issue in
order. For each statement, `excerptOf` runs against the description; when
that fails and issues were given, it runs against each issue in turn, and the
first source that accepts the quote (as given or widened to its sentence)
wins. A statement whose quote came from an issue gains `issue: <number>`. The
`heading` is computed from the winning source. A `deliberate` statement's
`reason` must come from the same source as its `quote`; one that does not is
dropped as
`statements[i].reason must be in the same source as its quote`, because an
issue's requirement paired with a description's excuse is not one author's
choice.

`issue` joins the accepted keys at `intent.ts:231` and is recomputed, never
trusted, exactly as `heading` is (`intent.ts:245`), so re-checking this
command's output passes and a supplied `issue` on a description quote
disappears. When issues were given and no source accepts the quote, the
problem reported is the one from the first source the quote occurs in (so a
fragment of an issue sentence still reads `... not part of one`); when it
occurs in none, the not-found message becomes
`<name> does not occur in the pull request description or in a linked issue`.
That message starts with the current one, so the patterns at
`test/intent-capture.test.mjs:73` and `:80` still match it. Without issues
every message is unchanged. `MAX_INTENT_STATEMENTS`,
`MAX_QUOTE`, `MIN_QUOTE_WORDS` and `intent.schema.json` are unchanged; the
schema governs the extractor's raw output, which never carries `issue`.

`checkIntentCommand` (`cli.ts:4293-4330`) reads `linkedIssuesOf` from the same
thread file at `:4301` and passes it to `parseIntent`. The no-description exit
2 at `:4307-4310` stands. A description that is empty cannot carry a closing
reference, so there is never an issue without a description, and the driver's
skip at `driver.ts:598` is right as it is.

### Prompts

`prompts.intentPrompt` (`src/review/prompts.ts:93-100`) gains an optional
third argument, the issue numbers read from `thread.json`; when non-empty it
adds one line naming them and the `linkedIssues` entries as a source to quote
from, so the existing two-argument call at `driver.ts:601` keeps working and
the driver passes the numbers.

`agents/intent-extractor.md`:

- The untrusted-input block (`:12-17`) says the linked issues are written by
  anyone with a GitHub account, not even necessarily the author, and are as
  untrusted as the description.
- "Input" (`:19-22`) adds the `linkedIssues` entries, each an issue the
  description closes, with its `number`, `title` and `body`. The title is
  context, like the pull request title, and is never quoted.
- "What to extract" (`:24-69`) adds one paragraph. A sentence of an issue body
  that states what the change is expected to do or not do is extracted with
  the same kinds, most often `goal` or `qa`, and the same rules (whole
  sentence of exactly one source, verbatim, four words, 600 characters).
  Never join a description sentence to an issue sentence. The CLI records the
  issue the quote came from; do not write it. Headings, labels, checklists
  with no text and template boilerplate in an issue have no intent, as in the
  description.

`agents/diff-analyst.md`, after the stated-intent list (`:157-184`), one
paragraph. A statement with `issue` is a requirement from an issue the author
set out to close. When the head does not meet it, the gap is not covered by a
`non-goal` or `deliberate` statement, and a search of the changed scope plus
the entry points that reach the changed code (the completeness rule's bound)
finds no code that does it, raise one `question` with `intent_ref`, anchored
on the changed line nearest the requirement's subject, asking whether the
requirement is meant to land in this change. A requirement gap is a
`question` at most, never a higher tier, because an issue is often closed
across several pull requests, and `question` is the tier for what the author
can answer and the analyst cannot (`:263-276`, `:342-343`). Code in the
change that contradicts an issue requirement with an exact location, a
concrete failure mode and evidence is an ordinary candidate under "What
qualifies", not a question.

`agents/evidence-verifier.md`, after the stated-intent paragraphs
(`:216-232`). For a candidate whose `intent_ref` names a statement with
`issue`, find the quote in that issue's entry under `linkedIssues` in
`thread.json`, not in the description, and read the whole sentence around it.
For a `question` about a requirement gap, `premises_verified` requires both
that the sentence, with its conditions and qualifiers, states the requirement,
and that a search at the head for the behaviour found nothing; a requirement
already met at the head, in the change or elsewhere, is a rejection.

`src/verify/challenge.ts:109` labels the cited statements as quoted from the
pull request description; its `IntentStatement` (`challenge.ts:25-31`) gains
`issue?: number`, and when a cited statement has `issue`, the label says
`linked issue #N` instead, and `agents/challenger.md:32` says the quotes may
come from either. Nothing else in the challenge changes.

### The scope block

S09's `RecordedChecks` gains `issuesRead?: number[]`. `record` reads the
`--thread` file already (`cli.ts:2930-2952`, for follow-ups) and, when it
builds `checks` (`recordedChecks`, which needs `--evidence` or `--symbols`),
sets `issuesRead` from `linkedIssues[].number`, `[]` when the key is absent.
`storedChecks` keeps a stored row without it valid and leaves it absent, so a
run recorded before this spec never claims it read no issues. `scopeBlock`
adds the prose line ``Linked issues: `#12`, `#15` read for intent.`` when the
list is non-empty and omits it when empty, as S09 omits zero counts; each
number is inline code, as S09 renders check names, so GitHub neither links it
nor adds a reference to the issue's timeline. The JSON trailer gains a
top-level `"issues": [12, 15]`, placed after S09's `checks` and before S17's
optional `families`, which stays the last key, and `"issues": null` when `checks` is null or
has no `issuesRead`, as S09 writes `checks: null`, so an unrecorded run shows
no data and never a zero.
`explain`'s "Checks" line (`describeChecks`) prints the numbers. An older row
has no `checks` and renders `not recorded` as S09 specifies. S09's trailer
test pins the key set by deep equality (`test/scope-block.test.mjs:154`,
`:176` and `:297` on `c2b16a6`), so it is extended with `issues` and the pull
request names it.

### Documentation

`docs/ARCHITECTURE.md`: the table row at `:18` says the extractor quotes the
description and, when enabled, the issues it closes; "The GitHub client"
(`:918-955`) gains a paragraph on the linked-issue read (closing keywords,
same repository, at most five, GET only, a failed read stays local);
"Posting" (`:1035`) names the scope-block line. `docs/THREAT-MODEL.md:23-25`
adds a linked issue to the texts an attacker can write. `docs/ACTION.md`
gains one line under its workflow: the minimal `permissions` block grants
`contents: read` and `pull-requests: write` only, so with
`review.linked_issues: true` a private repository's workflow also needs
`issues: read`, else every issue read fails, stays a local warning and the
review goes on without it. `help.ts` and `config.example.yaml` as above.
`PRIVACY.md:12` lists what GitHub ingestion
reads and needs "and, when `review.linked_issues` is on, the title and body
of each issue a pull request closes"; `PRIVACY.md` is outside Orbit's allowed
paths, so either add it to `scope.allowed_paths` for this run or make that
line a follow-up by hand, as S03 did.

No ADR is amended. The read is a GET inside the allowlist under ADR 0002's
rule and ADR 0018 leaves REST GET-only; the stage graph of ADR 0022 is
unchanged, since `intent` still runs `intent-extractor` then `check-intent`
(`src/review/stages.ts:39`); no write is added (ADR 0010). The decision of
which issues count is recorded in `docs/ARCHITECTURE.md`.

### Order against the other market specs

S19 is fifth of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"):

- After S15, whose `clean` in `thread.ts` strips the evidence block; this
  spec's changes to `readThread` leave that strip in place.
- After S16, which adds sections to `agents/evidence-verifier.md` and
  `agents/challenger.md` and rows to `challengePrompt`; this spec's
  paragraphs and the `linked issue #N` label go beside them.
- After S17, which adds the optional `families` trailer key; `issues` goes
  before it.
- Before S24, which edits the same `test/scope-block.test.mjs` literals and
  adds `held.belowTier`; its literals then also carry `issues`.

## Non-goals

- No Jira, Linear or any platform but GitHub (owner's decision, ADR 0002,
  `CONTRIBUTING.md`).
- No issue comments, only the body; no issues from another repository, even
  an allowlisted one.
- No second GraphQL query. GitHub's sidebar "Development" links
  (`closingIssuesReferences`) are visible only through GraphQL and would be a
  second `KNOWN_QUERIES` entry reviewed as a security change under ADR 0018.
  Open question for the owner: closing keywords only (this spec) or the
  sidebar links too, in a later spec.
- Open question for the owner: whether a bare `#N` mention with no closing
  keyword should count. This spec says no, because "see #12 for background"
  is not a requirement of this change.
- No posted text above `question` for a requirement gap; no new write, no
  change to the validator or the findings contract.
- No new metric. `evaluate` is unchanged; the scope block names the issues
  read and nothing counts them.
- No change for a repository that leaves the setting at its default.

## Acceptance criteria

- AC-1. `closingReferences` returns the numbers for each keyword, with and
  without a colon, in `#N`, `owner/repo#N` and URL form, ignoring case, in
  first-mention order, without duplicates and at most five, with a sixth and
  seventh same-repository number in `beyond`; a reference to another
  repository is in `skipped` and not in `numbers`; a bare `#N` and a keyword
  with no reference return nothing (`test/linked-issues.test.mjs`, new).
- AC-2. `readThread` with a fake fetch shaped like
  `test/issue-43-thread-resolution.test.mjs:27-34` and `:65`: with the option
  off, no `/issues/N` path is requested and the result has no `linkedIssues`
  key; with it on, each referenced issue is requested once as GET, a result
  carrying `pull_request` is skipped, a 404 adds the specified warning and
  skips, a token in a body comes back as `[REDACTED:...]`, a body over 10000
  characters is cut with `truncated: true`, a cross-repository reference and a
  sixth reference are never requested and each is named in its specified
  warning (`test/linked-issues.test.mjs`).
- AC-3. `review.linked_issues` is read into `LoadedConfig.linkedIssues`, a
  non-boolean warns with the specified text and keeps false
  (`test/linked-issues.test.mjs`), and the shipped example config, now
  carrying the key, still loads with no warnings (`test/issues-config.test.mjs`
  passes unchanged).
- AC-4. `check-intent`, with a thread file carrying one linked issue: a quote
  that is a whole sentence of the issue body is kept with `issue: N`; one from
  the description has no `issue`; a supplied `issue` on a description quote is
  removed; a quote in neither source is dropped with the message starting
  `quote does not occur in the pull request description`; a `deliberate`
  statement whose `reason` is in the other source is dropped with the
  specified message; re-checking the command's own output passes; every
  existing test in `test/intent-capture.test.mjs` passes unchanged
  (`test/linked-issues.test.mjs`).
- AC-5. A driver test shaped like `test/review-driver.test.mjs:391-411`, with
  `fakeGitHub` (`:78-114`) extended to serve `/repos/<repo>/issues/N`: with
  `review.linked_issues: true` in the run's config, `thread.json` carries the
  issue, the intent prompt names it, `/issues/N` was requested once, and the
  recorded run's `checks.issuesRead` is `[N]`; with the default config no
  `/issues/` path is requested and `issuesRead` is `[]`
  (`test/review-driver.test.mjs`).
- AC-6. `agents/intent-extractor.md`, `agents/diff-analyst.md` and
  `agents/evidence-verifier.md` each contain `linkedIssues` and
  `agents/challenger.md` contains `linked issue` (a test greps for each);
  `challenge --emit-prompts` labels a statement with `issue` as from
  `linked issue #N` (`test/linked-issues.test.mjs`; `test/challenge.test.mjs`
  passes unchanged).
- AC-7. With one recorded issue the scope block carries the `Linked issues`
  line with the number in inline code and the trailer carries
  `"issues":[N]`; with none read the line is absent and the trailer carries
  `"issues":[]`; a run with no `checks`, and a stored S09-era `checks` row
  without `issuesRead`, carry `"issues":null`; the idempotency key is
  unchanged in every case (`test/scope-block.test.mjs`, its three trailer
  deep-equals extended).
- AC-8. `help.ts` (`thread`), `config.example.yaml`, `docs/ARCHITECTURE.md`
  (`:18`, "The GitHub client", "Posting"), `docs/THREAT-MODEL.md` and
  `docs/ACTION.md` (`issues: read`) are updated (reviewer-checked); the
  `PRIVACY.md` line is made or filed as a follow-up.
- AC-9. `npm run verify` passes with the rebuilt bundle committed.

Stop point for a two-run split: run one is the setting, the read, the
`check-intent` change and the prompts (AC-1 to AC-6, with AC-5 asserting
`thread.json` and the prompt only, and AC-9); run two is the scope block and
the documents (the `issuesRead` half of AC-5, AC-7, AC-8, AC-9).

## Allowed paths

`plugins/review-voice/src/diff/thread.ts`, `plugins/review-voice/src/intent.ts`,
`plugins/review-voice/src/cli.ts` (`thread`, `check-intent`, `record`,
`explain`), `plugins/review-voice/src/policy/load.ts`,
`plugins/review-voice/src/review/driver.ts`, `plugins/review-voice/src/review/prompts.ts`,
`plugins/review-voice/src/verify/challenge.ts`, `plugins/review-voice/src/publish/verdict.ts`
(`scopeBlock`), `plugins/review-voice/src/store/runs.ts` (`RecordedChecks`,
`recordedChecks`, `storedChecks`, `describeChecks`),
`plugins/review-voice/src/help.ts`, `plugins/review-voice/agents/intent-extractor.md`,
`plugins/review-voice/agents/diff-analyst.md`, `plugins/review-voice/agents/evidence-verifier.md`,
`plugins/review-voice/agents/challenger.md`, `plugins/review-voice/templates/config.example.yaml`,
`docs/ARCHITECTURE.md`, `docs/THREAT-MODEL.md`, `docs/ACTION.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`. `PRIVACY.md` only when the
owner adds it to `scope.allowed_paths` for this run.

## Orbit goal

```
Implement docs/agent-handoffs/professionalisation/S19-ticket-intent-from-linked-issues.md
in this repository. S09 is already on the base branch, as are S15, S16 and
S17 (see the spec's "Order against the other market specs"), so locate code by
function name. Read the spec first, then plugins/review-voice/src/diff/thread.ts
(readThread, clean, the optional GraphQL read's failure handling),
plugins/review-voice/src/intent.ts (descriptionOf, sentencesOf, excerptOf,
statementOf and how heading is recomputed), the thread and check-intent
handlers in plugins/review-voice/src/cli.ts, plugins/review-voice/src/github/client.ts
(get and assertAllowed), plugins/review-voice/src/policy/load.ts (the review
block readers and configFile), plugins/review-voice/src/review/prompts.ts
(intentPrompt), plugins/review-voice/agents/intent-extractor.md,
docs/adr/0002-github-auth-model.md and docs/adr/0018-read-only-graphql-thread-state.md.

Outcome: a review.linked_issues setting, default false, read into
LoadedConfig; an exported closingReferences that finds GitHub closing-keyword
references to issues of the same repository, at most five, and names
cross-repository ones as skipped; readThread, when the option is on, reads each
one with GET /repos/<repo>/issues/<n> through the existing client, skips a
pull request, redacts and then caps the body, warns locally on a failed read,
a cross-repository reference and any reference past the fifth, and writes
linkedIssues to thread.json, with the key absent when the option is off; the
thread command takes the setting from the config the run reads;
parseIntent accepts an issues list, verifies each quote against the one source
it came from, records issue on a quote from an issue and recomputes it like
heading, and drops a deliberate reason from another source; check-intent
passes the issues from the thread file; intentPrompt names the issues read;
the extractor, analyst, verifier and challenger prompts carry the paragraphs
the spec gives, with a requirement gap a question at most and posted only
when its premises are verified; the challenge prompt labels a quote from an
issue as such; record fills checks.issuesRead and the scope block carries the
Linked issues line, numbers in inline code, and the issues trailer key, null
when not recorded; the documents, docs/ACTION.md included, are updated. All
nine acceptance criteria in the spec must hold. If one run cannot hold
everything, stop at the spec's stop point with every check green and say
which half is next.

Scope: only the paths the spec lists under "Allowed paths". The setting stays
off by default; the only new GitHub reads are GETs of same-repository issues
inside the allowlist; add no GraphQL query, no GitHub write and no agent
tool. Do not touch validate-output, the findings contract, the verdict or the
idempotency key. The only existing tests you may edit are
test/scope-block.test.mjs, whose trailer deep-equals gain the issues key, and
test/review-driver.test.mjs to extend fakeGitHub; every test in
test/intent-capture.test.mjs and the
thread tests must pass unchanged. Do not edit scripts/, .github/, CHANGELOG.md
or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; agent files
keep their untrusted-input blocks and sections; comments explain why; no em
or en dashes anywhere (the identity guard rejects them); no hardcoded
identities, so test issues use synthetic repositories, logins and text.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
