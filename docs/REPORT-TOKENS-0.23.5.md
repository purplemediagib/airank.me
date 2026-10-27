# Scheduled report read access — API 0.23.5

This release supplies the missing Bunny authentication path for scheduled weekly/monthly report jobs. Lovable remains responsible for scheduling, encrypted credential storage, recipients, summary/PDF generation and email delivery. This release does not create a schedule or send email.

## Deploy on Bunny

1. Update the **API container only** to the published image for the release commit. Use its default command (`node src/app/start-release.mjs`). The monitoring worker, Google connector and content container do not need an update for this feature.
2. Set `AIRANK_RUN_APP_MIGRATIONS=true` before redeploying. The release entrypoint applies the additive `app-020-report-tokens` migration after migrations 001–019. Existing migration files/checksums and report evidence are unchanged.
3. Optionally set `REPORT_TOKEN_DAYS=180`. This is already the default. Allowed values are whole numbers from 1 through 365; invalid configuration prevents minting tokens. Changing it affects newly created tokens only.
4. Redeploy. Confirm the startup log: `AI Rank app migrations 001–020 verified successfully.` Check `/healthz` for version `0.23.5` and the published revision, and `/readyz` for database readiness. `/readyz` alone does not verify migration 020: a cookie-authenticated `GET /v1/app/report-tokens` must also return `200` (an empty list is valid).
5. Restore `AIRANK_RUN_APP_MIGRATIONS` to its previous value if it was enabled only for this deployment. Leaving it enabled is safe because migrations verify their checksums and are repeatable.

No new shared secret, provider-budget change, OAuth client registry change or Google Cloud Console change is needed. Preserve existing provider and database settings. The token endpoints return `503 REPORT_TOKENS_NOT_CONFIGURED` if the migration is missing or its checksum differs; ordinary cookie reads continue to work.

## Credential contract

Each token is random (`airank_rt_` followed by 43 base64url characters), belongs to the authenticated user and expires. Only its SHA-256 hash is stored in Bunny; the plaintext is returned once on creation. Tokens can read **all projects owned by that user**, not just a single schedule's project, and cannot read another user's projects.

The only authenticated bearer operations are:

```text
GET /v1/projects
GET /v1/projects/:id
GET /v1/projects/:id/analytics
```

Pass existing analytics filters in the query string, exactly as the report page does. Reads use the same service and ownership checks as cookie-authenticated reports; no new AI/provider calls are triggered. The only bookkeeping write is a last-used timestamp, at most once per minute per token.

Machine requests go directly to the Bunny API with these headers and no browser cookie or CSRF token:

```text
Authorization: Bearer <stored report token>
x-airank-client: <an existing registered client ID>
```

`x-airank-client` is still required; reuse the app's existing registered client ID. It is not a replacement credential. Do not place the report token in a URL, client-side storage, logs, analytics, PDFs or emails. Store it encrypted in the server-side schedule store and forward it only to the fixed Bunny API origin.

A valid report token on another app route or on a non-GET operation returns `403 SCOPE_DENIED`, including mint/list/revoke, scans, content, connections and login actions. An invalid, revoked or expired report token on a protected read returns `401 AUTH_REQUIRED`. Requests for another user's project or run return `404 NOT_FOUND`.

An explicitly supplied report bearer cannot inherit broader permissions from an accompanying cookie. Unrelated authorization headers keep their previous behaviour and do not grant report access.

### Session endpoint clarification

`GET /v1/app/session` remains a public, **cookie-only** session probe. With a report bearer it returns `authenticated:false`, `user:null`, `csrfToken:null` and `accountCreated:false`; it does not establish a session, expose CSRF or consume signup state. This resolves the brief's conflict between its three-route allowlist and its proposed authenticated machine session response. Validate a report token using an allowed project read instead. Cookie-only browser sessions retain their existing response.

## Enable a schedule while the user is signed in

Use the existing browser/BFF cookie flow, including matching `Origin`, `x-airank-client`, `Content-Type: application/json` and `x-csrf-token`.

```text
POST /v1/app/report-tokens
```

```json
{"label":"Weekly report"}
```

`label` is optional (default `Weekly report`), must be a string of at most 60 characters and cannot contain control characters. Owner IDs, scopes and expiry overrides are not accepted from the caller.

The `201` response contains `id`, `token`, `label` and `expiresAt` (ISO timestamp). Encrypt/store the token server-side, associated with the authenticated owner and schedule. Store the token ID and expiry too. Activate the schedule only after that storage succeeds. Use one credential per schedule if each schedule needs independent revocation.

There is no plaintext recovery endpoint. If storing a newly minted token fails, revoke it using the signed-in session before trying again where possible; do not log it for troubleshooting.

## List and disable

Cookie-authenticated listing:

```text
GET /v1/app/report-tokens
```

Returns the current user's token metadata only: `id`, `label`, `createdAt`, `expiresAt`, `lastUsedAt`, `revokedAt`. List timestamps are Unix milliseconds, with `null` for unused/unrevoked fields. No token or hash is returned.

Cookie-authenticated revocation:

```text
POST /v1/app/report-tokens/:id/revoke
```

```json
{}
```

Returns `200 {"ok":true}`. Repeating revocation is safe. A foreign or unknown token ID returns `404 NOT_FOUND`. Disabling a schedule should stop its job and revoke its credential through this session-authenticated route; then remove the encrypted credential. A report token cannot revoke itself or mint its replacement.

Normal browser logout does not revoke report credentials, so scheduled reports can run while nobody is signed in. To renew an expiring token, obtain a fresh one during a signed-in session, securely replace the stored token, then revoke the old one. Lovable should show upcoming expiry/reconnection state and stop failed schedules with an actionable status when a protected read returns `401`; do not retry revoked credentials indefinitely.

## End-to-end acceptance after deployment

1. Sign in and enable a test report schedule, minting a token with the user's existing cookie and CSRF token.
2. From the server-side job, read that user's project and filtered analytics with the bearer and registered client header. Compare the resulting evidence/metrics with the signed-in report page.
3. Log out in the browser and run the test job again. The bearer read must still work. The frontend handles the report rendering and authorised test email.
4. Sign back in, disable the schedule and revoke its token. Subsequent bearer reads must return `401 AUTH_REQUIRED`.
5. Confirm a foreign user's project returns `404`, and a bearer POST to monitoring-runs returns `403 SCOPE_DENIED` without enqueuing work.

Offline tests cover the three allowed reads with actual analytics data, filters and owner isolation; hash-only storage; no CSRF/session promotion; write and route denial; cookie CSRF/origin protections; expiry/revocation; concurrent usage markers; rollback on audit failure; and additive migration compatibility. Live scheduled delivery still depends on Lovable's integration and the deployed API.
