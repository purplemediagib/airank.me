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
