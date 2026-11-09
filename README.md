# Local agent stack (Windows, AMD 16GB)

A fully local agentic coding setup for the RX 7900 GRE:

- **llama.cpp** (Vulkan build) serves the model. Vulkan is the reliable path on AMD consumer cards on Windows.
- **K2 Horizon 7B** (dense, Q5_K_M, ~6.6GB) does the coding. It is a September 2026 model from MBZUAI's Institute of Foundation Models, the top independently scored model in the 8-16GB tier, and it loads entirely into the 7900 GRE's 16GB of VRAM. No offloading, no MoE.
- **OpenCode** is the harness: agent loop, file edits, shell, sub-agents.
- **Browser use** comes from two MCP servers wired into OpenCode: Playwright MCP and Chrome DevTools MCP.
- **Computer use** is wired into OpenCode through a local MCP bridge (`computer-use-mcp.py`, Python stdlib only): the agent screenshots the desktop, a locally served UI-TARS vision model finds the elements, and the bridge clicks and types. UI-TARS Desktop is also included for standalone use.

## Run it

```powershell
# one time (downloads ~6GB of model, logs everything, safe to re-run)
powershell -ExecutionPolicy Bypass -File .\setup-local-agent.ps1

# every work session: start the model server, leave the window open
.\start-coding.ps1

# ...or start the coding AND vision servers together (needed for computer use)
.\start-agent.ps1

# then in your project folder
opencode
```

Skip the computer-use download during setup with `-SkipComputerUse`.

## Computer use

Two ways to use it:

**From inside OpenCode (the bridge).** Run `.\start-agent.ps1` — it starts the coding server (8080) and the UI-TARS vision server (8081) in separate windows. Then just ask the agent in OpenCode. It has `computer_*` tools: find and click elements by description, click at coordinates, type, press hotkeys, scroll, describe the screen, or carry out one GUI action per call. The calling model never sees the screenshots — the bridge sends them to the UI-TARS model on 8081 and hands back coordinates and status text, which is what lets a text-only model drive a desktop. Supervise it: the vision model is a local 7B, fine for simple GUI tasks, not for unattended work.

**Standalone (UI-TARS Desktop).** Run the installer from `%LOCALAPPDATA%\local-agent\downloads` (the setup script downloads it but does not auto-install it), run `.\start-computer-use.ps1`, and in the app's settings point it at the local endpoint: base URL `http://127.0.0.1:8081/v1`, model `ui-tars-1.5-7b`, any non-empty API key.

## The 16GB fit, in numbers

- K2 Horizon 7B at Q5_K_M is ~6.6GB of weights. `-ngl 99` puts every layer on the GPU, and there is room left for the full 64K context with the KV cache at q8_0. Nothing runs on the CPU.
- Both servers at once also fits: ~6.6GB coder + ~0.7GB draft model + ~5GB UI-TARS vision model + caches stays inside 16GB, with some slowdown while both are busy. The vision server runs an 8K context and the bridge downscales screenshots to 1344 wide before sending them, so computer-use calls stay cheap.
- Speculative decoding is on: the same-family K2 0.9B drafts tokens and the 7B verifies them in batches, worth roughly 1.5-2.5x on code generation. The start scripts probe the llama.cpp build's `--help` before adding the flags (ngram speculation as fallback), so an engine update cannot break startup. The model's old reasoning is also not preserved into later turns (`--no-reasoning-preserve`), which keeps long agent sessions from bloating.
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
