# AI Rank Finland language pilot

**Review draft v0.1 — 30 October 2026. Preparation only. Collection, spending, scheduling and publication are not approved.**

## Decision requested

Approve the research question, the three proposed sectors and a fluent Finnish reviewer. Separately approve a diagnostic/model-qualification budget and research pipeline before any paid execution. The proposed OpenAI-only usage allowance is $12 pre-tax, conditional on current model availability and verified cost controls. It is not a promise that billing is technically capped today. No authority from the public checker or any unrelated $100 allowance transfers to research.

## Research question and scope

For a fixed set of buying needs in Finland, do Finnish and English prompts produce the same recommended businesses and cited sources? Primary audience: agencies and in-house marketing teams. This is descriptive research on selected API configurations, not a representative Finnish consumer survey, national league table, causal website-language study or social-artwork language experiment.

Three sectors: accounting services, managed IT services, digital marketing agencies. Four constructed buyer intents in each: general shortlist, business-size scenario, service-specific scenario and location-specific scenario. The three local examples are deliberately different cities; do not compare them as a city effect. No measured prompt popularity or demand weighting is claimed. AI Rank and its competitors are not included as target recommendations.

`prompt_pairs.md` is the review copy; `prompt_pairs.json` is the machine-readable master. All 12 Finnish translations require fluent human approval. Confirm especially the equivalence of “managed IT” and “jatkuvat IT-palvelut.” Both languages use the same constraints and maximum five recommendations. Translate naturally, not word for word. No target service-provider or agency names, and no requirement for Finnish-language customer service, are injected. IT03 deliberately includes Microsoft 365 as the same technology constraint in both EN and FI; this is not a target-provider recommendation cue. Requested answer language is part of the treatment, so report the treatment as prompt-and-answer language, not merely interface language.

## Qualification gates and freeze

1. Owner approves research scope, endpoint access, diagnostic cap and spend authority.
2. Engineer reviews code/configuration without executing requests. Dedicated research job/key or clearly isolated accounting, never public guest-check quota bypass.
3. Verify model availability and tool compatibility. The official GPT-4.1 mini page was labelled “Deprecated” when checked 2026-10-30. The proposed snapshot is `gpt-4.1-mini-2025-04-14`; availability is not established by the page. If unavailable, choose and reprice a replacement before freezing; never silently substitute mid-study.
4. Up to 20 diagnostic attempts total, separately approved, not 20 per endpoint. Prefer 10 per endpoint if both are assessed; a one-endpoint run can use all 20. Include both languages, representative intents, search metadata, raw output and parser tests. Diagnostics never count as primary observations. No extra automatic retries outside this 20-attempt allowance.
5. Gemini through OpenRouter currently has an unresolved Finnish grounding problem. It is excluded from main collection unless search execution/metadata, citations where returned, provider routing and accounting are understood in both languages. Missing citations alone do not prove no search. A genuine no-citation outcome is not automatically a failed qualification. But an unexplained route/tool malfunction blocks inclusion.
6. Pin one Gemini provider, disable fallback and `auto` search-engine switching. Freeze native search or explicitly label an external-search experiment. Do not combine native Google grounding and Exa fallback as one “Gemini” series. Pin the returned model version if available; if not, say the alias cannot guarantee an immutable model.
7. Freeze exact prompts, rubrics, settings, prices and schedule with SHA-256 checksums. Record reviewer approval and date. Any amendment gets a version and reason before renewed collection.

## Collection matrix and draft timing

Full pilot: 12 intent pairs × 2 languages × 2 endpoints × 3 dates × 2 daily blocks = **288 scheduled response slots**. OpenAI-only: **144 slots**. Each endpoint has six observations per language/intent. Company count is not a further call multiplier.

`proposed_schedule.json` contains 288 offline-generated slots, random seed 20261030. Proposed dates: **3, 5 and 9 November 2026**, with blocks starting **08:00 and 14:00 UTC** (10:00 and 16:00 Helsinki). These are review suggestions, not activated jobs or reserved times. If approval is late, shift all dates before freeze while preserving spacing.

Within each block, intent order, endpoint order and FI/EN order are reproducibly randomized. Execute each FI/EN pair consecutively, aiming for completion within 10 minutes. Measure pair span from the first request start to the later answer completion. Flag spans over 10 minutes as paired_late; exclude these pairs from primary overlap analysis and include them only in a separately labelled sensitivity analysis using the same scoring rules. Report their count and reasons. Log delays; do not silently re-run a pair to repair an inconvenient result. Pause a block if endpoint outage would make pairing misleading. Record actual timestamps, not only planned ones. Request each slot in a fresh conversation, no memory, previous response ID or customer data. Same research identity/context on both languages; no personalized user history.

## Fixed request settings (proposals subject to qualification)

OpenAI: Responses API; snapshot above if available; non-preview `web_search`; `max_tool_calls=2`; `max_output_tokens=1500`; no other tools; `temperature=1` if supported, otherwise record fixed provider default; leave top_p default; no retries hidden in SDK; no background agent loops. Low search context if supported. Force one web-search call if supported and validated, otherwise use fixed auto setting and report search-use rate. Do not compare runs with different tool policies without labelling them.

Gemini: `google/gemini-2.5-flash` through OpenRouter, one exact provider route, native search engine explicitly selected; same fixed search/answer policy across languages. `max_tokens=1500` only after verifying whether it caps all billable completion/thinking tokens. Disable thinking if the selected route supports an explicit zero budget; otherwise record a supported finite budget and reprice. Verify an enforceable search-use maximum; a plugin and a server-tool configuration are not interchangeable. Do not run until this manifest is complete.

Common developer instruction: “Respond to the user's purchasing question. Do not invent businesses, sources or capabilities. Use the configured search tool when available. Follow the requested answer language.” Keep this instruction identical between FI and EN conditions. Count complete developer+user input before submission: proposed maximum 1,000 tokens, not just the visible question. Do not truncate reviewed prompts to fit; revise before freeze if necessary. All tool-result/context billing must be included in actual accounting; input prompt length is not a cap on total billed input.

Location: prompts specify Finland/city as content. Set supported search user_location consistently (Finland for national prompts; matching city for local prompts) only if both language conditions on that endpoint support it, and log it. If unsupported, record null. Never imply the cloud/API run is a Finnish consumer browser session. Endpoint-to-endpoint differences are descriptive because search/location capabilities may differ.

## Data schema

Store three linked JSONL tables and immutable raw-response files, with no credentials:

**runs:** study_version, slot_id, attempt_id, parent_attempt_id, intent_id, sector, language, date_block, replicate, planned_order, actual_start_utc, end_utc, prompt_text, prompt_hash, system_text/hash, requested_model, returned_model, endpoint, provider, route, settings_json, location_json, status, HTTP/error category, finish_reason, truncation_flag, raw_path/hash, tool_calls, grounding_status (verified/absent/unknown), input_tokens, cached_tokens, output_tokens, reasoning_tokens, search_content_tokens if exposed, billed_search_units, provider_cost, cost_currency, billing_reconciliation_status, exclusion_reason, protocol_deviation.

**entities:** slot_id, canonical_entity_id, raw_name, official_domain, optional Business ID, mention_present, recommended (yes/no/unclear), recommendation_position if explicit, Finland_service_eligibility (yes/no/unverified), supporting_text_span, identity_source_url, coder, reviewer, adjudication. One row per distinct entity per response; repeated text mentions do not multiply counts. Keep subsidiaries/brands separate unless the frozen alias map clearly identifies them as the same customer-facing provider.

**citations:** slot_id, raw_url, normalized_url, registrable_domain, source_origin (annotation/answer-text/retrieval-only), explicitly_cited, page_language (fi/en/sv/mixed/other/unknown), language_evidence, owned_by_recommended_entity, live_check_status, verification_date. Normalize tracking parameters and fragments without merging genuinely distinct pages. Do not equate retrieval-only sources with explicit citations.

## Scoring rubric

A recommendation is an explicit suitable option presented to answer the buying need. A brand merely mentioned as an example, competitor or rejected option counts as a mention, not a recommendation. Unclear cases are adjudicated. Never infer positive sentiment from presence alone. Preserve first listed order but do not call it preference ranking unless the answer explicitly ranks options.

Primary: within each endpoint and matched time/intent, Jaccard overlap of the FI and EN sets of recommended entities: intersection / union. Both empty: separate outcome, not perfect agreement; one empty: zero; missing/unusable answer: no paired overlap. Compute an intent-level mean over its eligible repeated pairs (complete, usable, on-time pairs with a non-empty union), then macro-average only contributing intents, so an intent with more successful repeats is not overweighted. An intent with zero eligible pairs is NA, never zero and never silently included as if measured. Report the contributing intent count out of 12 (out of four for each sector), each intent’s eligible pair count out of six, and separate counts for both-empty, late, missing and unusable pairs. If no intents contribute, the aggregate is NA. Report pair coverage and per-sector summaries alongside every aggregate.

Baseline variation: compare same-language sets between the two daily blocks for each intent/date/endpoint, alongside cross-language overlap. This is descriptive noise context, not a formal causal adjustment, because blocks are farther apart than paired languages.

Secondary: number of recommendations; Finland-eligible recommendation share with unverified separated; explicit citation-domain overlap; response-level Finnish-source presence; source-language composition by unique cited URL; recommendation frequency of each discovered entity within its sector. A business-level denominator is all usable responses in its sector/language/endpoint, including genuine empty/refusal responses, not only answers mentioning that business. Do not report “share of Finnish market.” No cohort restriction in the primary discovery analysis.

Optional reference cohort: ten organizations per sector, selected transparently and frozen before collection. PRH/YTJ can verify identities/status, supplemented by official websites for sector/service scope. Its open-data coverage excludes sole traders and lacks email/phone, so it cannot establish a comprehensive national business universe. No bulk PII enrichment.

## Failures, retries and denominators

Transport timeout, 429 or 5xx: one retry maximum for that slot after fixed 60-second delay or a longer provider Retry-After. Disable SDK/router extra retries. Retain both attempts. First usable completed answer is used. One retry consumes a new budget reservation; never overwrites evidence. HTTP 4xx configuration/authentication error: stop endpoint and investigate, do not keep retrying.

Valid refusal, no recommendations, no sources or unsupported claims: retain as observed outcome, no rerun. Missing grounding telemetry: mark unknown; no rerun for prettier evidence. Truncation: incomplete, retain but exclude from primary complete-answer comparisons and show separately. Parser failure: inspect raw output manually, no extra model call. Suspected cached duplicate: retain and flag; do not delete identical answers automatically.

Denominator report: scheduled slots; attempted slots; total attempts including retries; completed usable slots; refusals/empty recommendations; incomplete outputs; unresolved transport errors; grounding verified/absent/unknown; valid matched language pairs. Refusals and empty completed answers remain in recommendation-rate denominators. Technical/incomplete failures do not become zero visibility. Citation presence can be reported across all usable answers, including zero citations; conditional source-composition analyses use actual explicitly cited URLs and state their denominator. Any grounding-qualified analysis is an explicitly separate subset with coverage shown. Present successful-subset results with missingness by language; never hide differential failures.

## Independent review and uncertainty

Primary coder extracts all answers. Independent second coder reviews a seeded stratified 25% sample (36 of 144 or 72 of 288), balanced by sector/language/endpoint/date, plus all ambiguities and every public example. Second coder works before seeing aggregate rankings or headline. Fluent Finnish reviewer covers FI meaning; one person can serve both roles if qualified but independence from primary coding is retained. Report agreement counts for entity recommendation classification and adjudicate disagreements with recorded reasons. LLM-assisted extraction is optional only under separate cost approval and must not serve as its own independent reviewer.

There are 12 constructed intents, not 288 independent market samples. Show per-intent distributions and six-repeat consistency; no national significance claim. Default pilot outputs: medians/ranges and raw fractions. If exploratory intervals are added, resample whole intent clusters with all paired/repeated observations retained, stratify by sector, disclose only four intents per sector and instability; do not use naive response-level binomial precision. Do not assert statistical significance from this design or rank businesses by tiny differences.

## Publication plan and claim boundaries

Report title names endpoints, collection dates and exploratory scope. Outline: question; why it matters; one-page findings; prompt/endpoint matrix; paired language results; ordinary repeat variation; sources and grounding coverage; concrete examples; methods; failures/deviations; limitations; downloadable aggregate data and reviewed prompt list; correction contact.

Publish only after owner approval. Finnish report first with separate English translation. One chart per artwork. Derived content: research photograph + finding; short screen walkthrough of a paired example; methodology post; Academy lesson on bilingual tracking. Null/mixed findings are publishable. All headlines link to full methods. No public negative company league table from the small pilot. Verify example identities and citations before naming organizations. Do not publish raw full third-party text when excerpts/aggregate data suffice.

Allowed: “In our 12-intent API pilot, ...”; “On the specified dates and configurations, ...”. Not allowed: “Finns prefer ...”; “ChatGPT always recommends ...”; “English websites cause ...”; “AI Rank increases sales by ...”; “This proves which language social artwork should use.” Do not claim a citation validates the cited claim.

## Budget and release checklist

See BUDGET.md and budget_assumptions.json. Before collection: Finnish review signed; model/provider verified; route/search policy pinned; cost estimate refreshed; caps implemented and tested with mocked requests; spend and diagnostic approval explicit; raw data storage ready; retry logic audited; settings/protocol checksums saved. Runtime qualification is itself a paid step and requires approval. Stop before any attempt whose worst-case reservation would exceed the approved ceiling; reconcile tool and token costs after each response. If a credible per-attempt bound cannot be established, do not execute under a purported hard cap.

## Sources checked 30 October 2026

- Peec SIXT study: https://peec.ai/blog/how-sixt-increased-ai-citations-of-its-partner-listings-by-320 (bounded study, disclosed control and limitations; not evidence of our results).
- Peec UI/API distinction: https://peec.ai/ai-instructions (vendor's own description).
- PRH coverage/licence: https://avoindata.prh.fi/fi/info/swagger-ui
- PRH open data: https://www.prh.fi/en/companiesandorganisations/tietopalvelut/prhopendata.html
- Provider pricing/control sources: BUDGET.md.
