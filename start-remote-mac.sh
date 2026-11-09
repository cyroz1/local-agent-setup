#!/usr/bin/env bash
#
# Phone remote control, Mac side (split setup frontend).
#
# Starts OpenCode in headless serve mode on port 4096 with password
# auth, so a phone on your Tailscale network can drive the same
# sessions from a browser: send prompts, approve tool calls, watch
# output. The phone is a pure viewport; OpenCode and your projects
# stay on this Mac, and the model stays on the PC as usual.
#
# A password is generated once and stored in
# ~/.local-agent/opencode-password.txt (chmod 600). This server can
# run shell commands, so it never starts without one. Reach it over
# Tailscale (or your home LAN) only: never port-forward port 4096,
# never put it on Tailscale Funnel.
#
# Usage: ./start-remote-mac.sh   (leave the terminal open, Ctrl+C stops)

set -uf -o pipefail

PORT=4096
STATE_DIR="$HOME/.local-agent"
PW_FILE="$STATE_DIR/opencode-password.txt"

OPENCODE=""
if command -v opencode >/dev/null 2>&1; then
  OPENCODE="$(command -v opencode)"
elif [ -x "$HOME/.local/bin/opencode" ]; then
  OPENCODE="$HOME/.local/bin/opencode"
fi
[ -n "$OPENCODE" ] || { echo "opencode not found. Run setup-mac-frontend.sh first." >&2; exit 1; }
echo "opencode: $OPENCODE"

mkdir -p "$STATE_DIR"
if [ -f "$PW_FILE" ]; then
  PASSWORD="$(cat "$PW_FILE")"
  echo "Reusing the server password in $PW_FILE."
else
  PASSWORD="$(openssl rand -hex 16)"
  [ -n "$PASSWORD" ] || { echo "Password generation failed (openssl rand)." >&2; exit 1; }
  printf '%s' "$PASSWORD" > "$PW_FILE"
  chmod 600 "$PW_FILE"
  echo "Generated a server password and saved it to $PW_FILE."
fi
# Two env names on purpose: older OpenCode reads
# OPENCODE_SERVER_PASSWORD, the current docs say OPENCODE_PASSWORD.
# Same value, both exported.
export OPENCODE_SERVER_PASSWORD="$PASSWORD"
export OPENCODE_PASSWORD="$PASSWORD"

echo ""
echo "Open one of these on your phone (Tailscale app on):"
TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
[ -n "$TS_IP" ] && echo "  Tailscale: http://$TS_IP:$PORT  (works anywhere)"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
[ -n "$LAN_IP" ] && echo "  Home LAN : http://$LAN_IP:$PORT"
echo "  Username: opencode"
echo "  Password: $PASSWORD   (also in $PW_FILE)"
echo ""
echo "Make sure the PC model server is running too (start-server-pc.ps1 over there)."
echo "If macOS asks whether opencode may accept incoming connections, allow it."
echo "Leave this terminal open. Ctrl+C stops the remote server."
echo ""

exec "$OPENCODE" serve --hostname 0.0.0.0 --port "$PORT"
