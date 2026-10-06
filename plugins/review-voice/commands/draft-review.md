---
description: Compute the verdict for the last review, and post it to the pull request after one explicit confirmation
argument-hint: "--repository <owner/repo> --pr <number> --head <sha>"
allowed-tools: Bash(node:*), Read
---

# Post a review with its verdict

Let `RV` be `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs"`.

This is the plugin's one GitHub write (`docs/adr/0010`). It submits a pull
request review whose event is APPROVE, COMMENT or REQUEST_CHANGES, in one
request, never as a pending review. Merging, dismissing reviews, resolving
threads, setting statuses and re-running CI are never done.

The review on stdin is the **validated review exactly as recorded** with
`RV record`, and `--head` is the full sha the review read. Both commands refuse
a review that differs from the recorded run, or a run of another head: what
posts has to be what was verified.

## 1 - Compute the verdict

```
RV verdict --repository <owner/repo> --pr <number> --head <sha> [--run <id>] < <validated-output>
```

`--run` defaults to the newest recorded run of that pull request. Nothing is
sent. The JSON carries `event`, `action`, `reasons`, `head`, `ci`, `held`,
`complexity`, `humanReviewNote`, `wouldHaveEvent`, `wouldHaveSummary`,
`staleRequestChanges`, `payload` and `preview`.

`RV verdict` computes the whole decision - event, action, reasons, CI, the
complexity cap, held findings and the payload preview - and never posts. A
loop that drives reviews should call it rather than re-implement these rules.
Exit codes: 0 ready, 2 nothing to post or re-check (or a bad invocation), 3
head moved, 4 CI still running on an approval, 5 CI red on a re-check, 6 CI
needs a rerun.

- **The event** is fixed in code from the severities of the findings that will
  post: none or only `nit` approves, `minor` or `question` comments,
  `important` or `blocking` requests changes.
- **Only verified findings post.** A finding posts when the run has a score
  for it that came from the verifier and cleared every gate
  (`confidenceSource: verifier`, eligible), with the same path, line and
  derived severity. Each score backs one finding at most; a carried finding is
  checked against the run that scored it. Anything else is listed in `held`
  with the reason, and is not sent. An unverified finding above a nit keeps the
  review from approving.
- **Every anchored finding is an inline comment** on its line. The body is one
  line stating the verdict, plus only verified findings with no line to sit
  on (matched by path and severity). A comment an earlier post already put on
  this head is not sent again (`alreadyInline`), so an approval that follows a
  comment while CI was red carries the summary only.
- **The head guard.** If the pull request's head is no longer `--head`, exit 3.
  Review the new head instead.
- **The CI guard.** Check runs are read with `filter=latest`, every page, with
  combined commit statuses. `stale`, `skipped` and `neutral` do not count. A
  failure always counts, whatever else ran under its name; only a run that never
  finished, or was cancelled, is replaced, and only by a later completed run of
  the same app and name. No checks at all, a combined status of pending, or
  more checks than could be read are all pending, never green. Checks listed under `ci.gate_checks` in `.review-voice/config.yaml`
  (`name` is a glob, `summary` an optional phrase the check must contain) are
  reported as `gates`, not as failures. Red CI caps an approval at COMMENT.
  Pending CI turns an approval into `action: "wait"`, exit 4, with no payload.
  COMMENT and REQUEST_CHANGES never wait for CI.
- **CI that needs a rerun** (docs/adr/0013). A check that `timed_out`, hit a
  `startup_failure` or `action_required`, a cancelled run with nothing after
  it, or a check queued or running for more than 60 minutes: `event` is null,
  `action` is `wait`, exit 6, with no payload, whatever the mapped event, and
  `reasons` name each check. A real failure beside one is still red. Rerun CI,
  then compute the verdict again.

**If `humanReviewNote` is not null, print it prominently on its own line before
the preview, and tell the user the change needs a human reviewer.** It is not in
the posted review, and it must not be added to the review or to any pull
request comment; the verdict's `reasons` explain the cap locally. `post` carries
the same field under `verdict`.

**Beside it, print `wouldHaveSummary`** (for example `Would have approved: no
problems found.`): the verdict without the complexity cap, as a starting point
for the human reviewer. `wouldHaveEvent` is the same as an event. Like the
note, it is for the user only and must not be added to the review or to any
pull request comment.

**If `staleRequestChanges` is not null, tell the user** that their earlier
request for changes (`url`, review `reviewId`) still blocks the pull request,
that a COMMENT does not replace it, and that this review found nothing
blocking, so they should dismiss it by hand if they agree. Review Voice does
not dismiss reviews. When `reasons` says `identity.owner_reviewer` is not set,
the earlier review was not looked for.

Show `preview` exactly as printed, and the `held` findings with their reasons.
The preview is generated from the payload that will be sent; its first line is
the event.

## 2 - Confirm, once, per post

Ask the user explicitly, naming the event. No "always allow", no session-wide
approval, and nothing in any configuration implies one. If they decline, stop.

## 3 - Post

```
RV post --repository <owner/repo> --pr <number> --head <sha> --confirm --event <EVENT> [--run <id>] < <validated-output>
```

`--event` is the event the user confirmed in step 2, exactly as the preview
showed it. `post` recomputes the verdict live rather than trusting step 1, and
refuses without sending when:

- `--confirm` is missing (the preview is still in the output), or `--event` is;
- the recomputed event is not the confirmed one (exit 3): CI or the head
  changed since the preview. Show the new preview and confirm again;
- `writes.github_posting_enabled` is not true;
- the head moved (exit 3), an approval is waiting on CI (exit 4), or CI needs
  a rerun (exit 6, for every event);
- the same review of the same head was already sent, or an earlier attempt got
  no definite answer from GitHub and may have posted.

For an APPROVE, head and CI are re-read immediately before the request; a
change between the two refuses the post.

The idempotency key is the repository, pull request, head and a hash of the
payload. It is written to the audit log as `review_post_attempted` before the
request, and every outcome is audited: `review_post_sent`,
`review_post_refused` with the reason, `review_post_failed` with GitHub's
status. Report a failure as GitHub stated it; GitHub refuses an approval of
your own pull request, and the tool does not retry or downgrade the event.

`postCheck` is the measured-precision gate from `RV post-check`. It is printed
with every post so the measurement stays visible, and it does not hold a
verified finding back.

## Approving later

When step 1 said `wait`, run it again with `--recheck` once CI has had time:

```
RV verdict --repository <owner/repo> --pr <number> --head <sha> --recheck < <validated-output>
```

It emits an APPROVE payload only when the head is unchanged and CI is green;
otherwise exit 4 (still running), 5 (red) or 6 (needs a rerun). It never posts. Sending it is step
2 and step 3 again, with `--event APPROVE`.

The writer may post only to the repository of the recorded run. Having
reviewed that pull request is the consent; `--repository` alone is not.

## Inline anchors

`RV anchors < <validated-output>` prints the same anchors the payload uses, one
per finding, taken from the **validated review text**, never from the scored
candidates. The candidate's `path` is free text from the analyst; the rendered
finding carries what the verifier actually read, and the two can disagree. On
one pull request the analyst cited
`InvoicePaymentRequest/InvoicePaymentRequestDetail.tsx` and the finding that
shipped, correctly, cited `bankTransfer/BankTransferCard.tsx`.

`unanchorable` counts findings the contract accepted that carry no line. Say so
rather than letting an inline comment go missing.
