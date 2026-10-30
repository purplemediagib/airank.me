# Free checker CAPTCHA (operator setup required)

This change is code only. It does not create a Cloudflare account/widget, retrieve
secrets, change Bunny configuration, merge or deploy. Obtain owner approval for
those actions separately. Missing CAPTCHA configuration disables new public
checks; existing token-protected reports remain readable.

## Required coordinated rollout

1. Create a **managed Cloudflare Turnstile widget** after approval. Register only
   exact frontend hostnames hosting the checker, including approved production
   and preview app hosts. For the Framer iframe, the widget runs on the **iframe
   app's hostname**, not automatically the outer Framer page's hostname.
2. Set these on the Bunny API through its approved secret/configuration channel:
   - `TURNSTILE_SITE_KEY`: public widget site key (returned in capabilities).
   - `TURNSTILE_SECRET_KEY`: server-only secret; never put in frontend variables,
     logs, tickets, screenshots or source control.
   - `TURNSTILE_ALLOWED_HOSTNAMES`: comma-separated exact hostnames, without
     schemes, ports, paths or wildcards. Must match the widget's approved hosts.
3. Deploy compatible frontend and backend together after separate deployment
   authorization. No database migration is needed for this addition.
4. Allow HTTPS egress from Bunny API to
   `https://challenges.cloudflare.com/turnstile/v0/siteverify`. The frontend must
   allow the official `https://challenges.cloudflare.com` script and frames in
   its CSP; preserve existing origin/CSRF and iframe protections. Validate the
   actual Framer embed on mobile and desktop, including keyboard interaction,
   script-blocking, challenge expiration and retry.
5. Validate using Cloudflare's documented test keys only in isolated nonproduction
   configuration; never enable always-pass test credentials in production. Actual
   production widget tests and DNS/browser behavior remain operator checks.

## Contract and guarantees

`GET /v1/public-check/capabilities` adds
`captcha: {provider: "turnstile", siteKey: string | null, action: "public_check"}`.
The browser obtains a **fresh** widget token with action `public_check` for each
`POST /prepare`, `/preview` and `/scans` under `/v1/public-check`, and includes
`captcha_token` in the JSON body. Fresh tokens are also needed for cached draft
requests and idempotent submission retries. Reset after each submitted attempt,
on expiration or error. Preserve submission IDs on retries to avoid duplicate
jobs. Do not place tokens in URLs or analytics.

The server calls Siteverify on every protected request before website DNS,
scraping, question generation or queue creation. It checks success, exact
hostname, action and challenge timestamp (strictly younger than five minutes).
Cloudflare provides atomic single-use/replay rejection across API replicas.
Verification has an eight-second timeout and is never retried or cached; unknown
network outcomes fail closed and require a new challenge. No CAPTCHA tokens or
provider responses are logged or persisted. Existing quotas, preparation
reservations and paid worker budgets still apply before provider expense.

Errors: `CAPTCHA_REQUIRED` and `CAPTCHA_FAILED` (403), `CAPTCHA_UNAVAILABLE` (503).
When execution prerequisites are absent the public service returns
`APP_NOT_CONFIGURED` (503) and capabilities `enabled: false`.

Legacy free `POST /v1/scans` also requires server verification, even if a legacy
session cookie is present. Authenticated paid tracking is dispatched through
`appRoute` and retains existing authentication, plan, rate and budget checks.
Legacy deterministic `/v1/scans/preview` remains zero-cost and does not enqueue or
invoke paid providers. Signed-in website profiles already require account access
and are not changed.

## Sources

- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
- https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/
- https://developers.cloudflare.com/turnstile/troubleshooting/testing/

## Verification

Offline tests cover complete configuration, invalid/oversized tokens, hostname
and action mismatch, expired/future tokens, replay responses, network/HTTP/JSON
failure, guarded routes producing no paid preparation or queue writes, and the
legacy boundary. All provider responses are fixtures: no live CAPTCHA or paid
provider calls are made during tests.
