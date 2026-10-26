# Google connection popup: API 0.23.3 and connector 0.2.1

The API now selects the Google connector return URL from a configured list by
matching the request's app origin. The connect endpoint still requires the
registered app client, its exact Origin, the signed-in owner's session and a
valid CSRF token. The browser cannot supply a custom return URL in the body.
An absent or unmatched origin uses the first configured URL, never an arbitrary
URL. The legacy singular setting still works when the plural setting is absent.

The connector already returned successful and cancelled OAuth flows to the
stored allowlisted URL. Version 0.2.1 additionally normalises configured URLs
consistently with the API and treats an empty comma/whitespace list as missing
configuration. Tests cover GA4/GSC success and cancellation at all three app
origins, as well as replay, origin, ownership and unapproved-URL rejection.

## Bunny: API container

Use the new API image from this release commit. Keep the latest monitoring
worker; no worker change is required for Google popup routing.

```text
GOOGLE_CONNECTOR_BASE_URL=https://mc-kvj7j25914.bunny.run
GOOGLE_CONNECTOR_RETURN_URLS=https://app.airank.me/oauth/google/done,https://airankme.lovable.app/oauth/google/done,https://id-preview--f43f6624-1f66-4947-a301-a8060a55018e.lovable.app/oauth/google/done
```

Keep `GOOGLE_CONNECTOR_API_KEY` equal to the connector's `CONNECTOR_API_KEY`
(at least 32 characters). The new plural return-URL setting takes precedence
over `GOOGLE_CONNECTOR_RETURN_URL`. The origins used to sign in must already
have the correct registered entries in `AIRANK_OAUTH_CLIENTS_JSON`; this change
does not change that login registry or relax its origin checks.

## Bunny: Google connector container

Use the `google` image from the same release commit; its health version is 0.2.1.

```text
PUBLIC_BASE_URL=https://mc-kvj7j25914.bunny.run
APP_RETURN_URLS=https://app.airank.me/oauth/google/done,https://airankme.lovable.app/oauth/google/done,https://id-preview--f43f6624-1f66-4947-a301-a8060a55018e.lovable.app/oauth/google/done
```

The two return-URL lists are comma-separated values, not JSON. Add any other
intended app origin's exact completion URL to both lists before using it.
Keep the existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, shared
`CONNECTOR_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `DATA_DIR=/data`, mounted data
volume, port and sync settings. Do not generate a new encryption key for this
update: the existing key decrypts saved Google connections. No migration is
required. Redeploy the existing connector and API with their new settings.

## Google Cloud Console

Use the Cloud project and Web application OAuth client whose ID matches
`GOOGLE_CLIENT_ID` on the Google connector.

1. Google Auth Platform → Clients → that OAuth client → Authorised redirect
   URIs: add the following exact value if absent, preserving existing login
   callbacks:

   ```text
   https://mc-kvj7j25914.bunny.run/v1/oauth/google/callback
   ```

   The app's `/oauth/google/done` URLs are connector return destinations. Google's
   OAuth redirect URI for this flow is the connector callback above. No new
   authorised JavaScript origin is required by this server-side OAuth flow.

2. APIs & Services → Library: enable Google Analytics Data API, Google Analytics
   Admin API, and Google Search Console API in that project if not enabled.

3. Google Auth Platform → Data Access → Add or Remove Scopes: ensure these are
   included, retaining scopes already needed by the application's other flows:

   ```text
   openid
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/analytics.readonly
   https://www.googleapis.com/auth/webmasters.readonly
   ```

   The connector requests `openid email` plus the read-only scope for the
   selected service. It does not request Analytics or Search Console write access.

4. If the app's audience is External and its publishing status is Testing,
   add each Google account used for testing under Audience → Test users.
   Google's refresh tokens for these read-only scopes expire after seven days
   in Testing. Public customer use needs production status and any verification
   Google requires for the selected scopes.

## Post-deployment check

- API: `/healthz` should show 0.23.3 and the new revision; `/readyz` should be ready.
- Connector: `/health` should show 0.2.1 and the new revision; `/ready` should be ready.
- From each intended app address, open Settings → Connections and connect GA4,
  then GSC. Approve access with an account that can access the desired property.
  The popup should return to that same app address at `/oauth/google/done` with
  `google_connection=connected` and `service=ga4` or `service=gsc`, then the
  frontend closes it and refreshes the property picker.
- Cancel once to confirm `google_connection=cancelled` returns to the same app
  without replacing a saved connection. Refresh after choosing a property and
  verify the selection persists and sync starts.

The automated tests mock Google responses. They do not verify an actual user's
Google consent, deployed frontend popup closing, or live GA4/GSC property access.

## Official configuration references

- [Google web-server OAuth redirect requirements](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Consent screen, test users and scopes](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Refresh-token expiry in Testing](https://developers.google.com/identity/protocols/oauth2)
- [Google Analytics API setup](https://developers.google.com/analytics/devguides/config/admin/v1/quickstart)
- [Search Console authorisation](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing)
