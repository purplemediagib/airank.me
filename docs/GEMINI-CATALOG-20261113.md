# Gemini country catalogue dependency recovery

The Gemini consumer collection preflight can fail while loading the free locations catalogue, before a paid task is submitted. Three catalogue request exceptions still produced terminal collection failures. This does not establish that the requested country is unsupported.

This narrow change uses the documented DataForSEO country identifiers for Finland (2246) and United States (2840), avoiding the locations GET for these two markets. The language catalogue is still checked. Other markets keep the existing live catalogue validation and bounded retries. Pinned and live catalogue caches are separated so visiting one market cannot poison another market's lookup.

- No country/language substitution, model or measurement-surface change.
- Returned location code and language still must match the submitted context.
- No retry of task_post, no historical replay, no schedule/cap change.
- Provider rejection and uncertain submission remain failures, never fake successful answers.
- The transport/parse/size reason behind the catalogue exceptions remains unknown; this removes that prerequisite for the two documented countries rather than claiming the upstream exception is repaired.

References:
https://docs.dataforseo.com/v3/ai_optimization-llm_scraper-locations/
https://docs.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/task_post/

Validate offline with `cd app && npm ci && npm test`. A successful deployment/health check is not proof of a completed provider answer; verify the next naturally scheduled collection.
