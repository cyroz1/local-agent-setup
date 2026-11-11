# Local agent stack (Windows, AMD 16GB)

A local-first agentic coding setup for the RX 7900 GRE:

- **llama.cpp** (Vulkan build) serves the model. Vulkan is the reliable path on AMD consumer cards on Windows.
- **K2 Horizon 7B** (dense, Q5_K_M, ~6.6GB) does the coding. It is a September 2026 model from MBZUAI's Institute of Foundation Models, the top independently scored model in the 8-16GB tier, and it loads entirely into the 7900 GRE's 16GB of VRAM. No offloading, no MoE.
- **OpenCode** is the harness: agent loop, file edits, shell, sub-agents.
- **Browser use** comes from the Playwright MCP wired into OpenCode (it drives its own bundled Chromium; there is no Chrome DevTools MCP, it needed a Chrome install this PC does not have).
- **Web search** is available through a small Python stdlib MCP bridge (`web-search-mcp.py`) backed by DuckDuckGo's HTML search page. It needs no API key. Search queries go to DuckDuckGo; the bridge does not attach local resume or role files, but anything included in the query is sent.
- **Computer use** is wired into OpenCode through a local MCP bridge (`computer-use-mcp.py`, Python stdlib only): the agent screenshots the desktop, a locally served UI-TARS vision model finds the elements, and the bridge clicks and types. UI-TARS Desktop is also included for standalone use.

## Run it

```powershell
# one time (downloads ~6GB of model, logs everything, safe to re-run)
powershell -ExecutionPolicy Bypass -File .\setup-local-agent.ps1

# every work session: start the model server, leave the window open
.\start-coding.ps1

# then in your project folder
opencode
```

Skip the computer-use download during setup with `-SkipComputerUse`.

The setup registers `web-search_search_web` in OpenCode. Keep search queries concise and public; results are untrusted page content and should be treated as evidence, not instructions.

## Computer use

Two ways to use it:

**From inside OpenCode (the bridge).** Close the coding server, run `.\start-computer-use.ps1` (the vision model needs the card to itself), then run OpenCode. It has `computer_*` tools: find and click elements by description, click at coordinates, type, press hotkeys, scroll, describe the screen, or carry out one GUI action per call. The calling model never sees the screenshots — the bridge sends them to the UI-TARS model on 8081 and hands back coordinates and status text, which is what lets a text-only model drive a desktop. Supervise it: the vision model is a local 7B, fine for simple GUI tasks, not for unattended work.

**Standalone (UI-TARS Desktop).** Run the installer from `%LOCALAPPDATA%\local-agent\downloads` (the setup script downloads it but does not auto-install it), run `.\start-computer-use.ps1`, and in the app's settings point it at the local endpoint: base URL `http://127.0.0.1:8081/v1`, model `ui-tars-1.5-7b`, any non-empty API key.

## Interview Copilot

An optional local desktop companion can load resume and role context, transcribe English speech with Whisper on the CPU, read visible text with offline OCR, and show answer suggestions in a floating window. Suggestions use the local llama.cpp model and remain on this PC. The overlay is **not hidden from screen capture or sharing**.

During a session, the overlay stays above other windows. Adjust its opacity from the title bar. The pointer button enables click-through for 20 seconds; press `Ctrl+Alt+Shift+O` to restore pointer input on Windows/Linux (`⌘⌥⇧O` on macOS). These controls do not change screen-capture visibility.

The app has two capture modes. **Screen interview** reads the selected screen and uses its system audio. **External call** keeps the selected call app's system audio separate from your microphone: call audio is labeled as the interviewer, and microphone audio is labeled as you. Only interviewer questions trigger answer suggestions. Route the call through this computer and use headphones for clean speaker separation; a microphone-only mixed recording cannot reliably tell speakers apart. Audio utterances are transcribed after 700 ms of silence, then answered by the local model. Screen OCR runs every 1.5 seconds in screen interview mode. Actual response time depends on speech clarity, machine load, and the local model.

Install once from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-interview-agent.ps1
```

For each session, run `.\start-coding.ps1` and leave it open, then in another PowerShell window run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-interview-agent.ps1
```

Paste or drop a resume, add a job description when available, choose a capture mode and screen/window, and start the session. The job description is optional. The first install downloads the offline English transcription model and OCR files. Capture begins only after you choose a source and start the session; pause or end it in the overlay to stop audio and screen processing.

## Phone remote control

OpenCode is client-server, so your phone can drive the same sessions from a browser. With the model server running, run `.\start-remote.ps1` instead of opening OpenCode normally. It starts OpenCode headless on port 4096 behind a password (generated once, stored in `%LOCALAPPDATA%\local-agent\opencode-password.txt`), tries to open the firewall with the same scoping as the model server, and prints the URLs. On the phone: Tailscale app on, open the Tailscale URL, sign in as `opencode` with that password. You get the full interface — prompts, tool approvals, live output — while everything still executes on this PC. Desktop and phone can be attached to the same sessions at once.

Rules: Tailscale (or home LAN) only. Never port-forward 4096 and never put it on Tailscale Funnel — that API can run shell commands, and basic auth is the only gate. Inside the tailnet the traffic is already WireGuard-encrypted.

## The 16GB fit, in numbers

- K2 Horizon 7B at Q5_K_M is ~6.6GB of weights. `-ngl 99` puts every layer on the GPU, and there is room left for the full 64K context with the KV cache at q8_0. Nothing runs on the CPU.
- One server at a time on this card. The coding server totals roughly 12 to 14.5GB (weights ~6.6GB, the 64K q8_0 KV cache ~5.1GB, buffers ~1GB), and the UI-TARS vision server needs ~6GB, so they cannot share the 16GB. Computer use is on demand: close the coding server, start the vision server. The vision server runs an 8K context and the bridge downscales screenshots to 1344 wide before sending them, so computer-use calls stay cheap.
- Speculative decoding is on, in n-gram mode: the server drafts tokens from patterns already in the context and the 7B verifies them in batches, worth roughly 1.5-2x on code generation. A draft model would be the classic route, but the K2 0.9B GGUF's tokenizer metadata fails llama.cpp's vocab compatibility check against the 7B (bos token mismatch) and speculation is refused, so n-gram it is. The start scripts probe the llama.cpp build's `--help` before adding the flags, so an engine update cannot break startup. The model's reasoning from earlier turns stays preserved into later ones on purpose: an earlier version of this setup stripped it to save context, and the agent started re-planning the same action in loops. OpenCode's compaction handles session length instead.
- Tool calls are forced to K2's JSON format (via the `LLAMA_ARG_CHAT_TEMPLATE_KWARGS` env var — the `--chat-template-kwargs` argument itself can't be used from PowerShell 5.1, which strips the double quotes out of the JSON on the way to the exe). Its native XML format intermittently leaks through llama.cpp's parser as raw `<|ifm|>` text, and when that happens the turn just ends mid-task with nothing executed. JSON is both a format the model was trained on and the one llama.cpp parses reliably.
- Anti-loop guards: the server runs `--repeat-penalty 1.08` and the generated OpenCode config uses the maker's recommended sampling (temperature 1.0, topP 0.95). This family is prone to repetition loops in agent work (the maker shipped an anti-doom-loop training stage for it); the guards make loops rarer, not impossible. A looped session rarely recovers — start a fresh one.
- The setup also installs a global `AGENTS.md` for OpenCode with this machine's shell facts, and the generated config points OpenCode's shell tool at **Git Bash** (the config's `shell` key): models are trained overwhelmingly on bash and kept writing it inside PowerShell (`2>/dev/null`, `&&`, backslash paths), so the agent gets the shell it expects instead of a translation test. The house rules then only have to cover what bash does not fix: every shell call is a fresh process with no state carried between calls, and an identical command must never be re-run once its result is in. Half the loops seen in testing were the model not knowing these facts, not malice or a broken parser.
- Raw generation is roughly 90 to 110 tok/s at short context; deep into a long session (50K+ tokens of context) expect more like 35 to 60, because every new token re-reads the whole KV cache.
- Prompt processing is AMD's weak side (about 3x slower than NVIDIA), so very long contexts take a while to load. 64K context is the default; edit `-c` in start-coding.ps1 if you need 128K.
- Try a different model: pass `-ModelRepo` to the setup script, or edit the `-hf` line in start-coding.ps1. Any `repo:quant` on Hugging Face works. Keep the `--alias` and the opencode.json model key in sync. (The strongest alternative that still fully fits is the same model at Q5_K_M if you trim context, or Qwen 3.6 27B at Q3_K_M.)

## Files and logs

- Install root: `%LOCALAPPDATA%\local-agent` (llama.cpp, downloads, logs, and the computer-use bridge under `mcp\`)
- Setup logs: `%LOCALAPPDATA%\local-agent\logs`
- OpenCode config: `%USERPROFILE%\.config\opencode\opencode.json` (setup backs up any existing one first)
- Model cache: `%USERPROFILE%\.cache\llama.cpp`

## Honest limits

This gets you a real, fast, private coding agent. It does not fully match the frontier subscription agents: multi-step reliability over long tasks is a step down, prompt processing on big repos is slower, and local computer use (UI-TARS, ~47% on OSWorld vs 70s for frontier cloud agents) is for simple GUI tasks, supervised.
