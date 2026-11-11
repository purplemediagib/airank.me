# Three-route AI Rank research implementation

**Local preparation, not deployed or collecting.** Owner approved up to USD40 total including hosting, for an English/Finland API comparison. No new database, private storage namespace, remote branch or cloud resource has been initialized by this implementation task. All tests use isolated temporary fixture data and mocked network transports.

## Implemented
- New study identity `model-agreement-v01`; separate SQLite ledger and private storage prefix, with original Finland evidence untouched.
- 20 prompts ×3 endpoints ×3 rounds=180 planned answers; exact input hashes, balanced execution order and contiguous endpoint triples.
- Explicit request/parsing/accounting adapters for OpenAI Responses, Kimi via pinned OpenRouter provider, and Anthropic Messages. Candidates are not yet qualified or deployed.
- No model/provider fallback, no previous conversation context, no SDK retries.
- Integer micro-USD ledger, atomic unique claims, finite diagnostic/retry pools, all-in provider reservations.
- Immutable raw files and private snapshot archives; GET verification after upload; local logical ledger/raw/input fingerprint must equal the backed-up head before dispatch.
- Local exclusive lock and explicit singleton gate. **Not a distributed lock/CAS:** actual deployment must have one replica in one region, with sole ownership of its local ledger.
- Unknown transport charges retain their reservation and stop; no automatic retry while a previous cost is unknown. Content failures/empty outcomes cannot be rerun for nicer results.
- Models/provider mismatch, missing/unbounded usage, or charge above reservation stop future work. Accounting distinguishes provider-reported Kimi cost from conservative token/search-based OpenAI/Claude accounting.
- Pre-dispatch expiry/window checks happen after backup latency; known no-call expiry is recorded at zero cost.
- Narrow qualification→primary activation preserves the existing budget ledger and prior evidence; only release flags, qualified booleans and dates can change. A protocol/model/price/budget change cannot pass this activation path.

## Still blocked before any paid use
1. Exact request shapes, model/provider pin response identifiers and supported limits must be reviewed and qualified. In particular, OpenAI max_tool_calls does **not** establish a bound on all inference passes. `bound_verified` remains false.
2. Derive conservative token, reasoning, tool and other billable-unit bounds. No estimate or arbitrary reservation is a hard provider cap. Runtime guards detect excess but cannot undo a charge.
3. Claude credential availability and actual provider access are not verified. Inject secrets through the authorized host; never copy them into this folder, logs or chat.
4. Verify actual Bunny hosting/storage cost and external stop/undeploy mechanism. The manifest's allocation and expiry only stop provider work; **idle or exited/restarting containers can still bill**. Hosting gate stays closed until cost/lifetime is responsibly bounded within USD40 total.
5. Verify private storage, one region/replica, writable ephemeral /data ownership for uid10001 and verified recovery from private snapshots, current remote state, and new namespace. Old study markers and databases must not be reused/reset.
6. Review location policy: native location/search and Kimi+Exa differ. Requested and returned location metadata are preserved; a response configuration echo is not proof of a Finnish browser session. Qualify rather than claiming identical platform conditions.
7. Publish/build/deploy only after applicable authorization and review. No schedule is enabled, dates unset, all release gates closed.

## Commands
`python -m unittest -v test_runner` runs mocked tests only.
`python service.py validate` validates the inert draft, no network or secrets.
Default `python service.py` is idle and exits, no network or secrets.

After all gates are established, the supported lifecycle is explicit `init` of a fresh data directory/private marker, `preflight`, each approved stable-id `qualify`, evidence review, `activate` with a new immutable release manifest, and `scheduled`. Do not initialize a new ledger after diagnostics to discard their costs. Restarts resume the frozen state; missed windows are not backfilled. Recovery from stale/unknown state is deliberately manual, not an automatic ledger reset.

The prepared manifest is intentionally NOT live-ready. Candidate names are kept separately from null live model pins. Changing booleans is not a substitute for evidence. The USD30 providers/USD5 hosting/USD5 contingency allocation is a proposed partition of the approved USD40 ceiling, not evidence that the host or providers enforce it.


## Independent shutdown controller (offline artifact, NOT activated)
`shutdown_controller.py` runs **outside** the research container, on a separately verified scheduler. It accepts only the new study app ID/name and explicitly rejects the original Finland study plus both production IDs. It GETs the exact app, checks identity, POSTs only `/mc/apps/{appId}/undeploy`, then GETs and verifies a documented stopped status. It never deletes or redeploys. Already-stopped calls are idempotent. A timeout is followed by readback, not an immediate blind second POST. Unknown/still-running state fails loudly; an operator must respond. Credentials live only in the external controller's authorized secret store, not the research image.

API source: https://bunny.net/docs/api-reference/magic-containers/applications/undeploy-application
Pricing source: https://bunny.net/docs/magic-containers/pricing
Storage: https://bunny.net/pricing/storage/

`shutdown_policy_DRAFT.json` is inert. The actual GET response field names/status values and exact app identity must be verified before use; sample test fields are NOT assertions about Bunny's schema. No remote resource has been created or shut down.

Plan: use a new app with **no public IP and no persistent volumes**, one region/replica, verified CPU/RAM ceilings; use its ephemeral writable `/data` and private archive storage. A lost filesystem must be restored from the verified latest private snapshot and logical fingerprint, manually reviewed before dispatch. Never initialize a fresh budget ledger on restart. IPs and persistent volumes can bill even after undeploy and are excluded by design, not silently ignored.

The hosting calculator requires explicit verified CPU/RAM maxima, singleton, finite lifetime including shutdown grace, network byte cap, finite archive retention/size, controller costs, taxes, fees and rounding. CPU public headline rate is $0.02/core-hour; RAM $0.005/GB-hour; conservative network headline maximum $0.06/GB. All prices, units and actual account charges require verification. Calculator rounds memory to 64MiB blocks and up to whole hours, and archive retention to whole months. These are conditional upper bounds, not invoices. Logs, archive transfer and retry bytes must fit the network/storage caps. Storage retention must have a separately supported end policy; undeploy does not stop storage billing.

**A best-effort cron/API shutdown is not an absolute financial cap.** Scheduler outages, API outage and unavailable status can overrun a nominal deadline. Do not mark finite lifetime verified merely because cron exists. A verified provider-side spend/resource lifetime constraint or a defensible independently enforced maximum outage/termination bound is still needed. The external watchdog reduces risk; it does not make the approved $40 mathematically guaranteed. All runtime hosting/provider release gates remain closed.

Offline commands: `python -m unittest -q test_runner test_shutdown` (44 mocked tests). Controller defaults to dry-run; execution also requires a durable external receipt path. Its policy must be externally integrity-protected. It is intentionally not copied into the collection image. No production route, retrieval methodology or provider policy changes are introduced.
