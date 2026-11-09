# Machine rules for this computer

These rules describe the shell and environment on this machine. Follow them on every task.

## Shell calls do not persist

- Every shell tool call runs in a brand new shell process. Variables, the working directory, and anything you set in one call are GONE in the next call.
- Never split work across calls as "set a variable in this call, use it in the next". Put each complete operation in a single command, and use absolute paths.
- Prefer single quotes around strings and paths. Unescaped double quotes inside a command are the top cause of malformed tool calls.

## Do not repeat yourself

- If you have run a command and seen its result, do not run the identical command again. Re-read the result you already have.
- If the same approach fails or returns nothing useful twice, stop and change approach: check the working directory, switch to an absolute path, try a different command, or report what is blocking you.
- Identical repeated calls are a malfunction, not persistence.

## Working style

- Prefer one well-built command over many small ones.
- Verify state with a read before changing it, and verify the change with a read afterwards.
