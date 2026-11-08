# S21. One bounded reply per own finding

**Phase:** 6 (additions from the 2026-11-08 code review landscape report,
section 5 item 8). **Depends on:** S07 (the owner login reaches
`checkOutcomes` as `CheckOptions.ownerReviewer`, and `decide()` reads the
owner's reject before the poster filter) and S03 (the audit retention rule in
`src/store/retention.ts`). Both are on `main`. Phase 6 runs after S12, so where
S12 has moved a command into `src/cli/`, that module takes the place of
`cli.ts`. **Size:** about 420 source lines (part A about 330, part B about
90), 440 test lines, one new ADR, two ADR amendments; two Orbit runs (part A,
part B). **Risk:** medium. This is a second kind of GitHub write, which the
program's conventions rule out unless the owner admits it (see Non-goals). It
is bounded to a thread this tool started, its text is produced by code from
the recorded run, no model is in the loop, and it sits behind the posting
switch, a confirmation, an idempotency key and audit rows exactly as a review
does. Baseline `main` at `6294511` (S01 to S11 and S13 merged). Line
references verified against that tree with git grep on 2026-11-08; where S12
or S14 moves code, locate it by function name.

## Why

An author who replies to a Review Voice comment with "why?" or "this is
intentional" gets silence. The landscape report (section 4.1 item 3) found
that CodeRabbit, Greptile, Qodo, Gemini, Bito, Sourcery, Devin, Baz and
Macroscope answer questions on their findings and Claude Code Review posts one
follow-up on the next review; Review Voice never replies, and an unanswered
question is the cheapest way for a real finding to be dismissed. The same
report's anti-features set the bound (section 6 items 3 and 12): no chat agent
acting on `@bot` text from any contributor, and no resolving of threads on the
bot's own judgement. Item 5.8 asks for the narrow thing in between, one reply
per own finding, built only from the recorded evidence, never a new claim,
behind the same guards as a review, recorded as an outcome signal, with a
second reply on the same thread refused.

The code is most of the way there, and every piece sits on the read side.

- The outcomes reader already reads every reply under every comment this tool
  posted. `readPull` fetches the pull request's inline comments and the
  GraphQL thread states (`plugins/review-voice/src/store/outcomes.ts:280-293`),
  `matchComments` pairs each stored finding with the root comment it was
  posted as (`:319-348`), `reviewIdsOf` proves that root is this tool's, from
  the audit log or by author and head (`:296-312`), and `decide()` reads the
  replies whose `in_reply_to_id` is the root (GitHub sets it on every reply in
  a thread to the thread's first comment), drops bots, classifies each stance,
  reads the owner's latest `reject` first and then drops the poster's replies
  (`:442-472`, `classifyReply` at `:48-53`). A `reject` becomes a strong
  `dismissed`; a question classifies as `other` and is dropped on the floor.
  S07 put the owner's login in `CheckOptions` (`:219`) and reads it before the
  poster filter, because a review is posted under the owner's own credential
  (ADR 0002), so the poster is usually the owner.
- The thread reader knows what a reply is. `ThreadComment` carries `id`,
  `inReplyTo`, `author`, `createdAt`, `resolved` and `resolvedBy`
  (`src/diff/thread.ts:38-46`), and `raisedByOthers` already uses `inReplyTo`
  against this tool's own comment ids to tell a reply in a thread it started
  from a new point someone raised (`src/publish/post.ts:566`, `:582`). Nothing
  this spec adds needs a new GitHub read.
- The recorded run holds the evidence a reply could quote and nothing outside
  `explain` shows it. Each stored candidate keeps the analyst's `evidence`
  lines (`candidates_json`, read back by `recordedCandidates` at
  `post.ts:524-542`, `Candidate.evidence: string[]` at
  `src/scoring/score.ts:77`), and `applyChallenge` stores the challenger's
  verdict on each score as `challenge: { verdict, line_ok, decisive_evidence,
  reason }` (`src/verify/challenge.ts:268-279`), where `decisive_evidence` is a
  list of `path:line` references the independent challenge confirmed (ADR
  0024). `explain` prints the verifier's and the tie-break's lines
  (`explainCommand`, `src/cli.ts:4152`, `:4305-4320`); the author of the pull
  request never sees any of it.
- The write side is one path by construction. `ReviewWriter.request` admits a
  POST to `REVIEW_PATH` only (`src/github/writer.ts:39`, `:92-99`), and
  `test/post.test.mjs:195-217` scans the source so no other file can issue a
  write. The idempotency memory is `keyBlocked` and `claimKey` over
  `review_post_%` audit rows (`post.ts:626-669`), and retention keeps those
  rows until `purge` (`src/store/retention.ts:151`).

## Outcome

When an author replies to a Review Voice inline comment with a question or a
disagreement, the next `outcomes` pass can post one reply under that comment.
The reply is rendered by code from the recorded run alone, naming the head
reviewed and the `path:line` references the challenger confirmed or the
analyst cited, in a fixed template that adds no claim. At most one reply is
ever posted per finding per run, whoever wrote the last word; the thread is
never resolved, edited or dismissed. Each reply needs
`writes.github_posting_enabled`, a confirmation, an idempotency key and audit
rows, through the same writer with a second path checked in code. Nothing
posts by default: `reply --confirm` is the explicit path, `watch.reply: true`
(default false) is the unattended opt-in, and the GitHub Action never replies.

## Design

### What the thread and outcomes readers already know

The detection uses only what `checkOutcomes` has in hand for each posted
finding: the root comment (`matchComments`), every inline comment on the pull
request (`PullContext.replies`, `outcomes.ts:228-235`), the thread state by
comment id (`PullContext.states`, null when the GraphQL read failed), the
poster's login (`comment.user.login`) and S07's `ownerReviewer`. The
reply is anchored by GitHub on the root's path and line, so the thread reader
sees it as one more `review-comment` by this tool's account with `inReplyTo`
set: `raisedByOthers` ignores it as it ignores every own comment
(`post.ts:572`), `citedLocations` leaves it alone because it expands only
comments with no path (`score.ts:757`), and `check-candidates --thread` treats
it as it treats the root comment at the same location. No reader changes.

### The trigger

`src/store/outcomes.ts` exports a pure function and a new result field:

```ts
export interface PendingQuestion {
  reviewRunId: string;
  findingId: string;
  repository: string;
  pullNumber: number;
  rootCommentId: number;
  path: string;
  line: number;
  askedBy: string;
  askedAt: string;
  stance: 'question' | 'reject';
}

export function replyWanted(
  root: RawComment,
  replies: RawComment[],
  state: ThreadState | null,
  ownerReviewer: string | null,
): Pick<PendingQuestion, 'askedBy' | 'askedAt' | 'stance'> | null;
```

Rules, in order, each returning null when it fails:

1. The thread state is known and the thread is not resolved. An unreadable
   state is not an open thread, and a resolved thread is a conversation the
   author considers closed.
2. The replies under the root are those with `in_reply_to_id === root.id`,
   sorted by `created_at`.
3. No reply under the root is by the poster (`root.user.login`,
   case-insensitive). One reply per thread, ever, whoever wrote it, so a
   person answering from the posting account also counts.
4. The newest reply whose author is not a bot (`isBot`, `outcomes.ts:196`),
   not the poster and not `ownerReviewer` (case-insensitive) decides. The
   owner can run `explain`; a bot asked nothing.
5. Its stance, from `classifyReply(body)` unchanged: `reject` gives
   `'reject'`; `other` gives `'question'` only when a line that is not a
   blockquote contains `?`; `acknowledge`, and `other` without a question
   mark, give null. Silence and agreement are not questions (ADR 0004).

`CheckResult` gains `questions: PendingQuestion[]`, filled in `followRun`
beside the `decide()` call from the same root, the same `context.replies` and
the same `context.states`, so detection costs no request. `CheckOptions`
gains an optional `pullNumber?: number` filter beside `repository`, so the
`reply` command can narrow a check to one pull request; `checkOutcomes` skips
other pull requests before any request. The existing consumers
(`outcomesCommand`, `cli.ts:1573-1650`; `followOutcomes`,
`src/watch/command.ts:410-428`) read `outcomes`, `warnings` and `skipped` and
are unaffected. `outcomes --json` stays an array of outcomes
(`test/outcomes.test.mjs:307` pins it); the text mode prints one extra line per
pending question, `<repo>#<pr> <findingId> <path>:<line> question from <login>
awaiting a reply; run reply --pr <pr>`.

### The reply text

`src/publish/reply.ts` (new) exports a pure renderer:

```ts
export function renderReply(input: {
  head: string | null;
  finding: StoredFinding;
  /** The score at the finding's path and line, as `explain` matches it (cli.ts:4239). */
  score: { challenge?: { verdict?: unknown; decisive_evidence?: unknown } } | undefined;
  /** The recorded candidate at the finding's path and line, from `recordedCandidates`. */
  candidate: { evidence: string[] } | undefined;
}): { body: string; references: string[]; challengeConfirmed: boolean } | null;
```

- References are the challenger's `decisive_evidence` entries when the score
  carries a `challenge` with `verdict === 'confirmed'`; otherwise the
  candidate's `evidence` entries that match the `path:line` form the thread
  reader already recognises (`CITATION`, `score.ts:739`, exported for this and
  otherwise unchanged). Duplicates are dropped, order is the recorded order, at
  most four are kept. A reference whose path contains whitespace, a backtick or
  a dot segment, or is absolute, is dropped, because it goes into a comment
  body as inline code. The absolute case comes from S16, whose challenger may
  cite the reproduction copy under the run directory, which names the
  reviewer's home; S15's evidence block drops the same entries. A reference is also dropped when it alone breaks one of the properties
  below (a path such as `src/done.ts` reads as an acknowledgement, and
  `src/consider.ts` holds a forbidden phrase). With no reference left the
  renderer returns null and nothing is posted: a reply that cannot quote a
  line would be a new claim.
- The body is one fixed template, the same for both stances:

  ```
  Review Voice checked this at a1b2c3d. The claim rests on `src/cart.ts:12` and `src/cart.ts:40`. An independent challenge confirmed it at those lines. This reply is built from the recorded review and is not repeated.
  ```

  The head is the first seven characters of `run.headRef`, or the words "the
  head it reviewed" when the run recorded none. The third sentence appears
  only when `challengeConfirmed` is true. References are joined with commas
  and "and".
- Three properties hold for every rendered body, and a test pins each: it is
  at most 600 characters; the validator's own `findForbiddenPhrases`
  (`src/contract/validate.ts:50`) finds none of
  `DEFAULT_LIMITS.forbiddenPhrases` (`src/contract/limits.ts:74-82`) in it, so
  the posted text obeys the hedge rule the validator enforces on findings; and
  `classifyReply(body)` is `other`, so the outcomes reader and S07's
  calibration can never read this tool's own reply as a dismissal or an
  acknowledgement. This last property is the lock that matters. The reply is
  posted under the owner's credential, and since S07 `decide()` reads the
  owner's replies before the poster filter (`outcomes.ts:460-467`), so the
  poster filter alone does not exclude it. The renderer checks all three on
  the final body and returns null when one fails. The body is passed through
  `redact` before it is sent, as thread text is on the way in.

The wording of the template is an open question for the owner (see
Non-goals); the three properties and the no-new-claim rule hold for any
wording.

### The second write path

`ReviewWriter` (`src/github/writer.ts`) gains:

```ts
/** A reply to one of this tool's own inline comments. Nothing may follow `replies`. */
const REPLY_PATH = /^\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pulls\/([1-9][0-9]*)\/comments\/([1-9][0-9]*)\/replies$/;

async replyToComment(repository: string, pullNumber: number, commentId: number, body: string): Promise<{ id: number | null; htmlUrl: string | null }>;
```

`replyToComment` sends exactly `{ body }` to
`POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies` (GitHub's
"create a reply for a review comment"). `request` admits a POST whose path
matches `REVIEW_PATH` or `REPLY_PATH` and refuses every other method and path
as today, before the network; the allowlist check is unchanged.
`assertReplyBody` refuses an empty body, a body over 600 characters, or a
payload with any key but `body`. The class comment and the `WriteViolation`
text ("writes one thing") are updated to name the two things. The second
POST lives in `writer.ts`, so the source scan at `test/post.test.mjs:195-217`
passes unchanged (it counts POSTs in `client.ts` only and pins the file list).
The refusal list at `test/post.test.mjs:158-178` is extended with
`/pulls/{n}/comments/{id}` (an edit), `/pulls/{n}/comments/{id}/reactions`,
`/pulls/{n}/comments/{id}/replies?x=1`, `/pulls/{n}/comments/0/replies` and
`/issues/{n}/comments/{id}/replies`, and its title becomes "the writer refuses
every path but creating a review or replying to its own comment". The GraphQL
known-query set (`src/github/client.ts:135-143`) is unchanged, so resolving a
thread stays impossible (ADR 0018).

### Posting a reply

`src/publish/reply.ts` also exports the write:

```ts
export interface ReplyOptions {
  db: Database;
  client: GitHubClient;
  repository: string;
  pullNumber: number;
  questions: PendingQuestion[];
  /** Built from the recorded run's repository, as `postReview` builds it. */
  writerFor: (allowlist: string[]) => ReviewWriter;
  confirm: boolean;
  postingEnabled: boolean;
}

export interface ReplyResult {
  question: PendingQuestion;
  status: 'previewed' | 'sent' | 'refused' | 'failed';
  reasons: string[];
  key: string;
  body: string | null;
  reply?: { id: number | null; url: string | null };
}

export async function postReplies(options: ReplyOptions): Promise<{ exitCode: number; replies: ReplyResult[] }>;
```

The audit subject is the pull request, as for a review (`subjectId`,
`post.ts:116-118`). `AuditAction` (`src/store/audit.ts:9-32`) gains
`review_reply_attempted`, `review_reply_sent`, `review_reply_refused` and
`review_reply_failed`. `keyBlocked(db, key, prefix = 'review_post_')` and
`claimKey(db, key, subject, metadata, action = 'review_post_attempted')` in
`post.ts` take the prefix and action, are exported, and keep their behaviour
for reviews (`post.ts:626-669`); `recordedCandidates` is exported too.

Before the loop: when `postingEnabled` is false, one `review_reply_refused`
row with `questions: n` is written and the command exits 2, as `post` does
(`post.ts:701-703`). Then for each question, in order:

1. `runDetail(db, question.reviewRunId)` must exist and its `repository` must
   equal the question's (case-insensitive), else `refused`.
2. The finding is `run.findings` by `findingId`; the score is the one at its
   path and line (`cli.ts:4239`); the candidate is the one at its path and
   line from `recordedCandidates`. `renderReply` returning null is `refused`
   with `no recorded path:line evidence to quote`.
3. The key is `reply:<repository lower>#<pr>:<rootCommentId>`, so it names
   the thread and not the text: a reworded reply to the same thread is the
   same reply. `keyBlocked(db, key, 'review_reply_')` refuses a sent key and
   an attempt with no definite answer, exactly as for a review.
4. Without `confirm` the result is `previewed`, with the body, and a
   `review_reply_refused` row says `no --confirm`, as `post` records
   (`post.ts:749-751`).
5. `claimKey` writes `review_reply_attempted` with `run`, `finding`,
   `rootCommentId`, `askedBy` and `stance` inside the same transaction that
   rechecks the block.
6. `writerFor([run.repository]).replyToComment(...)`. Success writes
   `review_reply_sent` with `key`, `attempt`, `run`, `finding`,
   `rootCommentId`, `replyId`, `url`, `askedBy`, `stance` and `head`. Failure
   writes `review_reply_failed` with `status`, `message` and `uncertain`,
   under the rule at `post.ts:869-882`: refused in code or a 4xx is certain
   and may be tried again; anything else blocks a retry.

Exit codes: 0 when every question was sent, previewed or refused on its key,
1 when a send failed, 2 when posting is off or the invocation is bad. A
refusal on the key is the normal second pass, not an error.

The thread is read by `checkOutcomes` in the same invocation, seconds before
the send, and the key is what stops a double reply; no second read is made
between detection and send. The reply is posted under the token's identity.
`reviewIdsOf` proves the root belongs to this tool's review, not that the
token posted it (an `audit` source checks no login), so the per-thread key,
not rule 3, is what stops a second reply when the token is another account's.

### The `reply` command

```
review-voice reply --pr <number> [--repository <owner/repo>] [--since <Nd>] [--confirm] [--json]
```

Dispatched in `cli.ts` beside `outcomes` (`:5647`). The handler sits beside
`outcomesCommand`, or in a new `src/cli/reply.ts` once S12 has moved
`outcomes` into `src/cli/outcomes.ts`. It loads the config for
`postingEnabled`, `ownerReviewer` and the allowlist as `outcomesCommand`
does, runs `checkOutcomes` with `repository`, `pullNumber` and `since`
(default 30d), then `postReplies` with `writerFor` built from the run's
repository (`cli.ts:1480-1481`) and `confirm: argv.includes('--confirm')`.
Text mode prints one block per question, `<path>:<line> <askedBy> (<stance>)
<status>` and the body; `--json` prints `{ questions, replies }`. `--pr` is
required: a person replies on one pull request at a time, and the watcher is
the many-pull-request path. `help.ts` gains the `reply` entry and the
`outcomes` entry mentions the pending-question line.

### The watcher (part B)

`WatchConfig` (`src/watch/config.ts:2`) gains `reply: boolean`, default
false; `readWatch` (`src/policy/load.ts:502-546`) reads `watch.reply` with
the warning pattern of `watch.post` (`:521-524`). `templates/config.example.yaml`
gains, under `watch:`:

```yaml
  # true answers a question or disagreement under one of this tool's own inline
  # comments with one evidence-only reply per finding, in a pass that posts
  # (--post or watch.post); needs writes.github_posting_enabled. Off by default.
  reply: false
```

and still loads with no warnings (`test/issues-config.test.mjs:39`). The
`config.watch` deep-equal at `test/watch.test.mjs:1073` is extended with
`reply: true` and its yaml with `reply: true`.

`watchCommand` exits 2 at start when `watch.reply` is on and posting is
disabled, with the message pattern at `command.ts:130-133`. `followOutcomes`
(`command.ts:410-428`) returns the `CheckResult`'s `questions` beside the
count it returns today; `runPass` calls `postReplies` with `confirm: true`
(the unattended precedent at `command.ts:384-392`) for the questions whose
repository the client still allows, only when the pass's `post` is true and
`config.watch.reply` is true. The pass appends one line, `replies: N sent, M
refused`, only when N + M is above zero, so the totals lines pinned at
`test/watch.test.mjs:218`, `:237`, `:376`, `:496` and `:695` are unchanged;
with `--json` the line goes through `deps.err`, as the retention line does
(`command.ts:252`). A failed reply never fails the pass; the reviews already
ran. Only pull requests `recentlySentPulls` lists are checked
(`src/store/watch.ts:96-114`, seven days, twenty pull requests), so an older
thread is answered by `reply --pr` or not at all.

### Idempotency memory and retention

`AUDIT_WHERE` (`src/store/retention.ts:151`) becomes
`created_at < ? AND action NOT LIKE 'review_post_%' AND action NOT LIKE 'review_reply_%'`,
and its comment names the reply rows as the second write's memory. Nothing
else about retention changes.

### The outcome signal and the metrics

The reply is recorded as the `review_reply_sent` row keyed to run and
finding; the author's next reply is the outcome signal, read by `decide()` as
today (an `acknowledge` after a changed line is `fixed`, a `reject` is
`dismissed`). `outcomes.ts` exports `replyStats(db): { replied: number;
fixed: number; dismissed: number; fixedRate: number | null }`, joining
`review_reply_sent` rows to `finding_outcomes` by `(run, finding)` and
counting strong outcomes only. `computeMetrics` (`src/evaluate/metrics.ts`,
beside the posted metrics at `:422-445`) adds two goals, `posted_replies` (the count, null when
zero, so `evaluate` prints `no data`) and `replied_fixed_rate`
(`fixed / (fixed + dismissed)` over replied findings, null with none), each
with target `no target` and kind `goal` as `posted_fixed_rate` has, so the
every-metric tests find a target and S23 shows both under "Reported, not
scored".
`docs/EVALUATION.md` "Reported, not scored" lists both. S07's
`compileProposals` (`src/policy/compile.ts:168`) reads `feedback` and
`finding_outcomes`, never audit rows, so a reply is never a calibration signal
by itself.

### The scope block stays as it is

S09's `scopeBlock` (`src/publish/verdict.ts:785`) is pure and built from the
recorded run alone, so two renders of one run are identical. A count of reply
rows written after the run would break that, so the block takes no reply
input and its JSON trailer gains no key. The reply rows and the two metrics
are where replies are counted.

### Documentation

A new ADR, `docs/adr/00NN-one-bounded-reply-per-own-finding.md` (the next
free number at implementation time; 0035 once S14 and S17 have each taken
one after S06's 0032),
records the decision: the trigger, the template rule (code, recorded
references, no model, no new claim), what is never done (no reply to a reply,
no second reply on a thread, no reply without a recorded reference, no reply
to a bot or to the owner, no resolving, editing or dismissing), and how ADR
0007's decisions 1, 2, 3 and 5 apply to each reply (preview, confirmation,
exactly once, audit). `docs/adr/0010-*.md` gains a dated `## Amendment -
<date>` section: "one write path" becomes one writer with two paths checked
in code, the review write unchanged, and "What is still never done" gains
"reply to a reply, or resolve the thread". `docs/adr/0029-*.md` gains a dated
amendment naming `questions`, the reply row and the two metrics (S07 and S14
each add their own dated section; all coexist). `docs/adr/README.md` lists the
new ADR and marks the 0010 and 0029 rows. `docs/THREAT-MODEL.md` section 3
("Since ADR 0010 there is one write", `:119-123`) gains a paragraph: the
second write is bounded to a thread this tool started, its text comes from
code and the recorded run, an injected comment can at most provoke one
templated reply quoting recorded references, and the switch, confirmation,
key and audit apply. `docs/ARCHITECTURE.md` "Posting" (`:1147`) gains a
"Replies" paragraph with the guard order above and "The watcher" (`:1267`)
one sentence; `docs/WATCHER.md` updates `watch` (`:286`), `outcomes`
(`:323`), Configuration (the `watch:` block at `:211`, `reply: false`) and
Security (`:403`, "The writer is unchanged" becomes two checked paths).

### Order against the other market specs

S21 is seventh of S15 to S24 (`GOAL.md`, "Phase 4, the market gaps"), and
runs only after the owner admits the second write path:

- After S15, which strips the evidence block in `matchComments` and adds
  `evidenceBlocks` to the review's `claimKey` metadata. This spec's prefix
  and action parameters keep that call as it is, and the root comment it
  replies under may end with an evidence block.
- After S16, whose challenger may cite an absolute reproduction-copy path,
  which the renderer drops.
- Before S22, which also changes `runPass` in `src/watch/command.ts`; its held
  lines print under each entry's report line, and this spec's `replies:` line
  stays a pass-level line.
- Before S23, which factors the finding lookup out of `postedBreakdown` and
  shows `posted_replies` and `replied_fixed_rate` in its "Reported, not
  scored" table.

## Non-goals

- No reply to a reply, and no second reply on a thread, ever, even after a
  new head. A new head gets a new review, which is the answer to changed code.
- No model anywhere in the reply path, and no prose beyond the template. The
  finding's own text is not repeated; the verifier's and challenger's
  `reason` prose is never posted.
- No resolving, editing or deleting of any comment, no reaction, no status.
- No reply from the GitHub Action (`review --pr` never replies, `action.yml`
  is protected) and no slash command. The `reply` command and the watcher are
  the two callers.
- No reply under a review body, a conversation comment or an unanchored
  finding; only under an inline comment this tool posted.
- No change to `classifyReply`, to the outcome classes, to `decide()`'s rules
  or to S07's activation rule, and no reply count in the S09 scope block.
- Open question for the owner, settled before either run: whether the program
  admits a second write path at all. The README's "Conventions every spec
  inherits" says the single write path of ADR 0010 is not widened, and this
  spec widens it to two checked paths. Without a yes, nothing here runs.
- Open question for the owner: whether a disagreement (`reject`) should draw
  a reply at all, or only a question. The report asks for both; this spec
  implements both behind one switch and the owner may narrow the trigger to
  `question` before the run. Settling it changes rule 5 of the trigger and
  AC-2 only.
- Open question for the owner: the template wording and tone. The three
  pinned properties (600 characters, no forbidden phrase, classifies as
  `other`) and the no-new-claim rule hold for any wording.
- Open question for the owner: whether the watcher may reply unattended at
  all. The spec ships `watch.reply` default false; dropping part B's watcher
  half leaves `reply --confirm` as the only caller.

## Acceptance criteria

Part A:

- AC-1. `ReviewWriter.replyToComment` sends exactly `{ body }` to
  `/repos/{r}/pulls/{n}/comments/{id}/replies`; `request` refuses, before the
  network, a POST to `/pulls/{n}/comments/{id}`,
  `/pulls/{n}/comments/{id}/reactions`, `/pulls/{n}/comments/{id}/replies?x=1`,
  `/pulls/{n}/comments/0/replies`, `/issues/{n}/comments/{id}/replies` and a
  repository outside its allowlist; an empty body, a body over 600 characters
  and a payload with any other key are refused; the list at
  `test/post.test.mjs:158-178` is extended and retitled as the design says;
  `test/post.test.mjs:195-217` passes unchanged.
- AC-2. `replyWanted` returns `question` for a non-bot, non-poster, non-owner
  reply with stance `other` and a `?` outside a blockquote, `reject` for a
  rejecting reply, and null for an acknowledgement, an `other` without a
  question mark, a bot, the poster, the owner login, a thread with any poster
  reply already under it, a resolved thread and a null state; `checkOutcomes`
  returns `questions` from the same reads, proved by the request list of the
  fake at `test/outcomes.test.mjs:45-98` being unchanged for a run with a
  question; `CheckOptions.pullNumber` narrows the check before any request;
  `outcomes --json` is still an array of outcomes (new cases in
  `test/outcomes.test.mjs`).
- AC-3. `renderReply` quotes the challenger's `decisive_evidence` when the
  challenge is `confirmed`, else the candidate's `path:line` evidence entries,
  at most four, deduplicated, in recorded order, dropping unsafe paths (an
  absolute path included), and
  returns null with none; a reference such as `src/done.ts:3` or
  `src/consider.ts:3` is dropped, and a run whose only reference is one of
  them renders null; the body names the first seven characters of the
  head, carries the challenge sentence only on a confirmed challenge, is at
  most 600 characters, `findForbiddenPhrases` finds nothing in it, and
  `classifyReply(body)` is `other` for both stances; the sent body equals
  `redact(body).text` (`test/reply.test.mjs`, new).
- AC-4. `postReplies`: posting disabled refuses with one audit row and exit 2
  before any read of the store; no `confirm` previews, writes
  `review_reply_refused` and sends nothing; a confirmed reply writes
  `review_reply_attempted` before the request (proved as
  `test/post.test.mjs:239-255` proves it for a review) and `review_reply_sent`
  with the metadata the design lists after; the same question again is refused
  on the key with no request; a 5xx writes `review_reply_failed` with
  `uncertain: true` and blocks a retry while a 4xx does not; the writer's
  allowlist is the run's repository (`impl.allowlists`, `test/post.test.mjs:116-133`)
  (`test/reply.test.mjs`).
- AC-5. `reply --pr N [--repository] [--since] [--confirm] [--json]` exists,
  is dispatched beside `outcomes`, and has a `help.ts` entry; `outcomes` text
  mode prints the pending-question line (`test/reply.test.mjs`); `AuditAction`
  carries the four reply actions; a `test/retention.test.mjs` case shows a
  back-dated `review_reply_sent` row surviving `applyRetention` beside the
  `review_post_sent` row at `:89-101`.
- AC-6. A test asserts that the new ADR exists, that `docs/adr/README.md`
  lists it, that a dated `## Amendment - ` section of `docs/adr/0010-*.md`
  names `replyToComment`, and that `docs/THREAT-MODEL.md` names
  `replyToComment` (none of them does today); `docs/ARCHITECTURE.md`
  "Posting" documents the guard order (reviewer-checked).

Part B:

- AC-7. `watch.reply` (default false) is read, a bad value warns and keeps
  false, the `test/watch.test.mjs:1073` literal is extended,
  `config.example.yaml` carries `reply: false` and loads with no warnings; a
  `--once --post` pass with `watch.reply: true` and one pending question posts
  one reply through a wrapper around the watch test's `fakeGitHub` that serves
  the thread and the `replies` endpoint (the shared helper stays unedited),
  prints `replies: 1 sent, 0 refused` (through `h.err` with `--json`), and a
  second pass posts nothing on that thread; with `watch.reply` false, or
  without `--post`, nothing is posted and the totals lines at `:218`, `:237`,
  `:376`, `:496` and `:695` are unchanged; `watch.reply: true` with posting
  disabled exits 2 at start (new cases in `test/watch.test.mjs`).
- AC-8. `evaluate` reports `posted_replies` (null with none) and
  `replied_fixed_rate` (strong outcomes of replied findings only, null with
  none) as goals (`test/reply.test.mjs`); a test asserts that a dated
  `## Amendment - ` section of `docs/adr/0029-*.md` names `review_reply_sent`
  and that the 0029 row of `docs/adr/README.md` mentions replies (neither
  holds today, although 0029's S07 amendment already says "reply");
  `docs/EVALUATION.md` lists both metrics (reviewer-checked).
- AC-9. With `verdict.scope_block: true`, `computeVerdict` returns the same
  payload body and the same idempotency key for a pull request with one
  `review_reply_sent` row as with none (`test/reply.test.mjs`).
- AC-10. `docs/WATCHER.md` (`watch`, `outcomes`, Configuration, Security) and
  `help.ts` (`watch`, `outcomes`) describe the setting and the line
  (reviewer-checked).
- AC-11. `npm run verify` passes with the rebuilt bundle committed.

Stop point for the two-run split: part A is AC-1 to AC-6 and AC-11; part B is
AC-7 to AC-11.

## Allowed paths

`plugins/review-voice/src/github/writer.ts`, `plugins/review-voice/src/publish/post.ts`
(`keyBlocked`, `claimKey`, `recordedCandidates`),
`plugins/review-voice/src/publish/reply.ts` (new),
`plugins/review-voice/src/scoring/score.ts` (export `CITATION` only),
`plugins/review-voice/src/store/outcomes.ts`, `plugins/review-voice/src/store/audit.ts`,
`plugins/review-voice/src/store/retention.ts`, `plugins/review-voice/src/watch/command.ts`,
`plugins/review-voice/src/watch/config.ts`, `plugins/review-voice/src/policy/load.ts`
(`readWatch`), `plugins/review-voice/src/evaluate/metrics.ts`,
`plugins/review-voice/src/cli.ts` (`reply`, `outcomes`, the dispatch), and
once S12 has moved `outcomes`, `plugins/review-voice/src/cli/outcomes.ts` and
`plugins/review-voice/src/cli/reply.ts` (new) in its place,
`plugins/review-voice/src/help.ts`, `plugins/review-voice/templates/config.example.yaml`,
`docs/adr/00NN-*.md` (new), `docs/adr/0010-*.md`, `docs/adr/0029-*.md`,
`docs/adr/README.md`, `docs/ARCHITECTURE.md`, `docs/WATCHER.md`,
`docs/EVALUATION.md`, `docs/THREAT-MODEL.md`, `test/**`,
`plugins/review-voice/dist/review-voice.mjs`.

The only existing tests that may be edited are `test/post.test.mjs:158-178`
(its title and its refused-path list) and the `config.watch` deep-equal and
its yaml at `test/watch.test.mjs:1073`.

## Orbit goal, part A

```
Implement part A of docs/agent-handoffs/professionalisation/S21-bounded-reply-per-finding.md
in this repository. S03 and S07 are already on the base branch, as are S15
and S16 (see the spec's "Order against the other market specs"), and S12 may
have moved cli.ts into src/cli/, so locate code by function name. Read the
spec first, then docs/adr/0010-review-verdict-posting.md, docs/adr/0007-comment-posting.md,
docs/adr/0018-read-only-graphql-thread-state.md,
docs/adr/0029-posted-findings-are-followed-to-an-outcome.md,
docs/ARCHITECTURE.md ("Posting"), plugins/review-voice/src/github/writer.ts
(REVIEW_PATH, request, assertPayload), plugins/review-voice/src/publish/post.ts
(keyBlocked, claimKey, recordedCandidates, the audit rows and the uncertainty
rule in postReview), plugins/review-voice/src/store/outcomes.ts (readPull,
matchComments, followRun, decide, classifyReply, isBot, CheckOptions,
CheckResult), plugins/review-voice/src/verify/challenge.ts (the challenge field
stored on each score), plugins/review-voice/src/contract/limits.ts
(forbiddenPhrases), plugins/review-voice/src/contract/validate.ts
(findForbiddenPhrases), plugins/review-voice/src/scoring/score.ts (CITATION)
and test/post.test.mjs (the writer refusal tests and the source scan at lines
195-217).

Outcome: ReviewWriter gains REPLY_PATH and replyToComment, sending exactly
{ body } to /repos/{r}/pulls/{n}/comments/{id}/replies, with request admitting
the two checked paths and refusing everything else before the network;
outcomes.ts exports replyWanted and a PendingQuestion type, checkOutcomes
returns questions from the reads it already makes and accepts a pullNumber
filter, and outcomes prints a pending-question line in text mode; a new
src/publish/reply.ts exports renderReply (challenger decisive_evidence first,
else the candidate's path:line evidence, at most four, dropping an absolute
or unsafe path and a reference
that alone holds a forbidden phrase or does not classify as other, null
with none, a fixed template that names the head, is at most 600 characters,
in which findForbiddenPhrases finds nothing and which classifies as other) and
postReplies (posting switch, per-thread
key reply:<repo>#<pr>:<rootCommentId>, preview without confirm, attempted row
before the request, sent or failed row after, the same uncertainty rule as
postReview, writer allowlist from the run's repository); keyBlocked and
claimKey take a prefix and an action and recordedCandidates is exported;
AuditAction gains the four review_reply_ actions and retention keeps them; a
reply command exists with a help entry; the new ADR, the ADR 0010 amendment,
the README rows, THREAT-MODEL.md and ARCHITECTURE.md are written. Acceptance
criteria AC-1 to AC-6 and AC-11 of the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". No model call,
no new GitHub read, no GraphQL change, no reply to a reply, nothing posted
without --confirm, nothing on by default. The only existing test you may edit
is test/post.test.mjs lines 158-178 (title and refused-path list). Do not
edit scripts/, .github/, CHANGELOG.md or the manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them);
no hardcoded identities (use your-github-login style placeholders in tests).
Write the ADR in the format of the existing ones at the next free number and
add it to docs/adr/README.md; amendments are dated "## Amendment - <date>"
sections in the existing style.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```

## Orbit goal, part B

```
Implement part B of docs/agent-handoffs/professionalisation/S21-bounded-reply-per-finding.md
in this repository. Part A is already on the base branch. Read the
spec first, then plugins/review-voice/src/watch/command.ts (runPass,
followOutcomes, the postReview call with confirm: true, the retention line),
plugins/review-voice/src/watch/config.ts, plugins/review-voice/src/policy/load.ts
(readWatch), plugins/review-voice/src/publish/reply.ts (postReplies),
plugins/review-voice/src/store/outcomes.ts (postedStats as the shape for
replyStats), plugins/review-voice/src/evaluate/metrics.ts (the posted metrics),
docs/EVALUATION.md ("Reported, not scored") and docs/WATCHER.md.

Outcome: WatchConfig gains reply (default false), readWatch reads watch.reply
with a warning on a bad value, config.example.yaml documents it and still
loads clean, and the config.watch deep-equal in test/watch.test.mjs is
extended; watch exits 2 at start when watch.reply is on and posting is
disabled; a pass that posts and has watch.reply on hands the questions
followOutcomes found to postReplies with confirm: true and prints
"replies: N sent, M refused" only when there was one (stderr with --json),
leaving every existing totals line unchanged; outcomes.ts exports replyStats
and evaluate reports posted_replies and replied_fixed_rate as goals, null with
no data; the S09 scope block and the idempotency key are unchanged by reply
rows (scopeBlock is not edited); ADR 0029 is amended and the index marks it;
WATCHER.md, EVALUATION.md and help.ts are updated. Acceptance criteria AC-7 to
AC-11 of the spec must hold.

Scope: only the paths the spec lists under "Allowed paths". watch.reply stays
false by default and replies only in a pass that posts. The only existing test
you may edit is the config.watch deep-equal and its yaml at
test/watch.test.mjs:1073. Do not edit scripts/, .github/, CHANGELOG.md or the
manifests. Add no dependency.

Conventions: follow CONTRIBUTING.md and the surrounding style; comments
explain why; no em or en dashes anywhere (the identity guard rejects them);
no hardcoded identities. Amendments are dated "## Amendment - <date>"
sections in the existing style.

Proof: run `npm run build` after any change under plugins/review-voice/src.
Run the test files you add or change with `node --test <file>`; Orbit runs
unit-tests, typecheck, build, dist-check, identity-guard and action-pins on
the whole tree.
```
