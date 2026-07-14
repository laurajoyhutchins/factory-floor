#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[factory-floor docker] %s\n' "$*"
}

fail() {
  printf '[factory-floor docker] error: %s\n' "$*" >&2
  exit 1
}

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Root privileges or sudo are required to install the Docker CLI."
  fi
}

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker CLI and Compose plugin are already available"
  docker --version
  docker compose version
  exit 0
fi

command -v apt-get >/dev/null 2>&1 || fail "This installer currently supports Ubuntu hosts using apt."
[[ -r /etc/os-release ]] || fail "/etc/os-release is required to identify the host distribution."

# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || fail "Expected Ubuntu, found ${PRETTY_NAME:-unknown distribution}."

export DEBIAN_FRONTEND=noninteractive

log "Installing prerequisites for Docker's official apt repository"
run_as_root apt-get update
run_as_root apt-get install -y --no-install-recommends ca-certificates curl
run_as_root install -m 0755 -d /etc/apt/keyrings
run_as_root curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
run_as_root chmod a+r /etc/apt/keyrings/docker.asc

architecture="$(dpkg --print-architecture)"
codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
[[ -n "$codename" ]] || fail "Unable to determine the Ubuntu codename."

source_file="$(mktemp)"
trap 'rm -f "$source_file"' EXIT
cat >"$source_file" <<EOF_SOURCE
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${codename}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF_SOURCE
run_as_root install -m 0644 "$source_file" /etc/apt/sources.list.d/docker.sources

log "Installing Docker CLI and Compose plugin without Docker Engine"
run_as_root apt-get update
run_as_root apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin

command -v docker >/dev/null 2>&1 || fail "Docker CLI installation completed but docker is not on PATH."
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin installation could not be verified."

docker --version
docker compose version

if docker info >/dev/null 2>&1; then
  log "Docker daemon is reachable"
else
  log "Docker CLI is installed; no reachable daemon was detected"
fi
