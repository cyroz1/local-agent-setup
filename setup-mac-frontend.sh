#!/usr/bin/env bash
#
# Split setup, Mac side: this M4 Air is the frontend and control machine.
# The PC does all the model compute. This script:
#   1. Checks it can actually reach the PC's model server before changing anything.
#   2. Installs Node (via Homebrew) and OpenCode.
#   3. Writes ~/.config/opencode/opencode.json pointing at the PC, with the
#      Playwright + Chrome DevTools MCP servers (browser use runs here,
#      against your Mac's browsers).
#   4. Downloads the UI-TARS Desktop app (computer use UI runs here, its
#      vision model is served by the PC on port 8081).
#
# Usage:
#   ./setup-mac-frontend.sh <pc-address> <api-key>
# <pc-address> is the PC's LAN IP (e.g. 192.168.1.50) or its Tailscale
# address/name. Both values are printed by setup-pc-server.ps1 on the PC.
#
# Idempotent and logged. Optional steps are guarded individually.

set -uf -o pipefail

PC_HOST="${1:-${PC_HOST:-}}"
API_KEY="${2:-${API_KEY:-}}"
CODING_PORT=8080
VISION_PORT=8081
LOG_FILE="$HOME/local-agent-frontend-setup.log"

step() { printf '\n=== %s ===\n' "$1"; }
note() { printf '  %s\n' "$1"; }
warn() { printf '  WARNING: %s\n' "$1"; }
die()  { printf '\nSETUP STOPPED: %s\n' "$1" >&2; printf 'Log: %s\n' "$LOG_FILE" >&2; exit 1; }

exec > >(tee -a "$LOG_FILE") 2>&1

[ -n "$PC_HOST" ] && [ -n "$API_KEY" ] || die "Usage: ./setup-mac-frontend.sh <pc-address> <api-key>   (both are printed by setup-pc-server.ps1 on the PC)"

step "Reachability check: PC model server at $PC_HOST:$CODING_PORT"
note "If this fails: start start-server-pc.ps1 on the PC, confirm both machines"
note "are on the same network, and check the firewall step in the PC setup log."
HEALTH="$(curl -s -m 5 -H "Authorization: Bearer $API_KEY" "http://$PC_HOST:$CODING_PORT/health" || true)"
case "$HEALTH" in
  *'"status":"ok"'*|*'"status": "ok"'*) note "PC coding server is up and the key works." ;;
  *) die "Could not reach a healthy model server at http://$PC_HOST:$CODING_PORT (got: ${HEALTH:-nothing}). Fix the PC side first, then re-run." ;;
esac

step "Homebrew, Node, OpenCode"
if ! command -v brew >/dev/null 2>&1; then
  note "Homebrew is not installed. It needs your password once, so it is the"
  note "one manual step. Download its installer to a file and run that file:"
  note "  curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o /tmp/brew-install.sh"
  note "  /bin/bash /tmp/brew-install.sh"
  note "Then re-run this script."
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  note "Installing Node via Homebrew..."
  brew install node || die "brew install node failed."
fi
note "node: $(node --version), npm: $(npm --version)"
if ! opencode --version >/dev/null 2>&1; then
  note "Installing OpenCode from the standalone GitHub release zip."
  note "(Not npm: npm blocks opencode's postinstall, which is what fetches the real binary.)"
  if command -v npm >/dev/null 2>&1; then npm uninstall -g opencode-ai >/dev/null 2>&1 || true; fi
  OC_JSON="$(curl -s -m 20 -H 'User-Agent: local-agent-setup' https://api.github.com/repos/anomalyco/opencode/releases/latest || true)"
  OC_URL="$(printf '%s' "$OC_JSON" | grep -oE 'https://[^"]+/opencode-darwin-arm64\.zip' | head -n 1 || true)"
  [ -n "$OC_URL" ] || die "Could not find opencode-darwin-arm64.zip on the latest OpenCode release."
  mkdir -p "$HOME/.local/bin"
  OC_TMP="$(mktemp -d)"
  curl -fL -o "$OC_TMP/opencode.zip" "$OC_URL" || die "OpenCode download failed."
  unzip -o -q "$OC_TMP/opencode.zip" -d "$OC_TMP/extract" || die "OpenCode unzip failed."
  OC_BIN="$(find "$OC_TMP/extract" -name opencode -type f | head -n 1)"
  [ -n "$OC_BIN" ] || die "opencode binary not found inside the release zip."
  install -m 755 "$OC_BIN" "$HOME/.local/bin/opencode"
  rm -rf "$OC_TMP"
  export PATH="$HOME/.local/bin:$PATH"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) warn "~/.local/bin is not on your PATH for new shells. Add this to ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi
note "opencode: $(opencode --version)"

step "OpenCode config (PC provider + browser-use MCP servers)"
CONFIG_DIR="$HOME/.config/opencode"
CONFIG_PATH="$CONFIG_DIR/opencode.json"
mkdir -p "$CONFIG_DIR"
if [ -f "$CONFIG_PATH" ]; then
  BACKUP="$CONFIG_PATH.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$CONFIG_PATH" "$BACKUP"
  note "Existing opencode.json backed up to $BACKUP"
fi
cat > "$CONFIG_PATH" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "model": "llama.cpp/k2-horizon-7b",
  "small_model": "llama.cpp/k2-horizon-7b",
  "enabled_providers": ["llama.cpp", "opencode"],
  "provider": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "PC llama.cpp (remote)",
      "options": {
        "baseURL": "http://$PC_HOST:$CODING_PORT/v1",
        "apiKey": "$API_KEY"
      },
      "models": {
        "k2-horizon-7b": {
          "name": "K2 Horizon 7B (on PC)",
          "limit": { "context": 65536, "output": 8192 },
          "options": { "temperature": 1.0, "topP": 0.95 }
        }
      }
    }
  },
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp@latest"],
      "enabled": true
    },
    "chrome-devtools": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest"],
      "enabled": true
    }
  }
}
JSON
note "Wrote $CONFIG_PATH"

step "Warming up the MCP servers"
for pkg in "@playwright/mcp@latest" "chrome-devtools-mcp@latest"; do
  if npx -y "$pkg" --version >/dev/null 2>&1; then
    note "$pkg ready."
  else
    warn "$pkg warm-up failed. It will retry on first use inside OpenCode."
  fi
done
if npx -y playwright@latest install chromium >/dev/null 2>&1; then
  note "Playwright Chromium installed."
else
  warn "Playwright Chromium install failed. The MCP can also drive your installed Chrome."
fi
if [ ! -d "/Applications/Google Chrome.app" ]; then
  warn "Google Chrome is not in /Applications. chrome-devtools-mcp needs Chrome; install it or rely on the Playwright MCP."
fi

step "Computer use: UI-TARS Desktop (optional, guarded)"
TARS_DIR="$HOME/Downloads"
# The newest releases (v0.3.x) are CLI-only with no desktop binaries; the
# last desktop app release is v0.2.4 (UI-TARS-0.2.4-arm64.dmg). Scan the
# release list for that asset.
API_JSON="$(curl -s -m 30 -H 'User-Agent: local-agent-setup' 'https://api.github.com/repos/bytedance/UI-TARS-desktop/releases?per_page=30' || true)"
DMG_URL="$(printf '%s' "$API_JSON" | grep -oE 'https://[^"]+/UI-TARS-[^"]+-arm64\.dmg' | head -n 1 || true)"
if [ -n "$DMG_URL" ]; then
  DMG_FILE="$TARS_DIR/$(basename "$DMG_URL")"
  if [ ! -f "$DMG_FILE" ]; then
    note "Downloading UI-TARS Desktop: $DMG_URL"
    curl -fL -o "$DMG_FILE" "$DMG_URL" || warn "UI-TARS download failed."
  fi
  [ -f "$DMG_FILE" ] && note "Saved to $DMG_FILE. Open it and drag UI-TARS Desktop into Applications."
else
  warn "Could not find a macOS .dmg in the 30 most recent UI-TARS Desktop releases."
  note "Manual route: https://github.com/bytedance/UI-TARS-desktop/releases"
fi
note "In UI-TARS Desktop settings, use the custom VLM endpoint:"
note "  Base URL : http://$PC_HOST:$VISION_PORT/v1"
note "  API key  : (the same key you passed to this script)"
note "  Model    : ui-tars-1.5-7b"
note "And start start-vision-pc.ps1 on the PC first (stop the coding server before it, 16GB card)."

step "Sanity check"
MODELS="$(curl -s -m 5 -H "Authorization: Bearer $API_KEY" "http://$PC_HOST:$CODING_PORT/v1/models" || true)"
case "$MODELS" in
  *k2-horizon-7b*) note "PC is serving k2-horizon-7b. You are set." ;;
  *) warn "Could not confirm the model list from the PC (got: ${MODELS:-nothing}). OpenCode will surface any connection problem on first run." ;;
esac
printf '\nDone. Run:  opencode   in any project folder on this Mac.\n'
printf 'Log: %s\n' "$LOG_FILE"
