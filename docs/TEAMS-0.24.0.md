# Teams backend 0.24.0 — deployment and Lovable handoff

Implements `bunny-teams.md`: one workspace per owner, workspace members, brand guests, owner/admin/member/viewer roles, email-bound invitation acceptance, team management and ownership transfer. Project list/detail responses include `myRole`, `ownerName`, `workspaceId`.

## Bunny rollout

1. Deploy the **API** image from the merged 0.24.0 commit, with the existing `AIRANK_RUN_APP_MIGRATIONS=true` setting for this rollout. Preserve the database connection and all existing secrets. The standard Docker API entrypoint runs the additive migration automatically. A custom command that directly starts `server.mjs` must instead use `node src/app/start-release.mjs` for the migration rollout.
2. Confirm `AI Rank app migrations 001–021 verified successfully.` in API logs and `/healthz` reports `0.24.0` and the deployed commit revision. Restore `AIRANK_RUN_APP_MIGRATIONS=false` after successful migration if normally disabled.
3. Deploy **worker** and **content** images from the same commit before testing team checks or Content Studio jobs. They share the access code and use the same database. The content worker rechecks the initiating person's role when executing jobs.
4. Open Settings → Team as an existing owner, invite a second account, accept using the addressed email, and check a shared brand. Test a viewer cannot edit, a guest cannot open another brand, and removal stops access.

No new Teams environment variables, JSON, keys or secrets. Keep the existing model, provider-budget, report-token and Google connector settings. **No Google container or Google Cloud Console changes.**

Migration `app-021-teams` runs after the existing 001–020 checksummed migrations. It backfills each existing owner and brand, converts Content Studio viewers to project viewers and editors/reviewers to project members, and adds hashed invitations and audit tables. No observations, runs, prompts, content documents or existing report tokens are deleted. Migration is transactional and repeatable. Once teams are in use, deploy fixes forward: old releases do not enforce the new roles and their implicit project INSERT statements do not support the new column.

## Lovable contract

All endpoints retain the registered `X-AIRank-Client`, signed-in session cookie, and CSRF/origin checks for writes. Team email delivery remains in Lovable/Resend. Bunny never sends invite email. Only the create/resend response contains the token; do not log it or include it in analytics.

| Route | Behaviour |
| --- | --- |
| `GET /v1/projects/:id/team` | Workspace name, current role, owner/members/brand guests and pending invites; viewers get no invites. |
| `POST /v1/projects/:id/team/invites` | `{email,role,scope,projectIds?}`; returns `{token,invite:{id,email,role,scope,inviterName,inviterEmail,targetName}}`. Project scope defaults to this brand when projectIds is omitted. |
| `POST /v1/projects/:id/team/invites/:inviteId/resend` | Empty JSON body; rotates token, resets seven-day expiry. |
| `POST /v1/projects/:id/team/invites/:inviteId/revoke` | Empty JSON body; invalidates pending invite. |
| `PATCH /v1/projects/:id/team/members/:userId` | `{role}`; changes the workspace membership if present, otherwise project guest rows the caller may administer. |
| `DELETE /v1/projects/:id/team/members/:userId` | Empty JSON body; removes workspace membership and guest grants in the workspace when called by workspace owner/admin. |
| `POST /v1/projects/:id/team/transfer` | `{userId}`; target must be a workspace admin. Old owner becomes admin. All workspace project owner IDs change atomically. |
| `GET /v1/app/invites/:token` | Signed-in preview with `expired` boolean. |
| `POST /v1/app/invites/:token/accept` | Empty JSON body; email match, upgrade-only membership, one use, returns `{projectId}`. |

Timestamps in team lists are epoch milliseconds. `scope` is `workspace` or `project`, including the owner's workspace row. A user may have a workspace row and additional project rows; the highest role applies per brand. Guest rows of the same role combine `projectNames`.

Roles are checked in the backend across project details/versions, analytics/results/evidence, scans, prompts, suggestions, research/competitors, opportunities, intelligence/sentiment, reports, schedules, settings, Google proxy and content. Metadata and report reads require viewer; edits/checks require member; project/measurement/schedule/report creation and connection management require admin. Google status/imported reports remain readable; choosing/enumerating properties and changing connections require admin. Content members map to editor for the content UI; admin and owner can manage content settings. Legacy Content Studio sharing writes return `410 USE_TEAM_INVITES`; use Team invites to change access.

## Permission boundaries and error handling

- Missing brand access returns `404 NOT_FOUND`; insufficient role on a visible brand returns `403 ROLE_FORBIDDEN`.
- Workspace admins can invite admins. Only the owner may change/remove an existing admin or transfer ownership. Owners cannot be changed through member routes.
- **A project guest admin is limited to brands they administer.** They cannot invite workspace members, change workspace memberships, or manage guests on other brands. Team lists omit guests/project names outside the caller's visible brands. For workspace invitations and management across all brands, use an actual workspace owner/admin account.
- `409 ALREADY_MEMBER`: requested membership is already present. Use member role management for an existing workspace member.
- `403 INVITE_EMAIL_MISMATCH`: accept while signed in with the invited email (case insensitive).
- `410 INVITE_EXPIRED`: resend. Unknown, rotated, revoked and used tokens return `404 NOT_FOUND`.
- `429 INVITE_RATE_LIMIT`: 50 invitation creations/resends per rolling 24 hours per workspace.
- `422 WORKSPACE_ADMIN_REQUIRED`: transfer target is not a workspace admin. `409 TARGET_ALREADY_WORKSPACE_OWNER`: target already owns another workspace; automatic merging of unrelated workspaces is not performed.
- An invitation cannot be accepted after its inviter loses the required management access. Removing a workspace member also revokes their pending issued/received invitations for that workspace.

Creating a brand uses the creator's own workspace, creating one if absent. Membership in someone else's workspace does not implicitly move the creator's own brands into it. Ownership transfer does not rewrite historical run owners or snapshots. History remains readable through the project's current role, and subsequent runs/capacity limits use the new owner. Account-specific prompt-limit overrides follow the owner account, so review those existing entitlements when transferring ownership.

## Reports and auditing

Report credentials keep exactly the same three GET route scopes and cannot call Teams or write routes. Minting requires admin/owner access to at least one project. Users may still list and revoke their own credentials after losing management rights. Every report read uses the holder's current project role.

Removal additionally blocks that user's existing report tokens for the removed projects, without disabling reports for unrelated workspaces. Reinviting the person does not revive those old grants; mint a new report token after restoring access. No scheduled-email preference data is changed by this backend.

Team writes, role/ownership changes and acceptance are transactional with audit records. `app_team_audit` records actor, target, scope and changes; `app_audit_events` also receives the event kind. Neither records invitation or report credentials.

## Validation

Regression coverage includes migration/backfill, real routed role checks, guest isolation, owner budget attribution, owner/admin target restrictions, hashed email-bound invite expiry/rotation/replay/rate limits, scoped report revocation, ownership transfer and retained history, rollback on audit failure, browser CSRF, restricted bearers, Content Studio access and legacy scan URL authorization. Tests use local fixtures, without paid provider calls or outgoing email.

Live invite email delivery and frontend acceptance should be smoke-tested after Bunny deployment.
