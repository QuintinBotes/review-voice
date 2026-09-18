---
description: Render the last review as a GitHub draft, and check whether posting is permitted
argument-hint: "--repository <owner/repo> --pr <number>"
allowed-tools: Bash(node:*), Read
---

# Draft a GitHub review

Let `RV` be `node "${CLAUDE_PLUGIN_ROOT}/dist/review-voice.mjs"`.

## 1 - Check the gate first

Run `RV post-check`.

If `allowed` is false, show the reasons verbatim and **stop**. Do not offer a
workaround, do not suggest editing the config, and do not post.

The gate reads what has actually been measured, not what the configuration
says. Per `docs/adr/0007`, posting waits until owner-accepted precision holds
at 0.80 or better over at least 20 labelled findings, with full contract
compliance. There is no override, deliberately - a gate with a bypass is a
suggestion.

If the user asks to post anyway, the honest answer is that the reviewer has not
yet earned it, and that labelling findings with `/review-voice:feedback` is how
it does.

## 2 - Render the draft

Run `RV draft --repository <owner/repo> --pr <number>` with the validated
review on stdin.

Show the preview exactly as printed. That text is generated from the payload
that would be sent - a preview produced separately from what gets posted is a
mock-up, not a preview.

## 3 - Confirm, once, per post

Ask explicitly. No "always allow", no session-wide approval.

Comments only. Never approve, never request changes, never merge, never set a
status. An automated approval is a different product with a different risk
profile.

## Exactly once

Each draft carries an idempotency key derived from the repository, pull request
and diff hash. Record it in the audit log **before** sending, so a retry after
a timeout cannot double-post. A re-review after a force-push has a different
diff hash and is correctly a different post.

## Still not implemented

The posting call itself does not exist yet. This command renders and checks;
it cannot send. That is the current state of `docs/adr/0007`, not an oversight.

## Inline anchors

To post findings against their lines as well as in one block, take the anchors
from the **validated review text**, never from the scored candidates:

```
RV anchors < <validated-output>
```

The candidate's `path` is free text from the analyst; the rendered finding
carries what the verifier actually read, and the two can disagree. On one pull
request the analyst cited
`InvoicePaymentRequest/InvoicePaymentRequestDetail.tsx` and the finding that
shipped, correctly, cited `bankTransfer/BankTransferCard.tsx`. Anchors built
from candidate records would have put two comments on the wrong file.

**Post the validated body as the review summary and attach the inline comments
alongside it.** The single block is what `validate-output` checks and what
`record` stores, so the contract and the corpus stay intact; the inline
comments are an additional rendering of the same findings, not a replacement
for them.

`unanchorable` counts findings the contract accepted that carry no line. Say so
rather than letting an inline comment go missing.
