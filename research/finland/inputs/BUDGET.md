# Research API budget proposal

**2026-10-30. USD, pre-tax. No spending approved or performed.** Values below are planning calculations, not a verified billing guarantee. No existing guest-checker allowance funds this proposal. No credit purchase, top-up, technical probe or new endpoint call has been made.

## OpenAI-only first: conditional $12 usage ceiling for owner review

Verified published rates: GPT-4.1 mini input $0.40 per million tokens, output $1.60 per million. Non-preview web search $10 per 1,000 calls, plus a fixed 8,000 input-token block per search call for GPT-4.1 mini. Responses API itself has no separate fee. Do not substitute preview web search: the non-reasoning preview tool has a different price.

Proposed assumptions per attempt: at most 1,000 complete initial input tokens, 1,500 output tokens, two non-preview searches. Arithmetic:

`(1,000 + 2 × 8,000) × $0.40 / 1,000,000 + 1,500 × $1.60 / 1,000,000 + 2 × $0.01 = $0.0292`

| Scenario | Attempts | Planning cost |
|---|---:|---:|
| Primary OpenAI responses | 144 | $4.2048 |
| Maximum one retry per primary slot | 144 | $4.2048 |
| Separate diagnostic allowance | 20 | $0.5840 |
| Combined conservative call-count scenario | 308 | **$8.9936** |
| Proposed owner usage authorization ceiling | — | **$12.00** |

The retry scenario deliberately assumes full charge on every attempt; actual failure billing may differ. Diagnostic limit is 20 attempts total and is separate from 144 study slots. If the dual-endpoint option is later approved, its 20 diagnostics are shared across endpoints, not duplicated.

**Limits still to verify:** `max_output_tokens` and `max_tool_calls` are documented Responses parameters. Initial 1,000-token input is an application-side validation, not a provider cap on total billed context. Search-context billing is included above as documented, but any additional billable input/tool-loop context, endpoint differences or unsupported controls must be reconciled before treating this as an upper bound. No unbounded agent/tool loops, automatic fallback or SDK retries. Configuration must demonstrate finite attempt cost; otherwise stop and reprice. The $12 is a proposed usage ceiling, not proof current infrastructure can enforce it. Reserve conservatively before each attempt and reconcile actual usage after it; provider billing delay is not permission to overspend.

**Model gate:** official model page currently labels GPT-4.1 mini “Deprecated,” checked 2026-10-30. Snapshot proposed: `gpt-4.1-mini-2025-04-14`. Availability and tool support are unverified. Select/reprice another model if necessary before protocol freeze; do not silently change models.

Sources: [model rates/status](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [tool/search billing](https://developers.openai.com/api/docs/pricing), [Responses output/tool controls](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

## Gemini 2.5 Flash through OpenRouter: no approved all-in cap

Published model rates: $0.30/M input and $2.50/M output. Thinking tokens can be billable output; do not count only visible text. At 1,000 input and 1,500 total output tokens, inference-only illustration is **$0.00405 per attempt**, or $0.5832 for 144 responses. This is NOT the grounded-search price and not a validated total-context ceiling.

Google direct pricing lists native Search grounding at $35 per 1,000 grounded prompts after its listed allowance. **Do not assume any Google direct free allowance passes through OpenRouter.** If the chosen OpenRouter route passes through exactly one $0.035 grounded-prompt fee, the illustration becomes $0.03905/attempt or $5.6232 for 144 responses. This is a conditional scenario, not a quote: provider choice, search mechanism, billable search units and route support remain unverified. Gemini Finnish grounding also remains unresolved.

OpenRouter's current search documentation distinguishes legacy `web` plugin / `:online` and `openrouter:web_search` server tools. Auto can choose native search or fallback to Exa depending on the provider. Published Exa instant/fast/auto is $0.007 per request, deep/deep-lite $0.012, deep-reasoning $0.015, with potential extra-result fees. Search snippets also enter input context. These are not interchangeable with Google native grounding. Disable fallback and pin the engine/provider; if using Exa, label it as Gemini with external Exa retrieval, not native Gemini Search. Do not calculate a blended “Gemini price” across routes.

OpenRouter says inference is passed through without markup, while credit purchases incur **5.5% Standard or 8% Business**, with applicable taxes additional. This is a purchase fee, not a per-request surcharge. Existing-credit usage versus new top-up cash must be separated; account plan, exact payment fee and any minimums must be verified at approval. No top-up is included or authorized. BYOK economics differ and are not assumed here.

**Release gate:** verify exact route and web mechanism, finite input/context and billable thinking limits, search-use cap, actual fee unit, and FI/EN grounding behaviour within separately approved diagnostics. Only then calculate the 288-response full study plus retry reserve. Until then, the defensible budget proposal is OpenAI-only, still conditional on its availability/caps.

Sources: [OpenRouter model pricing](https://openrouter.ai/google/gemini-2.5-flash/pricing), [Google direct pricing, reference only](https://ai.google.dev/gemini-api/docs/pricing), [OpenRouter web plugin](https://openrouter.ai/docs/guides/features/plugins/web-search), [server-tool pricing](https://openrouter.ai/tool/web-search/), [credit-purchase fees](https://openrouter.ai/pricing).

## Not included

Taxes, foreign-exchange/payment costs, new credit deposits, paid human translation/review, hosting/storage, additional extraction-model calls or consumer-app subscriptions. These need separate approval if applicable. Time spent preparing the protocol does not authorize spending. Recheck all rates and deprecation status immediately before any approved run.
