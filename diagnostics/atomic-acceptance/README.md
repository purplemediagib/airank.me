# Atomic publication diagnostic

This is an inert-by-default diagnostic image, not a production analytics worker.
Its source is the real publisher from candidate `b7e71ccb883de4d5a22809f7b40d283004cbc766`.
`source-manifest.json` pins the publisher and its transitive local imports.
`package-manifest.json` additionally pins all application runtime source/data,
locked dependency declarations and the shipped diagnostic modules.

The ordinary Dockerfile, service commands, dependency lock and normal five-service
CI builds remain unchanged. The separate diagnostic Dockerfile installs the same
Node 22 official-image production dependencies, copies the same source, and runs
as `node`. Fixture tests and their test-only destination substitution loader are
not copied into the diagnostic image. Runtime destination identity remains fixed.

## Commands and safety

Default image command: `node diagnostics/atomic-acceptance/hold.mjs`.
It reads no database configuration, makes zero database requests, and holds until
stopped. `/healthz` and `/readyz` report process health only: `status: not_run`,
`projector_running: false`, and `restore_required: true`. HTTP 200 never means
analytics is operational or that the test passed. Preparation is paused.

An explicit, separately authorized one-shot test uses the same command followed
by `--confirm=RUN_ATOMIC_SIX_SYNTHETIC_TABLES_20261104` and
`--expires=<absolute UTC timestamp ending .000Z>` in that order. Expiry must be
future and at most two minutes away. Runtime is bounded to 90 seconds. Missing,
wrong or expired flags remain inert before reading database environment values.
The runtime accepts only its pinned destination and six fixed synthetic tables.
This document and CI do not authorize running that command against a database.
No live endpoint or credential belongs in source, image, command examples or CI.

A completed or failed test stays in the hold process: no automatic rerun,
cleanup, polling, ordinary projector startup or restoration occurs. Retain all
ambiguous results and rows for review; do not infer rollback from a lost reply.

The same image with no flags can contain a production writer incident without
any database access, but it is **not functional analytics rollback**. Keep the
new sentinel-aware API reads. Do not replace them with older readers when real
quarantine markers might exist. Restoring an older worker after a synthetic-only
test is a separate operational decision, not an image behavior.

## Validation and publication

CI runs all existing app tests on Node 22 and 24, existing connector tests and all
five normal image builds, plus the offline fixture suite on Node 22 and 24.
The fixture-only loader substitutes a reserved `.invalid` hostname hash only in
memory, proving destination enforcement without exposing a live hostname.
The runtime files retain their reviewed hashes on disk and inside the image.

CI verifies a no-network, read-only, non-root, no-credential default container,
source hashes, revision label and the exact default command. Publication is
restricted to `fix/stateless-analytics-20261104`, after the entire reusable CI
workflow succeeds, using the ephemeral workflow token. API, analytics and worker
images use `candidate-sha-<revision>` tags; the diagnostic uses
`diagnostic-sha-<revision>`. Pulled digests, source bytes and revision are checked.
Use the returned immutable digest for any subsequently authorized action.
There are no deployment, migration or live acceptance steps in the workflow.

Local checks:

- `node scripts/verify-atomic-package.mjs`
- `node --experimental-sqlite --import ./diagnostics/atomic-acceptance/test/register.mjs --test diagnostics/atomic-acceptance/test/*.test.mjs`
- `docker build -f Dockerfile.atomic-acceptance --build-arg BUILD_REVISION=<revision> --label org.opencontainers.image.revision=<revision> -t atomic-local .`
- `bash scripts/verify-atomic-image.sh atomic-local <revision>`
