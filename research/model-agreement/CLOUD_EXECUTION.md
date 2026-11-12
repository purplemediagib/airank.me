# Browser-independent study execution

Owner-authorized 12 November amendment: rounds 12, 14 and 18 November at
10:00 Europe/Gibraltar (09:00 UTC), existing two-hour window and ten-minute
start grace. This does not create extra daily runs.

`amend-schedule` is nonpaid and one-time. It restores the audited activation
snapshot, verifies ledger/receipts, rejects any primary work, and changes only
windows, slot timestamps and expiry. Prior manifests, schedules (in the audit
receipt and immutable snapshots), marker, charges and attempts are retained.

`preflight` uses the existing study storage secret, not browser login or provider
secrets. `cloud-round` performs the same verification before provider requests.
The trusted anchor is the previously verified activation head. New backups
preserve immutable, hash-linked head records. A new runner verifies descent to
that anchor, snapshot hash, ledger integrity, frozen inputs and raw receipt
hashes. Unresolved charges, halt, budget exhaustion, missing ancestors, existing
round activity or incomplete earlier rounds stop execution. No automatic reset,
backfill or retry of an uncertain operation is permitted.

All study operations share a GitHub concurrency group, execute only the reviewed
research branch/commit, and have finite hosted-job deadlines. The independent
native dispatcher must refuse another cloud-round run for the same round. The
hash chain detects corrupt or unrelated snapshots, but cannot detect a malicious
wholesale rollback of the private store to a previously valid state; GitHub's
independent no-replay history guard is therefore required.

No raw answers, prompts, credentials or public artifacts are logged. Provider
pins, the scientific panel, prices, qualification and $40 allocation stay fixed.
OpenAI accounting remains an explicitly labelled estimate, not a hard billing cap.

## 12 November follow-up amendment

Owner approved moving only missed round 1 to 14:00 Europe/Gibraltar
(13:00 UTC) on 12 November, window ends15:00 UTC, ten-minute start grace.
Rounds 2 and 3 remain at10:00 Gibraltar on14 and18 November.
`amend-schedule` now accepts only the prior10am frozen protocol and exactly
this round-one four-hour change. It rejects any existing primary attempt,
preserves qualification receipts, earlier manifests and chained storage history.
No provider call occurs in the amendment or preflight operations.
