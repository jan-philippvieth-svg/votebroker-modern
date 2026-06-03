#!/usr/bin/env bash
# Restart the VoteBroker API container with correct network configuration.
# Caddy resolves the API via Docker DNS as "api:3000" inside votebroker_internal.
# A manually started container lacks this alias — this script always sets it correctly.

set -euo pipefail

CONTAINER="votebroker_api_1"
IMAGE="votebroker-api:production"
NETWORK="votebroker_internal"
ENV_FILE="/opt/votebroker-modern/.env"
VOLUME="votebroker_data:/app/data"

echo "[restart-api] Stopping existing container..."
docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true

echo "[restart-api] Starting $IMAGE ..."
docker run -d \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias api \
  --env-file "$ENV_FILE" \
  -p 3000:3000 \
  -v "$VOLUME" \
  --restart unless-stopped \
  "$IMAGE"

echo "[restart-api] Waiting for health check..."
for i in $(seq 1 15); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "[restart-api] API healthy after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "[restart-api] WARNING: API did not become healthy within 15s — check logs:"
echo "  docker logs $CONTAINER --tail=30"
exit 1
