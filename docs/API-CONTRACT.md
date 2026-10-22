# Content Studio API contract

Base: existing authenticated API `/v1/projects/{projectId}/content`. Existing Replit proxy may expose this under `/api/airank/v1/...`.

GET requests require the existing session and registered client header. Mutations also require the established Origin, JSON content type and CSRF token. The normal app service supplies userId; the browser never chooses it. Content roles are enforced server-side. Errors use `{error:{code}}` through the existing HTTP wrapper.

## Routes

| Method | Suffix | Body / response |
|---|---|---|
| GET | empty | Project identity, role, documents summary, opportunities, brand, automation settings, configuration capabilities |
| GET | `/documents` | Full stored documents |
| POST | `/documents` | `{title,description,markdown,locale,sourceUrl?,topic?,expertise?}` → new draft |
| GET | `/documents/:id` | Full document |
| PATCH | `/documents/:id` | `{expectedVersion,...editableFields}` → new draft revision |
| GET | `/documents/:id/revisions` | Version, payload, actor, created_at |
| POST | `/documents/:id/restore` | `{expectedVersion,revision}` → new draft revision |
| POST | `/documents/:id/review` | `{expectedVersion,status,note?,factsChecked?}`; status in_review/approved/changes_requested; approval requires factsChecked=true |
| POST | `/documents/:id/apply` | `{expectedVersion,jobId,changeIds?}`; rewrite uses selected IDs; create uses generated full draft |
| GET | `/documents/:id/export` | `{markdown,html,plainText,title,description,structuredDataSuggestion,note}` |
| POST | `/documents/:id/published` | `{expectedVersion,url}`; records manual publication of approved revision |
| GET/PUT | `/brand` | PUT `{expectedVersion,tone,audience,prohibitedClaims,facts:[{id,statement,sourceUrl?,verified}]}` |
| GET/PUT | `/settings` | PUT `{expectedVersion,enabled,refreshHours,locale}`; interval 24–720 hours |
| GET | `/jobs` | Latest 200 project jobs |
| POST | `/jobs` | `{kind,input,submissionId}` → 202 with persistent job |
| GET | `/jobs/:id` | Persistent job and checkpoint/result |
| POST | `/jobs/:id/cancel` | Non-publishing active jobs only |
| POST | `/jobs/:id/retry` | Failed non-publishing jobs only; completed checkpoints reused |
| POST | `/bulk` | `{submissionId,items:[{kind,documentId,documentVersion}]}`; 1–50 audit/research/rewrite entries |
| GET/POST | `/comments` | POST `{documentId,documentVersion,text}`; GET optional documentId query |
| PATCH | `/comments/:id` | `{expectedVersion,resolved}` |
| GET/PUT | `/access` | Owner only; PUT `{expectedVersion:0,email,role}`; role viewer/editor/reviewer/remove; existing account required |
| GET/PUT | `/cms` | Owner only; encrypted credentials, safe GET summary; bodies below |
| GET | `/cms/items` | Owner/reviewer; query page, search and WordPress type posts/pages; returns remote IDs, current modification values and Webflow locale IDs, never credentials |
| GET | `/sources`, `/opportunities`, `/publications`, `/assessments` | Project records; optional `/:id` |
| PATCH | `/opportunities/:id` | `{expectedVersion,status,note}`; status new/in_progress/completed/dismissed |
| POST | `/publications/:id/reconcile` | `{expectedVersion,verifiedInCms:true,status,url?,remoteId?,note}`; published/draft/not_published; bookkeeping only |
| GET | `/usage` | Owner only, daily totals, estimated-versus-known costs |
| GET | `/events` | Latest 200 project content audit events |

Outside this base: GET `/v1/app/content-projects` returns owned/shared Content Studio project identities. Existing project/monitoring routes retain their original ownership rules.

## Job inputs

All jobs accept locale `en` or `fi`. Document-based requests carry documentId and its exact documentVersion.

| Kind | Additional inputs | Result |
|---|---|---|
| import | url (owned HTTPS page) | documentId/version; existing edits preserved |
| sitemap | url (owned HTTPS XML), maxPages 1–500 | discovered URLs, child import job IDs, errors, partial flag |
| audit | documentId, documentVersion, sourceUrls? | checklist + AI findings, missing information, source provenance |
| research | topic? or documentId/version, sourceUrls?, expertise?, instructions? | brief, comparisons, external actions, sources |
| rewrite | documentId/version, sourceUrls?, expertise?, instructions? | original/replacement/reason/sourceIds changes; does not modify document |
| create | topic, documentId/version optional, sourceUrls?, expertise?, instructions? | generated article; creates draft when no documentId; otherwise review/apply |
| opportunities | locale | AI/GSC opportunities with coverage and dates |
| perception | locale, sourceUrls? | evidence-linked brand findings and verified fact IDs |
| impact | documentId/version | latest publication's comparable before/after monitoring + Google reports |
| publish | documentId/version, targetStatus draft/publish, slug?, remoteId?, expectedRemoteModified?, wpType?, cmsLocaleId?, publishedUrl? | persisted publication or uncertain state |

Job state: queued/running/completed/failed/cancelled/uncertain. Public job data has no claim_token or lease_until. Result payload depends on kind. Checkpoints include named completed stages. Errors are stable codes, not raw provider responses.

## CMS configuration

WordPress PUT `/cms`:

```json
{"expectedVersion":0,"type":"wordpress","baseUrl":"https://your-owned-site.com","username":"application-user","password":"application-password"}
```

Webflow PUT `/cms`:

```json
{"expectedVersion":0,"type":"webflow","collectionId":"actual-24-character-id","token":"api-token","bodyField":"post-body","descriptionField":"description"}
```

Never put real credentials in a prompt. Use the app's secure form. POST publication is separate, approval-gated and explicit about draft/live status. A WordPress remote update must match the current modified_gmt and source page path when available. A Webflow remote update must match lastUpdated and cmsLocaleId. New Webflow items must satisfy collection-required fields. This adapter does not automatically create missing taxonomy/reference records.

## Concurrency and retry

Every document/settings update requires expectedVersion. Initial records use 0; subsequent saves use the current version. Every save returns the new version. Reuse submissionId for the same intended job; changed inputs with the same ID return SUBMISSION_CONFLICT. Never retry CMS writes blindly.

Typical client handling: AUTH_REQUIRED → sign in; CONTENT_PERMISSION_DENIED → read-only feedback; VERSION_CONFLICT/REVISION_CHANGED → refresh and preserve local edits; CONTENT_BUDGET_EXCEEDED → show allowance/usage; CONTENT_MIGRATION_REQUIRED/CONTENT_MODEL_NOT_CONFIGURED → configuration state; SOURCE_FETCH_FAILED/ROBOTS_DISALLOWED → show source issue, allow pasted content where appropriate; PUBLICATION_UNCERTAIN → reconciliation.

The worker stores source snapshots and editorial records in the existing private database. Historical rows preserve version provenance. The checklist score is never an AI visibility score. Google data carries availability/metadata; empty unavailable results must not be rendered as measured zero.
