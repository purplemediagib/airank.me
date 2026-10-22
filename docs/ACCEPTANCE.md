# Release acceptance

These are gates for the coordinated launch, not a list of future features. The existing saved source and local fixtures cannot verify your live accounts.

## Deployment

- Verify current API/Google tags against the saved baselines; preserve any newer production changes.
- GitHub builds succeed for all four images. Run each image with the appropriate environment on a staging database. Check command, port, non-root runtime where applicable and readiness.
- Back up current DB/Google volume. Apply migration once; repeat verifies checksum and preserves projects, sessions, scan history and Google consent.
- Existing app login, free checker, monitoring queue, sentiment and report views still work.
- API auth still rejects unauthenticated reads, invalid Origin/CSRF mutations and cross-project IDs.

## Editorial journey

- Import a real owned English URL and Finnish URL. Compare original headings, body, links, images and tables with the editor. Confirm unsupported components are flagged.
- Test robots restrictions, redirects, large pages, unavailable sources, a sitemap index and duplicate imports. No arbitrary/private-network fetch should succeed.
- Save, edit from a second tab, trigger a conflict and recover without losing local text. Review/approve, edit again and confirm approval resets.
- Research using actual citations from a tracked question; source URLs, snapshots and timestamps must be inspectable. A failed source must not appear as fetched evidence.
- Generate a new article and selective rewrites with the configured live model in each language. Check source IDs, quotation accuracy, invented claims and awkward localisation manually.
- Apply one selected rewrite; reject the remainder. An edited original must produce a revision conflict rather than a forced patch.
- Comment, resolve, view history and restore a prior version. Restoring creates a new draft.
- Test viewer/editor/reviewer/owner using separate real accounts. Revoking access stops new reads/actions. No sharing invitation email is sent by this package.
- Export HTML/Markdown/plain text; preview safely. Check images and tables. Test hostile HTML and unsafe links.

## Opportunities and measurement

- Google connector /health reports 0.2.0; preserve the existing OAuth accounts. Query-page report contains real `[query,page]` rows after backfill.
- Reconcile GSC page clicks/impressions and weighted positions with the selected property/date range. Preserve missing dates and top-row limitations.
- Compare an incomplete report with a complete report; missing rows must not masquerade as zero performance or proven content decay.
- With an unconnected Google property, show unavailable Google sections while editorial work remains usable.
- Validate a brand-perception finding against its original AI quote and verified fact; avoid treating a negative opinion as a factual error.
- Record a real publication and inspect the collecting state. Before/after AI comparisons require identical group composition. Sentiment comparisons also require identical analysis versions and models.
- Verify page filtering, revenue currency, Google timezone and identified-referral labels. Monitoring results are project-level associations, not exact causal attribution to one article.

## Publishing

- WordPress: connect an application user, create a draft, inspect it, approve a revision and explicitly publish. Test updating a known existing post with the correct modified_gmt. A remote edit made after reading the timestamp must block a stale update where detected.
- Webflow: use an authorised collection, valid field slugs, correct locale IDs and required fields. Create a draft and then a live item. Inspect actual rich-text rendering. A mismatched locale or lastUpdated must block update.
- CMS field/version prechecks cannot provide an atomic compare-and-swap when the remote CMS does not support it. Avoid simultaneous editing during publication; retain the saved backup.
- Simulate a dropped response after a CMS write. Confirm the job becomes uncertain and never writes again automatically. Verify the actual CMS result, then reconcile explicitly.
- Export to Framer, publish manually and mark the approved revision as published with its real URL. Label this user-confirmed.

## Operations

- Interrupt/restart the worker during research and after a completed checkpoint. Jobs recover or surface a stable error without changing completed content.
- Cancel a running non-publishing job and verify it cannot commit a later result. An in-flight model request may still be billed; show accounted usage honestly.
- Verify per-project and global reservation limits, provider account spend caps and unknown-cost accounting.
- Run at least one sitemap/bulk workload with enough documents to reveal queue behaviour and provider rate limits. Raise capacity only after observing actual usage.
- Enable the recurring setting and verify opportunity refresh and impact jobs for recent publications. It covers the ten most recent publication records per project per scheduled tick; all documents support on-demand impact refresh.
- Restore the prior image tags in staging without removing tables. Document operator recovery for encryption-key loss and CMS publishing failures.

Production can be labelled ready only after these gates pass against the deployed version. No live CMS write was performed while preparing this package.
