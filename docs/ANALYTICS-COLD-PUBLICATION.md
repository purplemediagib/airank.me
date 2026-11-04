# Bounded cold saved-analytics publication

## Scope

This change only optimizes `analytics/summary-store.mjs` publication. The calculator, source reads, query keys, authorization, immutable response shape, worker scheduling, and schema are unchanged. It does not add workers, caches, migrations, provider calls, or services.

The baseline is runtime `eac14d5521f38d5515c5e6df9d5d3395bb7616dc`. The existing synthetic profile's `b1b9c68` checkout has the same runtime source. The ten setup-specific builds still occur, including ten complete project-window source reads. This is a bounded reduction in their publication overhead, not a replacement for a future all-setup projection design.

## Design and bounds

- Generations with at most 100 evidence rows can publish inside one write transaction. The compact budget is at most 1 MiB: summary JSON bytes plus twice the encoded evidence JSON bytes, because both payload and evidence statements bind the data. SQL/transport framing and JSON escaping are additional bounded overhead.
- Encoding still processes at most 50 rows at a time. If compact eligibility overflows, it immediately releases the accumulated compact encodings and uses existing chunked staging instead. There is no cross-call retained state.
- The compact initial batch has at most five statements and 15 bind parameters total. Finalization has three statements and ten parameters. No SQL parameter list grows with evidence-row count; JSON arrays remain bound parameters.
- Larger generations keep 50-row staging transactions, releasing the database writer lock between chunks. The existing 4 MiB encoded-chunk rejection, 50,000-row publication limit, 5 MiB summary limit, and projector's 128 MiB raw-evidence preflight are unchanged. The compact eligibility limit is not a new hard rejection.
- Writes use ordered `transaction.batch`, never parallel transaction statements. A sequential fallback preserves compatibility with minimal local adapters. Installed `@libsql/client` 0.15.15 supports ordered batches inside the existing transaction, including its HTTP/Hrana path. Real local libSQL tests exercise both compact and staged publication and a failed batch rollback.

## Fences and failures

The initial and final guards retain project/query, current lease token, source revision, and fresh wall-clock expiry checks. The final evidence count must match exactly before updating the head. The finalization transaction checks time again after its write batch, rolling back if the lease expired during the batch. The SQLite writer lock prevents concurrent source or lease-token changes inside that transaction.

The compact path rolls back all newly inserted generation, evidence, and payload rows on batch/constraint failure, count mismatch, definite commit failure, or a final fence failure. The staged path preserves existing behavior: unpublished references are deleted after failure and unreferenced staged payloads are removed by bounded cleanup. Previous published generations remain readable.

If a commit succeeded but its response was lost, cleanup still deletes only generations with `published_at IS NULL`. It cannot delete a successfully published generation or its pinned evidence. No automatic replay is introduced. Fresh source-change requeue logic cannot clear another worker's lease.

Authorization remains at the current read and calculator boundaries. No cached source rows, shared query result, or cross-project memory is introduced.

## Validation

Node 24.22.1:

- Backend: 603/603 tests passed.
- Summary integration: 34/34 passed, including guest/workspace revocation, project/generation isolation, exact canonical parity, immutable pagination, source changes, large staging interruption, and compact row/byte boundaries.
- Added regressions cover count mismatch; expiry during staging, after the guard read, and during final writes; definite and uncertain commit failures; payload rollback; and the inherited per-chunk byte rejection.
- Actual local libSQL 65-row compact and 105-row staged generations match canonical responses and paged evidence. A duplicate-row batch failure leaves the previous head and all table counts unchanged.
- Google connector: 17/17 tests passed.
- API, projector, and `@libsql/client/web` runtime import smoke test passed. `git diff --check` passed.
- Independent safety review found no blocking issue.

No remote database, provider, deployment, migration, push, or production load test was used. Node 22 and Docker were not run in this environment.

## Reproduction and interpretation

From the repository root, with local dependencies installed:

```sh
node app/scripts/cold-preparation-profile.mjs 0
node app/scripts/cold-preparation-profile.mjs 150
node app/scripts/cold-preparation-profile.mjs 150 /absolute/baseline/app/src/analytics/summary-projector.mjs
```

The harness uses ten synthetic setups, ten runs, and 840 tasks, with the real calculator, Overview builder, and publisher. Output is anchored to the fixture UTC day while lease time advances by actual elapsed time. It records phase times, execute/batch/transaction operations, SQL statement counts, peak process RSS, and a SHA-256 digest of each complete saved summary (including UI) and ordered evidence. Generation IDs and storage timestamps are not part of that digest.

The 150 ms delay is injected per adapter operation, including transaction begin/commit. It is not a capture of actual HTTP requests: libSQL may pipeline transaction setup or use protocol-specific requests. Results establish fewer awaited adapter operations and identical output on this fixture, not a guaranteed production speedup. Zero-delay single-run timing and peak RSS are illustrative, not statistically robust benchmarks.

### Recorded local result (4 November 2026)

| Fixture measurement | Baseline | Optimized |
| --- | ---: | ---: |
| 150 ms delay: all ten projections | 65.552 s | 37.028 s |
| 150 ms delay: publication phase | 37.911 s | 10.605 s |
| Adapter operations, including begin/commit | 480 | 300 |
| Transactions begun | 50 | 20 |
| SQL statements | 380 | 320 |
| Complete project-window evidence reads | 10 | 10 |
| No injected delay: all ten projections | 919 ms | 925 ms |
| Peak process RSS, 150 ms fixture | 167,500 KiB | 186,640 KiB |

The delayed run improved 43.5% overall and 72.0% in publication. All ten complete output digests match exactly at both delay settings. The largest observed batch was five statements, 15 bindings, and 610,116 bytes of JSON-serialized arguments. The no-delay 6 ms difference and RSS variation show why this should be described as a latency/round-trip optimization, not a CPU or peak-memory improvement.

The compact path keeps the writer lock through its bounded small generation instead of releasing it between stages. At 150 ms per adapter operation its publication transaction spans roughly 1.05 s rather than four shorter transactions totaling roughly 3.8 s; real lock duration depends on the database protocol and latency. Larger cases still release the lock between chunks. This trades a longer individual small transaction for much less total publication time; it needs a real HTTP smoke and modest concurrent-write check before any later production rollout. No such rollout is authorized or included here.
