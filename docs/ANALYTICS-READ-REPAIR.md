# Analytics read performance repair

Prepared against source revision `33420b5e74e4b1cea0d7b96427a7f0a11f6ccc45`.

## Scope

- Keep authorization, filters, comparison window, frozen measurement groups,
  metrics, full-data denominators and response format unchanged.
- Restrict sentiment reads to the same **run-created-at** window already used
  for tasks and evidence, including the prior comparison period. With no date
  filter, all history remains included. Job creation/analysis time is not used.
- Index sentiment rows once per response. Keep the first configured-version
  row, otherwise the first historical row, exactly as the previous array search.
- Add `mon_evidence(run_id)`, `intelligence_jobs(analysis_version,run_id)` and
  `mon_runs(project_id,created_at,id)` indexes through a new additive migration.
  Historical migration definitions and checksums are unchanged.
- No provider, worker, billing, credentials, cache, schema removal, data backfill
  or frontend changes. No dashboard read performs a database write.

Source-schema SQLite query plans previously scanned the entire evidence and
intelligence-job tables. The new indexes produce selective lookups instead.
This identifies scalability defects, **not the verified cause of a particular
production HTTP error**. Production exceptions and timings were not available.

## Verification

Node 24 local results:

- Full backend suite: 510 passed.
- Google connector suite: 17 passed.
- Production dependency and service imports passed.
- Independent review: 10 tests passed, including 46 full analytics/results
  response comparisons against frozen baseline source, sentiment fallback,
  midnight boundaries, denied access, unfinished-task denominators, query plans,
  migration rollback, idempotency and checksum-drift rejection.

Docker images and Node 22 were not available locally. Required CI remains the
Node 22/24 test matrix and production image build/import checks. All fixtures
were synthetic and local. No production reads/writes, secrets or paid calls
were used for implementation or testing. Local results do not establish live
latency, production schema state or that the reported failure is resolved.

## Controlled rollout, only after authorization

1. Confirm the running API revision and check the failing request status/body.
   Ensure the image is based on the intended production branch, not older main.
2. Pass the repository's CI/build checks. Keep the current image reference and
   normal database backup available. Preserve all runtime settings and secrets.
3. The new migration requires the existing monitoring and intelligence tables
   (migrations 003 and 015) and `app_migrations`. Confirm those prerequisites.
4. Choose one explicit migration path: run
   `node src/analytics/read-migration.mjs` as an operator, or temporarily set
   `AIRANK_RUN_ANALYTICS_READ_MIGRATION=true` on the new API image. The latter
   works with either API entrypoint, and runs before accepting requests. The CLI
   prints `Applied app-026-analytics-read-indexes`; the startup path prints
   `AI Rank analytics read indexes verified.` Remove the opt-in afterward.
   Never enable the broad app migration flag merely to install these indexes.
5. Verify `/healthz` revision, readiness, index presence and query plans. Repeat
   the previously failing authenticated analytics request without starting new
   scans. Verify HTTP 200, unchanged response fields/counts, and acceptable
   end-to-end timing under the same filters. Check both current and comparison
   period metrics and an unauthorized request before calling the issue fixed.

Index creation can take a database write lock and use storage proportional to
table size. Plan the migration according to live table sizes and database load.
It is transactional: failures roll back partial indexes and do not record a
successful migration. Repeating a successful migration is a no-op.

Rollback can use the prior API image. These additive indexes may remain; do not
drop data or rewrite prior migration records to roll back application code.

The window optimization relies on the existing invariant established by normal
writers: a sentiment job's `run_id` is the run of its referenced evidence. If
manual imports ever violated that invariant, reconcile them before rollout.

## Remaining diagnostic limits

The API still maps unexpected application exceptions to `SERVICE_UNAVAILABLE`.
This patch does not guess at the cause of such exceptions or mask failures with
partial metrics. Add sanitized request/stage diagnostics separately if the live
request still fails. Group-filtered results also still invoke analytics before
pagination; a separate refactor can avoid that repetition after this narrow
repair is validated.
