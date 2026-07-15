#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TIMEOUT_SECONDS="${FACTORY_FLOOR_SERVICE_TIMEOUT_SECONDS:-120}"
if (( $# == 0 )); then
  SERVICES=(postgres minio)
else
  SERVICES=("$@")
fi

log() { printf '[factory-floor services] %s\n' "$*"; }
fail() {
  printf '[factory-floor services] error: %s\n' "$*" >&2
  cd "$ROOT_DIR"
  docker compose ps >&2 || true
  docker compose logs --no-color --tail=80 "${SERVICES[@]}" >&2 || true
  exit 1
}

cd "$ROOT_DIR"
command -v docker >/dev/null 2>&1 || fail "Docker CLI is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose is required."

end=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < end )); do
  all_healthy=1
  for service in "${SERVICES[@]}"; do
    container_id="$(docker compose ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      log "$service is not created yet"
      all_healthy=0
      continue
    fi
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    log "$service health: ${health:-unknown}"
    if [[ "$health" != "healthy" ]]; then
      all_healthy=0
    fi
  done

  if (( all_healthy == 1 )); then
    if [[ " ${SERVICES[*]} " == *" postgres "* ]]; then
      docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-factory_floor}" -d "${POSTGRES_DB:-factory_floor}" >/dev/null
    fi
    if [[ " ${SERVICES[*]} " == *" minio "* ]]; then
      docker compose exec -T minio mc ready local >/dev/null
      curl --fail --silent --show-error "http://${FACTORY_FLOOR_MINIO_HOST:-127.0.0.1}:${FACTORY_FLOOR_MINIO_API_PORT:-9000}/minio/health/live" >/dev/null
    fi
    log "requested services are ready"
    exit 0
  fi
  sleep 2
done

fail "services did not become healthy within ${TIMEOUT_SECONDS}s"
