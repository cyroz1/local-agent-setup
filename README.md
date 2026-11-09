# Local agent stack (Windows, AMD 16GB)

A fully local agentic coding setup for the RX 7900 GRE:

- **llama.cpp** (Vulkan build) serves the model. Vulkan is the reliable path on AMD consumer cards on Windows.
- **K2 Horizon 7B** (dense, Q4_K_M, ~5.6GB) does the coding. It is a September 2026 model from MBZUAI's Institute of Foundation Models, the top independently scored model in the 8-16GB tier, and it loads entirely into the 7900 GRE's 16GB of VRAM. No offloading, no MoE.
- **OpenCode** is the harness: agent loop, file edits, shell, sub-agents.
- **Browser use** comes from two MCP servers wired into OpenCode: Playwright MCP and Chrome DevTools MCP.
- **Computer use** is UI-TARS Desktop driving its own 7B vision model, also served locally by llama.cpp.

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

## Computer use

1. Run the UI-TARS Desktop installer from `%LOCALAPPDATA%\local-agent\downloads` (the setup script downloads it but does not auto-install it).
2. Run `.\start-computer-use.ps1` — stop the coding server first, a 16GB card cannot run both models well at once.
3. In UI-TARS Desktop settings, point it at the local endpoint: base URL `http://127.0.0.1:8081/v1`, model `ui-tars-1.5-7b`, any non-empty API key.

## The 16GB fit, in numbers

- K2 Horizon 7B at Q4_K_M is ~5.6GB of weights. `-ngl 99` puts every layer on the GPU, and there is room left for the full 64K context with the KV cache at q8_0. Nothing runs on the CPU.
- Expect roughly 90 to 110 tok/s generation. Dense speed is basically memory bandwidth divided by model size, and 7B reads very little per token.
- Prompt processing is AMD's weak side (about 3x slower than NVIDIA), so very long contexts take a while to load. 64K context is the default; edit `-c` in start-coding.ps1 if you need 128K.
- Try a different model: pass `-ModelRepo` to the setup script, or edit the `-hf` line in start-coding.ps1. Any `repo:quant` on Hugging Face works. Keep the `--alias` and the opencode.json model key in sync. (The strongest alternative that still fully fits is the same model at Q5_K_M if you trim context, or Qwen 3.6 27B at Q3_K_M.)

## Files and logs

- Install root: `%LOCALAPPDATA%\local-agent` (llama.cpp, downloads, logs)
- Setup logs: `%LOCALAPPDATA%\local-agent\logs`
- OpenCode config: `%USERPROFILE%\.config\opencode\opencode.json` (setup backs up any existing one first)
- Model cache: `%USERPROFILE%\.cache\llama.cpp`

## Honest limits

This gets you a real, fast, private coding agent. It does not fully match the frontier subscription agents: multi-step reliability over long tasks is a step down, prompt processing on big repos is slower, and local computer use (UI-TARS, ~47% on OSWorld vs 70s for frontier cloud agents) is for simple GUI tasks, supervised.
