# Overview read latency — 30 October 2026

## Confirmed code path

The Overview keeps its headline cards in a loading state until the selected-setup
analytics response arrives. The backend previously awaited independent database
reads serially. Billing precheck does not call Stripe for these GETs. This change
parallelizes independent reads **after** project authorization and input validation.
No query population, date window, KPI calculation, authorization, response cache,
provider call, or billing rule changes.

The first stage has five independent branches; the metadata stage has three.
`loadJobs` retains its own access check. Any branch failure rejects the whole
response, not a partial metric set. Already-started sibling reads may finish on a
failure. Before and after, separate reads are not a transactional snapshot.
The existing libSQL client limits simultaneous operations (installed default 20);
per-request parallelism can increase queue pressure under load and should be
observed during rollout.

## Verification

- Backend full suite: 476 passed; focused analytics: 20 passed.
- Independent review and independent frozen-baseline replay found identical JSON.
- Offline fixture: 28 runs, 17 prompts, 476 answers, injected **25 ms per DB read**.
  Baseline: 341 ms, 11 reads, peak 1 active. Changed: 173 ms, 11 reads, peak 5 active.
  A second independent replay measured 330 ms / 160 ms.
- These are synthetic local measurements, **not production or browser latency**.
- No production data, paid scans, live provider calls, or credentials are used.

Reproduce from this branch (temporary baseline stays next to its relative imports):

```sh
git show 90dc266ba36e33ab8cf4b9c1ab21f7b10bb053cd:app/src/analytics/service.mjs > app/src/analytics/.overview-baseline.mjs
node scripts/benchmark-overview.mjs app/src/analytics/.overview-baseline.mjs
rm app/src/analytics/.overview-baseline.mjs
cd app && npm test
```

Companion UI work bounds history requests to three simultaneous background reads,
uses account-scoped shared analytics keys, cancels abandoned requests, and provides
visible bilingual loading feedback. Headline metrics remain single-setup; full
history remains separately labelled. Neither component is deployed by this PR.
