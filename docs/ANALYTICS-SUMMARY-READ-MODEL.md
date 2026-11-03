# Analytics summary read model, staged implementation

This implementation is local and feature-gated. It is not a production deployment,
SLO guarantee, or proof that all analytics screens now use the new read path.
It builds on the exact 33420b5 production source snapshot and the separate
analytics read-index repair. Existing `/analytics` and `/results` remain unchanged
for callers not explicitly migrated. The only canonical change is passing the
already supplied environment into `readIntelligence`, so output configuration
matches the cache fingerprint rather than implicitly reading another environment.

## What ships

- `GET /v1/projects/:id/analytics/summary`: existing summary fields without the
  top-level `evidence` array, exact `overview-ui-v1` display projections, and
  freshness metadata. Requires finite UTC `from` and `to`, at most 366 days.
- `GET /v1/projects/:id/analytics/evidence`: full-selection search, the existing
  seven evidence predicates, exact frozen-brand drilldown and bounded pages.
- `GET /v1/projects/:id/analytics/evidence/:id`: selected result, zero-based
  index, total, previous/next IDs and the cursor for its list page.
- Dedicated `analytics` Docker target / `npm run start:analytics`. It only reads
  saved evidence and writes deterministic projections. It does not run monitoring,
  provider calls, sentiment calls, entity calls or paid collection.
- Operator-only, checksummed `app-027-analytics-summary-read-model` migration.
  No request, import or worker startup applies schema changes.
- API feature gate `AIRANK_ANALYTICS_SUMMARY_ENABLED=true` and separate frontend
  gate `VITE_AIRANK_ANALYTICS_READ_MODEL=true`. Both default off outside the new
  dedicated projector image. The frontend gate must not be enabled before readiness.

## Consistency and access

Every request uses the existing session and current project authorization before
reading a cached object. Existing report bearer tokens deliberately cannot call
these new routes; their old scope stays unchanged. Account-scoped frontend cache
keys and cancellation remain required. Project IDs and generation IDs are not
access controls; no browser receives a database or Bunny Storage token.

Canonical source-table INSERT/UPDATE/DELETE triggers atomically increment the
owning project's revision. Exact no-op updates do not churn revisions. Budget
state and unrelated tenant activity do not invalidate every project. Source row
moves invalidate both old and new owners. Source migrations affecting intelligence
availability invalidate all affected projects. Build revision, extraction version,
sentiment/entity configuration and enabled states are in the format fingerprint.
API and projector must use the same executable and output-affecting configuration.
UTC midnight also invalidates time-dependent daily trend points.

A transactional lease admits one worker for a query. Workers calculate canonical
analytics off the request path, build exact UI projections once, then stage data
in bounded 50-answer transactions. Immutable full-answer payloads are content-
addressed and shared across generations and filters. Each staged generation is
invisible. A final short transaction checks lease ownership, current time, complete
page count and unchanged source revision before publishing its pointer. A stale
worker or a source mutation cannot publish an inconsistent generation. Payload
insertion and references are atomic so garbage collection cannot race deduplication.

Warm reads do not query raw `mon_*` evidence. An old valid summary can be returned
with `isStale: true` while a replacement builds. Evidence requests stay pinned to
one immutable generation and run in a read transaction, so counts, cursor pages
and drawer neighbors cannot mix generations or race expiry cleanup. Permission
revocation still applies immediately on the next request, including old generations.
Pinned evidence represents saved snapshot data and can therefore precede a later
source correction; metadata identifies staleness. It is not a live row view.

## API details

Ready summary, status 200: canonical non-evidence fields plus `ui` and `readModel`.
The latter contains:

```
{schemaVersion: 'analytics-summary-v1', state: 'ready', generation: '<UUID>',
 sourceRevision: 123, generatedAt: 1793707200000, expiresAt: 1793793600000,
 isStale: false, evidenceCount: 1680}
```

Times are epoch milliseconds. `ui.version` is `overview-ui-v1`. The UI projections
preserve the previous UI's observedAt scoping, daily denominators, diagnostic
handling and raw weekly timestamp behavior. They do not silently fix numerical
inconsistencies between the previous headline and daily chart semantics. That
requires a separate, explicitly reviewed metric-contract change.

A cold query returns status 202 with `retry-after: 3` and
`{state:'preparing',retryAfterSeconds:3,readModel:{schemaVersion,state:'preparing',isStale:false}}`.
It enqueues deterministic work, never raw synchronous fallback or a new paid scan.
Unknown project/filter semantics are validated by the canonical calculator in the
background and surfaced honestly on the next read. A failed cold projection returns
503 `ANALYTICS_BUILD_FAILED`, not a permanent "preparing" state. Retriable jobs use
bounded backoff. Permanent filter/capacity failures wait for a changed source revision
instead of repeatedly recomputing the same invalid query. Exception bodies, secrets
and answers are never persisted as errors.

Evidence query: `generation` required, optional `cursor`, `pageSize` (1–100), `q`
(up to 200 characters), `filter` (all/mentioned/recommended/cited/ordered/first/excluded),
`evidenceBrand` (exact frozen name). Ordering is observedAt descending, ID ascending,
identical to the previous UI. Search preserves field boundaries and Unicode casing.
The opaque cursor binds generation and all selection predicates.

List body: `{items,total,pageSize,offset,nextCursor,previousCursor,hasMore,generation,readModel}`.
`offset` is zero-based. `previousCursor:null` means the preceding page is the first
page when offset > 0, and there is no preceding page when offset = 0.
Detail body: `{item,index,total,prevId,nextId,pageCursor,generation,readModel}`.
`index` is zero-based. `pageCursor:null` points at the first page.

Expired/config-incompatible generations return 409 `ANALYTICS_GENERATION_EXPIRED`.
Missing/foreign generations return 404. Unknown cursors return 422 `INVALID_CURSOR`.
All responses are private/no-store. No CDN is required for this phase.

## Work and retention limits

- At most 64 active query variants per project and format revision; 7-day demand
  retention. Concurrent admission and expired-demand reactivation enforce the cap.
- Optional `AIRANK_ANALYTICS_PREWARM=true` admits each active project's default
  trailing-28-day window in bounded batches at startup/UTC day rollover. Common
  nondefault filter selections are admitted on first use. There is no claim that
  arbitrary unseen filter combinations are instantly precomputed.
- Up to 50,000 raw rows and 128 MiB of source JSON in the full current/comparison
  window; 5 MiB serialized summary and 4 MiB per staging batch. Exceeding limits
  returns `ANALYTICS_PROJECTION_LIMIT`; it never truncates a population or returns
  misleading zeros. These are safety limits, not a capacity target.
- Leases last 10 minutes and renew during staging. Published generations last
  24 hours; failed/crashed staging expires after its lease interval. A bounded GC
  removes expired generations and unreferenced payloads. Active pinned snapshots
  are not removed simply because demand retention elapses.
- Scale projector processes independently of the API. Each claims a different
  query and CPU work is isolated from API request serving. Projector health probes
  allow 30 seconds because that separate process can be CPU-busy while aggregating. This phase materializes
  requested query windows, not fully incremental per-run/day facts. Real write
  throughput, worker pool size and refresh lag still need hosted load tests.

## Deployment plan and explicit gates

1. Review the code and final Node 22/24 tests, Docker build/import tests and frontend
   tests/build. Local Node 24 success does not replace hosted CI or Docker testing.
2. Review DB backup/restore and migration locks. Apply read indexes via
   `npm run migrate:analytics-reads`, then `npm run migrate:analytics-summary` to an
   approved staging database first. Never enable the broad historical migration
   runner merely to obtain these two additive migrations. Worker startup checks
   the exact read-index migration checksum.
3. Publish reviewed API and analytics-projector images from the same exact commit
   to the intended production branch lineage. Existing manual deployment still
   applies. A new projector service and persistent DB access require the appropriate
   deployment/access approval; this implementation grants neither.
4. Configure the existing server-only DB access, matching output configuration,
   API summary gate, projector gate and optional prewarming. Do not give shared DB
   credentials to Lovable browser code. Verify `/readyz`, build revision, prewarm
   coverage, queue age, error counts and representative snapshot revision parity.
5. On staging, exercise 200 varied tenants with 90/365 days, realistic answer sizes,
   1/10/50 concurrent reads, writes during reads/rebuilds, worker crashes, revoked
   members, invalid filters, large-tenant limits, expiry and rollback. Verify the
   frontend makes no legacy all-group evidence fanout in enabled Overview mode.
6. Enable the frontend gate for a small approved canary, check authenticated
   end-to-end p50/p95/timeout rate and user-visible freshness, then expand.
   Proposed acceptance goals remain p95 server summary under 500 ms, usable view
   under 2 seconds, and p95 refresh lag under 60 seconds under specified load.
   These are not measured production results. Summary bytes currently exceed the
   original 100 KB aspiration because canonical source/intelligence metadata and
   evidence ID lists remain intact; separating those drilldowns is further work.
7. Roll back the frontend/API feature gates and projector image independently.
   Existing raw routes remain available for deliberate rollback, not automatic
   timeout fallback. Additive tables/triggers may remain until an explicit cleanup
   migration is reviewed. Never permanently delete stored evidence as rollback.

Bunny per-client files can later serve immutable downloads under authorization.
A folder name is not tenant isolation. They do not replace project authorization,
source revision invalidation, filtered queries or the projector.
