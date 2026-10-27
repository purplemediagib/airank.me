# Mistral and Google AI Overviews recovery — 0.23.4

Deploy the API and monitoring worker from the same release commit. No database migration, Google OAuth connector change, content container change or Google Cloud Console change is required for this fix. Google AI Overviews uses DataForSEO, independently of the GA4/Search Console OAuth connector.

## Behavior

- Mistral OpenRouter models default to 12,000 output tokens, including reasoning. The request asks for an answer under about 600 words, permits two search uses, three results per search and six total results. Other OpenRouter models keep their existing defaults. Truncated answers still fail, without a paid retry.
- The request and budget reservation share the exact prompt, output limit and search limits. The additional length instruction counts toward the input byte limit.
- New Mistral routes and actual response metadata carry `mistral-concise-search-v1`. Analytics keep those measurements separate from historical Mistral collection methods while retaining complete-answer metric semantics. Previously queued calls that execute the new request record the actual method in their result metadata. Historical answers are not rewritten.
- AI Overviews retries once after four seconds for explicit DataForSEO task/API-body codes `40101`, `50000`, `50001`, `50301`, `50302`, `50303`, `50401` or `50402`. It reserves two requests before the first call. It does not retry authentication, payment, rate/concurrency limits, invalid requests, `50100`, `50304`, HTTP errors, transport timeouts or valid SERPs with no overview. Ambiguous outcomes are never replayed.
- The retry shares the original total timeout, including locale lookup and backoff. The deadline is checked again after backoff. Diagnostics retain request attempts, initial/final supplier codes and the sum of reported attempt costs, without supplier messages.
- Terminal failures and deadline-expired tasks remain historical. Start a fresh check after deployment; this release does not automatically resubmit them.

DataForSEO documents `40101` as a search-engine error after its own internal retries, and notes failed requests can still be billable. It is not the concurrency-limit code (`40209`). Therefore this release does not change concurrency based on the supplied `40101` evidence.

## Bunny environment changes

On **both API and monitoring worker**:

1. Remove `OPENROUTER_MAX_TOKENS` if set, especially if it is `8192`. A global override takes precedence over all per-model defaults; leaving it set prevents Mistral using 12,000.
2. Set `MONITORING_PROVIDER_TIMEOUT_MS=180000` to allow three minutes per tracked-provider task, still bounded by the run deadline. This setting applies to all tracked providers. `OPENROUTER_TIMEOUT_MS` is not read by this runtime.
3. Set `MONITORING_RUN_TIMEOUT_MS=86400000` (24 hours). If already set to that value, keep it. This is the supported maximum and applies to newly created runs; `RUN_DEADLINE_MS` is not a runtime setting. Existing run deadlines are not extended.
4. Keep `MAX_DAILY_PROVIDER_CALLS=unlimited` and `API_BUDGET_CONFIG_JSON.dailyUsd=null` if daily caps should remain disabled.
5. Keep Mistral's model and search engine identical in the routing and budget variables. Use the one-line values below if they match the deployed model selection.

`OPENROUTER_MODELS_JSON`:

```json
{"deepseek":"deepseek/deepseek-v4-pro","meta_ai":"meta/muse-spark-1.3","mistral":"mistralai/mistral-large-4-0","kimi":"moonshotai/kimi-k3"}
```

`OPENROUTER_SEARCH_ENGINES_JSON`:

```json
{"gemini":"native","grok":"native","deepseek":"exa","meta_ai":"native","mistral":"exa","kimi":"exa"}
```

Use the complete, single-line [API_BUDGET_CONFIG_JSON](PROVIDER-RECOVERY-BUDGET-0.23.4.json). It retains the prior nine configured API routes and unlimited daily budget, with Mistral input/output ceilings of $2/$6 per million tokens. These are conservative routing/reservation ceilings, not the actual invoice price. OpenRouter's endpoints API checked on 27 October 2026 reported standard Mistral rates $1.36/$4.18 per million and a 1,048,576-token context; the EU endpoint reported $1.496/$4.598 and 524,288 tokens. The full context reservation remains conservative across those endpoints.

The budget JSON must retain `searchEngine`, `contextWindowTokens`, `maxInputBytes`, token rates and search price. The brief's abbreviated Mistral example is not a complete configuration for this code. `maxTokens` and `mode` are derived by the runtime; adding them to the price entry does not configure them. `API_BUDGET_ROUTE_MISMATCH` means the configured transport, model or search engine differs, and `API_BUDGET_NOT_CONFIGURED` means the JSON or route is missing.

`google_aio.requestUsd` remains the price ceiling **per attempt** (`0.01` in the supplied configuration). The code now reserves up to `0.02` for two attempts. Do not double `requestUsd` merely to allow the retry. Check the per-attempt ceiling against your DataForSEO account pricing if it differs.

Preserve existing provider credentials, enabled providers and the Grok OpenRouter setting. Do not add `DATAFORSEO_CONCURRENCY`; this runtime does not read that setting. Investigate separately if actual `40209` errors appear.

## Verification

After redeploying API and worker, their `/healthz` responses should show `version: "0.23.4"` and the deployed release revision; `/readyz` should report ready. Start a small new check with Mistral and Google AI Overviews.

- Mistral: `max_tokens_requested: 12000`, `collection_method: mistral-concise-search-v1`, complete answer or a specific provider failure. The shorter prompt does not guarantee the model will always finish within its limit.
- AI Overviews: `request_attempts` is one or two. A recovered retry records `initial_upstream_error_code`; repeated temporary failures return `SERP_TEMPORARILY_UNAVAILABLE`. A genuine no-overview SERP remains `no_overview`.
- Old failed evidence stays unchanged; inspect the new run IDs.

Offline tests cover the actual monitoring → reservation → mocked HTTP → persisted evidence flow, finite-budget rejection before dispatch, retry limits and costs, timeout boundaries, non-retry cases, prompt-byte validation and historical method separation. Production provider responses still require the fresh deployment check.

## References

- https://dataforseo.com/help-center/what-does-the-40101-error-mean
- https://docs.dataforseo.com/v3/appendix-errors/
- https://openrouter.ai/api/v1/models/mistralai/mistral-large-4-0/endpoints
- https://openrouter.ai/blog/agentic-web-tools/
