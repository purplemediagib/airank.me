# Backend entitlement repair — draft only,30Oct2026

Base backend main288c2c88f903d7e8f63f641f5abc621a85cc351c. Local branch `audit/backend-seat-entitlements`. No deployment, environment change, migration or production test.

## Implemented: team admission enforcement
`app/src/app/team-plans.mjs` mirrors the app's current `plan-limits.ts`: Starter2seats/no project guests,Pro5seats,Advanced/Custom unlimited. Trial has existing Pro policy. No new plan prices or migration.
- Check invitation creation before admission, resend, and resulting acceptance in the existing serialized write transaction.
- PATCHmember roles and ownership transfer also recheck capacity only when counted usage increases: a project role edit can split a user+role group, and transfer can reactivate an old owner guest entry. Neutral/reducing changes remain available after an active downgrade.
- Recheck subscription access and capacity when accepting an outstanding invite; stale invite cannot bypass downgrade/inactive/expired subscription.
- Acceptance consumes its pending-invite reservation and creates membership atomically; failure rolls back both membership and accepted timestamp.
- Revocation/removal are not blocked; existing customers are not evicted. Legacy null-plan compatibility remains exactly as migration022 specifies (billing reconciliation still required).
- Counter matches current owner-visible Team.members+Team.invites used by app billing: owner1, workspace membership rows excluding owner, project guest groups by user+role across workspace projects excluding owner, every unaccepted/unrevoked invitation. Expired pending invitations still count until revoked, exactly like current app usage. Viewer/guest entries count. Multiple scope/role entries for a person can count separately.

This deliberately does NOT silently switch product policy to unique-human seats. That more intuitive policy would require simultaneous app/backend usage changes and approval. Project-level admins may see fewer entries in the app, but backend checks the entire workspace and therefore may correctly reject an invite that the app's partial view thought available. Follow-up: expose authoritative usage to the app rather than derive from visible membership lists.

## Not implemented: legacy content quota/retirement
Actual current app source consumer trace (app checkout HEAD0ad4aa57eba37d7ad4bda629436ced755c2feec3):
- `src/App.tsx:28` loads `@/features/content`; its `index.tsx:11,38` calls `growth.functions` (`draftFromTopic`, `improvePage`, etc.). This current rendered Content Studio is the app-native growth pipeline.
- `src/features/content/studio.tsx` still defines StudioProvider calling `contentClient`; repository search found no active import/render of that provider. That is source evidence, not proof that no older deployed clients or external integrations exist.
- `src/lib/content-api.ts` + `src/server/content-paths.ts` retain legacy document/job/bulk/CMS routes through the app proxy. Backend `content/service.mjs`, `content/worker.mjs` retain its own content_jobs/content_records and scheduled opportunities/impact processing.
- App paid article usage comes from Supabase `growth_documents`; Bunny legacy documents/jobs are separate. Adding20/60 locally would allow two independent quotas, not one shared paid allowance. It could also disrupt existing queued work while failing to solve the commercial promise.
- Existing audit fixture proves active Starter legacy POSTdocument201 and POSTcreatejob202. That gap is not repaired by this seat patch.

Decision options (no choice implemented):
1. **Retire legacy paid mutations after verifying consumers.** Preserve secure GET/history/export; explicitly reject new legacy jobs/doc writes/CMS writes with a stable migration error. Decide how to drain/cancel existing queued jobs and scheduled tasks, prevent old workers dispatching them, preserve already-approved publications/uncertain write reconciliation, and provide migration/export for old content. Do not merely hide UI or proxy routes because direct Bunny calls remain possible. Existing content/access cleanup requires careful exception handling. Requires product/operational approval and deployment coordination.
2. **Keep legacy functionality with one shared quota authority.** Define billable actions (create/brief/rewrite/import/manual doc), monthly window/timezone, trial allowance, idempotent reservation/commit/refund and downgrade behavior. Both Supabase growth and Bunny legacy admissions/workers must consult a shared authoritative ledger; avoid two separate20/60counters. Secure cross-service auth and failure mode require design, not a token UI guard.

Recommendation for review: because current source UI uses growth, verify actual legacy users/queued jobs with authorised metadata-only operational checks; if none, retire rather than maintain duplicate paid pipelines. Until approved, leave this portion explicitly unresolved, not silently disabled. No customer data or production queues were queried in this task.

## Tests
New regression fixtures are in `app/test/team-plans.test.mjs`: last-seat parallel creation; Starter/Pro/Advanced caps; owner/invite accounting; stale accept/resend after downgrade; Starter guest denial; inactive/trial-expiry acceptance; revocation and expired invite policy; legacy null plan; workspace-wide grouped guest accounting; role-group split rollback; ownership-transfer reactivated guest rollback; neutral/reducing over-cap role/ownership edits; concurrent stale acceptance rollback. Uses in-memory SQLite, fixture users, no network/email/provider calls.
