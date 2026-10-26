# API and monitoring worker 0.23.0

This release supports the four OpenRouter providers requested by the Lovable brief, fixes sentiment quote validation, supports explicitly unlimited daily budgets, and leaves production deployment manual in Bunny. No database migration is added.

## Changes

- Scan validation and provider readiness use the existing route registry, including extra OpenRouter mappings. Unknown, disabled, malformed and reserved mappings still fail closed. Public guest scans remain OpenAI/Claude only.
- Both the OpenRouter HTTP adapter and budget reservations use 8,192 output tokens for Gemini, DeepSeek and Kimi, and 4,000 for other models. An explicit `OPENROUTER_MAX_TOKENS` still takes precedence. Truncated output is never silently retried.
- Optional `OPENROUTER_SEARCH_ENGINES_JSON` selects an engine per provider, preserving the existing global fallback. It accepts only `native` or `exa` for Gemini or explicitly mapped extra providers. Stored route compatibility includes the engine.
- Budgeted OpenRouter requests send the configured input/output rates as `provider.max_price` ceilings. No qualifying endpoint produces an error, rather than silently choosing a more expensive endpoint. These ceilings do not cover account credit-purchase fees or separate consumer/sentiment budgets.
- Explicit `API_BUDGET_CONFIG_JSON.dailyUsd: null` removes the aggregate API dollar cap while preserving price validation, per-call bounds, reservations and deduplication. `unlimited` is also supported for the shared provider-call cap, consumer collection cost cap and sentiment-call cap. Missing values retain previous behaviour; numeric zero never means unlimited.
- Sentiment drops invalid, paraphrased and overlapping quotes, retaining only exact text/offsets. It still requires at least one verified quote naming the assessed brand. Rubric `brand-sentiment-quotes-v2` creates a separate analysis version. Historical reanalysis remains explicit.

## Both containers: environment changes

Paste each JSON value on one line, without wrapping it in additional quotes.

```dotenv
ENABLED_PROVIDERS=openai,claude,gemini,grok,perplexity,google_aio,deepseek,meta_ai,mistral,kimi
OPENROUTER_MODELS_JSON={"deepseek":"deepseek/deepseek-v4-pro","meta_ai":"meta/muse-spark-1.3","mistral":"mistralai/mistral-large-4-0","kimi":"moonshotai/kimi-k3"}
OPENROUTER_SEARCH_ENGINES_JSON={"gemini":"native","deepseek":"exa","meta_ai":"native","mistral":"exa","kimi":"exa"}
OPENROUTER_GEMINI_MODEL=google/gemini-2.5-flash
GROK_MODEL=grok-4.7
SENTIMENT_MODEL=gpt-4.1-2025-04-14
SENTIMENT_TIMEOUT_MS=60000
TRACKED_PROMPT_LIMIT=55
MAX_DAILY_PROVIDER_CALLS=unlimited
CONSUMER_MAX_DAILY_COST_USD=unlimited
SENTIMENT_MAX_DAILY_CALLS=unlimited
```

The Gemini pin above matches the existing operator-supplied budget, rather than changing an existing model. Keep `CLAUDE_MODEL` aligned with its budget entry too. Remove a low `OPENROUTER_MAX_TOKENS` override if you want the new per-model defaults.

Keep the existing OpenRouter credential. Grok needs its own valid `XAI_API_KEY`. Remove only `grok` from the existing `CONSUMER_COLLECTION_PROVIDERS`; preserve other consumer routes and their separate enablement, credentials and budgets. `OPENROUTER_GROK_MODEL` has no effect and can be removed. Do not map the reserved `grok` key in `OPENROUTER_MODELS_JSON`.

Merge the four extra routes and direct Grok into the existing `API_BUDGET_CONFIG_JSON`, preserving existing Claude, Gemini and Google AI Overviews settings. For the explicitly requested unlimited daily API budget, set `"dailyUsd":null` (JSON null, not a quoted string); keep the routes object. The model and search engine must exactly match each route. Use verified full context windows; `maxInputBytes` bounds only the local prompt, not server-added search content. Use deliberate conservative price ceilings rather than treating a headline minimum endpoint price as universal.

The existing budget ledger reserves each attempted call at its full configured ceiling for 24 hours; it does not refund unused tokens. With a numeric `dailyUsd`, expanding models can therefore hit that reservation cap after only a few prompt panels even when actual provider bills are lower. Explicit `null` removes that stop. It does not mean free usage: provider charges continue, and external account credits, provider rate limits and account spending limits still apply. Consumer collections and sentiment have independent daily settings; use the explicit `unlimited` values above to remove those daily stops too. Keep `CONSUMER_UNIT_COSTS_JSON` because collection accounting still requires per-provider costs.

`MAX_PROVIDER_CALLS_PER_SCAN` applies to the legacy/quick scan worker. Current signed-in monitoring has a separate shared `MAX_DAILY_PROVIDER_CALLS` cap. A numeric value caps prompt × provider attempts across monitoring and guest usage; `unlimited` removes that cap. Fifty-five prompts across ten providers need 550 provider calls; a 385-prompt account needs 3,850. For a 385-prompt, ten-provider run also set `MONITORING_MAX_TASKS_PER_RUN=5000`; the default 1,000-task per-run cap is separate from daily budgets. Large runs may require a larger `MONITORING_RUN_TIMEOUT_MS` (maximum 86,400,000 = 24 hours), depending on provider latency and concurrency. Keep the established once-per-day measurement rule and prompt entitlements.

For an account override, `TRACKED_PROMPT_LIMITS_JSON={"ACTUAL_USER_ID":385}` must contain the real database user ID, not an email address or a literal placeholder. Keep existing overrides. The current pre-payment prompt cap is already enforced across the owner's active projects. Paid-plan project caps and per-project model selection are explicitly future work in the brief and are not introduced here.

## Existing limitations and rollout

- Direct Perplexity Agent monitoring is deliberately blocked with `API_BUDGET_UNBOUNDED_ROUTE`. Preserve an existing configured Perplexity consumer collection route. Merely enabling its provider name does not make direct API monitoring available.
- If OpenAI uses a consumer route, keep that route and its separate collection budget. If it uses direct API monitoring, add a matching OpenAI budget route and pin `OPENAI_MODEL` to it; the supplied existing budget did not include one.
- `google_ai_mode` remains disabled and unimplemented pending verified DataForSEO support for the target locale.
- These extra model APIs measure API answers, not the consumer websites' exact behaviour.
- Wait for the release workflow to publish matching API and worker commit tags. Update both existing Bunny containers with the same `sha-...` tag and the same relevant configuration. Health should show version `0.23.0` and the matching revision; check readiness too. Other containers do not need updating for this change.
- Run one small Finnish Elisa monitoring check, inspect provider outcomes and budget errors, then explicitly reanalyse an existing long answer from Results. Live credentials, Finnish provider results, and Bunny deployment still require this post-deployment verification.

## Sources checked on 26 October 2026

- [OpenRouter model catalogue](https://openrouter.ai/api/v1/models)
- [Mistral endpoint pricing and native tools](https://openrouter.ai/api/v1/models/mistralai/mistral-large-4-0/endpoints)
- [Meta endpoint pricing and native tools](https://openrouter.ai/api/v1/models/meta/muse-spark-1.3/endpoints)
- [OpenRouter web-search configuration](https://openrouter.ai/docs/guides/features/server-tools/web-search)
- [OpenRouter token price ceilings](https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/)
- [xAI Grok model pricing](https://docs.x.ai/developers/pricing)
