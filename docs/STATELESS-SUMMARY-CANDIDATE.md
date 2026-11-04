# Saved analytics fixed-stream candidate

Offline candidate, 2026-11-04. This is not provider acceptance or deployment evidence.

## Transport and transactions

`summary-transport.mjs` constructs a dedicated adapter from the configured database URL only. It normalizes HTTPS/libsql roots to that origin's `/v2/pipeline`, sends one POST containing `baton:null`, a conditional batch and `close`, sets redirects to `error`, and never adopts `base_url`. It does not implement interactive transactions or fall back to common/db. Shared source reads through this adapter use fresh `BEGIN` snapshot batches. Store writes use `BEGIN IMMEDIATE`, SQL real-error assertions, conditional COMMIT and conditional ROLLBACK. There is no statement-at-a-time publication traffic.

Acknowledgements require a closed stream, exact pipeline and statement slot counts, coherent success/error chains and expected assertion/renewal rows. Bounded fatal UTF-8 decoding rejects duplicate JSON object keys, including escaped aliases. Provider text and URLs are not propagated in errors. Named row decoding rejects missing, empty or duplicate names and unsafe integers. Claimed job metadata and renewal deadlines are validated after acknowledged mutation; invalid semantic results remain unknown rather than triggering failure writes.

Local limits are 36 MiB serialized request and 16 MiB response. These are application policy limits, **not verified Bunny HTTP limits**. Publication preparation caps 50,000 rows, 5 MiB summary and 4 MiB per 50-row encoded chunk, with a 1 MiB/100-row compact threshold counting all four evidence parameter copies. It snapshots evidence before awaits but does not retain all encoded chunks. A source read that exceeds 16 MiB produces the explicit permanent-for-current-revision `ANALYTICS_PROJECTION_LIMIT`, without truncation or publication. Consequently the effective source capacity is below the older 128 MiB preflight bound for some datasets. Paginated source reading is separate unfinished work.

## Durable uncertain-outcome containment

Before compact publication or stage setup, an acknowledged atomic transaction stores `ANALYTICS_PUBLICATION_UNKNOWN:<generation UUID>` in the existing request `last_error`. No schema migration is introduced. The write checks exact token, valid DB lease and revision under the writer transaction. A delayed intent cannot capture a replacement lease.

Publication guards require the same exact marker and token. Final publication swaps the head, publishes generation metadata and clears the marker/request lease together. Every store mutation guards against any pending marker under its own transaction. This deliberately serializes publication intents globally for this candidate. Peer workers pause; the worker that observes ambiguous mutation output latches blocked and performs no subsequent claim, failure, cleanup, requeue or retry.

Only a complete acknowledged rollback/not-started permits an explicit guarded abort. Abort matches exact token and generation marker and clears/requeues the request without deleting any staged data. If abort itself is ambiguous, dependent work stops. Acknowledged older stage rows remain unpublished and are removed later by normal bounded expiry cleanup. Unknown results never trigger eager cleanup or a negative-read recovery inference.

Restart containment relies on the database retaining acknowledged writes and providing the documented transactional writer ordering. It is not an independent journal and cannot protect against provider failover losing acknowledged intent under its RPO. Absence in an unordered/replica read is never proof of rollback. Operator reconciliation must use primary-ordered positive evidence and generation identity; automatic reconciliation is not implemented.

**Rollback gate:** do not restore any marker-unaware worker while markers may exist. Stop writers, preserve the quarantine-aware guard/claim/cleanup exclusions, and investigate first. Candidate legacy/local compatibility branches include marker guards, but earlier marker-unaware versions do not acquire those protections retroactively. Normal source writers are not modified by this candidate.

## Clock and pinning

Fixed store claims, renewals, demand age, retry admission, expiry cleanup and publication use the same SQLite millisecond UTC expression. Host time is not used for fixed-store lease or expiry decisions. Read-side snapshots use the same expression. The compatibility path retains injected host clocks only for existing local tests; production API/worker composition explicitly selects the dedicated adapter.

The last SQL fence checks the previous lease deadline after publication writes and rolls back on expiry. It does **not** promise physical COMMIT completes before that deadline. Generation publication TTL is assigned within SQL; old unexpired published generations remain available by immutable ID even after a newer head wins. Aborted staged generations never become heads.

## Offline measured request counts

The actual HTTP adapter was exercised against a no-network SQLite Hrana-condition fixture with synthetic content:

- Publication, 0 rows: 2 POSTs (intent + compact), maximum request 8,598 bytes.
- Publication, 100 rows: 2 POSTs, maximum request 336,562 bytes.
- Publication, 101 rows: 6 POSTs (intent + setup + three stages + final), maximum request 170,331 bytes.
- Warm/no-op demand: 1 POST, 3,279 bytes.
- Idle claim: 1 POST, 3,501 bytes.

These are publication/store counts, not total projector request counts or live latency. Worker readiness, schema checks, source queries and explicit DB clock reads add requests. Worker idle cadence/backoff is owned by the worker. No live performance or upper payload acceptance is established here.

## Verification boundaries

Local tests cover compact/staged publication, SQL failure at every compact statement, old lease expiry after head swap, immutable input, existing pinned evidence, strict acknowledgements, duplicate keys, bounded decoding, malformed semantic results, lost intent/setup/stage/final acknowledgements, restart quarantine, guarded abort uncertainty, source churn, retained stage expiry and exact HTTP request counts. SQLite fixtures model transaction semantics; they do not establish Bunny request/statement limits, timeout behavior, replication durability, acceptance of largest intended payloads or deployment health. Separate bounded synthetic provider acceptance and whole-application checks remain required.
