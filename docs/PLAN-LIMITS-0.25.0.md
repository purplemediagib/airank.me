# Plans and seven-day Pro trial — backend 0.25.0

Implements Lovable's `bunny-plan-limits.md`, with the signup rule: **new accounts receive Pro free for seven days**. Limits belong to a workspace, including work done by its members and brand guests.

| Plan | Active prompts across the workspace | Active brands | Models per brand/check | Scheduled frequency |
| --- | ---: | ---: | ---: | --- |
| Starter | 60 | 1 | 3 | Weekly |
| Pro, including the free trial | 175 | 3 | 5 | Daily |
| Advanced | 400 | 10 | All enabled | Daily |
| Custom | Unlimited | Unlimited | All enabled | Daily |

`null` in a limit means unlimited, not zero. Existing provider budgets, concurrency, deadlines and maximum tasks per run remain operational limits even on Custom.

## Deploy on Bunny

1. Update **API, worker and content** to the images from this merged commit. Update the API first with the existing `AIRANK_RUN_APP_MIGRATIONS=true` setting. Its normal `node src/app/start-release.mjs` entrypoint runs additive migration `app-022-plan-limits`; a custom command starting `server.mjs` directly must use that migration entrypoint for this rollout.
2. Confirm API logs show `AI Rank app migrations 001–022 verified successfully.` and `/healthz` reports `0.25.0` plus the correct revision. Restore the migration flag to false if normally disabled.
3. Set **`BILLING_SHARED_SECRET` on the API container only**. Use a newly generated cryptographically random secret (32 bytes or more; for example `openssl rand -hex 32`). Put the exact same value in **Lovable's server-side secrets**. Never expose it in client JavaScript, public env variables, GitHub files or request logs. Worker and content read the plan from the database and do not need this secret.
4. Keep existing model/provider/budget settings. Legacy `TRACKED_PROMPT_LIMIT` / `TRACKED_PROMPT_LIMITS_JSON` are used only for workspaces awaiting their first billing sync; once a plan is assigned, the plan's limits replace those prompt entitlements.

No Google container or Google Cloud Console change. No provider-budget JSON change.

## Required Lovable integration

Send plan changes directly from trusted server code to:

`POST https://mc-u87t7nkvtg.bunny.run/v1/internal/workspaces/<workspaceId>/plan`

Headers:

```text
Authorization: Bearer <BILLING_SHARED_SECRET>
Content-Type: application/json
```

This route needs no browser session, CSRF token or `X-AIRank-Client`. Cookies and report credentials cannot authorize it. Ordinary users, including owners, cannot self-assign a plan.

Paid active Pro example (one line):

```json
{"plan":"pro","status":"active","revision":1}
```

Pro trial example (one line):

```json
{"plan":"pro","status":"trialing","revision":1}
```

Expired/cancelled entitlement example (one line):

```json
{"plan":"pro","status":"inactive","revision":2}
```

Required fields:

- `plan`: `starter`, `pro`, `advanced`, `custom`.
- `status`: **required** — `active`, `trialing`, or `inactive`. Do not send an ordinary trial as active Pro: active represents paid/explicitly authorised entitlement and does not expire at the trial deadline.
- `revision`: a positive, monotonically increasing safe integer **per workspace**. Persist this in Lovable's billing state. Increment it when pushing a new authoritative entitlement. Retry the same payload/revision after a timeout. Same revision/same state is idempotent; stale or conflicting revisions return `409 PLAN_REVISION_CONFLICT`. Read the current subscription state when handling Stripe events so an old webhook cannot become a newer entitlement revision. Stripe event timestamps alone are not a reliable revision counter.
- Optional `trialEndsAt`: epoch milliseconds, only with `status: trialing` and `plan: pro`. It may align an earlier app trial deadline, but cannot exceed the account's original signup time plus seven days. Omit it to use the backend's canonical signup-based deadline.

Successful response:

```json
{"workspaceId":"ws_example","plan":"pro","status":"active","revision":1,"trialEndsAt":null,"updatedAt":1793188800000,"limits":{"prompts":175,"brands":3,"models":5,"frequency":"daily"},"usage":{"brands":1,"prompts":12},"changed":true}
```

`trialEndsAt` retains the original trial deadline if the account previously trialled; `status: active` supersedes it. `changed:false` denotes a duplicate, successfully applied revision.

Use the existing `workspaceId` from project list/detail, **not** the project ID or owner ID. Obtain it by creating/loading the user's brand before the first push. Send updates after signup/trial sync, successful payment, effective plan changes and when an entitlement actually ends. A subscription cancelled at period end should remain active until the paid-through period ends; map Stripe state to an effective entitlement in Lovable.

**Run an initial sync for every existing workspace, including existing trials and expired/cancelled accounts.** Migration leaves existing workspaces in a temporary legacy state so rollout cannot assign the wrong paid tier or unexpectedly cut off existing projects. They keep their current operator limits until this sync. New workspaces receive the signup-based Pro trial automatically. This release does not contact Stripe, install its webhook, or send email; Lovable owns billing events, retries and the initial sync.

## Trial lifecycle

- Pro trial starts at the Bunny account's original `users.created_at`, not first project creation. It lasts exactly `7 * 24 * 60 * 60 * 1000` milliseconds.
- Creating a brand/workspace later does not restart it. Ownership transfer preserves the workspace's trial dates; the previous owner cannot obtain another seven days by opening a replacement workspace.
- At the deadline, server checks stop project writes and new paid monitoring work without waiting for a webhook. Historical reads remain available. Owners/admins can still archive brands, remove team access and revoke invites; people can revoke their report credentials.
- Content jobs recheck entitlement before execution, and content automation stops enqueueing after expiry. Monitoring rechecks entitlement before each queued task spends provider credit. Already submitted/in-flight upstream work cannot be recalled.
- An `active` plan push restores the paid entitlement. Expiry does **not** silently grant a free Starter plan.
- The settings response exposes `plan`, `planStatus`, `trialEndsAt`, `planLimits` and `planSyncPending`. Display the backend deadline if it differs from the frontend clock.

## Limits, downgrade behaviour and API compatibility

- Counts include active brands and active tracked prompts across that workspace. Archived brands/prompts release count capacity. Trial or paid limits are checked inside write transactions; concurrent requests cannot claim the final slot twice.
- `POST /v1/projects`, prompt creation, archived-prompt restoration and suggestion acceptance enforce the same quota. Existing identity/role checks remain required.
- `PUT /v1/projects/:id/monitoring` is an alias for monitoring provider settings. Body: `{"providers":["openai","claude","gemini"]}`. `expectedVersion` is optional for this PUT; when supplied it is enforced. Existing `GET/PATCH /v1/projects/:id/measurement-settings` remains supported, with PATCH retaining its required `expectedVersion`.
- `GET /v1/projects/:id/monitoring` returns the same settings data. New brands without an explicit provider choice default to the first permitted number of configured providers, in `ENABLED_PROVIDERS` order. Users may choose any enabled providers up to their model count; Advanced and Custom can select all.
- Downgrades preserve brands, prompts, choices and history. Over-limit brands/prompts or a saved provider selection exceeding the new plan stop new checks until the user reduces usage or upgrades. Reads remain available. Stored selections are not silently truncated.
- The worker also checks frozen queued model/prompt counts after a downgrade, even if current settings or active prompt counts have since been reduced. Blocked queued tasks spend no new provider credits and record `plan_blocked` / `PLAN_LIMIT`.
- Starter's interval is a rolling **seven days** per brand and prompt kind (neutral/diagnostic). Both kinds may be collected during the same scheduled check. Scheduled and immediate/manual bootstrap paths share this gate, so editing prompts cannot turn Starter into daily checks. Reservations count even when a run subsequently fails; this prevents automatic duplicate spending. Existing daily scheduling and its Helsinki time slot remain for Pro/Advanced/Custom.
- Schedules expose `frequency` and `plan`. Plan/status changes refresh enabled schedules without unpausing paused ones. Weekly schedules advance to the first regular slot after the seven-day interval; upgrading to daily does not wait out the old weekly date. Existing missed-slot behaviour skips missed runs rather than backfilling.

## Error contract

HTTP 402, unchanged Lovable limit shape:

```json
{"error":{"code":"PLAN_LIMIT","limit":3,"upgradeTo":"pro"}}
```

`limit` is the affected prompt, brand or model allowance; a weekly-frequency rejection uses `7`. `upgradeTo` is Pro for Starter, Advanced for Pro, Custom for Advanced.

Trial expiry adds a reason, still under the existing `PLAN_LIMIT` code:

```json
{"error":{"code":"PLAN_LIMIT","limit":0,"upgradeTo":"pro","reason":"TRIAL_EXPIRED"}}
```

An inactive subscription uses `reason:"SUBSCRIPTION_INACTIVE"`. Keep reads enabled and show the plan/payment action. A caller with no brand access receives 404 before entitlement details are exposed; ordinary role checks remain enforced.

Billing push errors: `401 AUTH_REQUIRED`, `415 JSON_REQUIRED`, `422 VALIDATION_FAILED` / `INVALID_TRIAL_END`, `404 NOT_FOUND`, `409 PLAN_REVISION_CONFLICT`, `503 BILLING_NOT_CONFIGURED` / `PLANS_NOT_CONFIGURED`.

## Validation and smoke checks

Automated fixtures cover every plan boundary, concurrent writes, workspace/team accounting, legacy migration, secure/idempotent billing updates, seven-day signup expiry, transfer/recreation, activation/inactivation, old/new settings routes, downgrade/frozen task enforcement, weekly/daily scheduling, content access and atomic audit rollback. They make no paid provider calls.

After rollout and Lovable wiring: verify a fresh account sees Pro/175/3/5 and the correct trial end; verify a Starter account cannot select a fourth model; test a payment upgrade and a stale revision retry; confirm an expired trial retains reports but cannot start checks. Live Stripe checkout/webhook delivery remains an integration smoke test for Lovable.
