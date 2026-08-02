#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version_file="$repo_root/tools/deciduous/VERSION"
expected_version="$(tr -d '[:space:]' < "$version_file")"
state_dir="${DECIDUOUS_PILOT_STATE_DIR:-$repo_root/.deciduous}"
current_node_file="$state_dir/current-node"
export DECIDUOUS_DB_PATH="${DECIDUOUS_DB_PATH:-$state_dir/deciduous.db}"

usage() {
  cat >&2 <<'EOF'
Usage:
  bash scripts/deciduous-pilot.sh doctor
  bash scripts/deciduous-pilot.sh init
  bash scripts/deciduous-pilot.sh recover
  bash scripts/deciduous-pilot.sh start <goal>
  bash scripts/deciduous-pilot.sh decision <decision> <reason>
  bash scripts/deciduous-pilot.sh observe <observation>
  bash scripts/deciduous-pilot.sh finish <outcome> [commit]
  bash scripts/deciduous-pilot.sh export <filename.json>
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
  if ((actual < required)); then
    usage
    return 2
  fi
}

ensure_state_directories() {
  mkdir -p "$state_dir/documents" "$state_dir/exports"
}

read_current_node() {
  if [[ ! -f "$current_node_file" ]]; then
    printf 'No active Deciduous pilot chain. Run "bash scripts/deciduous-pilot.sh start <goal>" first.\n' >&2
    return 1
  fi

  local node_id
  node_id="$(tr -d '[:space:]' < "$current_node_file")"
  if [[ ! "$node_id" =~ ^[0-9]+$ ]]; then
    printf 'The active Deciduous pilot chain pointer is invalid: %s\n' "$current_node_file" >&2
    return 1
  fi
  printf '%s\n' "$node_id"
}

created_node_id=''
add_node() {
  local output
  output="$(deciduous add "$@")"
  printf '%s\n' "$output"

  created_node_id="$(printf '%s\n' "$output" | sed -n 's/.*Created node \([0-9][0-9]*\).*/\1/p' | tail -n 1)"
  if [[ -z "$created_node_id" ]]; then
    printf 'Deciduous created a node but its ID could not be read from the CLI output.\n' >&2
    return 1
  fi
}

write_current_node() {
  local node_id="$1"
  local temporary="$current_node_file.tmp"
  printf '%s\n' "$node_id" > "$temporary"
  mv "$temporary" "$current_node_file"
}

link_from_current() {
  local new_node_id="$1"
  local rationale="$2"
  local parent_node_id
  parent_node_id="$(read_current_node)" || return 1
  deciduous link "$parent_node_id" "$new_node_id" -r "$rationale" -t leads_to
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
    ensure_state_directories
    deciduous nodes >/dev/null
    printf 'Initialized local Deciduous state at %s without assistant hooks.\n' "$state_dir"
    ;;
  recover)
    check_version
    ensure_state_directories
    deciduous nodes
    deciduous edges
    deciduous commands
    ;;
  start)
    require_arguments 1 "$#" || exit $?
    check_version
    ensure_state_directories
    add_node goal "$1" -c 90
    write_current_node "$created_node_id"
    ;;
  decision)
    require_arguments 2 "$#" || exit $?
    check_version
    ensure_state_directories
    read_current_node >/dev/null
    add_node decision "$1" -d "$2" -c 85
    link_from_current "$created_node_id" "$2"
    write_current_node "$created_node_id"
    ;;
  observe)
    require_arguments 1 "$#" || exit $?
    check_version
    ensure_state_directories
    read_current_node >/dev/null
    add_node observation "$1" -d "$1" -c 90
    link_from_current "$created_node_id" 'Observation recorded during pilot'
    write_current_node "$created_node_id"
    ;;
  finish)
    require_arguments 1 "$#" || exit $?
    check_version
    ensure_state_directories
    read_current_node >/dev/null
    commit_ref="${2:-HEAD}"
    add_node outcome "$1" -c 95 --commit "$commit_ref"
    link_from_current "$created_node_id" 'Pilot task completed'
    rm -f "$current_node_file"
    ;;
  export)
    require_arguments 1 "$#" || exit $?
    check_version
    ensure_state_directories
    filename="$1"
    if [[ ! "$filename" =~ ^[A-Za-z0-9._-]+\.json$ ]]; then
      printf 'Export filename must be a simple .json filename without path separators.\n' >&2
      exit 2
    fi

    destination="$state_dir/exports/$filename"
    temporary="$state_dir/exports/.$filename.tmp.$$"
    if ! deciduous graph > "$temporary"; then
      rm -f "$temporary"
      printf 'Deciduous could not export the graph snapshot.\n' >&2
      exit 1
    fi
    if ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));' "$temporary"; then
      rm -f "$temporary"
      printf 'Deciduous produced an invalid JSON graph snapshot.\n' >&2
      exit 1
    fi
    mv "$temporary" "$destination"
    printf 'Exported Deciduous graph snapshot to %s\n' "$destination"
    ;;
  *)
    usage
    exit 2
    ;;
esac
