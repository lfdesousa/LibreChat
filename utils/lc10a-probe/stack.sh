#!/usr/bin/env bash
# LC-10a probe stack. usage: stack.sh up <variant: rendered|plus-header> | down
# Containers are all named explicitly (lc10a-probe-*) and removed with `docker rm -fv`.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# PROBE_SCRATCH: a private scratch dir (holds the per-variant yaml copy). PROBE_IMG: the image under test (AC-P2b).
SCRATCH=${PROBE_SCRATCH:?set PROBE_SCRATCH to a private scratch directory}
NET=lc10a-probe-net
IMG=${PROBE_IMG:-lfds/audittrace-librechat:768de61}
NAMES="lc10a-probe-librechat lc10a-probe-api-recorder lc10a-probe-bff-recorder lc10a-probe-mongo"
down() { for n in $NAMES; do docker rm -fv "$n" >/dev/null 2>&1 || true; done; docker network rm $NET >/dev/null 2>&1 || true; }
case "${1:-}" in
down) down; exit 0;;
up) variant=${2:?variant}; rec=${3:?records dir};;
*) echo "usage"; exit 2;;
esac
down
mkdir -p "$rec"; : > "$rec/p1.jsonl"; : > "$rec/p2.jsonl"; chmod 777 "$rec"
mkdir -p "$SCRATCH"
cfg="$SCRATCH/librechat.$variant.yaml"
cp "$HERE/librechat.rendered.yaml" "$cfg"
if [ "$variant" = plus-header ]; then
  sed -i "s|^\(\s*\)Authorization: .*|&\n\1X-Session-Id: '{{LIBRECHAT_BODY_CONVERSATIONID}}'|" "$cfg"
fi
chmod 644 "$cfg"
# throwaway secrets, generated here, never printed, never written to a file
export CREDS_KEY=$(openssl rand -hex 32) CREDS_IV=$(openssl rand -hex 16)
export JWT_SECRET=$(openssl rand -hex 32) JWT_REFRESH_SECRET=$(openssl rand -hex 32)
docker network create $NET >/dev/null
docker run -d --name lc10a-probe-mongo --network $NET mongo:7.0 >/dev/null
docker run -d --name lc10a-probe-bff-recorder --network $NET --network-alias audittrace-librechat-bff \
  -e MODE=bff -e PORT=8766 -e OUT=/rec/p1.jsonl -v "$rec:/rec" \
  -v "$HERE/recorder.py:/recorder.py:ro" python:3.12-slim python /recorder.py >/dev/null
docker run -d --name lc10a-probe-librechat --network $NET \
  -e HOST=0.0.0.0 -e PORT=3080 -e MONGO_URI=mongodb://lc10a-probe-mongo:27017/LibreChat \
  -e DOMAIN_CLIENT=http://localhost:13081 -e DOMAIN_SERVER=http://localhost:13081 \
  -e ENDPOINTS=custom -e ALLOW_REGISTRATION=true -e ALLOW_EMAIL_LOGIN=true -e ALLOW_SOCIAL_LOGIN=false \
  -e AUDITTRACE_MEMORY_BACKEND=sovereign -e AUDITTRACE_BFF_BASE_URL=http://audittrace-librechat-bff:8766 \
  -e AUDITTRACE_BFF_TIMEOUT_MS=15000 -e CONFIG_PATH=/app/librechat.yaml \
  -e CREDS_KEY -e CREDS_IV -e JWT_SECRET -e JWT_REFRESH_SECRET \
  -v "$cfg:/app/librechat.yaml:ro" "$IMG" >/dev/null
docker run -d --name lc10a-probe-api-recorder --network $NET -p 127.0.0.1:13081:13081 \
  -e MODE=api -e PORT=13081 -e UPSTREAM=lc10a-probe-librechat:3080 -e OUT=/rec/p2.jsonl -v "$rec:/rec" \
  -v "$HERE/recorder.py:/recorder.py:ro" python:3.12-slim python /recorder.py >/dev/null
echo up
