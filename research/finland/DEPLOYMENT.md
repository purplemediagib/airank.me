# One research-container update — prepared, not deployed

Use only after this exact research-only release passes independent review, owner
publication approval, and successful image CI. The live AI Rank app is unrelated.
Published image tag/digest: PENDING — do not use the prior e4a1394 image with this manifest.

In the existing separate Bunny research app, make one bundled update:
- Image: the newly verified immutable sha tag/digest supplied after publication.
- RESEARCH_MANIFEST_JSON: complete contents of manifest_PRIMARY_RELEASE.compact.json.
- RESEARCH_ACTION=scheduled; RESEARCH_THEN_IDLE=1; TZ=UTC.
- Keep RESEARCH_STUDY_ID=finland-language-v02, RESEARCH_DATA_DIR=/data/research,
  the SAME /data durable volume, private backup zone/host and existing securely
  injected provider/storage keys. Keep one replica min=max=1 in Zagreb, no public
  endpoint. Do not replace the volume, initialize, reset ledger, reconcile to old
  head31, run diagnostics/city tests, or change attempt IDs.
- In the same setup check, verify research hosting/storage incurred spend plus
  expected remaining usage to 8 Nov 01:00 UTC and final export fits its $2 allowance.
  $38 provider ledger cap is unchanged; $40 aggregate is an allowance, NOT a
  technically enforced hosting cap. Actual Bunny cost could not be read through
  connector (GET /mc/apps internal error); no increase is authorized.

Activate before 1 Nov 21:00 UTC (23:00 Helsinki). First start grace ends 21:10 UTC;
if missed, stop and report missed block, never shift/backfill. The six windows are
Nov1/3/7 at21:00 and23:00UTC — Helsinki23:00, then01:00 the following local day.
Each block has48 planned answers (288 total); adjacent FI/EN pairs and order retained.
The scheduler waits internally between blocks; no extra cron or repeated deployment.
Runtime verifies current private backup head; reviewed starting head35,17diagnostics,
$0.535310 accounted. Any unexplained change requires review, not ledger overwrite.

Expected behavior: provider requests begin only in the frozen eligible windows.
Any model/provider/location/usage/cost/storage violation stops further requests.
City routing is offline-tested and fail-closed, not separately live-city-qualified.
Kimi reserve$7 under reviewed normal-contract bound$6.395456; OpenAI reserve$1.50.
All prior diagnostic charges remain. No guarantee all288fit if real costs differ.

Send the resulting Application status/log and private checkpoint/ZIP after first
block and at final completion; do not paste keys. A running/healthy/idle container
alone is not evidence that collection completed. Keep existing data and backup.
Final block starts7Nov23:00UTC, maximum window ends8Nov01:00UTC (03:00 Helsinki).
After final evidence export and verification, owner undeploys compute and reviews
retained storage billing; idle alone does not stop billing. Do not delete evidence.
