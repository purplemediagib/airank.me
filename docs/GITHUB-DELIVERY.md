# GitHub builds; manual Bunny deployment

The user manages the Bunny containers manually. These workflows only test, build and publish images. They do not access Bunny or change live containers.

## First release

1. Merge the integration pull request after its checks pass. The default `main` branch initially contains only a repository introduction; the complete application is on the pull request branch until merged.
2. Open **Actions → Publish release images**. The merge triggers it automatically. Wait for every publish job to succeed; a partially successful workflow is not a complete release.
3. Open the run's summary. Each image has a `sha-` tag containing the full 40-character commit SHA. Copy the exact references; do not substitute `latest` or older Docker Hub tags.
4. GitHub Container Registry packages initially may be private, even when the repository is public. For each of the four packages, either set package visibility to **Public**, or configure a GHCR registry in Bunny using a GitHub credential with `read:packages` access. Do this in the browser. Repository source is already public; never store credentials in it.

GitHub publishes using its built-in `GITHUB_TOKEN` with `packages: write`; no Docker Hub credentials are required. Organisation/repository policy must allow GitHub Actions and package publishing. No Bunny secret is needed in GitHub.

## Image settings

All four images from one successful release use the same tag. In Bunny, choose/configure the `ghcr.io` registry, use the image name below, then paste the `sha-...` tag from the workflow summary. If Bunny requests a full image reference, prepend `ghcr.io/`.

| Service | Image name | Port | Health | Readiness | Version |
|---|---|---:|---|---|---|
| Existing API | `purplemediagib/airank.me/api` | 3000 | `/healthz` | `/readyz` | 0.22.0 |
| Existing monitoring worker | `purplemediagib/airank.me/worker` | 3001 | `/healthz` | `/readyz` | 0.22.0 |
| New Content Studio worker | `purplemediagib/airank.me/content` | 3002 | `/health` | `/ready` | 1.0.0 |
| Existing Google connector | `purplemediagib/airank.me/google` | 3000 | `/health` | `/ready` | 0.2.0 |

Use the image's default startup command. Clear any old image-digest pin when switching tags, or replace it with the new matching digest. Preserve existing ports, domains, environment settings, registry settings as appropriate, and persistent storage. Reuse the existing API, monitoring and Google applications; only the Content Studio worker needs a new container. Use one content-worker replica initially.

## First rollout order

1. Back up the existing database and Google connector `/data` volume using your normal process. Keep the current image references available for rollback.
2. Add the content settings below to the existing API. Temporarily set `AIRANK_RUN_APP_MIGRATIONS=true`, switch to the new API image, and redeploy. Confirm the log **AI Rank app migrations 001–019 verified successfully.** Migration `app-019-content-studio` is additive. All existing migrations through 018 retain their original code/checksums. Restore the migration variable to its previous value after success.
3. Update the existing monitoring worker to the matching image/tag. Preserve all provider, budget, collection and scheduler settings from 0.21.0, including any `CLAUDE_MAX_OUTPUT_TOKENS` override.
4. Update the existing Google connector image. Keep **all** existing OAuth settings, API/encryption keys and its persistent `/data` volume. Query/page reports are collected on new imports and normal refreshes; upgrading does not force a historical backfill or restart failed imports. Use the application's Sync action when you deliberately want to backfill missing report dates.
5. Create the content worker using the content image, port 3002, the same database and the settings below. It requires no persistent local volume. Keep any health endpoint accessible only as needed by your deployment setup.
6. Check every service's health and readiness. Health includes `revision`, which must match the full commit SHA in the image tag. A healthy process alone does not verify CMS/provider integrations; complete [ACCEPTANCE.md](ACCEPTANCE.md) before announcing launch.
7. Integrate and publish the Replit interface using [REPLIT-IMPLEMENTATION.md](REPLIT-IMPLEMENTATION.md). Existing Replit and Framer behaviour is preserved; these backend images do not install frontend screens.

## Content settings

| Setting | API | Content worker |
|---|---|---|
| `BUNNY_DATABASE_URL`, `BUNNY_DATABASE_AUTH_TOKEN` | Keep existing values | Same existing database |
| `CONTENT_ENCRYPTION_KEY` | New random 64-character hex key | Exact same key as API |
| `CONTENT_MODEL` | Explicit supported OpenRouter model ID | Same model |
| `OPENROUTER_API_KEY` | Needed for configuration status | Needed for generation |
| `CONTENT_DAILY_BUDGET_USD` | — | `10` suggested starting value |
| `CONTENT_PROJECT_DAILY_BUDGET_USD` | — | `2` suggested starting value |
| `CONTENT_CALL_RESERVATION_USD` | — | `0.50` suggested starting value |
| `GOOGLE_CONNECTOR_BASE_URL`, `GOOGLE_CONNECTOR_API_KEY` | Preserve existing values | Copy existing connector settings |
| `CONTENT_GOOGLE_WORKSPACES_JSON` | — | Optional legacy override; omit for the 0.21 project-based connection flow |

Generate the encryption key with a trusted password/secret manager offering 32 random bytes encoded as hex; keep a secure backup. Do not reuse the Google connector encryption key. CMS credentials are encrypted with this new key. The three budget defaults are configurable estimates/reservations, not a provider-enforced spending cap; configure the provider account cap too.

See `content.env.example` and `google-connector/.env.example` for names only. Keep actual values out of GitHub and Replit browser code.

## Future changes and rollback

For future work, create a branch and pull request. CI tests API behaviour on Node 22 and 24, the connector on Node 24, and builds/import-checks all four production images. Merging to `main` publishes a new, commit-specific set. You choose when to update Bunny in its dashboard; nothing deploys automatically.

Rollback uses a previous successful release tag/digest, with the same secrets, database and connector volume. Roll back API and monitoring worker together. Do not drop additive tables or delete cached reports to roll back code. Previous Docker Hub images remain an option for the first migration; their health endpoints do not expose the new Git commit revision field.

References: [GitHub container publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [GHCR visibility and authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [Bunny container configuration](https://docs.bunny.net/docs/magic-containers-how-to-edit-app-configuration).
