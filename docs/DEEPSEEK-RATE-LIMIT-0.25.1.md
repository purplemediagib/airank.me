# DeepSeek rate-limit recovery — 0.25.1

Deploy the API and worker images built from this release's merged commit. The
existing release workflow also publishes content and Google images; neither
needs updating for this fix. No database migration is added (latest remains
app-022). The seven-day Pro signup trial and plan enforcement are retained.

## Bunny configuration

Add this variable to every monitoring worker, using the same value on all replicas:

`PROVIDER_CONCURRENCY_JSON`

```json
{"deepseek":2,"kimi":3,"default":6}
```

These are also the code defaults if the variable is absent. Values must be
integers from 1 to 8. Partial maps keep the named defaults; `default` controls
other providers. Invalid configuration fails startup rather than silently
removing the caps. The existing `MONITORING_CONCURRENCY` remains the global
ceiling and can be lower (its default is 2). Do not increase it just to deploy
this fix. Counts are shared through the task database across monitoring workers;
executing and collecting tasks both occupy slots. A saturated provider does not
block another provider's queued tasks. This cap covers tracked monitoring, not
the separate sequential quick-scan or benchmark jobs.

Remove `OPENROUTER_MAX_TOKENS` from API and worker if it is still set. Its global
override would replace per-model defaults. Keep the existing DeepSeek model,
Exa search setting, API keys, and `API_BUDGET_CONFIG_JSON`. No price, daily cap,
Google Cloud, or Lovable environment change is required. Existing recommended
`MONITORING_PROVIDER_TIMEOUT_MS=180000` and run timeout can remain unchanged.

Restart/redeploy API and worker and verify `/healthz` reports version `0.25.1`
and the expected build revision. The worker startup event includes
`provider_concurrency`. For consistent accounting and provenance, update both
services; every worker replica must run the new image for the shared caps to
apply consistently.

## Behaviour

- Shared HTTP handling retries explicit HTTP 429 responses for direct APIs and
  OpenRouter: at most **three total HTTP attempts per request**. Respect
  `Retry-After` seconds or HTTP dates; otherwise wait 2s then 6s plus up to 25%
  jitter. The brief's 15s third delay would require a fourth attempt, so it is
  intentionally omitted. Stop earlier if the original timeout cannot accommodate
  the delay. Never shorten a server-supplied delay to fit the timeout.
- Each retry stays inside the same task, lease and budget reservation. No new
  daily call or monetary reservation is made for a rejected HTTP request. The
  existing separately reserved Claude continuation and AI Overview supplier
  recovery still retain their own bounds and share the overall adapter deadline.
- Do not replay ambiguous network errors, timeouts, HTTP 200 error/partial
  output, token truncation, 402 payment failures, other status codes or completed
  tasks. The optional end-of-run requeue is not enabled, keeping retries bounded.
  Existing terminal failures remain historical; run a fresh check to measure
  recovery. Consumer scraper job submission/polling is unchanged.
- DeepSeek requests use `provider.allow_fallbacks=true`, `sort="throughput"`
  and a default `max_tokens=4096`. Existing `require_parameters=true` and
  `max_price` ceilings remain enforced for fallback hosts of the same model.
  Other model token/routing defaults remain unchanged.
- Evidence and safe logs include `request_attempts` and `rate_limit_retries`.
  Exhausted HTTP 429s remain `RATE_LIMITED`; upstream limits can still occur.
  DeepSeek's new request profile is `deepseek-throughput-4096-v1`, separating
  these observations from historical collection groups. No historical evidence
  is rewritten; actual HTTP response metadata takes priority for old queued runs.

## Verification after deployment

Run a fresh check including DeepSeek, Kimi and another provider. Confirm DeepSeek
evidence shows `max_tokens_requested=4096`, and retry recovery can show
`request_attempts` 2 or 3 with one task/reservation. Use a bound Unix-millisecond
deployment timestamp in this read-only query:

```sql
SELECT json_extract(e.payload,'$.status') AS status,
       json_extract(e.payload,'$.meta.failure_code') AS failure_code,
       json_extract(e.payload,'$.meta.request_attempts') AS attempts,
       count(*) AS total
FROM mon_evidence e JOIN mon_tasks t ON t.id=e.id
WHERE t.provider='deepseek' AND e.observed_at > ?
GROUP BY status,failure_code,attempts;
```

Check the rate of `RATE_LIMITED` failures and also `OUTPUT_TOKEN_LIMIT`: 4,096
tokens can be insufficient for some reasoning-heavy answers. A truncated answer
remains excluded and is not automatically repeated. Offline tests simulate
upstream responses and database concurrency; they cannot guarantee live provider
availability or zero 429 failures. No paid provider calls are made by the tests.

Reference: [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
and [Retry-After guidance](https://openrouter.ai/docs/api_reference/errors-and-debugging).
