# Gemini catalogue resilience and Kimi allowance

Based on deployed worker candidate 7dd75ff, not main. No schema, provider model,
token allowance, budget or guest behavior change. No paid tests or task replays.

## Evidence
Elisa's eight latest Gemini tasks on 11 November reported
COLLECTOR_LOCALE_CATALOG_UNAVAILABLE before paid submission. This is not evidence
that Finland is unsupported. Official DataForSEO documentation still defines
Gemini /locations and /languages catalogues. The exact upstream cause remains
unverified pending live worker/provider access; this patch is resilience and
better diagnostic coverage, not proof the supplier now works.

## Changes
- Retry non-billable catalogue GETs at most three times for network/parse errors,
  HTTP 429/5xx or supplier 5xxxx; never retry paid task_post or authentication
  failures. Gemini shares one cached catalogue across requested markets.
- Persist allowlisted catalogue stage, numeric HTTP/supplier status and attempt
  count when it fails. Never log provider bodies or credentials.
- Continue exact country/language lookup from provider catalogues. Never replace
  Finland with US, change language, or silently relabel an API answer as consumer.
  Unsupported supplier countries remain unsupported rather than falsely covered.
- Kimi tracked model API calls default to at least 300 seconds, overridable with
  MONITORING_KIMI_TIMEOUT_MS (10..600000). Other providers retain global timeout.
  Existing recovery stays one extra reserved sequence; total lease remains
  capped at ten minutes and run deadline. Guest checks and consumer polling
  retain their policies. Longer waits do not add retries or tokens.

## Validation and rollout
Local Node tests: 529 passed. Tests cover FI/fi and US/en, transient catalogue
recovery, no paid call on catalogue failure, exact diagnostics, Kimi first and
retry allowance, no duplicate execution and unchanged global providers.
Wait for exact commit CI/candidate publication before live update. Verify current
Bunny revision first; preserve all environment values. Deploy worker only after
access is available, verify health/readiness/config, then inspect natural runs.
Do not claim deployment or actual successful answers from local tests.
Rollback restores the previous worker image; no database changes to revert.
