# Free AI check: OpenAI + Gemini — deployment review

Draft implementation based on `288c2c88f903d7e8f63f641f5abc621a85cc351c`. No production deployment, migration, configuration or paid provider call was performed.

## What the guest ledger covers
Guest preparation and measurement calls reserve an operator-priced conservative ceiling before network access. This is an accounting bound contingent on correct exact-model context/prices and supplier charges; it is not an upstream account spending limit. The reservation is never refunded.

| Stage | Where | Reserved ceiling | Idempotency |
| --- | --- | --- | --- |
| Website scrape (Firecrawl `/v2/scrape`) | `/prepare` | `preparation.firecrawl.requestUsd` × 1. It's one request and is never retried. | One paid attempt per (visitor, website+context) per 6 h |
| Identity inference (OpenAI chat, `max_tokens` 700) | `/prepare` | Operator-verified full model context × input price + 700 × output price, × 1 attempt (no retry in this adapter) | Same key, separate stage |
| AI question drafting (OpenAI chat, `max_tokens` 1800; only for languages other than EN, and FI/fi) | `/preview` | Full model context/input price plus bounded output cost × 3. `requestJson` retries HTTP 429 up to `maxHttpAttempts` = 3, and every attempt is reserved. | One paid attempt per (visitor, profile+preview) per 6 h |
| Scan answers (OpenAI direct, Gemini via OpenRouter) | worker | Context window × input + output tokens × output + max searches × search, × 3 for the 429 retries | Unique (scan, provider, question); at most 6 logical measurements / up to 18 HTTP attempts per scan |

Preparation models require operator-verified `contextWindowTokens` and `maxInputBytes`. The entire model context is reserved (including server-side chat/schema framing); bytes are only a local payload cap, never a token estimator. Unknown context or excessive payload fails before fetch. All retry attempts are conservatively reserved, including rejected429s.

Caps, all checked in one write transaction:
- `perScanUsd`: money per scan.
- `preparation.maxStageUsd`: the most a single preparation stage may cost.
- `preparation.visitorDailyUsd`: preparation money per visitor fingerprint per rolling 24 h.
- `dailyUsd`: **one** rolling 24 h ceiling shared by preparation and scan reservations together.
- The existing `MAX_DAILY_PROVIDER_CALLS` counts logical reservations (not HTTP attempts); preparation rate limits also remain in force.

Fail-closed behaviour:
- Missing, zero, null or malformed caps, prices or `preparation` block: the stage is refused before any network request and the user sees `AI_UNAVAILABLE`.
- A model that doesn't match the priced model (`WEBSITE_PROFILE_MODEL`, `CONTEXT_PROMPT_MODEL`): refused with `API_BUDGET_ROUTE_MISMATCH`.
- Any exhausted cap: refused with `PREPARATION_RATE_LIMIT` (HTTP 429). Scans record `budget_blocked` with the reason.
- Migration 023 or 024 missing: every guest reservation is refused.

Where the real code calls the hook:
- `scrapeWebsite`, `inferProfile` and `generateContextQuestions` call an optional `reserve()` hook right before their request.
- Only the public check passes the hook. Signed-in website autofill, signed-in context prompts and paid tracking pass no hook and behave exactly as before.
- Website-first extraction still works when the config is correct: one scrape and one identity call, and later requests are served from the cached draft.

## Limits of the guarantee (please read)
- **Firecrawl:** the app can't see the credit cost of one scrape. Firecrawl's default `proxy: "auto"` can retry with an enhanced proxy that costs more credits. So `requestUsd` must be the **worst-case** price of one scrape on your Firecrawl plan, including any enhanced-proxy surcharge. If you can't state that price, leave `firecrawl` unset: preparation is then refused before any request, and the free check is used without website autofill. Pinning `proxy: "basic"` would make the cost fixed, but it changes scraping behaviour for signed-in autofill too, so it was not done.
- **OpenAI scan web searches:** these are bounded by `max_tool_calls` (reservation `maxSearches`), which is the same mechanism paid tracking uses.
- **Guest report emails (Resend):** these are not part of this ledger. Email is still disabled on Bunny.

## Guest config schema (`PUBLIC_CHECK_BUDGET_CONFIG_JSON`; values come from the owner)
```json
{
  "perScanUsd": <n>, "dailyUsd": <n>,
  "routes": {
    "openai": {"transport":"direct","model":"<OPENAI_MODEL>","contextWindowTokens":<int>,"maxInputBytes":<int>,"inputUsdPerMillion":<n>,"outputUsdPerMillion":<n>,"searchUsdPerCall":<n>},
    "gemini": {"transport":"openrouter","model":"<OPENROUTER_GEMINI_MODEL>","searchEngine":"<e.g. native>","contextWindowTokens":<int>,"maxInputBytes":<int>,"inputUsdPerMillion":<n>,"outputUsdPerMillion":<n>,"searchUsdPerCall":<n>}
  },
  "preparation": {
    "maxStageUsd": <n>, "visitorDailyUsd": <n>,
    "firecrawl": {"requestUsd": <worst-case USD per scrape>},
    "identity":  {"model":"<WEBSITE_PROFILE_MODEL or gpt-4.1-mini>","contextWindowTokens":<int>,"maxInputBytes":<int>,"inputUsdPerMillion":<n>,"outputUsdPerMillion":<n>},
    "questions": {"model":"<CONTEXT_PROMPT_MODEL or WEBSITE_PROFILE_MODEL or gpt-4.1-mini>","contextWindowTokens":<int>,"maxInputBytes":<int>,"inputUsdPerMillion":<n>,"outputUsdPerMillion":<n>}
  }
}
```
The config must satisfy: `perScanUsd ≤ dailyUsd`, `maxStageUsd ≤ visitorDailyUsd ≤ dailyUsd`, and all values > 0. A full scan needs at least3 × (OpenAI per-answer ceiling + Gemini per-answer ceiling); each ceiling already reserves up to3 HTTP attempts. Preparation uses additional shared daily/visitor allowance. Do not automatically choose those financial limits for the owner.

## Migrations (only through the opt-in `AIRANK_RUN_APP_MIGRATIONS=true` release step)
- `app-023-public-check-api-reservations` creates the table `public_check_api_reservations` (scan reservations).
- `app-024-public-check-prep-reservations` creates the table `public_check_prep_reservations` (preparation reservations).

## Independent verification and readiness
- Full backend `cd app && npm test`: **449 passed**, Node24.22.1, no live provider calls.
- Google connector regression: **17 passed**.
- API/worker syntax checks passed. Docker unavailable locally; CI must verify Node22/24 and all four runtime image builds.
- Capabilities and legacy guest preview/start require both migrations023/024, matching checksum, at least one valid guest provider price route and local credential presence. Missing prerequisites => disabled/503 for new work, no empty queued scan. Existing scan-token-protected evidence remains readable during measurement configuration outages; authentication is unchanged. Autofill separately checks preparation price/model configuration.
- Credential presence is not credential validity, and API-local readiness cannot establish worker replica readiness. Verify both deployed roles and exact image revision.
- Mocked tests cover monetary concurrency/idempotency, shared preparation+scan daily limits, no-fetch rejection, website-first cache reuse and actual6measurement execution/7threfusal. Live provider responses, complete EN/FI journey and long-running worker launch remain untested.

## Deployment gates — not executed
1. Review this draft and approve migrations023/024 separately. They add reservation tables, do not remove data; backing up and verifying restore is still required.
2. Owner approves numeric caps and exact supplier model/context/prices in `PUBLIC_CHECK_BUDGET_CONFIG_JSON` for API and every worker. Do not use test prices or placeholders. Confirm existing provider credentials without exposing their values. Email must remain off (not budgeted here).
3. Merge only after review/CI; main merge builds immutable images via the existing workflow but does not itself authorise Bunny deployment. Deploy API+worker from the same reviewed revision, run opt-in migrations once, verify checksums. Do not enable or broaden paid models/settings.
4. Confirm capabilities lists OpenAI+Gemini and valid preparation configuration; check missing config/migration returns disabled. Verify the app proxy fix separately.
5. Run bounded EN/FI tests within actual guest daily/domain limits and approved spend: website→review→questions→real evidence, citations, partial/error/retry/mobile. Do not bypass caps.

## Outstanding owner values and approvals
- `perScanUsd` and `dailyUsd`.
- `preparation.maxStageUsd` and `preparation.visitorDailyUsd`.
- Per-route prices for OpenAI and Gemini (scan), and for the identity and question models.
- The worst-case Firecrawl price per scrape, or a decision to leave it unset, which turns website autofill off for guests.
- Approval for migrations 023 and 024 and for the backend deploy.
