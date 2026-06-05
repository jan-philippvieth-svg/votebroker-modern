#!/usr/bin/env bash
# VoteBroker Production Deployment
# Usage: bash scripts/deploy.sh [--skip-pull]
#
# WICHTIG — externe Ressourcen (dürfen nie von Compose neu erstellt werden):
#   Netzwerk:  votebroker_internal   (alle 3 Services müssen drin sein)
#   Volume:    votebroker_data       (SQLite DB + content + screenshots)
#   Volumes:   votebroker_caddy_data, votebroker_caddy_config
#
# Bekannte Fehlerquelle: "docker compose" ohne -f docker-compose.prod.yml
# aufrufen erzeugt ein neues Netzwerk (votebroker-modern_default) und ein
# neues Volume (votebroker-modern_votebroker_data) — Caddy bleibt dann im
# alten Netzwerk → 502. Immer dieses Script verwenden.
#
# Backup der Produktionsdaten: /root/votebroker-volume-backup-20260605-001521/

set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/var/log/votebroker-deploy.log"
SKIP_PULL=false
NETWORK="votebroker_internal"

for arg in "$@"; do
  [[ "$arg" == "--skip-pull" ]] && SKIP_PULL=true
done

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"; }
die() { log "FEHLER: $*"; exit 1; }

cd "$REPO_DIR"

log "=== VoteBroker Deploy gestartet ==="

# ── 1. git pull ──────────────────────────────────────────────────────────────
if [[ "$SKIP_PULL" == false ]]; then
  log "1/5 git pull..."
  git pull --ff-only
else
  log "1/5 git pull übersprungen (--skip-pull)"
fi

COMMIT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
log "    Branch: $BRANCH  Commit: $COMMIT"

# ── Vorab-Prüfung: externe Ressourcen müssen existieren ─────────────────────
docker network inspect "$NETWORK" > /dev/null 2>&1 \
  || die "Netzwerk '$NETWORK' nicht gefunden. Einmalig anlegen: docker network create $NETWORK"

docker volume inspect votebroker_data > /dev/null 2>&1 \
  || die "Volume 'votebroker_data' nicht gefunden."

# ── 2. Build ─────────────────────────────────────────────────────────────────
log "2/5 docker compose build..."
$COMPOSE build

# ── 3. Up — alle Services, Orphans entfernen ─────────────────────────────────
log "3/5 docker compose up -d..."
$COMPOSE up -d --remove-orphans

# ── 3b. Netzwerk-Sanity: alle 3 Services müssen in votebroker_internal sein ──
log "    Netzwerk-Check: alle Services in '$NETWORK'..."
for SERVICE in api web caddy; do
  CONTAINER="votebroker-modern-${SERVICE}-1"
  NETS=$(docker inspect "$CONTAINER" \
    --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "")
  if ! echo "$NETS" | grep -qw "$NETWORK"; then
    log "    $CONTAINER nicht in '$NETWORK' — verbinde..."
    docker network connect "$NETWORK" "$CONTAINER" 2>/dev/null \
      || log "    Hinweis: $CONTAINER bereits verbunden oder Fehler ignoriert"
    docker compose -f docker-compose.prod.yml restart "$SERVICE"
    log "    $SERVICE neu gestartet und in '$NETWORK' eingehängt"
  else
    log "    $CONTAINER ✓ in $NETWORK"
  fi
done

# ── 4. Healthcheck ────────────────────────────────────────────────────────────
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
  log "    FEHLER: Healthcheck fehlgeschlagen nach 60s — letzte Logs:"
  $COMPOSE logs api --tail=20 | tee -a "$LOG_FILE"
  $COMPOSE logs caddy --tail=10 | tee -a "$LOG_FILE"
  die "Deploy abgebrochen — Site nicht erreichbar"
fi

# ── 5. Abschluss ──────────────────────────────────────────────────────────────
log "5/5 Deploy-Commit ins API-Log..."
curl -s https://votebroker.org/health | python3 -c "
import sys, json
h = json.load(sys.stdin)
print(f'    API antwortet: {h}')
" 2>/dev/null || true

log "=== Deploy abgeschlossen: $COMMIT ==="
echo ""
echo "  Commit:  $COMMIT ($BRANCH)"
echo "  Status:  healthy"
echo "  Log:     $LOG_FILE"
