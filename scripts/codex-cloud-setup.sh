#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export CI="${CI:-1}"

bash "$SCRIPT_DIR/install-docker-cli.sh"
bash "$SCRIPT_DIR/bootstrap-workspace.sh"
