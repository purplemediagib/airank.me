# AI Rank Finland: isolated research-runner scaffold

**Offline only — not deployed, scheduled, or connected to any model.**

Prepared 30 October 2026. Latest owner direction: OpenAI + Kimi, replacing Gemini **in this study only**. Public checker is unchanged. No live endpoint/model credentials were inspected or used.

## What works now

Python standard library only. `python -m unittest -v` runs the offline safety/scoring suite.

```
python runner.py --dry-run /tmp/new-openai-fixtures
python runner.py --dry-run /tmp/new-kimi-fixtures --endpoint kimi_candidate
```

Each command validates 12 paired intents, filters 144 scheduled slots, preserves adjacent FI/EN pairing, writes immutable-per-run raw fixtures and hashes, a durable SQLite attempt ledger, response/citation JSONL, a blank human entity-coding CSV, and a seeded 36-response independent-review sample balanced by sector/language/date. Every output directory has a SYNTHETIC_ONLY marker. Existing output directories are refused.

`synthetic-demo/` and `synthetic-kimi-demo/` contain 288 fake examples, **not collected research**. Kimi fixtures use an explicitly fictitious unqualified model label and the same fixture schema solely to exercise storage. Their fictional reservation amounts are not Kimi pricing or a budget proposal.

The ledger tests atomic slot claiming, reservation survival across restart, conservative retention of uncertain costs, one transport-only retry, Retry-After, diagnostic maximum 20, primary maximum 144 per isolated endpoint fixture ledger, no rerun of valid empty/refusal answers, fatal/unknown halts and budget rejection. Integer micro-USD avoids rounding errors. An unresolved reserved attempt cannot automatically replay. Actual over-reservation halts future attempts; it cannot undo a provider overcharge. This is why a verified bound is essential before live use.

Scoring provides deterministic deduplicated Jaccard, missing/both-empty distinctions, >10-minute exclusion, and intent-macro aggregation. Extraction preserves model/usage/search/citation metadata and does not equate absent citations with absent search. Full recommendation coding remains human work; the tool does not invent entities or turn mere mentions into recommendations.

## Versioning

- `inputs/PROTOCOL.md`, `BUDGET.md`, original prompts and schedule: preserved v0.1 source copies, not newly approved or frozen by this implementation.
- `inputs/schedule_v02_openai_kimi_DRAFT.json`: **new proposed** 288-slot schedule with OpenAI + `kimi_candidate`, lineage to superseded Gemini draft slot IDs. No Kimi model/route is assumed. Revised proposed October 31 / November 2 / November 6 dates at 08:00 and 14:00 UTC are not activated and remain gated.
- `release_manifest_DRAFT.json`: all qualification/release facts remain unconfirmed. Scope approval does not approve a changed two-model spend ceiling.
- Never change frozen inputs in place. Amend version, reason, owner decision, review and hashes before renewed collection.

## Implementation sequence / least effort for Vincent

1. **Fluent Finnish review:** nominate one reviewer (Vincent if qualified) to check the 12 FI/EN pairs, especially managed IT terminology. Record reviewer name, date and any amendments. Assign an independent coder for 25% of responses plus ambiguities and public examples; the same Finnish reviewer can do this only if independent from the primary coder.
2. **Choose/qualify exact routes:** verify the deprecated OpenAI candidate snapshot remains available, and identify one supported Kimi model + provider + native/external search policy. No silent substitutions. Route qualification requires separately approved diagnostic spend; maximum **20 diagnostic attempts total across all endpoints**, not 20 each, with no hidden retries. Use representative FI and EN prompts.
3. **Verify approved $40 total:** the original $8.9936 planning figure and proposed $12 allowance apply only to OpenAI assumptions. They are not an enforceable cap today and cannot cover Kimi by implication. Prove all billable input/tool context, reasoning/output, search units and error charges are bounded. If a credible bound is unavailable, stop; do not advertise a hard cap. Owner has now approved **$40 total across both endpoints, qualification and retries**. Do not stack the old $12 or any unrelated allowance. Repricing must establish whether the design fits this total.
4. **Secure execution:** easiest operational design is a separate one-shot Python job in an already authorized durable worker environment, private SQLite + private raw artifact directory, with a restricted research credential injected by that host's secret store. Do not copy production `.env` files or paste keys into chat. Creating a new credential, secret injection, host deployment and scheduler activation each need explicit authority as applicable. A local laptop can avoid new hosting, but must be awake at all six blocks; a confirmed existing durable runner is preferable.
5. **Finish live adapter and integration tests:** see gaps below. Disable provider SDK retries and router fallbacks. Use a fresh request context for every slot. Persist reservation before request; response evidence before cost release; retained uncertainty after crash. Back up ledger/raw files, set restrictive permissions, test restore and double-start safety.
6. **Freeze:** exact prompts, complete rubric, alias policy, route/model, location/search parameters, supported token/tool caps, pricing/evidence, schedule, signed review, code commit and all hashes. Owner-informed amendment if OpenAI snapshot or Kimi route changes.
7. **Authorize and execute six blocks:** manually trigger initially or separately approve a scheduler. Complete consecutive FI/EN pairs, record real UTC start/end timestamps, stop on configuration/authentication failure, budget uncertainty or major outage. No repair reruns for inconvenient outcomes.
8. **Code and report:** human entity/citation coding and adjudication, secondary/sector/baseline analyses, missingness and sensitivity tables, independent review. Owner approves publication separately.

## Important unfinished live work (not hidden by the test count)

This is a **scaffold, not production readiness**. An injectable standard-library HTTP adapter module is now prepared and only mocked in tests. There is no live CLI, credential loader, scheduler, billing reconciliation API, or deployment action. `validate_live` refuses execution even if every gate is manually set true.

Before a live adapter is enabled, implement and independently test:
- Integrate the now-implemented **StudyLedger**, one shared $40 ledger across both endpoints, 288 allowlisted primary slots, up to one retry per slot, and **20 total diagnostics**. It blocks reservations with unknown billable bounds and retains uncertain-charge holds. Current historical fixture demos still have separate synthetic ledgers; do not use those for live accounting.
- Frozen slot allowlist and endpoint-specific verified per-attempt reservations; conservative error/timeout billing; proper real UTC completion and separate retry-eligibility timestamps; accounting reconciliation and audit exports.
- Exact provider requests, tool/schema compatibility, full input-token counting and total billed-context bounds; return-version drift detection. Kimi needs its own native response parser after actual schema qualification.
- Immutable crash-safe raw-file persistence integrated with SQLite state transition; recovery inspection that never resubmits an uncertain charged request automatically; least-privilege file permissions and credential redaction defense in depth (current regex sanitizer is not a guarantee against arbitrary secrets echoed in provider text).
- Complete protocol runs/entities/citations schema, complete/incomplete tool-status checks, retrieval-only vs explicit citations, public-suffix registrable domains, source-language review and identity evidence. Current citation normalization removes only known tracking parameters and preserves meaningful query parameters.
- Final coding import validation, frozen alias map, explicit recommendation-vs-mention adjudication, sector summaries, same-language baseline variation, late-pair sensitivity, recommendation denominators, agreement counts and report rendering. Current `analyze` is a tested primary-statistic primitive, not the final report pipeline.

## Existing backend reuse / feasibility checked read-only

Inspected `/workspace/shared/airank-backend-combined-release/app/src/providers/openai.mjs` and `src/research/service.mjs` (no production edits).

Existing backend OpenAI adapter names `OPENAI_API_KEY`, uses Responses API/web_search, retains raw responses and extracts annotations/search calls. Its default model is an alias, and its completion logic excludes refusals, unlike this study's usable-refusal requirement. The research service is project/cohort/UI oriented, not this independent protocol. **Do not call or reuse those live services as the runner.** Safe concepts to port after tests: annotation extraction, raw metadata and redaction. Avoid substring brand detection as final recommendation coding.

Availability of a usable key/host is **not established**: only source code references to a secret name were inspected; no local environment or secret values were read. Bunny connector failure reported by the parent means it is not a confirmed execution route. Existing Lovable gateway is not a qualified substitute for the exact study endpoint/model and was not used. No new account, credential, durable access grant, production service or scheduled job was created.

## Results location and portability

**Today:** only local synthetic test artifacts exist under `/workspace/shared/airank-finland-runner/`; there are no real study results and no remote storage folder has been created by this task.

**Proposed after storage/access approval:** an isolated private research prefix on verified Bunny storage, not the public checker database or a publicly readable CDN. Verify storage authentication, public URL behavior, bucket/zone access, backup and retention before any upload. The previously reported connector failure is unresolved here. Do not create a storage zone or upload on the strength of a question about location.

Portable per-version layout:

```
study-v0.2/
  manifest/    # frozen protocol, prompt pairs, schedule, prices, approvals, code hash
  ledger/      # private SQLite backup made through SQLite backup API
  raw/         # sanitized provider response per attempt; immutable names/hashes
  tables/      # runs.jsonl, entities.jsonl, citations.jsonl, reviewed CSV exports
  review/      # independent sample, adjudications, identity/language evidence
  analysis/    # reproducible scripts, denominators, tables, charts
  checksums/   # SHA256 inventory, backup restore verification record
```

Keep synthetic fixtures in a completely different prefix, never append them to study tables. Every table links to study/slot/attempt IDs, model/route/version and raw hashes. Backup SQLite using its backup API (not a loose copy of a live WAL database), verify file counts and all hashes after restore, and retain source versions. Notion can contain the approved overview, findings, charts and appropriately access-controlled links; Space can hold reviewed exports. Never paste storage credentials, signed private URLs or unpublished raw provider text into a public Notion page. Publication/remote artifacts remain separate authorized steps.

## Confirmed execution-host discovery (30 October)

`cloud_threads.list_environments` returned only `PURPLE-LAPTOP3`, connected but **not attached and not authorized for tasks**; zero saved cloud coding environments. Thus there is no verified authorized execution host in this catalog. No Bunny console-exec capability was established.

**Minimum specific owner step:** authorize PURPLE-LAPTOP3 for this research task, or designate/approve an existing host for an isolated research container. Inject an existing authorized research credential through that host's secure secret UI; do not email/paste it. Any new persistent credential creation or security-setting change still needs explicit per-action approval. `Dockerfile` prepares a non-root container whose default command is only offline tests; image build/deployment have not been run.

Implementation/start-tomorrow approval is recorded; it does not prove model billing bounds, authorize unrequested persistent security changes, or substitute for fluent Finnish review. Actual activation waits on those concrete gates.


## Owner budget allocation update — 30 October 20:49 UTC

Owner explicitly approved **$40 total = $38 provider usage + $2 Bunny hosting/storage**. This supersedes earlier $40-provider/separate-hosting text above. Shared StudyLedger is now $38; no old allowance stacks. Owner will enter existing provider keys directly in the research container secure settings. Stop collection and verify private backup at the final block November 6; undeploy compute after verified export. Retained/detached volumes continue charging, so agree retention/deletion after backup rather than leave monthly storage unbounded. Account UI minimum allocation and actual cost must fit the $2 allowance; ask before any higher commitment. No resources provisioned yet.


## Bootstrap update

Default Docker command is now the safe, long-running idle service, not tests. Run tests explicitly with `python -m unittest -v`. `service.py init` explicitly provisions an identified mounted ledger; `service.execute_one` binds diagnostic/collection gates to budget, singleflight and backup persistence. No paid CLI or scheduler is enabled. See DEPLOYMENT.md.
