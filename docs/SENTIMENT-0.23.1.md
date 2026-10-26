# Sentiment validation recovery (0.23.1)

An `INVALID_SENTIMENT_OUTPUT` report with analysis version
`8810e3aa17e67ce483d97a28b42179bf44a5b07256e0e718cef85c35f28ea188`
identifies the v2 rubric with `gpt-4.1-2025-04-14`. It is not a daily-budget
failure. That generic log cannot establish which validation check failed.

Previously a single brand's false absence, missing brand context or lack of
verifiable quotations discarded the complete response. Version 0.23.1 isolates
those failures: that brand is `unclassified` with null score and no quotes,
while other brands retain their independently validated assessments. Quotes
still have to match the original answer exactly. No fuzzy matching, invented
scores, additional model calls or automatic retries are introduced.

The result's affected assessment includes `validationReason`. The
`sentiment_saved` event includes `validation_issues` with brand IDs and fixed
reason codes. Structurally invalid responses (missing/unknown/duplicate brand
identities, invalid JSON) still fail with `INVALID_SENTIMENT_OUTPUT`, now with
a `validation_reason` in the log. Neither diagnostic contains answer or model
response text. `done` means processing is complete; consult each assessment's
status before treating it as scored.

The rubric is `brand-sentiment-quotes-v3`, so scores are not silently mixed
with old analysis versions. Deploy both API and monitoring worker at the same
new commit, then explicitly request re-analysis from the Results page for a
previous run. Existing failed jobs are not automatically repeated. No database
migration or sentiment environment change is required. Keep:

```text
SENTIMENT_MODEL=gpt-4.1-2025-04-14
SENTIMENT_TIMEOUT_MS=60000
SENTIMENT_MAX_DAILY_CALLS=unlimited
```

## Separate model configuration failure

`API_BUDGET_NOT_CONFIGURED` occurs when `API_BUDGET_CONFIG_JSON` is absent or
its `routes` object lacks the requested provider. Removing the daily cap uses
`"dailyUsd":null`; it does not remove the route entries. Install the complete
one-line JSON from `MODEL-EXPANSION-BUDGET.json` (the rollout configuration) in both API and monitoring worker and
redeploy. This JSON uses the operator-selected model IDs and conservative price ceilings; keep the matching routing settings from `MODEL-EXPANSION-0.23.0.md`. Check `routes.deepseek`, `routes.meta_ai`, `routes.mistral` and
`routes.kimi`. Restarted containers do not replay already skipped tasks; start
a new small run after correcting configuration.

The 0.23.1 regression tests cover target-score survival after invalid competitor
quotes, null scores for unverifiable claims, exact saved offsets, structural
failure diagnostics, absence of response text in logs and no duplicate paid
calls. Live re-analysis remains necessary to verify the original failing item.
