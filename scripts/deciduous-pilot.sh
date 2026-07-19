#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version_file="$repo_root/tools/deciduous/VERSION"
expected_version="$(tr -d '[:space:]' < "$version_file")"

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/deciduous-pilot.sh doctor
  scripts/deciduous-pilot.sh init
  scripts/deciduous-pilot.sh recover
  scripts/deciduous-pilot.sh start <goal>
  scripts/deciduous-pilot.sh decision <decision> <reason>
  scripts/deciduous-pilot.sh observe <observation>
  scripts/deciduous-pilot.sh finish <outcome> [commit]
  scripts/deciduous-pilot.sh export <filename.json> [branch]
EOF
}

require_deciduous() {
  if ! command -v deciduous >/dev/null 2>&1; then
    printf 'Deciduous is not installed. Install reviewed version %s before using this pilot.\n' "$expected_version" >&2
    return 1
  fi
}

installed_version() {
  deciduous --version | awk '{print $NF}'
}

check_version() {
  require_deciduous || return 1
  local found
  found="$(installed_version)"
  if [[ "$found" != "$expected_version" ]]; then
    printf 'Deciduous version mismatch: expected %s, found %s. Upgrade or downgrade explicitly; this wrapper never changes tools automatically.\n' "$expected_version" "$found" >&2
    return 1
  fi
}

require_arguments() {
  local required="$1"
  local actual="$2"
  if (( actual < required )); then
    usage
    return 2
  fi
}

command="${1:-}"
if [[ -z "$command" ]]; then
  usage
  exit 2
fi
shift

cd "$repo_root"

case "$command" in
  doctor)
    check_version
    printf 'Deciduous %s is ready for the Factory Floor pilot.\n' "$expected_version"
    ;;
  init)
    check_version
    deciduous init --opencode
    ;;
  recover)
    check_version
    deciduous nodes
    deciduous edges
    deciduous commands
    ;;
  start)
    require_arguments 1 "$#" || exit $?
    check_version
    deciduous add goal "$1" -c 90
    ;;
  decision)
    require_arguments 2 "$#" || exit $?
    check_version
    deciduous add decision "$1" -c 85 -p "$2"
    ;;
  observe)
    require_arguments 1 "$#" || exit $?
    check_version
    deciduous add observation "$1" -c 90
    ;;
  finish)
    require_arguments 1 "$#" || exit $?
    check_version
    commit_ref="${2:-HEAD}"
    deciduous add outcome "$1" -c 95 --commit "$commit_ref"
    ;;
  export)
    require_arguments 1 "$#" || exit $?
    check_version
    filename="$1"
    branch="${2:-$(git branch --show-current)}"
    if [[ ! "$filename" =~ ^[A-Za-z0-9._-]+\.json$ ]]; then
      printf 'Export filename must be a simple .json filename without path separators.\n' >&2
      exit 2
    fi
    mkdir -p .deciduous/patches
    deciduous diff export --branch "$branch" -o ".deciduous/patches/$filename"
    ;;
  *)
    usage
    exit 2
    ;;
esac
