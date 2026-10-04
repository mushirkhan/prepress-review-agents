#!/usr/bin/env bash
# Deploys a new image tag on the app VM. Installed once at /opt/prepress/deploy.sh.
#
# CI connects with a restricted SSH key whose authorized_keys entry forces
# this script, whatever command is sent:
#   restrict,command="/opt/prepress/deploy.sh" ssh-ed25519 AAAA... gitlab-deploy
#
# CI usage (compose file on stdin, tag as the "command"):
#   ssh deploy@APP_VM "deploy <git-sha>" < infra/compose.yml
#
# Steps: validate input -> validate compose -> pull -> start -> health check.
# If the health check fails, the previous compose file and tag are restored.
set -euo pipefail

APP_DIR=/opt/prepress
HEALTH_TIMEOUT_S=60
cd "$APP_DIR"

log() { echo "[deploy] $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ---- 1. Parse and validate the requested command ----
read -r action tag extra <<<"${SSH_ORIGINAL_COMMAND:-${*:-}}" || true
[[ "${action:-}" == "deploy" ]] || fail "usage: deploy <git-sha>"
[[ -z "${extra:-}" ]] || fail "unexpected extra arguments"
[[ "${tag:-}" =~ ^[0-9a-f]{8,40}$ ]] || fail "tag must be a git SHA (8-40 hex characters)"
[[ -f .env ]] || fail "$APP_DIR/.env is missing"

# ---- 2. Receive and validate the new compose file ----
new_compose="$(mktemp "$APP_DIR/compose.new.XXXXXX.yml")"
new_tag="$(mktemp "$APP_DIR/tag.new.XXXXXX.env")"
trap 'rm -f "$new_compose" "$new_tag"' EXIT

cat >"$new_compose"
[[ -s "$new_compose" ]] || fail "no compose file received on stdin"
echo "IMAGE_TAG=$tag" >"$new_tag"

compose() { docker compose -f "$1" --env-file .env --env-file "$2" "${@:3}"; }

compose "$new_compose" "$new_tag" config --quiet || fail "compose file is invalid"

# ---- 3. Keep the current release for rollback, then switch ----
[[ -f compose.yml ]] && cp compose.yml compose.prev.yml
[[ -f image-tag.env ]] && cp image-tag.env image-tag.prev.env
mv "$new_compose" compose.yml
mv "$new_tag" image-tag.env

log "pulling images for $tag"
compose compose.yml image-tag.env pull --quiet
log "starting services"
compose compose.yml image-tag.env up -d --remove-orphans

# ---- 4. Health check, rollback on failure ----
healthy() {
  compose compose.yml image-tag.env exec -T api node -e \
    "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

for ((i = 0; i < HEALTH_TIMEOUT_S; i += 3)); do
  if healthy; then
    log "healthy: $tag is live"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 3
done

log "health check failed after ${HEALTH_TIMEOUT_S}s"
compose compose.yml image-tag.env logs --tail 30 api || true
if [[ -f compose.prev.yml && -f image-tag.prev.env ]]; then
  log "rolling back to $(cut -d= -f2 image-tag.prev.env)"
  mv compose.prev.yml compose.yml
  mv image-tag.prev.env image-tag.env
  compose compose.yml image-tag.env up -d --remove-orphans
fi
fail "deploy of $tag failed"
