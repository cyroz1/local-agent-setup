const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const UI_URL = "http://127.0.0.1:5173";
const LLM_URL = "http://127.0.0.1:8080";
const ASR_URL = "http://127.0.0.1:8765";
let mainWindow;
let selectedSourceId = null;
let clickThroughEnabled = false;
let clickThroughTimeout = null;
const CLICK_THROUGH_TIMEOUT_MS = 20000;

function setClickThrough(enabled) {
  if (!mainWindow) return false;
  clickThroughEnabled = Boolean(enabled);
  mainWindow.setIgnoreMouseEvents(clickThroughEnabled, { forward: true });
  if (clickThroughTimeout) clearTimeout(clickThroughTimeout);
  clickThroughTimeout = clickThroughEnabled
    ? setTimeout(() => setClickThrough(false), CLICK_THROUGH_TIMEOUT_MS)
    : null;
  mainWindow.webContents.send("window:click-through-changed", clickThroughEnabled);
  return clickThroughEnabled;
}

function modelHeaders() {
  const headers = { "Content-Type": "application/json" };
  const keyPath = path.join(process.env.LOCALAPPDATA || "", "local-agent", "api-key.txt");
  try {
    const key = fs.readFileSync(keyPath, "utf8").trim();
    if (key) headers.Authorization = `Bearer ${key}`;
  } catch { /* The standalone setup has no key file. */ }
  return headers;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 790,
    minWidth: 780,
    minHeight: 650,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    title: "Interview Copilot",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(UI_URL);
  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.on("closed", () => {
    if (clickThroughTimeout) clearTimeout(clickThroughTimeout);
    clickThroughTimeout = null;
    clickThroughEnabled = false;
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === "display-capture") return callback(true);
    if (permission === "media") {
      const types = details?.mediaTypes || [];
      return callback(types.includes("audio") && !types.includes("video"));
    }
    return callback(false);
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 360, height: 210 },
        fetchWindowIcons: false,
      });
      const source = sources.find((item) => item.id === selectedSourceId);
      if (!source) return callback({});
      callback({ video: source, audio: "loopback" });
    } catch {
      callback({});
    }
  });

  ipcMain.handle("sources:list", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 360, height: 210 },
      fetchWindowIcons: false,
    });
    return sources
      .filter((source) => !source.name.toLowerCase().includes("interview copilot"))
      .map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
      }));
  });

  ipcMain.handle("sources:select", (_event, sourceId) => {
    selectedSourceId = typeof sourceId === "string" ? sourceId : null;
    return Boolean(selectedSourceId);
  });

  ipcMain.handle("window:overlay", () => {
    if (!mainWindow) return;
    setClickThrough(false);
    const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
    const width = 420;
    const height = Math.min(760, workArea.height - 48);
    mainWindow.setMinimumSize(360, 460);
    mainWindow.setBounds({
      x: workArea.x + workArea.width - width - 18,
      y: workArea.y + 24,
      width,
      height,
    });
    const topmostLevel = process.platform === "win32" ? "screen-saver" : "floating";
    mainWindow.setAlwaysOnTop(true, topmostLevel);
    mainWindow.show();
    mainWindow.moveTop();
  });

  ipcMain.handle("window:prepare", () => {
    if (!mainWindow) return;
    setClickThrough(false);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(780, 650);
    mainWindow.setBounds({ x: 120, y: 90, width: 1100, height: 790 });
    mainWindow.show();
  });

  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:click-through", (_event, enabled) => setClickThrough(enabled));
  ipcMain.handle("services:check", async () => {
    const headers = modelHeaders();
    const [model, transcription] = await Promise.all([
      fetch(`${LLM_URL}/health`, { headers: { Authorization: headers.Authorization || "" }, signal: AbortSignal.timeout(2500) })
        .then((response) => response.ok)
        .catch(() => false),
      fetch(`${ASR_URL}/health`, { signal: AbortSignal.timeout(2500) })
        .then((response) => response.json())
        .then((body) => body.status === "ok")
        .catch(() => false),
    ]);
    return { model, transcription };
  });

  ipcMain.handle("audio:transcribe", async (_event, wavBytes) => {
    const response = await fetch(`${ASR_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from(wavBytes),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`Transcription service returned ${response.status}`);
    return response.json();
  });

  ipcMain.handle("answers:suggest", async (_event, payload) => {
    const { resume, jobDescription, transcript, screenText } = payload || {};
    const headers = modelHeaders();
    const response = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model: "k2-horizon-7b",
        temperature: 0.2,
        max_tokens: 384,
        chat_template_kwargs: { reasoning_effort: "low" },
        messages: [
          {
            role: "system",
            content: "Answer quickly with 2 to 3 natural first-person sentences. Use only facts and methods explicitly present in the resume; never infer what an analysis found, why a metric changed, or a process detail. For example, 'used funnel analysis' does not mean it revealed a particular drop-off. If the resume omits a requested detail, say that and leave a short [add verified detail] cue. Tailor emphasis to the job description without adding new facts. The question may come from live audio or noisy screen OCR; treat clear prompts such as 'Tell me about...' or 'Describe...' as questions even without punctuation. Do not repeat the question or explain your reasoning. Return only the answer sentences.",
          },
          {
            role: "user",
            content: `RESUME\n${String(resume || "").slice(0, 8000)}\n\nJOB DESCRIPTION\n${String(jobDescription || "").slice(0, 5000)}\n\nRECENT INTERVIEW AUDIO\n${String(transcript || "").slice(-1200)}\n\nVISIBLE SCREEN TEXT\n${String(screenText || "").slice(0, 1600)}\n\nUse the clearest current question found in either source. Keep every claim grounded in the resume.`,
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Local model returned ${response.status}`);
    const result = await response.json();
    return String(result?.choices?.[0]?.message?.content || "").trim();
  });

  createWindow();
  const clickThroughShortcut = process.platform === "darwin" ? "Command+Option+Shift+O" : "Control+Alt+Shift+O";
  const shortcutRegistered = globalShortcut.register(clickThroughShortcut, () => {
    if (mainWindow && (clickThroughEnabled || mainWindow.isAlwaysOnTop())) setClickThrough(!clickThroughEnabled);
  });
  console.log(`Click-through shortcut ${clickThroughShortcut}: ${shortcutRegistered ? "ready" : "unavailable"}`);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("will-quit", () => {
  if (clickThroughTimeout) clearTimeout(clickThroughTimeout);
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
