# Caller-only signup and trial context

`GET /v1/app/session` adds `lifecycle` for a valid cookie session. Anonymous,
expired, and report-bearer session requests return `lifecycle: null`. No report
bearer scope is expanded. Existing private/no-store response headers remain.

Fields:
- `accountCreatedAt`: valid positive caller signup timestamp, never a current-time fallback.
- `observedAt`: server observation time; NOT a trial start.
- `state`: `ready` when team and plan migration checksums match, otherwise `unknown`.
- `ownedWorkspaces`: caller-owned IDs, ownerUserId, plan, status, original
  trialStartedAt/trialEndsAt and revision. No other tenants' identities/emails.
- `hasNonOwnerMembership`: boolean for a nonowned workspace/project membership,
  or null when schema is unknown. No foreign workspace IDs returned.
- `provisionalTrial`: only for a valid signup with no owned workspace and no
  nonowner membership: `{source:'account_signup', startsAt, endsAt}`. End is signup
  plus the existing seven-day policy, even if already expired. This is NOT a
  persisted workspace, subscription, or email eligibility decision.

The helper issues SELECTs only. It never creates a workspace, resets a trial,
changes rate data, or grants credentials. Current schema enforces one owned
workspace per user; an array avoids implicit selection if that invariant evolves.
Legacy null plans and stored trial dates are preserved, not reinterpreted.

## Email integration requirements
Consume this context server-to-server using the authenticated session; do not
trust trial dates posted by the browser. New-trials-only enrollment must use the
immutable account/trial anchor and the approved rollout cutoff, not first-brand
creation or observedAt. Invited-only users are not owner-drip recipients. Existing
old accounts, transferred old trials, paid/inactive/expired/unknown trials must
not become new campaigns. Attaching a workspace later must not reset the anchor.

This response is a point-in-time snapshot, NOT background send authorization.
Before each future email, revalidate fresh owner/subscription state plus Cloud
unsubscribe/deletion and Stripe paid suppression. If authoritative lookup is
unavailable, fail closed. No new persistent token or report-token scope is added.
Any new service read authority or reuse of existing database credentials for
this purpose needs a separate explicit scope decision; no live query is included.

Six new offline tests cover read-only prebrand anchoring, anonymous/expired/bearer
privacy, invited memberships, legacy/paid/expired/transferred contexts, migration
and malformed-date fail-closed behavior, and old-account first-brand attempts.
Full suite: 486 passed. No production database reads, sends or deployments.
