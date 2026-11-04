# Redacted provider failure stages

Local preparation based on Gibraltar locale commit
`9c6e4444e854f0c9e1131e57e95f541901bcfb19`. This follow-up changes diagnostics,
not flags, provider budgets, supported markets, retries, migrations or queue
policy. No remote write, deployment, production inspection or provider request
was performed. The prior locale correction is preserved.

## Entity analysis

The existing timer now reports the structured event
`entity_analysis_unavailable`. It includes only `failure_stage`,
`diagnostic_code` and a bounded numeric `http_status` when present.

Stages distinguish database client creation, migration query, migration checksum
validation, engine initialization, automatic queue seeding, job claiming and
otherwise-unclassified tick failure. Nested stage details survive outer wrappers.
The startup `worker_configuration` event also reports the non-secret boolean
`entity_analysis_enabled` for comparison with API/projector state.

Error codes are mapped through a closed list to categories such as
`DATABASE_BUSY`, `DATABASE_LOCKED`, `DATABASE_UNAVAILABLE`,
`DATABASE_AUTHENTICATION_FAILED`, `DATABASE_QUERY_FAILED`,
`DATABASE_TRANSACTION_FAILED`, `TIMEOUT`, or `OPERATION_FAILED`.
A failed migration checksum uses the fixed `MIGRATION_NOT_READY` code.
Unknown exception codes are never copied. The installed libsql client wraps
Hrana HTTP errors; only a bounded numeric status on the exception or its immediate
cause is retained, never the message/body.

The disabled flag, busy gate, missing-credential wait, count-budget wait,
provider-failure recording and uncertain paid-job no-replay behavior remain
unchanged. These ordinary states do not emit the new timer failure event.
Existing result-persistence recovery is unchanged. There are no new retries.

## Collector catalog preflight

Catalog failures retain the original status and
`COLLECTOR_LOCALE_CATALOG_UNAVAILABLE` failure code, adding:

- `failure_stage`: `collector_locations` or `collector_languages`.
- `diagnostic_code`: closed classification for HTTP rejection, supplier
  rejection, invalid response, oversized response, timeout, abort or network
  failure; unknown errors become `OPERATION_FAILED`.
- `http_status`: integer 100–599, when available.
- `upstream_error_code`: supplier status 10000–60000 only, represented as a
  numeric string for the existing metadata contract.
- `submission_attempted: false`, now preserved by the safe metadata allowlist.

The runner emits `collector_preflight_failed` with these sanitized fields and
the already-logged `task_id`. It adds no project identifier or account metadata.
The same diagnostic fields are persisted with the evidence. Logging failure
cannot block its persistence. Existing failed records are not backfilled.

The same two catalog GETs occur, with the same caching and timeout behavior.
There is no new GET retry, task POST, fallback locale or replay. Unsupported
market/language and disabled/budget states do not trigger this catalog alarm.

## Privacy boundary

The common diagnostic helper accepts only fixed stages/codes and bounded numeric
statuses. It never serializes the original exception, stack, SQL, provider body,
headers, URL/query string, prompt, answer, email or credential. Original error
details are not attached to the replacement diagnostic exception. New log fields
cannot be populated by arbitrary supplier text. Provider credentials used by the
existing request are not changed or logged.

## Confirmed operational context

At deployed worker commit `33420b5e74e4b1cea0d7b96427a7f0a11f6ccc45`, the
observed entity warning can execute only with the worker's enabled flag true.
The displayed API/projector state is false. This disagreement is established;
the underlying execution error is not. Shared database trouble is plausible,
not proven. This patch is intended to distinguish it from migration or queue
errors after a separately authorized release. Do not flip flags or rerun
migrations just to collect diagnostics.

The inspected Meta AI result exhausted its actual 4000-token allowance, including
2205 reasoning tokens, on one HTTP 200 response. Its partial answer remains
correctly excluded. No cap increase or automatic replay is part of this work.

## Validation and deferred work

The regression suite covers malicious raw error text, unknown codes, malformed
and oversized supplier responses, stream/network errors, HTTP and numeric
supplier statuses, persisted metadata, logger failure, stage propagation and
silent disabled/missing-key/budget states. Provider traffic uses injected mocks
and all databases are local fixtures. Final Node 24.22.1 validation:

- Backend aggregate: **608 passed, 0 failed**.
- Google connector aggregate: **17 passed, 0 failed**.
- Runtime/dependency imports, changed worker/client syntax and whitespace checks
  passed.
- Independent read-only review, including the final wrapped-status and silent
  wait-state assertions: no blocking findings. The reviewer did not claim an
  independent test run.

The new event format and its log-view filters have not been verified on Bunny.
No live configuration values, supplier access, migrations or runtime fixes are
established by these tests. Historical generic failures cannot be reconstructed
retroactively. Node 22 and Docker/hosted CI remain separate validation steps.
