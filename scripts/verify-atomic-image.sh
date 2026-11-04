#!/usr/bin/env bash
set -euo pipefail
image=$1
revision=$2
test "$(docker image inspect "$image" --format '{{.Config.User}}')" = node
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$revision"
test "$(docker image inspect "$image" --format '{{json .Config.Cmd}}')" = '["node","diagnostics/atomic-acceptance/hold.mjs"]'
# Anchor the image-owned verification code and manifest to this checkout.
proof=$(mktemp -d)
created=$(docker create "$image")
trap 'docker rm -f "$created" >/dev/null 2>&1 || true; rm -rf "$proof"' EXIT
docker cp "$created:/app/diagnostics/atomic-acceptance/package-manifest.json" "$proof/package-manifest.json"
docker cp "$created:/app/scripts/verify-atomic-package.mjs" "$proof/verify-atomic-package.mjs"
cmp diagnostics/atomic-acceptance/package-manifest.json "$proof/package-manifest.json"
cmp scripts/verify-atomic-package.mjs "$proof/verify-atomic-package.mjs"
docker rm "$created" >/dev/null
rm -rf "$proof"
trap - EXIT
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$image" scripts/verify-atomic-package.mjs --image
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$image" --input-type=module -e '
  import assert from "node:assert/strict";
  assert.equal(process.getuid(),1000);
  assert.equal(process.env.AIRANK_BUILD_REVISION,process.argv[1]);
  process.env=new Proxy(process.env,{get(target,key){if(typeof key==="string"&&/BUNNY_DATABASE|AUTH_TOKEN|SECRET|PASSWORD/.test(key))throw Error("FORBIDDEN_CONFIGURATION_READ");return Reflect.get(target,key);}});
  globalThis.fetch=()=>{throw Error("FORBIDDEN_NETWORK");};
  const {startHold}=await import("./diagnostics/atomic-acceptance/hold.mjs");
  const hold=await startHold({port:0,host:"127.0.0.1",emit:()=>{}});
  try {const result=await hold.completed;assert.equal(result.status,"not_run");assert.equal(result.requests,0);assert.equal(result.writes,0);assert.equal(result.restore_required,true);} finally {await hold.stop();}
' "$revision"
container=$(docker run -d --network none --read-only --cap-drop ALL --security-opt no-new-privileges "$image")
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
for attempt in $(seq 1 30); do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:3003/healthz').then(r=>r.json()).then(b=>{if(b.status!=='not_run'||b.projector_running!==false||b.restore_required!==true)process.exit(1)})"; then break; fi
  sleep 1
done
docker exec "$container" node -e "fetch('http://127.0.0.1:3003/readyz').then(r=>r.json()).then(b=>{if(b.status!=='not_run'||b.projector_running!==false||b.restore_required!==true)process.exit(1)})"
docker logs "$container" > atomic-hold.log
node -e "const fs=require('node:fs');const rows=fs.readFileSync('atomic-hold.log','utf8').trim().split('\n').map(JSON.parse);if(rows.length!==1||rows[0].status!=='not_run'||rows[0].requests!==0||rows[0].writes!==0||rows[0].restore_required!==true)process.exit(1)"
# No environment file, credentials, host ports, network or acceptance flags supplied.
