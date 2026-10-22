# Replit implementation prompt — complete launch scope

Implement the complete AI Rank Content & AI Perception Studio inside the existing AI Rank application. This is one coordinated launch. Do not substitute an MVP, mock data, placeholder buttons, a separate app, a new database, or a generic AI chat box. Use the supplied Bunny API source and API-CONTRACT.md as the authoritative contract.

## Inspect the existing application first

Identify its router, design tokens, components, translations, authentication, API proxy, project selector, Google connection UI and monitoring charts. Preserve these. Reuse the existing navy/cyan AI Rank identity and established dashboard style. Do not apply Purple+'s purple branding. Keep existing login, free checker, monitoring, sentiment and billing behaviour unchanged.

Document the existing proxy header/session flow. The supplied API uses the current `__Host-airank_session` cookie, `X-AIRank-Client`, exact Origin and X-CSRF-Token. The browser uses the existing same-origin Replit proxy; it must never send database tokens, CMS secrets, worker credentials or Google connector keys directly to Bunny.

Add the exact `/v1/projects/:projectId/content/...` routes to the existing allowlisted proxy. Do not introduce a general arbitrary-path proxy. Preserve method restrictions and size limits: content routes accept up to 512 KiB; do not raise the limit for unrelated endpoints. Preserve 401/403/404/409/413/422/429/503 responses. Treat unexpected write failures as uncertain and reconcile before repeating them. Queue submissions have idempotency keys.

## Navigation and pages

Add a Content Studio section to the current project navigation with these working pages, in both languages:

1. **Overview / Yleiskatsaus**: counts from actual documents/jobs/opportunities; current job progress, opportunity summary, latest published changes and measured impact. Show no-data and connection-required states, never fabricated trend lines.
2. **Opportunities / Mahdollisuudet**: filter by AI visibility, cited-source coverage, search quick win, low CTR, content decay and query overlap. Cards show priority, evidence, rationale, Google date range and completeness. Actions: inspect evidence; create brief; create article; optimise matching page; mark in progress/completed/dismissed. Keep external-source actions as guidance, not automated outreach.
3. **Content library / Sisältökirjasto**: document table with title, source URL, language, status, last revision, audit issues and publication state. Search/filter locally or paginate in the app as the dataset grows. Import URL, paste content, import sitemap, create new, and select documents for bulk audit/research/rewrite. Sitemap discovery lists child jobs and individual failures.
4. **Editor / Sisältöeditori**: a substantial writing surface with a side panel, not a cramped textarea. Reuse or add the application's supported rich-text editor with a loss-aware Markdown serialisation. The authoritative storage is Markdown. Preserve supported headings, paragraphs, links, images, lists and tables. Raw HTML embeds are not supported and must be flagged rather than silently discarded. Include title, description, topic, language and expert input.
5. **AI perception / Tekoälyn brändikuva**: verified brand facts alongside verbatim AI answer excerpts. Show inaccurate, unsupported, missing-strength and aligned assessments as model suggestions. Each must link to evidence and the cited sources. Distinguish factual accuracy from sentiment. Do not show a suggested correction as a proven error without a verified fact.
6. **Sources / Lähteet**: private snapshots with URL, title, fetched time, source hash, extracted text, limitations and citing evidence. Render text safely. Allow opening the public URL in a new tab with rel=noopener/noreferrer. Never execute raw stored HTML.
7. **Impact / Vaikutus**: published revisions and before/after comparisons. Separate editorial checklist, AI visibility/citations, sentiment, Google Search performance and identified AI traffic. Include sample sizes, matching comparison groups, dates, source timezone/currency and missing/partial data. An incomplete 28-day window says Collecting data. A missing metric shows an em dash, never zero.
8. **Settings / Asetukset**: brand facts/tone/audience/prohibited claims; existing GA4/GSC connection cards; CMS connection; sharing; recurring opportunity/impact refresh; usage history. Existing project owner maps to Content Studio owner. Additional roles apply to Content Studio only and must not grant access to unrelated monitoring or billing routes.

Keep the UI responsive. On mobile, change the editor side panel to tabs/drawers; keep Save and Review actions accessible. Support keyboard navigation, meaningful labels, focus handling, error summaries and accessible contrast.

## Full editor workflow

Top controls: Save draft, Audit, Research & brief, Suggest changes, Generate full draft, Send for review, Version history, Export, Publish.

- Always save local changes before submitting a job. Send the resulting documentVersion. If unsaved changes exist, ask to save or cancel the action.
- Retain the user's unsaved buffer after an error. Autosave can be debounced, but it must use expectedVersion and never silently overwrite a conflict. On 409 show Reload latest / Copy my changes; no automatic last-write-wins.
- Audit shows deterministic checks separately from AI editorial findings. Display extraction limits, unsupported embedded components, lack of JavaScript rendering and source fetch failures.
- Brief view shows intent, outline, questions, source comparisons, missing information and external-source actions. Let the user supply expertise/facts before generating the article.
- Rewrite view shows each original passage, replacement, reason and sources. Allow individual selection and Apply selected. The API validates exact anchors; on REVISION_CHANGED or CHANGE_ANCHOR_CONFLICT refresh rather than forcing the replacement.
- Full generation for an existing document uses create with documentId/documentVersion and a topic. Display the generated draft beside the current draft; Apply creates a new revision. New-content generation without a documentId creates a new draft automatically. Do not double-create it in Replit.
- Show generated claims/missingInformation and preserve them in the UI. The reviewer must explicitly confirm the content facts have been checked before approval. Approval is tied to a specific revision and resets after edits/restores.
- Comments reference the document and revision. Show resolved status and author; comments on older revisions remain visible as historical comments.
- Version history shows immutable snapshots, actor and timestamp. Restore makes a new draft version, not a destructive rollback of the old row.
- Export Markdown, HTML and plain text as client-created downloads using the returned strings. Provide a copy button and an HTML preview sanitised by an established sanitizer. JSON-LD is a suggested Article object requiring verification, not a ranking trick.

## Publishing

Native targets are WordPress and Webflow. Framer and other platforms use HTML/Markdown export and Mark published. Do not expose a disabled fake Framer integration or claim automatic Framer publication.

WordPress settings: HTTPS site base URL, username and Application Password. The server stores secrets encrypted. Never log those fields or re-display saved secrets. Password replacement requires a full new configuration.

Webflow settings: collection ID, API token, rich-text body field slug and optional description field slug. Publication requires a verified cmsLocaleId for English or Finnish. Obtain field IDs and locale IDs from the actual customer Webflow configuration; do not invent them. Additional required collection fields must be satisfied in the customer's collection configuration before publication.

Publish dialog shows the approved revision, final HTML preview, target, draft/live choice, URL/slug and locale. New content should default to draft. Publishing live requires an explicit user selection. Use GET `/cms/items` to select an existing target and obtain its remote ID, current modification value (`modified_gmt` in WordPress, `lastUpdated` in Webflow) and Webflow locale ID. Paginate results; Webflow search filters the current page only. For a brand-new empty Webflow collection, obtain its locale ID from the customer's verified configuration. The backend rejects changed remote versions. Do not present an unchecked overwrite button.

On uncertain publication, display Check CMS and reconcile. Do not retry automatically or generate a new submission ID. The reconciliation form requires the user to confirm the CMS result, status, remote ID and published URL. This resolves bookkeeping; it does not send a second CMS write.

For manual publication, require the approved revision and an owned public URL. Clearly label the record User-confirmed publication. Record the current publication time; do not pretend the service verified the article content or indexed it.

WordPress's excerpt field is not a guaranteed SEO-plugin meta description. Show the SEO description as a separate export/copy field when the installed SEO plugin does not have a verified integration.

## Jobs and background work

Use the supplied client as a starting point. Create a UUID submissionId once per intentional action. Reuse it for network reconciliation/retry with the same body. Persist the submission in browser state until the job ID is known. A different payload needs a new action and key.

Show queued/running/completed/failed/cancelled/uncertain separately. Poll about every 3–5 seconds while the page is visible and there are active jobs; slow down in background tabs. Navigating away must not cancel the server job. Use checkpoint keys as stage hints, not a made-up percentage. Job results are durable.

Cancel and retry are supported for non-publishing jobs only. Retry preserves completed checkpoints. For publication, manual reconciliation is mandatory after an uncertain write. Bulk submission is all-or-nothing at queue creation; processing results may differ by article.

## Brand facts and Google integration

Only facts deliberately verified by the owner may be treated as verified. Include fact IDs and sources where available. Do not import marketing claims and mark them verified automatically.

Use the existing GA4/GSC connection flow. The content worker's trusted project-to-workspace mapping is operator configuration; do not expose it as a customer-editable text box. When disconnected, the user can still edit and analyse content, and the interface clearly marks unavailable Google inputs.

The updated connector provides query_pages rows with keys `[query,page]`. Keep query overlap labelled as a candidate; matching a query does not justify an automatic merge/redirect. GSC provides top rows, not all queries. Its totals and detailed row sums are different measures. Do not infer an absence of demand from missing data.

## Permissions

Owner: every content action, settings, CMS credentials, members and usage.
Editor: create/edit/import/research/generate, opportunity updates and non-publishing jobs; cannot approve or publish.
Reviewer: read, comment, review, publish/reconcile and mark manual publication; cannot edit content or CMS settings.
Viewer: read only.

Use `/v1/app/content-projects` to list projects shared for this feature. The content overview includes the project identity and role. Sharing uses an existing user's email and sends no invitation email. Do not change the original project ownership model.

## Release completion criteria

Implement all pages and flows above before presenting the feature as ready. Use real backend records throughout. Add loading, empty, unavailable, partial, stale revision, permissions, quota and failed-job states. Run the live acceptance checklist against the deployed backend. Summarise what passed, what requires actual customer credentials and any integration mismatch; do not hide missing API behaviour behind UI-only success toasts.

Deliver: changed files, a concise route map, environment variable names only (never values), screenshots of the implemented UI if the user requests them, test results and any remaining blocking issue. Preserve the existing app and domains.
