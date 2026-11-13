# Gemini country catalogue dependency recovery

Gemini consumer collection preflight can fail while loading its free locations catalogue, before a paid task is submitted. This change removes that locations GET dependency for every Gemini submission. It preserves exact country targeting and fails closed for unverified markets.

## Snapshot provenance

On 2026-11-13, the authenticated official DataForSEO AI Optimization Playground was set to **LLM Scraper / Gemini**. Its Location dropdown was fully scrolled through all pages: 192 options, including a duplicated United States entry, yielded **191 distinct countries/territories**. For every distinct choice, its **Code Example** was opened and the Gemini `location_code` read. No Request button was executed. The resulting code set is embedded in `gemini-countries.mjs`.

ISO identifiers were cross-referenced by exact verified numeric code against DataForSEO's published country CSV; this reference was used for ISO identifiers only, not to infer Gemini support. Taiwan's preview code2158 uses ISO TW. No country code was calculated or inferred from ISO numeric identifiers.

Sources:
- https://app.dataforseo.com/api-playground/ai-optimization (authenticated Gemini selection)
- https://docs.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/locations/
- https://docs.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/task_post/
- https://cdn.dataforseo.com/v3/locations/locations_ai_optimization_chat_gpt_llm_scraper_2026_11_02.csv (ISO cross-reference only)

The public Gemini documentation has an illustrative result_count213 with only six example entries. That is not a complete current catalogue. The191 verified Playground choices are the supported snapshot here; we do not claim to support all geographic territories or all213 illustrative entries. Unlisted markets, including Gibraltar, fail as unsupported rather than silently targeting another country. Future supported additions need a reviewed snapshot update.

## Safety and unchanged behavior

- Gemini no longer calls the locations catalogue at runtime, including for unknown markets.
- Language catalogue validation remains; its failure can still block collection.
- No country/language substitution, model change, or measurement-surface change.
- Returned location and language still must match the submitted context.
- No retries of ambiguous task_post, historical replay, or schedule/cap changes.
- OpenAI's existing location validation remains unchanged.
- No credentials, customer answers, or startup diagnostic are included.

Offline tests cover all191 codes, concurrent catalogue caching, unknown/excluded countries, language rejection and uncertain paid submission handling. Successful deployment/health checks do not prove a completed provider answer; verify the next naturally scheduled collection.
