# Analytics candidate release and Bunny runbook

Candidate branch: `fix/analytics-summary-read-model-20261103`.
Exact source base: `33420b5e74e4b1cea0d7b96427a7f0a11f6ccc45`.
This branch is separate from the deployed `feature/signup-owner-notifications`.
Creating candidate images does not merge code, change Bunny, migrate data or fix
production by itself. Publication requires the owner's approval for this change.

## GitHub gate

The branch-only workflow calls the existing CI first: backend Node 22/24 tests,
Google Node 24 tests, and all five Docker targets with import checks. Only after
those jobs succeed does it publish the API and analytics-projector candidates.
It uses existing ephemeral GITHUB_TOKEN authentication, never a new stored token.
No floating/latest tag is changed. Every image is tagged with the exact candidate
commit and its pulled immutable digest is written to logs and the job summary.

Use the successful run's actual SHA and digest. Do not substitute the local source
snapshot commit hashes, an earlier run, or an image that merely built locally.

- API candidate: `ghcr.io/purplemediagib/airank.me/api:sha-<candidate-sha>`
- Projector candidate: `ghcr.io/purplemediagib/airank.me/analytics:sha-<candidate-sha>`

There is no direct Bunny deploy job, no Bunny credential, no migration job, and no
production DB/provider secret in the workflow. The API read-model feature remains
off unless the operator explicitly sets `AIRANK_ANALYTICS_SUMMARY_ENABLED=true`.

## Bunny steps, only after review and approval

1. Record the existing API image digest, startup command, environment and service
   routing. Verify the current production `/healthz` revision. Preserve the current
   image for rollback. Review database backup/restore and expected migration locks.
2. Run the candidate against an approved staging database first. Apply exactly
   `node src/analytics/read-migration.mjs`, then
   `node src/analytics/summary-migration.mjs`, using an approved one-off command
   facility. These correspond to migrations 026 and 027, are checksummed/idempotent,
   and do not call providers. Do not enable all historical migrations.
   If Bunny offers no approved one-off command facility, stop here: use a separately
   reviewed startup-command override or narrow migration flag. Do not improvise a
   credentials workaround or assert that a migration happened.
3. Verify migration records and the evidence/run/intelligence indexes. Start the
   API candidate by immutable digest, preserving its existing command/env/routing.
   Enable its summary feature only for the reviewed canary. Neither API entrypoint
   automatically applies migration 027.
4. Create a separate analytics-projector service from its immutable digest. This
   is a new server-side service and ongoing DB access must be explicitly approved.
   Use the same existing DB destination and output-affecting configuration as API.
   Do not expose DB secrets to Lovable browser code. No provider API credentials are
   required for this deterministic projector. Set `PORT=3003`,
   `AIRANK_ANALYTICS_SUMMARY_ENABLED=true`, and, if approved,
   `AIRANK_ANALYTICS_PREWARM=true`. Its startup checks both migration checksums.
   Give its health probe up to 30 seconds because aggregation can be CPU-intensive.
5. Verify projector `/readyz` and build revision, successful projection logs,
   default-window prewarming and source revision freshness. Measure actual worker
   CPU/memory and queue delay before choosing replica count. Do not infer capacity
   from local benchmark timings.
6. Run authenticated parity checks for the previously failing project/date window,
   previous-period metrics, mixed setups, search, pagination and revoked access.
   The new summary must be 200 with the expected compact shape, then evidence pages
   must match that generation. A 202 cold response is not a completed fix.
7. Publish the corresponding reviewed frontend with
   `VITE_AIRANK_ANALYTICS_READ_MODEL=true` only after the backend is ready. Confirm
   Overview has no full-evidence/group fanout or automatic raw fallback. Check
   ordinary users, mobile layout, deep-linked answers and access revocation.
8. Confirm live end-to-end latency, payload size, freshness and error rate. Only
   then describe the dashboard issue as fixed. Other screens still use legacy
   endpoints and require their own migration if they remain slow.

## Rollback

Disable the frontend/API read-model feature gates and stop or roll back the new
projector. Restore the recorded prior API image if necessary. Additive schemas and
indexes can remain while reviewed rollback is evaluated; never delete raw evidence
or rewrite old migration checksums. Do not merge or deploy this branch implicitly.
