# Source provenance and validation

## Baselines

The repository was empty when this work began. Its initial `main` commit contains only a README; all application source is proposed on `feat/content-studio-github-delivery`.

Application files were recovered from `/app` in the ordered final filesystem layers of the supplied Docker archives. Operating-system files, installed dependencies, image archives and runtime data are not committed. The API and monitoring images in 0.21.0 share the same application layers. `imported-source-sha256.json` records the recovered original source hashes for future comparison.

| Input | SHA-256 |
|---|---|
| `airank-release-0.21.0.zip` | `31905c2a0bb50c338a6a80125142502209bc67c2609e8864931df27fefc7cf37` |
| `airank-google-connector-0.1.1.zip` | `21a5e6d0b4b14a6a06ca93c1a57bc9e43e7a12528c08db67e3d8aaedf014a8bb` |
| Earlier `airank-content-studio-1.0.0-source.zip` | `eedf0fa1270e00f9ce45bf12c8d4b49320cde85eea1eaa7a3c85269937e76d58` |

## Reconciliation

- Preserved the 0.21.0 runtime, including intelligent suggestions, branded/neutral measurement separation, provider budgets, collectors, Google connection proxy and all original tests.
- Preserved every existing migration through `app-018-intelligent-suggestions`. The content schema is now `app-019-content-studio`; the older, undeployed package's 013 identifier is not used.
- Added the existing Content Studio backend and tests. Integrated its routes after existing authentication/CSRF handling, with the larger body limit confined to content routes.
- Reused the current stored-project-ID Google workspace convention. An optional trusted legacy mapping remains available; browser-supplied workspace IDs are not accepted.
- Preserved connector 0.1.1 diagnostic/error sanitisation. Added the query/page report view, accurate missing-view dates and tests. Deployment does not reset existing or failed historical import jobs merely because their report format is older.
- Added the built commit revision to health responses. Runtime version is 0.22.0; connector is 0.2.0. Image tags use full Git commit SHAs.
- Replaced the earlier release's overlay image assembly and PowerShell delivery with fresh Docker builds from checked-in source. Dependencies install from the supplied lockfile. The Node base-image major versions remain 22 for the API/workers and 24 for the connector.

## Validation performed locally

- **321 API/runtime tests pass** on Node 24.19.0, including 0.21 regressions and content upgrade tests.
- **15 Google connector tests pass** on Node 24.19.0.
- The upgrade test applies the full existing migration sequence followed by 019, verifies original migration checksums are unchanged, reruns 019, and exercises current analytics through Content Studio.
- Source checks found no private keys or recognised live provider/GitHub credential patterns in the proposed files. Example secrets in tests are synthetic fixtures.

GitHub CI separately tests the runtime on Node 22 and 24, tests the connector on Node 24, and builds/import-checks all four production images. The workflow result is the authority for those checks; local fixture success is not a Docker build result.

No production database was migrated, no container was deployed, no paid provider request or CMS publication was made, and no Replit frontend screen was installed during this work. Live account, provider, CMS and complete UI acceptance remain rollout checks in `ACCEPTANCE.md`.
