# Machine rules for this computer

These rules describe the shell and environment on this machine. Follow them on every task.

## Shell calls do not persist

- Every shell tool call runs in a brand new PowerShell 5.1 process. Variables, the working directory, and anything you set in one call are GONE in the next call.
- Never split work across calls as "set a variable in this call, use it in the next". Put each complete operation in a single command, and use absolute paths.
- PowerShell 5.1 has no `&&` or `||`. Chain commands with `;` and test `$LASTEXITCODE` when success matters.
- Stderr redirection in PowerShell is `2>$null`. There is no `/dev/null` on this machine; using it breaks commands.
- Prefer single quotes around strings and paths. Unescaped double quotes inside a command are the top cause of malformed tool calls on this machine.
- Use FORWARD slashes for paths inside shell commands: `C:/Users/amir/...`, not `C:\Users\amir\...`. PowerShell and git accept forward slashes fine, and backslashes get eaten by JSON escaping (`\t`, `\n`, `\r` turn into control characters and silently mangle commands).

## Browser tools

- For browser tasks, use the Playwright MCP. It drives its own bundled Chromium and always works on this machine.
- The chrome-devtools MCP only works if Google Chrome is installed in a standard location. If a chrome-devtools call fails with a "Chrome not installed" error, do not debug it and do not go hunting for browser executables in the shell: switch to Playwright and carry on with the task.

## Do not repeat yourself

- If you have run a command and seen its result, do not run the identical command again. Re-read the result you already have.
- If the same approach fails or returns nothing useful twice, stop and change approach: check the working directory, switch to an absolute path, try a different command, or report what is blocking you.
- Identical repeated calls are a malfunction, not persistence.

## Working style

- Prefer one well-built command over many small ones.
- Verify state with a read before changing it, and verify the change with a read afterwards.
