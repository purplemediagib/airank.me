# Legacy Replit/Bunny content retirement

The obsolete Bunny Content Studio is retired for **new work**, following the owner's confirmation it is no longer required. This does not delete a Replit project, repository, account, database, saved content, CMS credentials or subscriptions.

## Permanent server-side boundary
Authenticated legacy clients receive HTTP410 `LEGACY_CONTENT_RETIRED` for:
- POST `/v1/projects/:id/content/documents` (new documents);
- POST `/v1/projects/:id/content/jobs`, `/jobs/:id/retry`, and `/bulk`;
- PUT `/v1/projects/:id/content/settings` and `/cms` (new automation/CMS configuration).

Authentication, role and subscription checks still apply; unauthorized clients may receive their existing401/403/404/402 instead. There is no environment opt-in/re-enable flag. Internal `enqueue` and `runJob` reject before storage/provider execution, covering scheduler/sitemap child/direct dispatcher admissions. Dedicated content-worker `tick` and `schedule` are permanently quiescent.

Saved documents, revisions, exports, job history, publications and other existing authenticated reads remain available. Existing document editing/restoring/reviewing/applying historical output, comments and manual publication records remain subject to existing access controls. Existing non-publish job cancellation and manual uncertain-publication reconciliation remain available; there is no automatic publishing replay. Local overview advertises retired:true/newWorkEnabled:false. The retired content worker reports retired:true/executionEnabled:false in health output.

## Queue and in-flight policy
No queued/running/uncertain/failed/completed jobs are deleted, claimed, retried, expired or automatically rewritten by the retired worker. Persisted automation settings are preserved but never scheduled. Legacy work stays historical/paused rather than silently draining or spending. A row that was running may remain running until explicitly investigated; it is not proof that the new retired worker is executing it.

**Operator cutover:** stop all old dedicated *content* worker replicas before replacing them; do not drain the old queue or restart an old version. An already-sent provider/CMS request cannot be recalled by this release, and a shutdown may leave an uncertain remote publication. Inspect those outcomes and use existing manual reconciliation only after verifying the remote CMS; never replay them automatically. Do not delete queue rows or reset checkpoints as a shortcut.

Update the **API and dedicated content-worker images** to the retirement release. Keep ports, secrets, schema and stored data unchanged. No new migration or environment setting is needed. If no dedicated content-worker container is deployed, there is none to update/start; confirm old replicas are absent. Main monitoring worker, paid provider tracking, free checker, and Google connector are not retired and do not need an image change for this delta.

## Current product remains separate
Current app Content Studio uses `growth.functions`/`growth.server` and Cloud `growth_documents`. Direct publishing/scheduling/connectors use `publish.functions`/`publish.server`, Cloud `publish_*` and Zernio. These paths do not call the retired Bunny Content API and this release changes no app files or those services. Current monitoring routes/worker are unchanged.

## Validation
Offline tests assert HTTP admission refusal for every legacy job kind, internal enqueue/dispatch denial before dependencies, no-op scheduler/tick preserving every job state and enabled automation, role/tenant boundaries, saved export/edit/history, cancellation and manual publication reconciliation. Legacy tests that required new jobs/automatic retries were replaced with retirement-contract tests rather than skipped. The full backend regression suite covers unchanged monitoring/free checker/team flows. No production database inspection, deletion, paid provider request or live publishing is performed for this change.
