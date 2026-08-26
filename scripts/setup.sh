#!/bin/bash
set -euo pipefail

# One-command setup for Claude Patrol contributors. Idempotent.
#
# Does what we deliberately do NOT do via npm/pnpm lifecycle hooks
# (preinstall/postinstall are a supply-chain footgun):
#   1. Clones and builds the vendored xterm.js (frontend depends on it via file:)
#   2. Installs deps for root + frontend in one `pnpm install` (frontend/ is a
#      pnpm workspace package; see pnpm-workspace.yaml)
#   3. Fixes node-pty's spawn-helper executable bit on macOS
#   4. Verifies the postconditions - fails loudly if any step left the tree broken

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ---- System prerequisites ----------------------------------------------------
# Check for runtime dependencies before doing any work, so contributors don't
# get all the way through dep install only to discover `pnpm start` can't run.
# Required tools mirror README "Prerequisites"; Ghostty is optional.

echo "==> Checking system prerequisites"
missing=()
optional_missing=()

check_cmd() {
  local cmd="$1" label="$2" hint="$3"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "   ok: $label ($(command -v "$cmd"))"
  else
    missing+=("$label - $hint")
  fi
}

check_optional() {
  local cmd="$1" label="$2" hint="$3"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "   ok: $label ($(command -v "$cmd"))"
  else
    optional_missing+=("$label - $hint")
  fi
}

# gh-stack isn't a standalone binary on PATH - it's a `gh` extension invoked as
# `gh stack`, so it needs its own check rather than command -v.
check_gh_extension() {
  local ext="$1" label="$2" hint="$3"
  if gh extension list 2>/dev/null | grep -q "$ext"; then
    echo "   ok: $label"
  else
    missing+=("$label - $hint")
  fi
}

# Node >= 22 (uses node:sqlite built-in)
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$node_major" -lt 22 ]; then
    missing+=("Node.js >= 22 (found $(node -v)) - upgrade via nvm/fnm/brew")
  else
    echo "   ok: Node.js $(node -v)"
  fi
else
  missing+=("Node.js >= 22 - install via nvm/fnm/brew")
fi

check_cmd pnpm  "pnpm"          "install via 'npm i -g pnpm' or corepack"
check_cmd gh    "GitHub CLI"    "install via 'brew install gh' then 'gh auth login'"
check_cmd tmux  "tmux"          "install via 'brew install tmux'"
check_cmd claude "Claude Code"  "install via 'npm i -g @anthropic-ai/claude-code'"
if command -v gh >/dev/null 2>&1; then
  check_gh_extension "github/gh-stack" "gh-stack extension" "install via 'gh extension install github/gh-stack'"
else
  missing+=("gh-stack extension - install via 'gh extension install github/gh-stack' (requires GitHub CLI first)")
fi
check_optional ghostty "Ghostty" "optional - needed only for Pop-out / Terminal buttons"

if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo "Missing REQUIRED prerequisites:"
  for m in "${missing[@]}"; do echo "  - $m"; done
  echo
  echo "Install the above and re-run \`pnpm run setup\`."
  exit 1
fi

if [ ${#optional_missing[@]} -gt 0 ]; then
  echo
  echo "Optional tools not found (you can still run the server):"
  for m in "${optional_missing[@]}"; do echo "  - $m"; done
fi
echo

if [ ! -d vendor/xterm.js/lib ]; then
  echo "==> Setting up vendored xterm.js"
  bash scripts/setup-xterm.sh
else
  echo "==> xterm.js already built (skipping)"
fi

echo "==> Installing dependencies (root + frontend workspace)"
pnpm install

echo "==> Fixing node-pty spawn-helper permissions"
shopt -s nullglob
spawn_helpers=(node_modules/node-pty/prebuilds/darwin-*/spawn-helper)
shopt -u nullglob
if [ ${#spawn_helpers[@]} -eq 0 ]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "ERROR: node-pty darwin prebuild not found at node_modules/node-pty/prebuilds/darwin-*/spawn-helper"
    echo "       Root install may have skipped node-pty (check npm_config_ignore_scripts / pnpm onlyBuiltDependencies)."
    exit 1
  fi
  echo "   (no darwin prebuilds - skipping on non-macOS platform)"
else
  chmod +x "${spawn_helpers[@]}"
  echo "   fixed: ${spawn_helpers[*]}"
fi

echo "==> Verifying postconditions"
errors=0
check() {
  if [ ! -e "$1" ]; then
    echo "   MISSING: $1 ($2)"
    errors=$((errors + 1))
  fi
}
check node_modules/zod "root dep - pnpm install at root did not populate node_modules"
check node_modules/fastify "root dep - pnpm install at root did not populate node_modules"
check frontend/node_modules/vite "frontend dep - pnpm --filter install did not populate frontend/node_modules"
check vendor/xterm.js/lib "xterm.js was not built - re-run scripts/setup-xterm.sh"
if [ "$errors" -gt 0 ]; then
  echo
  echo "Setup INCOMPLETE: $errors missing artifact(s) above. Fix and re-run \`pnpm run setup\`."
  exit 1
fi

echo
echo "Setup complete. Next: create config.json (see README) and run \`pnpm start\`."
