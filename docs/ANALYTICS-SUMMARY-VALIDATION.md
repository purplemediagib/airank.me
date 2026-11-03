# Local summary implementation validation

Local only, not deployed. Node 24.22.1; no production DB, provider calls, paid scans,
secrets, production migration or publication. Node 22 and Docker unavailable locally.
Hosted CI, remote libSQL HTTP and authenticated browser end-to-end remain gates.

## Correctness

Full backend: 578 tests, including 34 migration, 25 integration and 9 UI projection
checks. Google connector: 17 tests. Production imports/syntax/whitespace pass.
Actual local @libsql/client file-backed staging/publication/read test passes.

Covered: full canonical summary/evidence parity; exact UI formulas; warm cache
revocation and cross-project isolation; bearer-token denial; 70 search/filter/brand
combinations; cursor/generation binding; drawer neighbors; unfinished denominators;
configuration/midnight changes; between-chunk source mutation; lease expiry;
failed chunk/final commit; invisible staging; two-connection read/GC race; immutable
payload deduplication; retention; demand cap/reactivation; permanent-error backoff.

## Dataset and observations

200 synthetic tenants × 90 runs × 20 prompts × 3 providers: 18,000 runs and 1,080,000
rows EACH in task/evidence/sentiment/intelligence tables. The measured tenant has
5,400 full answers, frozen two-brand cohort, 3 citations and retrieval metadata.
Other tenants have placeholder answer JSON: realistic cardinality, not realistic
multi-tenant payload/IO. 28 current + 28 comparison days read 3,360 raw answers and
produce 1,680 selected answers. Local disk SQLite/WAL/64 MiB cache. No HTTP/network,
proxy/TLS/browser latency. Shared execution environment makes small timing
comparisons between cases insignificant.

| Observation | ~ 913-char answers | 20,000-char answers |
|---|---:|---:|
| Legacy JSON bytes |6,102,922|38,168,242|
| Summary JSON bytes |367,589|367,593|
| Cold 202 response ms |1.90|3.17|
| Background compute +  staged publish ms |1,394|6,999|
| 25-answer page ms |2.08|3.73|
| Full-selection search ms |5.99|61.80|
| Warm 1-overlap observed p95 ms, 4 samples |3.52|4.20|
| Warm 10-overlap observed p95 ms, 40 samples |53.84|46.43|
| Warm 50-overlap observed p95 ms, 200 samples |260.94|174.42|

Concurrency is overlapping promises within one process/local DB, serialization
included, not distributed HTTP load. Small-sample percentiles are not production
SLOs. Every canonical summary field, UI projection and all paged answers deep-equal
the legacy calculation. Equivalent rebuild retained 1,680 payloads rather than
copying full answers again. Cumulative benchmark RSS ~362/821 MiB retains baseline
and projected data for equality checks: not isolated projector peak memory.

## Remaining gates

This proves the implemented read path avoids full-answer recomputation/transfer
for Overview while preserving exact selection and current authorization. It does
not prove 500 ms hosted p95,2 s usable page, 60 s refresh lag, or 200 concurrently active
clients at any particular worker count. Rich projection still needs ~7 s offline
per newly calculated query. Burst invalidations need a measured worker pool;
incremental per-run/day facts remain a further efficiency phase.

Summary ~368 KB exceeds the initial 100 KB aspiration because canonical source and
intelligence metadata remain intact. No fields were silently truncated to meet a
size goal. Hosted read/write load, source lag, queue recovery, worker memory and
browser behavior must be measured before feature-gate rollout.

Benchmark scripts, JSON results, logs and the synthetic SQLite fixture are in the
accompanying read-model validation artifact directory. They are not production data.
