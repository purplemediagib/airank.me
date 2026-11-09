# Bounded tracked-answer recovery

This candidate is based on worker revision `57868b97a58d1a3d175295433c097bf239c3c000`,
not the older `main` branch. It preserves the economical answer prompt, guest Kimi
route, signup notification code and existing provider model settings. It does not
change a model, price table, aggregate budget, guest allowance or database schema.

## Behaviour

Set `MONITORING_RECOVERY_ENABLED=true` on the monitoring worker to opt in. It is
off by default and reported by the worker configuration diagnostic. The opt-in
only affects monetary-reserved tracked OpenRouter and direct Claude tasks.

- One fresh recovery sequence at most for an output limit, empty answer, settled
  request timeout, selected transient HTTP 5xx failures, or Claude's explicit
  transient search-tool error. Authentication, payment, invalid input, refusal,
  unknown network failures, and exhausted rate limits are not repeated.
- On output-token exhaustion, the recovery allowance doubles up to 16,384 tokens
  and the configured model context limit. Mistral's 12,000 default can rise to
  16,384; DeepSeek's 4,096 to 8,192; Meta's 4,000 to 8,000. Existing explicit
  token settings determine the actual starting values. No retry is made if the
  allowance is already at its maximum. Other failures reuse the initial tokens.
- The first request retains `MONITORING_PROVIDER_TIMEOUT_MS`. Recovery gets up
  to the greater of that timeout and 180 seconds, capped at 300 seconds. Both
  attempts and backoff share a lease capped at ten minutes and the original run
  deadline. Very long first timeouts can leave less recovery time.
- Recovery is permitted only after the first call has settled. A watchdog
  timeout with an unresolved request is terminal. An expired/crashed task is
  never replayed, and ownership/project state is checked immediately before a
  recovery request. A settled provider timeout can still be charged upstream.
- Final metrics use only the complete final answer. Failed/truncated text and
  citations are never appended to a successful retry or treated as complete.
  Complete uncited answers and Google's absence of an AI Overview retain their
  existing meaning; neither is a reason to spend again.
- Diagnostics record the retry policy, initial failure, attempts, total HTTP
  requests, numeric usage and known total cost. Unknown costs remain unknown.
  No prompts, credentials, or arbitrary provider error text are logged.

Google AI Overviews already reserves two supplier requests. Its adapter now
shares that same maximum of two across explicit transient HTTP failures and
temporary supplier status codes, rather than retrying supplier codes only.
There is no outer Google retry and no increase in its reservation. Ambiguous
transport timeouts, rate limiting, auth/payment errors and `no_overview` are
not replayed. This adapter improvement does not require the recovery opt-in.

## Costs and limits

Both sequences are conservatively reserved **before the first request**, using
the existing configured prices and context/search ceilings. Claude may use its
existing one continuation in each sequence: up to four paid HTTP requests, all
reserved. OpenRouter's existing rejected-429 retry limit is unchanged.

The extra sequence counts toward the existing daily call cap. Unused recovery
reservations are retained, not refunded. If either the daily monetary budget or
call budget cannot cover the whole sequence, the task is budget-blocked without
making a provider request. Enabling recovery can therefore reduce the number
of tasks admitted per day; do not silently raise the aggregate limits.

The prompt's $0.10 target is an instruction, **not a hard spending ceiling**.
Prices/context limits are operator-provided, and their accuracy still matters.
No production price/budget settings were inspected or changed while preparing
this patch, and no live paid test was performed.

## Rollout and rollback

1. Verify the current worker revision, image digest and nonsecret settings in
   Bunny. This candidate must not replace a newer deployment without comparing
   its changes. Record the existing image/digest and recovery setting.
2. Wait for the exact commit's CI and isolated worker candidate publication.
   The workflow tests Node 22/24, builds all runtime targets, publishes only the
   worker candidate and verifies its pulled immutable digest against source.
   It never deploys or calls providers. Do not merge this release branch into
   `main` without reconciling its older service-specific release history.
3. Review existing `API_BUDGET_CONFIG_JSON`, token/timeout settings and the
   resulting reservation estimates. Preserve provider choices, keys, price
   ceilings, run deadlines and aggregate caps.
4. Deploy only the verified worker candidate to the existing monitoring worker,
   preserving all other settings, and opt in with
   `MONITORING_RECOVERY_ENABLED=true`. No migrations or API deployment required.
5. Confirm `/healthz` revision, `/readyz`, configuration and normal worker logs.
   Validate the next authorized collection: recovered counts, initial/final
   failure codes, reservation use and budget-blocked counts. Retries cannot
   guarantee a successful provider response. Do not rerun historical failed or
   already successful tasks automatically.

To stop future recovery, set `MONITORING_RECOVERY_ENABLED=false` and restart the
worker. Already admitted tasks retain their immutable reservation. To roll back
code, restore the recorded prior worker image/digest and settings. Do not remove
evidence/reservations or drop tables. The prior published candidate is
`ghcr.io/purplemediagib/airank.me/worker:candidate-sha-57868b97a58d1a3d175295433c097bf239c3c000`,
digest `sha256:14988d36430e9775cb5036c812d618746ddbadcd35c8d6be15be9a505db2d2e1`;
its current deployment status must be reverified in Bunny.
