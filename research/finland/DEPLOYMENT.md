# Isolated container handoff — not deployed

## Recommended production shape

Use a new **research-only** container on the owner's existing Bunny account, once capacity/cost is confirmed. Do not change the public checker, its scheduler or API permissions. Prefer one-shot execution for each approved block; only enable an internal schedule after restart/durability and single-writer behavior are proven.

An ordinary ephemeral container filesystem is **not** durable research storage. Two safe choices:
1. Confirm Bunny supports a durable private mounted volume suitable for SQLite WAL and one writer. Then mount `/data/research`, persist SQLite plus raw files there, and back up externally.
2. If no such volume exists, implement a separate research schema in an approved transaction-capable external database (the existing app source uses libSQL, but account access/reuse is not authorized or verified here), and private object storage for raw files. Object storage alone is not a transactional ledger or distributed lock. Do not pretend SQLite upload/download solves concurrency.

Current code implements option 1 locally. Option 2 requires a database adapter and atomic reservation/claim tests before live use. Existing production tables must not be reused or migrated implicitly.

## Container artifact

Local Dockerfile: `/workspace/shared/airank-finland-runner/Dockerfile`.

Proposed local image name: `airank-finland-research:v0.2` (**not a published image URL**). Build command, after selecting an authorized build environment:

```
docker build -t airank-finland-research:v0.2 .
```

Default entrypoint runs offline tests. No image build, registry push, provider execution or scheduling has happened. Shipping a live entrypoint before billing/route gates are resolved would hide a substantive blocker, so it is intentionally absent.

## Environment/secret references for secure setup

- `OPENAI_API_KEY`: existing authorized provider credential securely injected; never printed.
- `OPENROUTER_API_KEY`: existing authorized provider credential securely injected; never printed.
- `RESEARCH_DATA_DIR=/data/research`: only after durable mount verification.
- `RESEARCH_MANIFEST=/research/release_manifest_FROZEN.json`: signed reviewed configuration, not draft.
- `RESEARCH_MAX_TOTAL_USD=38`: single shared allowance including diagnostics/retries; lower runtime bound may be used, never higher implicitly.
- Optional external DB route would require separately authorized `RESEARCH_DATABASE_URL` / `RESEARCH_DATABASE_AUTH_TOKEN`, not production credentials casually copied into the task.
- Private artifact storage credentials only after exact storage route is verified; avoid inventing environment names for an unchosen adapter.

This list is a handoff, not a request to paste secrets in chat. Creating new credentials, adding persistent access, or changing security/network settings needs explicit per-action approval through secure setup. Existing credential reuse must be authorized and scoped. No credentials were read by this task.

## Proposed schedule after gates

October 31, November 2, November 6, 2026; blocks 08:00 and 14:00 UTC (10:00 and 16:00 Helsinki). If gate completion misses a start, shift the schedule before freeze; never backdate collection. Each block has 24 slots per endpoint / 48 total, with adjacent Finnish/English pairs. Schedule file is a draft, not cron activation.

## Minimum owner action

Confirm a research-only container on existing Bunny capacity, with verified durable storage or approved isolated transactional DB, and securely inject the existing provider credentials. If that cannot be established, the tool-discovered laptop is connected but not authorized for tasks and would require explicit authorization; it is not the preferred unattended host. Do not purchase hosting or change plans under the $40 model-usage allowance without separate cost approval.

## Independent blockers even after secure setup

Fluent Finnish review; exact model availability and response schema qualification; verified all-billable request bounds (Kimi server-side search loops currently unresolved); finalized shared ledger integration; billing reconciliation; immutable crash-safe evidence; independently reviewed frozen manifest. A $40 owner allowance does not prove a provider request cannot exceed its reservation.

## Verified Bunny resolution — supersedes earlier uncertainty

Official documentation checked 30 October 2026:
- Persistent volumes exist and survive restarts/redeploys: https://bunny.net/docs/magic-containers/persistent-volumes
- **Caveat:** node-bound disks; scale-down/up may provision new empty storage instead of reattaching. Hardware replacement can lose data. There are no automatic backups or replication. Therefore hold one replica in one European region throughout the week; disable autoscaling/autoprovisioning beyond that instance. Do not stop/recreate between daily blocks merely to save pennies. Require an initialized-study marker and halt on a missing ledger; never auto-create an empty live budget on restart. Back up through SQLite backup API to private external storage after each reconciled attempt/block, with hash verification.
- Volume price $0.10/allocated GB-month, including detached volumes. Minimum size is **not specified** in the reviewed official volume/limits documentation; propose the smallest UI-accepted size, ideally 1 GB, but do not claim 1 GB is confirmed minimum.
- CPU billed on actual core-seconds at $0.02/core-hour. RAM $0.005/GB-hour, 64 MB increments, with variable system overhead. Europe egress $0.01/GB. No Anycast IP is needed (it would cost extra). Source: https://bunny.net/docs/magic-containers/pricing
- Illustrative—not a quote/cap—seven days at 256 MB billable RAM = $0.21; one total CPU-hour = $0.02; 1 GB volume for a full month = $0.10; 1 GB European egress = $0.01. Total illustrative $0.34, excluding backup storage/tax and any higher actual usage/minimum allocation. Approve a separate small hosting allowance only after UI confirms account allocation; the $40 is model usage, not implicit hosting authority.
- Nonzero exits trigger automatic restart; stop signals 137/143 are treated as intentional. Do not assume a one-shot process means the whole app is undeployed or storage billing ends. Explicit Undeploy stops the container but preserves configuration. Sources: https://bunny.net/docs/magic-containers/restart-policy and https://bunny.net/docs/magic-containers/undeploy

Current connector check `bunny_storage_list_zones` still failed with MCP -32603 Internal error. This is not evidence that account resources are absent. Manual owner setup is the practical route until the connector is repaired.

### Minimal image publication plan

Keep research files in a new isolated directory/repository, not production services. Manually triggered CI: checkout, offline unit tests, `docker build`, push immutable commit tag to existing authorized GHCR package using scoped GITHUB_TOKEN. No cache export, upload-artifact step, paid API calls, Bunny deployment key, or automatic production deploy. Owner then selects the immutable image in Bunny, one region/replica, volume at `/data`, timezone UTC, no public endpoints. Registry permissions/new credential changes remain separate approval steps. Official GHCR-to-Bunny support: https://bunny.net/docs/magic-containers/deploy-with-github-actions

### Kimi qualification cost finding

OpenRouter documents server-loop `stop_server_tools_when` conditions (including step count and cost); a stopping condition can still execute pending tools and **one final tool-disabled model turn**. Thus a cost stop is not itself a no-overshoot cap. Source: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion

The proposed $7 per-Kimi-attempt reservation remains conditional on verified model pass/output bounds. OpenRouter's reasoning documentation says combined reasoning/output `max_tokens` applies on **most providers**, not an explicit guarantee for the pinned Kimi route. Source: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

A dedicated research OpenRouter key can have a lifetime USD credit limit, available on all plans; leave reset unset and include BYOK if relevant. This requires specific permission to create/configure a key. Docs describe blocking subsequent requests once the cap is reached; do not claim it eliminates every in-flight overrun. Do not change the public checker's existing key limits. Source: https://openrouter.ai/docs/guides/best-practices/capping-shared-agent-keys


## Owner budget allocation update — 30 October 20:49 UTC

Owner explicitly approved **$40 total = $38 provider usage + $2 Bunny hosting/storage**. This supersedes earlier $40-provider/separate-hosting text above. Shared StudyLedger is now $38; no old allowance stacks. Owner will enter existing provider keys directly in the research container secure settings. Stop collection and verify private backup at the final block November 6; undeploy compute after verified export. Retained/detached volumes continue charging, so agree retention/deletion after backup rather than leave monthly storage unbounded. Account UI minimum allocation and actual cost must fit the $2 allowance; ask before any higher commitment. No resources provisioned yet.

## Bootstrap service revision

The next research image defaults to `python service.py idle`, a long-running idle process with health at **127.0.0.1:8080/healthz**. It opens no public interface, reads no provider credentials, initializes no ledger and dispatches no requests. Configure no external endpoint; loopback health can be checked within the container. This replaces the first image's test-and-exit default.

Explicit one-time initialization, only on the mounted persistent data directory:

```
python service.py init --data-dir /data/research --study-id finland-language-v02
```

This refuses any existing ledger/identity rather than resetting spend. Normal start uses the default idle command. Readiness does not equal qualification: the health response always says paid execution is disabled.

`service.execute_one` now provides the guarded execution primitive: per-study identity, exclusive lock, frozen input hashes, $38 ledger, 20 pooled diagnostics, immutable raw response, explicit endpoint bound and credential injection, consistent local snapshots and mandatory separately injected **private external backup hook**. Unknown charges (including transport failures) prevent further dispatch until manual reconciliation. Diagnostics can test an unqualified model only after its route/bound is approved; collection additionally requires Finnish review, protocol freeze and live model qualification. No paid CLI/scheduler is enabled in this bootstrap revision, and no backup credential is silently reused. The owner can safely deploy bootstrap while final qualification configuration is completed.

## Qualification envelope resolved after independent review

The selected OpenRouter Moonshot route documents free cache writes; cache reads are cheaper than input. Endpoint maximum completion 943,718 and context 1,048,576 permit a conservative **$35 initial qualification reservation**: three full-context/full-endpoint-output passes at $2/$10 per million plus two $0.007 Exa-auto calls = $34.616996. Reconcile authoritative total `usage.cost` before any next request. After route/token/metadata qualification, the documented 1,500 combined reasoning+answer output bound yields $6.350456 per attempt, rounded up to **$7**. Do not promise all 288 slots fit the $38 usage allocation. Stop when the next reservation cannot fit. Unknown/error charges hold the entire reservation and block further dispatch.

API model ID is `moonshotai/kimi-k3.1-pro`, canonical endpoint version recorded as `moonshotai/kimi-k3.1-pro-20261023`, provider only `moonshotai/mxfp4`, fallback disabled. Qualification must record actual returned identifiers; an alias cannot guarantee immutable weights, and unexplained version drift blocks collection. Candidate JSON is not an activated signed runtime manifest.

Sources: https://platform.kimi.ai/docs/api/chat ; https://openrouter.ai/api/v1/models/moonshotai/kimi-k3.1-pro/endpoints ; https://openrouter.ai/docs/guides/best-practices/prompt-caching#moonshot-ai ; https://openrouter.ai/docs/cookbook/administration/usage-accounting

## Private backup + explicit paid commands (still no automatic execution)

The bootstrap now includes a real Bunny Storage adapter and gated diagnostic/collection CLI. Default remains idle. Owner must explicitly approve a **private research storage zone with no Pull Zone/CDN** and inject its zone-specific password as `RESEARCH_STORAGE_ACCESS_KEY`; never use the global Bunny account API key. Other setup values:

```
RESEARCH_STORAGE_ZONE=<owner-created-private-zone>
RESEARCH_STORAGE_HOST=storage.bunnycdn.com
```

Use `uk.storage.bunnycdn.com` or `se.storage.bunnycdn.com` only if that matches the chosen primary region. Zone proposal: `airank-finland-research-private` (availability not checked). Storage adapter uploads raw binary with SHA256 checksum header, reads it back through authenticated Storage API and verifies the hash. A remote study marker prevents reinitializing a budget after disk loss; restore remains a deliberate verified operation. Each backup archive contains SQLite, study identity, frozen manifests and raw response files. Secrets are never included in the manifest; manifest credential patterns are rejected.

Official HTTP contract: https://bunny.net/docs/storage/http . Storage pricing lists $1 monthly minimum: https://bunny.net/pricing/storage/ . This must fit the approved **$2 combined hosting/storage allowance**, not be added on top. Account minimum/allocation needs confirmation before provisioning. New storage access is not silently assumed authorized.

Commands after secure setup and reviewed manifest exist:

```
python service.py init --data-dir /data/research --study-id finland-language-v02 --manifest /data/manifest.json
python service.py diagnostic --data-dir /data/research --manifest /data/manifest.json --endpoint kimi_candidate --intent-id IT01 --language fi
python service.py collect --data-dir /data/research --manifest /data/manifest.json --endpoint openai_responses --slot-id <exact-frozen-slot-id>
```

Every command is explicit and each dispatch makes at most one model request. The diagnostic pool is 20 total across providers. There are no paid commands in CI and no activated schedule. Private-storage authority, identity, frozen configuration, bound evidence and budget gates are checked before dispatch. Primary collection additionally requires reviewed Finnish prompts and qualified models. If any gate is closed, the command refuses; it never substitutes a route or manufactures approval. Idle never loads the storage or provider keys.

Loopback health is intentionally internal. Do not configure a pod-IP HTTP probe expecting it to answer; use an appropriate internal exec probe if supported, or leave the idle bootstrap without an external HTTP health probe. No public data or management route is exposed.

### Triggering through Bunny UI without console/exec

The image startup reads `RESEARCH_ACTION` (default `idle`) and always returns to idle after the selected one-time action (`RESEARCH_THEN_IDLE=1` is built in). Owner can set nonsecret reviewed JSON in `RESEARCH_MANIFEST_JSON`, then update/redeploy the **research container only**. No unsupported console-exec is needed.

Initialize once: `RESEARCH_ACTION=init`, `RESEARCH_STUDY_ID=finland-language-v02`. The init path checks remote identity first, refuses an absent local identity if a remote study already exists, and can recover a matching zero-attempt local initialization after a failed marker upload. Never resets existing attempts.

For ONE Kimi qualification request: `RESEARCH_ACTION=diagnostic`, `RESEARCH_ENDPOINT=kimi_candidate`, `RESEARCH_INTENT_ID=IT01`, `RESEARCH_LANGUAGE=fi`, **`RESEARCH_ACTION_ID=qualification-kimi-fi-01`**. This stable ID is the slot identity: restarting/redeploying cannot replay the same diagnostic. Do not change the ID to bypass unknown costs or a failed gate. A second intentional diagnostic gets an explicitly new ID after cost reconciliation. Then set action back to idle.

`RESEARCH_ACTION=collect` requires `RESEARCH_SLOT_ID` exactly matching the frozen schedule and all stronger collection gates. There is still no autonomous schedule in this bootstrap. Primary responses with an unexpected returned model are retained but marked fatal and halt the ledger. Provider aliases/allowed returned versions must be frozen by qualification.

Backup immutability uses GET-before-PUT and is NOT a distributed lock. Exactly one replica/region is required. The local file lock prevents concurrent execution only on that mounted ledger. Never deploy a second replica with a fresh disk under the same study identity.

## Offline-prepared autonomous scheduler (not yet published/activated)

A subsequent local revision adds `RESEARCH_ACTION=scheduled`. It waits for all six frozen blocks and processes their 48 slots in frozen order, retaining each adjacent FI/EN pair. Owner does not manually trigger 288 slots. Default remains idle, and `schedule_enabled` must explicitly be true in the signed manifest alongside collection/Finnish/model/secure-host/billing/backup gates.

Timing policy must be explicitly frozen: proposed block-start grace 600 seconds and maximum active-block duration 7,200 seconds. These are implementation proposals, not silently approved amendments. A late initial start marks a block missed with no automatic backfill; an active block exceeding its window expires. Restart resumes completed/remaining slots without repeating completed answers; uncertain requests or costs halt. Reconciled transport failures may receive one retry after at least60seconds/provider Retry-After, within active block. An unpriced timeout is not blindly retried. Pair span uses first attempt start through last completion; >600seconds is marked paired_late for exclusion from primary comparisons.

Scheduler block/pair state lives in the same persistent SQLite ledger and is included in consistent backup archives. The scheduler revalidates execution gates per attempt. Any model drift, budget exhaustion, unknown charge or backup failure stops dispatch. It does not silently backfill missed dates or increase allowance. After all blocks become terminal it returns to idle. No startup action has been set remotely and no paid call was made during development.

## Conservative OpenAI accounting (local scheduler revision)

OpenAI Responses does not expose an authoritative per-response invoice cost here. The new accounting module therefore keeps `actual` **null**, and records a separate `accounted` value with basis `conservative_usage_upper_bound`. Formula in micro-USD for the qualified fixed GPT4.1mini configuration: `ceil(0.4*input_tokens + 1.6*output_tokens + 26400)`. The26400 includes the full configured2searches, each with8000inputtokens at$0.40/M plus$0.01 fee. No cached-token discount and no missing-tool discount. Because official docs do not resolve whether input usage already incorporates the fixed block, any possible double-count remains charged to our internal budget; do not refund it or call the estimate invoice actual.

This is conservative recognized spend, **not an enforceable per-request bound**. Admission still needs separately verified request bounds. Missing/invalid usage, model mismatch, output-cap deviation, unrecognized pricing or uncertain transport retains the full reservation and stops further calls. OpenRouter Kimi uses verified authoritative `usage.cost`; non-finite/negative/bool values are rejected.

Source: https://developers.openai.com/api/docs/pricing . Rates are frozen evidence, not dynamically silently updated. Any change requires a new reviewed manifest.

Scheduler liveness starts concurrently before long waits. Health returns only sanitized action state (`idle`, `scheduled`, etc.) and `management_api:false`, not raw data or credentials. Pair span uses actual request dispatch start/response end rather than reservation/backup timestamps. Scheduler state transitions are snapshot-backed before waiting/finishing; backup failure stops execution.

## Latest-checkpoint recovery and initial OpenAI reservation

Private backups now advance a verified remote `latest-backup.json` containing sequence, archive hash/reference and canonical SQLite state fingerprint. Startup and each actual dispatch compare the local head AND current ledger fingerprint against it. A stale restored ledger, missing head, unknown later remote checkpoint or failed head update halts for manual recovery; no automatic reset/replay. Reservation backup/head is verified before HTTP. This remains a **singleton** design, not distributed compare-and-swap; never run two research replicas. Manual recovery must use the latest verified archive and reconcile all unknown attempts before replacing a missing head.

Initial OpenAI qualification reserves **$1.50**, conservatively above $1.4407776 from full context1,047,576 and full endpoint output32,768 across three passes at$0.40/$1.60 per million plus two fixed8Ksearch-input blocks and two$0.01searchfees. Three passes is an engineering upper-envelope interpretation of two built-in tool calls plus final answer, not a quoted vendor loop guarantee. Actual request still sets output1500 and tools2; no other paid facilities. Keep the1.50 reservation rather than silently shrinking it after successful responses. Reconcile to conservative accounted usage, never invoice actual. Model availability remains unverified/deprecated until qualification.

Official sources: https://developers.openai.com/api/docs/models/gpt-4.1-mini ; https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/reference/cli/resources/responses/methods/create . Candidate/template gates for secure host/private storage/collection remain closed.

### Local disk pressure control

After private remote archive readback/hash and latest-head verification succeed, the real Bunny adapter removes only the newly created redundant local snapshot `.sqlite`/`.tar.gz` files. It retains local immutable raw evidence, live ledger, frozen manifests and receipt JSON, and retains remote archives. This avoids quadratic local disk growth across hundreds of snapshots on a small volume. A failed upload/head never removes its local snapshot. Primary evidence is not deleted.

### Scheduler regression coverage

The local revision includes an offline full six-block run:288 distinct response slots,144 matched language pairs, no duplicate submissions. Integration tests use the actual Bunny backup adapter against an in-memory HTTP fake and actual gated execution against synthetic model transport; future wait/schema creation, adjacent providers, latest-head updates, and stale financial-state rollback rejection are covered. Tests do not imply live endpoint qualification.

## Optional internal health probe
Default binding remains `127.0.0.1:8080`. For Bunny internal HTTP probes only, explicitly set `RESEARCH_HEALTH_BIND=0.0.0.0`, port `8080`, path `/healthz`; keep the research app without a public CDN route. No management, secrets, raw data or ledger fields are exposed. Other bind values fail closed. Old fec3 image does not support this option: leave research HTTP/TCP probes disabled there, especially any inherited port 3007 probe. Never change production app probes.
