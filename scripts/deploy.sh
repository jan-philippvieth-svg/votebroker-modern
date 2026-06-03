#!/usr/bin/env bash
# VoteBroker Production Deployment
# Usage: bash scripts/deploy.sh [--skip-pull]
#
# Standard deploy: pull → build → up → healthcheck → log commit
# Recovery (container crash without code change): use scripts/restart-api.sh

set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/var/log/votebroker-deploy.log"
SKIP_PULL=false

for arg in "$@"; do
  [[ "$arg" == "--skip-pull" ]] && SKIP_PULL=true
done

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"; }

cd "$REPO_DIR"

log "=== VoteBroker Deploy gestartet ==="

# 1. git pull
if [[ "$SKIP_PULL" == false ]]; then
  log "1/5 git pull..."
  git pull --ff-only
else
  log "1/5 git pull übersprungen (--skip-pull)"
fi

COMMIT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
log "    Branch: $BRANCH  Commit: $COMMIT"

# 2. Build
log "2/5 docker compose build..."
$COMPOSE build

# 3. Up
log "3/5 docker compose up -d..."
$COMPOSE up -d

# 4. Healthcheck
log "4/5 Healthcheck..."
HEALTHY=false
for i in $(seq 1 30); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://votebroker.org/health 2>/dev/null || echo "000")
  if [[ "$STATUS" == "200" ]]; then
    HEALTHY=true
    log "    Healthy nach ${i}s (HTTP $STATUS)"
    break
  fi
  sleep 2
done

if [[ "$HEALTHY" != true ]]; then
  log "    FEHLER: API nicht healthy nach 60s — docker logs:"
  docker compose -f docker-compose.prod.yml logs api --tail=30 | tee -a "$LOG_FILE"
  exit 1
fi

# 5. Commit-ID in API loggen
log "5/5 Deploy-Commit ins API-Log..."
curl -s https://votebroker.org/health | python3 -c "
import sys, json, datetime
h = json.load(sys.stdin)
print(f'    API antwortet: {h}')
" 2>/dev/null || true

log "=== Deploy abgeschlossen: $COMMIT ==="
echo ""
echo "  Commit:  $COMMIT ($BRANCH)"
echo "  Status:  healthy"
echo "  Log:     $LOG_FILE"
