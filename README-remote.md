# Split setup: PC computes, M4 Air drives

Same local stack as the all-in-one setup, split across two machines:

- **PC (7900 GRE) = compute only.** llama.cpp serves K2 Horizon 7B (dense, ~6.6GB at Q5_K_M, fully in VRAM, with n-gram speculative decoding) on port 8080, and UI-TARS 1.5 7B for computer use on port 8081. The coding server alone takes roughly 12 to 14.5GB (its 64K KV cache is ~5.1GB by itself), so run one server at a time: vision on demand, not alongside coding.
- **M4 Air = frontend and control.** OpenCode runs here and talks to the PC over the network. The browser-use MCP servers (Playwright, Chrome DevTools) also run here, so the agent drives the Mac's browsers. UI-TARS Desktop runs here too; only its vision model lives on the PC.

Nothing leaves your network. The PC servers require an API key that the PC setup generates (`%LOCALAPPDATA%\local-agent\api-key.txt`), and the PC firewall rules are scoped to the Private profile plus the Tailscale address range only. Do not port-forward 8080/8081 on your router. For access away from home, put both machines on Tailscale and use the PC's Tailscale address (100.x) instead of the LAN address; the PC setup prints it if one exists, and it adds a firewall rule admitting those ports from the Tailscale range (100.64.0.0/10) because Windows often classifies the Tailscale adapter as Public, which the Private-profile LAN rule would miss.

## Setup order

```powershell
# 1. on the PC (run the firewall step elevated if it asks)
powershell -ExecutionPolicy Bypass -File .\setup-pc-server.ps1
# it ends by printing this PC's addresses and the API key
```

```bash
# 2. on the Mac, with the address and key from step 1
chmod +x setup-mac-frontend.sh
./setup-mac-frontend.sh <pc-address> <api-key>
```

The Mac script checks it can reach the PC before changing anything, so start the PC server first if the check fails. Homebrew is the one possible manual step on the Mac; the script prints exactly what to run if it is missing.

## Daily use

```powershell
# PC: start the coding server, leave the window open
.\start-server-pc.ps1
```

```bash
# Mac: in your project folder
opencode
```

Computer use: stop the coding server on the PC, run `.\start-vision-pc.ps1` there instead, then open UI-TARS Desktop on the Mac and point its custom VLM endpoint at `http://<pc-address>:8081/v1`, model `ui-tars-1.5-7b`, with the same API key.

## Troubleshooting

- Mac setup says it cannot reach the PC: PC server not started, machines on different networks (guest Wi-Fi isolates clients), or the firewall rule never got added (re-run the PC setup in an Administrator PowerShell).
- 401 errors in OpenCode: the key in `~/.config/opencode/opencode.json` on the Mac does not match `api-key.txt` on the PC. Re-run the Mac setup with the right key.
- Slow first token on long files: prompt processing is the AMD card's weak side. Normal, not a config bug.
