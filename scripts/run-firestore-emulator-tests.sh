#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image="${FIRESTORE_EMULATOR_IMAGE:-gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators}"
# Use a preloaded image: no package installation, image pull or GCP connection.
docker image inspect "$image" >/dev/null || { echo "Emulator image missing; preload it in an authorized environment." >&2; exit 1; }
container=""
cleanup() { if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
container=$(docker run -d --rm -p 127.0.0.1::8080 --entrypoint gcloud "$image" emulators firestore start --host-port=0.0.0.0:8080 --project=demo-police-essay)
port=$(docker port "$container" 8080/tcp | awk -F: '{print $NF}')
export FIRESTORE_EMULATOR_HOST="127.0.0.1:$port"
node --input-type=module <<'NODE'
const endpoint = "http://" + process.env.FIRESTORE_EMULATOR_HOST
  + "/v1/projects/demo-police-essay/databases/(default)/documents/readiness?pageSize=1";
const deadline = Date.now() + 45000;
while (true) {
  const ready = await fetch(endpoint, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
  if (ready) break;
  if (Date.now() >= deadline) throw new Error("Firestore emulator startup timed out");
  await new Promise(resolve => setTimeout(resolve, 250));
}
NODE
node --import tsx --test tests/firestore-emulator.test.ts
