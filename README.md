# AI Rank.me

Source-controlled backend for AI Rank, including the API, monitoring worker, Content & AI Perception Studio worker, and Google Analytics/Search Console connector.

This integration starts from **API/worker 0.21.0** and **Google connector 0.1.1**, recovered from the supplied release archives. It prepares runtime **0.22.0**, content worker **1.0.0**, and connector **0.2.0**. Production deployment is performed manually in Bunny.

## Delivery without PowerShell

1. Review and merge the Content Studio pull request after **Test and build** passes.
2. GitHub runs **Publish release images**, tests the source, and publishes four images to GitHub Container Registry.
3. Copy the image references from the successful workflow summary into Bunny's dashboard.

No Docker Desktop, local Docker build, image ZIP, PowerShell command, or Bunny API key in GitHub is required. Read [GITHUB-DELIVERY.md](docs/GITHUB-DELIVERY.md) for the one-time registry setup and manual rollout.

## Repository layout

| Path | Purpose |
|---|---|
| `app/src/` | Existing API/monitoring runtime plus `content/` |
| `app/test/` | Runtime, security, content and migration regression tests |
| `google-connector/` | Google OAuth, encrypted report cache and importer |
| `Dockerfile` | Independent `api`, `worker`, `content`, `google` build targets |
| `replit/` | Content API client and English/Finnish translation keys |
| `docs/REPLIT-IMPLEMENTATION.md` | Full interface integration instructions |
| `docs/API-CONTRACT.md` | Content Studio API contract |
| `docs/ACCEPTANCE.md` | Coordinated launch checks |
| `docs/SOURCE-PROVENANCE.md` | Imported versions, preserved changes and validation limits |

The Replit application UI is not included in the supplied releases or this repository. The backend, API client and interface brief are included; adding the Content Studio screens to the existing Replit app remains a separate integration task.

## Local development

Use Node 24 for all tests. Production runtime images use Node 22 for the API/workers and Node 24 for the Google connector.

```sh
cd app
npm ci
npm test
cd ../google-connector
npm test
```

Keep actual secrets in Bunny or your local environment. Only blank/example settings belong in Git. Content generation requires an explicit OpenRouter model, provider key and configured budgets. Shared database migrations are operator-controlled; importing or testing this repository does not run them in production.
