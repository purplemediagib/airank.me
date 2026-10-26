# Grok through OpenRouter (0.23.2)

Set `OPENROUTER_GROK_MODEL` to explicitly select OpenRouter for the existing
`grok` provider. Without this setting, direct xAI remains the default. The
dedicated setting validates an `x-ai/grok...` model ID; the reserved `grok`
key must not be added to `OPENROUTER_MODELS_JSON`.

Apply these settings to **both API and monitoring worker**, together with their
0.23.2 images from the same release commit:

```text
OPENROUTER_GROK_MODEL=x-ai/grok-4.7
OPENROUTER_SEARCH_ENGINES_JSON={"gemini":"native","grok":"native","deepseek":"exa","meta_ai":"native","mistral":"exa","kimi":"exa"}
```

Keep `grok` in `ENABLED_PROVIDERS`. Keep the existing `OPENROUTER_API_KEY` and
fund that key's OpenRouter account. `XAI_API_KEY` and `GROK_MODEL` are not used
by the new OpenRouter route. The four extra-model mappings remain unchanged.

Remove **only `grok`** from `CONSUMER_COLLECTION_PROVIDERS` on both containers;
preserve the other entries, especially Perplexity. Collection selection takes
precedence over API routing, so leaving Grok there would still use Scrapeless.

Replace the old `routes.grok` entry in `API_BUDGET_CONFIG_JSON` with:

```json
{"transport":"openrouter","model":"x-ai/grok-4.7","searchEngine":"native","contextWindowTokens":500000,"maxInputBytes":20000,"inputUsdPerMillion":4,"outputUsdPerMillion":12,"searchUsdPerCall":0.025}
```

`GROK-OPENROUTER-BUDGET.json` contains the complete one-line rollout JSON,
preserving the other routes from the previous configuration and `dailyUsd:null`.
Token rates are deliberate ceilings covering the standard endpoint's long
context rates, not an estimate of every request's bill. The search allowance
is conservative. The existing duplicate-call protection, budget reservations
and route checks remain active. Keep `MAX_DAILY_PROVIDER_CALLS=unlimited`.

Remove `OPENROUTER_MAX_TOKENS` if it overrides model defaults. Grok's default
is 8192 output tokens, shared by the reservation and HTTP adapter, matching
the previous direct route's allowance. There are no automatic retries or
fallback to direct xAI on OpenRouter payment or provider failure.

Redeploy both containers, wait for readiness, and start a new small run. The
saved `grok` result should have `meta.transport=openrouter`,
`meta.requested_model=x-ai/grok-4.7`, the returned model, and saved answer.
Old runs retain their original route and are not silently rerouted or replayed.
No database migration, project provider rename or frontend change is needed.

The offline tests exercise routing, key selection, budget reservation, actual
HTTP dispatch under a mock, saved results, and payment/truncation failures.
They do not establish that a live funded OpenRouter request has succeeded.

Verified on 26 October 2026:
- [Grok 4.7 endpoints, native web search, context and prices](https://openrouter.ai/api/v1/models/x-ai/grok-4.7/endpoints)
