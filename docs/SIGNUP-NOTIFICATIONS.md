# Owner new-account notifications

Prepared locally on top of `c9c5ddcf03cbec81b724a6d76d83ac8000edff8c` (the delivered, unmerged free-check Kimi branch). Preserve that base when building updated API images; a PR to main will also include the Kimi ancestor until that branch is merged. This patch does not change Kimi behavior, account linking, OAuth permissions, or credentials.

## What it sends

One notification per newly inserted account ID to the fixed owner `vincent.carrie@purple.gi`. Subject says **new account**, not new person. Includes stored name, email, account ID, actual creation time explicitly UTC, email/password or Google authentication, verification status, and initial app locale when supplied. Both currently supported account creation paths require email verification. No account exists while an email signup challenge remains unverified.

Company/website, persisted plan/trial/team role and user timezone are not collected/assigned at account insertion. The message says so rather than inventing values; the app may show a provisional account-signup trial before a workspace has a persisted plan. No later onboarding-update email is sent. Passwords, tokens, Google subject IDs, IPs, profile images and payment information are not copied into the email. Values are HTML-escaped.

The shared `users` table is the source of truth: AFTER INSERT covers app Google, legacy Google and verified email creation. Account UPDATE/link, Google UPSERT on existing subject, resets and logins do not enqueue. No backfill query runs. Initial available app locale is added by the first preferences INSERT and never overwritten on later preference changes. For app Google/email signup this is in the account-creation transaction; legacy signup has no locale, though its first later app login may provide one before dispatch.

**Existing behavior:** Google callbacks match Google subject only. A password account followed by Google sign-in with the same email currently creates a different account ID, not a linked account. An offline real app-callback test proves two rows with the same email; each is a new account and each queues one notification. This patch deliberately does not change authentication/linking security.

## Activation (not yet performed)

Publication, image building/publishing and production activation require owner approval. No live signup or test email has been performed.

Use the API's existing `RESEND_API_KEY` and verified `AUTH_EMAIL_FROM`; do not create credentials or change sender/domain. Confirm current sender verification operationally before enabling. Set `SIGNUP_NOTIFICATIONS_ENABLED=true` on the API. Optional `SIGNUP_NOTIFICATION_TO` must exactly equal the fixed owner address; any other value disables delivery. No arbitrary/client-provided recipient is accepted.

For the simplest manual rollout, set **AIRANK_RUN_SIGNUP_NOTIFICATION_MIGRATION=true** alongside **SIGNUP_NOTIFICATIONS_ENABLED=true** on the API. This narrow startup opt-in applies only additive migration 025, before listening, whether Bunny uses the default release wrapper or a direct `src/api/server.mjs` command. Existing app tables/migrations must already exist. It creates table and triggers in one transaction, is idempotent/checksum-verified, and does not scan historical users. Remove the migration flag after successful rollout; keep notifications enabled.

Alternative operator paths remain `node src/app/signup-notification-migration.mjs`, or the existing broad `AIRANK_RUN_APP_MIGRATIONS=true` release wrapper (which includes 025 when notifications are enabled). The narrow flag avoids rerunning unrelated migrations. The API itself dispatches once per 15 seconds, across replicas safely; no worker credentials/settings need changing.

## Reliability and operational limits

- The outbox event commits or rolls back with its new account. Mail/provider/network failures never run on, or fail, the signup response path. A corrupted/dropped outbox table with its trigger still installed *will* fail the account INSERT: this is the explicit atomic-outbox tradeoff, not silent loss. Atomic migration and schema integrity are required.
- Atomic DB lease, six bounded attempts, fixed persisted payload/sender and stable `signup-owner/<account-id>` Resend idempotency key handle concurrent replicas and ambiguous responses. Lease ownership and age are checked immediately before sending.
- Resend deduplicates keys for 24 hours. Automatic retries stop after 23 hours from first attempt (or six attempts), leaving a dead-letter record. Never blindly reset an uncertain old delivery: check provider evidence first. No claim of guaranteed exactly-once inbox delivery across arbitrary crashes/provider failures is made.
- After success the PII snapshot/payload are cleared; only account ID, provider receipt and delivery bookkeeping remain. Dead-letter snapshots remain restricted in the backend DB for operator diagnosis; resolve and clear them promptly. Do not expose these tables through public APIs or logs.
- Logs contain only safe event/status/attempt/count fields, not raw error messages or user data. Startup reports whether dispatch is enabled/configured. `signup_notification_dispatch_unavailable` means check migration/database readiness; `signup_notification_dead` needs operator review.
- Setting enabled=false pauses delivery, **not capture**: the installed trigger continues recording future accounts. To fully remove capture, explicitly drop both named triggers after operator review. Never drop the table while its users trigger remains installed.

Operator-only status query (no PII):

```sql
SELECT status, count(*) FROM app_signup_notifications GROUP BY status;
```

## Validation

Offline focused tests cover verified email creation/challenge/login/reset/replay; real app Google callback/new/repeat/replay/same-email accounts; equivalent legacy INSERT and account update/upsert; rollback/no backfill; concurrent dispatcher claims; payload safety; bounded failure/DLQ; crash recovery; stale lease/window suppression; fixed recipient; and intentionally corrupted outbox failure semantics. The legacy HTTP OAuth exchange is not live-tested; its existing users INSERT is exercised. No external mail is sent by tests.

Before production completion: publish approved code/image, apply migration/config, confirm the exact API revision and safe configuration log, then perform one expressly approved email signup and one Google signup with controlled accounts and confirm owner inbox receipt/no duplicate on login. Actual signup tests and real mail are pending approval; do not create accounts or send to customers for verification.

Provider dedupe reference: https://resend.com/changelog/idempotency-keys
