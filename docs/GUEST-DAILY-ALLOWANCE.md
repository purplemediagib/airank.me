# Two free checks per rolling 24 hours

Owner-approved change: increase the public guest allowance from one to **two**
scan admissions per rolling 24 hours for the same keyed IP-derived visitor
fingerprint. Changing language or domain does not create a new visitor allowance.
The domain limit remains **five per rolling seven days**, shared across visitors.

The common rate guard and public capabilities use the same constants. Prepare,
preview and scan admission enforce the same visitor/domain rule. Both public and legacy free scan
admissions now check counters and insert job/profile/rate-event rows in a write
transaction; concurrent submissions across either route cannot take the same
last visitor or domain slot. Legacy CAPTCHA validation stays before admission,
and network work never runs while holding the transaction. Identical public-check scan retries remain idempotent and do not
consume another allowance. All existing rate history is retained: a visitor with
one recent scan can use one additional slot after this release is deployed.

No new environment variable, migration or data reset. No CAPTCHA, budget ledger,
$100 emergency ceiling, global paid-provider daily limit, authenticated dashboard
behavior or staging-only test switch changes. Existing legacy guest submissions
use the same common limit; paid signed-in tracking remains unchanged.

## Rollout

Only the **API image** needs updating for this delta. Monitoring worker, dedicated
legacy content worker, and Google connector logic are unchanged. Updating API does
not retire an old content worker; follow the separate retirement instructions.
Check public capabilities reports `guestScansPerDay: 2` before the second test.
This does not authorize spoofing visitor identity or deleting/resetting history.

No exact reset timestamp or Retry-After metadata is added. The rolling window is
based on recorded admission timestamps, not midnight and not scan completion.
