#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc"; then
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
fi

corepack enable
corepack prepare pnpm@10.12.1 --activate

git config --global --add safe.directory /workspaces/factory-floor

printf '\nFactory Floor development environment ready.\n'
printf 'Node:   %s\n' "$(node --version)"
printf 'pnpm:   %s\n' "$(pnpm --version)"
printf 'Python: %s\n' "$(python --version 2>&1)"
printf 'uv:     %s\n' "$(uv --version)"
printf 'Docker: %s\n' "$(docker --version)"
printf 'GitHub: %s\n\n' "$(gh --version | head -n 1)"

if [[ -f package.json ]]; then
  pnpm install --frozen-lockfile=false
fi
