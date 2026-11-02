# Free check: OpenAI + Kimi (manual Bunny rollout)

This release adds an **opt-in public-only pair**. It does not deploy Bunny, change
paid tracking, migrate data, alter user/domain/call limits, or rewrite old reports.
The default remains the previous OpenAI/Gemini configuration until enabled.
No real provider call was made for this change: adapter validation uses mocks.
The earlier research result is not production-adapter acceptance.

## Images

Use the successful **Publish free-check Kimi images** Actions run for branch
`feature/free-check-kimi-20261102`. It first runs the complete existing CI workflow
(Node 22/24 tests and all four Docker builds), then publishes **only API and worker**.
The summary provides full `sha-<40-character-commit>` tags and immutable digests:

- `ghcr.io/purplemediagib/airank.me/api:sha-<commit>`
- `ghcr.io/purplemediagib/airank.me/worker:sha-<commit>`

Use the matching digest if Bunny accepts digest pins. Never substitute `latest`.
No merge, content-worker update, or Google-connector update is needed for this
branch preview. Keep the previous API/worker references and settings for rollback.

## Budget decision required before activation

**Do not silently raise `perScanUsd` or `dailyUsd`.** Keep the existing values
unless the owner expressly chooses new limits. The route below fails closed if
those caps cannot reserve the complete six-call check. API capabilities advertise
neither provider for this pair if all three OpenAI and all three Kimi questions
cannot fit under the configured per-scan ceiling.

The Kimi reservation is deliberately conservative, not expected/actual spend:

- Fixed MoonshotAI `moonshotai/mxfp4` endpoint; no fallback/highspeed endpoint.
- Input $2/million, output $10/million, full 1,048,576-token context per pass.
- 3 model passes × (full input context + 3,000 output tokens), plus 2 Exa Auto
  searches at $0.007 each = **$6.395456 per HTTP attempt**.
- Kimi uses exactly one HTTP attempt (no retries, including HTTP 429), reserving
  **$6.395456 per Kimi question**. Other providers retain their existing retries.
- Three Kimi questions = **$19.186368**, **plus three existing OpenAI reservations**.
- The shared rolling 24-hour budget also includes preparation reservations; caps
  are never refunded after an attempted call, even on timeout/crash.

These extend the existing full-context accounting rules to Kimi. The **three-pass
allowance is a conservative engineering inference, not a formal upstream billing
guarantee**. `stop_server_tools_when` overrides `max_tool_calls`; the one-step
condition requests a final answer after the tool step. A timeout cannot guarantee
upstream billing has stopped. Returned aggregate tokens and required all-in cost are checked against the
reservation; missing or out-of-bounds usage excludes the answer, but cannot undo
any charges already incurred. Search counters are validated as diagnostics when
present, not treated as independently verified executed-search counts. Archived
research responses reported six calls while all-in-minus-inference cost matched
two searches at the published rate, so a
counter above two alone is not interpreted as overspend. Retain
provider-account spend controls as an independent backstop. Do not copy research spending limits or treat
`max_tokens` as a whole-request dollar cap. A practical smaller reservation needs
a separately reviewed hard input/loop bound, not a smaller guessed price table.
Prices were checked against OpenRouter's endpoint catalog and
[server-tool search pricing](https://openrouter.ai/docs/guides/features/server-tools/web-search).
[Tool-loop controls](https://openrouter.ai/docs/guides/features/server-tools) are beta.

## Exact Bunny changes (API and existing monitoring worker)

1. Pause new public checks (`PUBLIC_CHECK_ENABLED=false` on API), and let existing
   guest jobs finish. Preserve all old variables and image references securely.
2. On **both API and worker**, preserve `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
   `OPENAI_MODEL`, `ENABLED_PROVIDERS`, paid `API_BUDGET_CONFIG_JSON`, and all other
   settings. **Do not add Kimi to `ENABLED_PROVIDERS` or paid model mappings.**
3. In each existing `PUBLIC_CHECK_BUDGET_CONFIG_JSON`, append this `routes.kimi`
   entry. Preserve `routes.openai`, `routes.gemini`, all other route entries and
   existing aggregate caps. Both services must have identical guest config:

   ```json
   "kimi": {
     "transport": "openrouter",
     "model": "moonshotai/kimi-k3.1-pro",
     "searchEngine": "exa",
     "contextWindowTokens": 1048576,
     "maxInputBytes": 10000,
     "inputUsdPerMillion": 2,
     "outputUsdPerMillion": 10,
     "searchUsdPerCall": 0.007
   }
   ```

   This is a property fragment to append inside `routes`, not a replacement for
   the full JSON value. Existing caps below the documented minimum require an
   owner decision before activation. Existing Gemini entries stay for old jobs.
4. Add `PUBLIC_CHECK_PROVIDER_PAIR=openai,kimi` on **both API and worker**.
   Leave global `OPENROUTER_MAX_TOKENS` and search settings alone; the guest Kimi
   request uses its own fixed 3,000-token limit, Exa Auto search, two-search cap,
   one-step stop condition, low reasoning and forced search.
5. Update the existing **worker** image to the exact new worker tag/digest. Keep
   port 3001, command, credentials, database, scale and paid settings unchanged.
   Check `/healthz` revision equals the selected commit and `/readyz` is healthy.
6. Update the existing **API** image to the matching API tag/digest. Keep port
   3000, domains, command, database and all other variables unchanged. Check
   `/healthz` revision and `/readyz`. No migration flag is required by this patch.
7. Ensure the frontend handles `provider: "kimi"` as **Kimi**, never Gemini or
   Claude. Read provider names from capabilities/report data; retain Gemini labels
   for historical reports. This backend repo does not contain the production UI.
   Do not relabel old measurements or include no-grounding/truncated failures in
   scores. The new model label is `moonshotai/kimi-k3.1-pro`.
8. Once the budget decision and frontend check are complete, restore the previous
   API `PUBLIC_CHECK_ENABLED` value. `GET /api/public-check/v1/capabilities` must
   list exactly `openai,kimi`. An empty list is a configuration/budget blocker;
   do not repeatedly submit scans to diagnose it.
9. A fresh six-call production smoke check **incurs provider spend** and needs
   approval within the chosen budget. Verify successful cited results, provider
   and model identity, reports/progress and unchanged paid capabilities. Health
   and mocked CI alone do not establish live provider acceptance.

Rollback: pause public submissions; drain new Kimi jobs before reverting both
images and restoring the saved guest variables. Keep all reports and budget rows.
Old Gemini reports are unchanged; the new worker can still finish old Gemini jobs
when their route, credential and guest price entry remain configured. Do not
remove Gemini from global enabled providers as part of this rollout.
