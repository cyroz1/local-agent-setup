import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  FolderOpen,
  Headphones,
  LoaderCircle,
  MonitorUp,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  X,
  Minus,
} from "lucide-react";
import { createWorker, PSM } from "tesseract.js";

type Source = { id: string; name: string; thumbnail: string };
type Services = { model: boolean; transcription: boolean };
type SessionState = "prepare" | "live" | "paused";
type ContextField = "resume" | "jobDescription";

const CONTEXT_KEY = "interview-copilot-context-v1";
const AUDIO_WINDOW_SECONDS = 6;
const AUDIO_OVERLAP_SECONDS = 0.75;

function loadSavedContext() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONTEXT_KEY) || "{}");
    return {
      resume: typeof parsed.resume === "string" ? parsed.resume : "",
      jobDescription: typeof parsed.jobDescription === "string" ? parsed.jobDescription : "",
    };
  } catch {
    return { resume: "", jobDescription: "" };
  }
}

function mergeTranscript(previous: string, next: string) {
  const prior = previous.trim();
  const incoming = next.trim();
  if (!incoming) return prior;
  if (!prior) return incoming;
  if (prior.toLowerCase().includes(incoming.toLowerCase())) return prior;

  const oldWords = prior.split(/\s+/);
  const newWords = incoming.split(/\s+/);
  const maxOverlap = Math.min(oldWords.length, newWords.length, 16);
  for (let count = maxOverlap; count >= 2; count -= 1) {
    const oldTail = oldWords.slice(-count).join(" ").toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "");
    const newHead = newWords.slice(0, count).join(" ").toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "");
    if (oldTail === newHead) return `${prior} ${newWords.slice(count).join(" ")}`.trim();
  }
  return `${prior} ${incoming}`.trim();
}

function questionLike(text: string) {
  return /\?|\b(can you tell me|tell me about|walk me through|describe|how would you|what would you|why do you|what is your|how did you|give me an example)\b/i.test(text);
}

function floatToWav(samples: Float32Array, sourceRate: number, targetRate = 16000) {
  const outLength = Math.max(1, Math.floor(samples.length * targetRate / sourceRate));
  const pcm = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const sourceIndex = i * sourceRate / targetRate;
    const left = Math.floor(sourceIndex);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourceIndex - left;
    const value = samples[left] * (1 - fraction) + samples[right] * fraction;
    pcm[i] = Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767);
  }

  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buffer, 44).set(pcm);
  return buffer;
}

function takeSamples(chunks: Float32Array[], count: number) {
  const output = new Float32Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    const amount = Math.min(chunk.length, count - offset);
    output.set(chunk.subarray(0, amount), offset);
    offset += amount;
    if (offset >= count) break;
  }
  return output;
}

async function extractDocumentText(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "txt" || extension === "md") return file.text();

  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = `${window.location.origin}/pdf.worker.mjs`;
    const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return pages.join("\n\n");
  }

  if (extension === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }

  throw new Error("Use a text, Markdown, PDF, or Word document.");
}

function StatusDot({ ready }: { ready: boolean }) {
  return <span className={`status-dot ${ready ? "ready" : "offline"}`} />;
}

function App() {
  const savedContext = useRef(loadSavedContext()).current;
  const [resume, setResume] = useState<string>(savedContext.resume);
  const [jobDescription, setJobDescription] = useState<string>(savedContext.jobDescription);
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [services, setServices] = useState<Services>({ model: false, transcription: false });
  const [sessionState, setSessionState] = useState<SessionState>("prepare");
  const [heardText, setHeardText] = useState("");
  const [screenText, setScreenText] = useState("");
  const [answer, setAnswer] = useState("");
  const [answerBusy, setAnswerBusy] = useState(false);
  const answerBusyRef = useRef(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [ocrProgress, setOcrProgress] = useState("");
  const [audioLanguage, setAudioLanguage] = useState("");
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const muteRef = useRef<GainNode | null>(null);
  const ocrWorkerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null);
  const ocrTimerRef = useRef<number | null>(null);
  const audioChunksRef = useRef<Float32Array[]>([]);
  const audioSamplesRef = useRef(0);
  const audioBusyRef = useRef(false);
  const activeCaptureRef = useRef(false);
  const ocrBusyRef = useRef(false);
  const lastQuestionRef = useRef("");
  const answerTimerRef = useRef<number | null>(null);
  const heardRef = useRef("");
  const screenTextRef = useRef("");
  const resumeRef = useRef(resume);
  const jobRef = useRef(jobDescription);
  const stopCaptureRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => { resumeRef.current = resume; }, [resume]);
  useEffect(() => { jobRef.current = jobDescription; }, [jobDescription]);
  useEffect(() => { heardRef.current = heardText; }, [heardText]);
  useEffect(() => { screenTextRef.current = screenText; }, [screenText]);

  useEffect(() => {
    const video = videoRef.current;
    const stream = screenStreamRef.current;
    if (sessionState !== "prepare" && video && stream) {
      video.srcObject = stream;
      void video.play().catch(() => undefined);
    }
  }, [sessionState]);

  const refreshServices = useCallback(async () => {
    try {
      setServices(await window.interviewAgent.checkServices());
    } catch {
      setServices({ model: false, transcription: false });
    }
  }, []);

  const refreshSources = useCallback(async () => {
    setSourceBusy(true);
    setSourceError("");
    try {
      const next = await window.interviewAgent.listSources();
      setSources(next);
      if (!next.length) setSourceError("No available screen or window was found.");
    } catch {
      setSourceError("Screen capture is unavailable. Restart the app and try again.");
    } finally {
      setSourceBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshSources();
    void refreshServices();
    const timer = window.setInterval(() => { void refreshServices(); }, 8000);
    return () => window.clearInterval(timer);
  }, [refreshServices, refreshSources]);

  const saveContext = useCallback(() => {
    localStorage.setItem(CONTEXT_KEY, JSON.stringify({ resume, jobDescription }));
    setSaveNotice("Saved on this device");
    window.setTimeout(() => setSaveNotice(""), 2200);
  }, [jobDescription, resume]);

  const selectSource = useCallback(async (sourceId: string) => {
    setSelectedSource(sourceId);
    await window.interviewAgent.selectSource(sourceId);
  }, []);

  const requestAnswer = useCallback(async (questionOverride?: string) => {
    const transcript = questionOverride || heardRef.current;
    const screen = screenTextRef.current;
    if ((!transcript.trim() && !screen.trim()) || answerBusyRef.current) return;
    answerBusyRef.current = true;
    setAnswerBusy(true);
    setSessionNotice("");
    try {
      const suggestion = await window.interviewAgent.suggestAnswer({
        resume: resumeRef.current,
        jobDescription: jobRef.current,
        transcript,
        screenText: screen,
      });
      setAnswer(suggestion || "I could not form a clear answer from the available context yet.");
    } catch (error) {
      setSessionNotice(error instanceof Error ? error.message : "The local answer service is unavailable.");
    } finally {
      answerBusyRef.current = false;
      setAnswerBusy(false);
    }
  }, []);

  const scheduleAnswer = useCallback((text: string) => {
    if (!questionLike(text)) return;
    const signature = text.trim().toLowerCase().slice(-420);
    if (signature === lastQuestionRef.current) return;
    if (answerTimerRef.current) window.clearTimeout(answerTimerRef.current);
    answerTimerRef.current = window.setTimeout(() => {
      lastQuestionRef.current = signature;
      void requestAnswer();
    }, 1400);
  }, [requestAnswer]);

  const appendHeard = useCallback((text: string, language?: string) => {
    if (!text.trim()) return;
    const joined = mergeTranscript(heardRef.current, text).slice(-3600);
    heardRef.current = joined;
    setHeardText(joined);
    scheduleAnswer(joined);
    if (language) setAudioLanguage(language);
  }, [scheduleAnswer]);

  const transcribeWindow = useCallback(async (samples: Float32Array, sampleRate: number) => {
    audioBusyRef.current = true;
    try {
      const wav = floatToWav(samples, sampleRate);
      const result = await window.interviewAgent.transcribe(wav);
      appendHeard(result.text, result.language);
    } catch {
      setSessionNotice("Local transcription stopped responding. Check the transcription service.");
    } finally {
      audioBusyRef.current = false;
    }
  }, [appendHeard]);

  const startScreenReader = useCallback(async () => {
    const workerPath = `${window.location.origin}/tesseract/worker.min.js`;
    const langPath = `${window.location.origin}/tesseract/lang`;
    const corePath = `${window.location.origin}/tesseract/core`;
    const worker = await createWorker("eng", 1, {
      workerPath,
      langPath,
      corePath,
      gzip: true,
      cacheMethod: "readOnly",
      logger: (message) => {
        if (message.status === "recognizing text") setOcrProgress(`Reading screen · ${Math.round((message.progress || 0) * 100)}%`);
      },
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    ocrWorkerRef.current = worker;
  }, []);

  const inspectScreen = useCallback(async () => {
    const video = videoRef.current;
    const worker = ocrWorkerRef.current;
    if (!activeCaptureRef.current || !video || !worker || ocrBusyRef.current || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    ocrBusyRef.current = true;
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1400 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = await worker.recognize(canvas);
      const text = data.text
        .split(/\r?\n/)
        .filter((line) => !/interview copilot|suggested answer|audio listening|screen captured|use as a guide|pause session/i.test(line))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2400);
      if (text && text.toLowerCase() !== screenTextRef.current.toLowerCase()) {
        screenTextRef.current = text;
        setScreenText(text);
        scheduleAnswer(`${heardRef.current}\n${text}`);
      }
      setOcrProgress("Screen text ready");
    } catch {
      setOcrProgress("Screen text unavailable");
    } finally {
      ocrBusyRef.current = false;
    }
  }, [scheduleAnswer]);

  const startCapture = useCallback(async () => {
    if (!selectedSource) throw new Error("Choose a screen or window first.");
    setSessionNotice("");
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: true,
    });
    screenStreamRef.current = display;
    if (videoRef.current) {
      videoRef.current.srcObject = display;
      await videoRef.current.play();
    }

    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      micStreamRef.current = mic;
    } catch {
      setSessionNotice("Microphone permission was unavailable; listening to shared system audio only.");
    }

    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const mix = audioContext.createGain();
    const systemTrack = display.getAudioTracks()[0];
    const hasAudio = Boolean(systemTrack || mic?.getAudioTracks().length);
    setAudioAvailable(hasAudio);
    if (systemTrack) {
      audioContext.createMediaStreamSource(new MediaStream([systemTrack])).connect(mix);
    } else {
      setSessionNotice("System audio was not available for the selected screen. Checking microphone and screen text.");
    }
    mic?.getAudioTracks().forEach((track) => {
      audioContext.createMediaStreamSource(new MediaStream([track])).connect(mix);
    });
    if (!hasAudio) setSessionNotice("No audio source is available. Screen text capture remains active.");

    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    mix.connect(processor);
    processor.connect(silent);
    silent.connect(audioContext.destination);
    processorRef.current = processor;
    muteRef.current = silent;
    audioChunksRef.current = [];
    audioSamplesRef.current = 0;
    activeCaptureRef.current = true;

    processor.onaudioprocess = (event) => {
      if (!activeCaptureRef.current) return;
      const incoming = new Float32Array(event.inputBuffer.getChannelData(0));
      audioChunksRef.current.push(incoming);
      audioSamplesRef.current += incoming.length;
      const windowSamples = Math.floor(audioContext.sampleRate * AUDIO_WINDOW_SECONDS);
      const overlapSamples = Math.floor(audioContext.sampleRate * AUDIO_OVERLAP_SECONDS);
      if (audioSamplesRef.current < windowSamples || audioBusyRef.current) return;

      const all = takeSamples(audioChunksRef.current, audioSamplesRef.current);
      const window = all.slice(0, windowSamples);
      const keepFrom = Math.max(0, windowSamples - overlapSamples);
      const leftover = all.slice(keepFrom);
      audioChunksRef.current = leftover.length ? [leftover] : [];
      audioSamplesRef.current = leftover.length;
      void transcribeWindow(window, audioContext.sampleRate);
    };

    try {
      await startScreenReader();
    } catch {
      setOcrProgress("Offline screen reader files are missing. Run setup-interview-agent.ps1 again.");
    }
    if (ocrTimerRef.current !== null) window.clearInterval(ocrTimerRef.current);
    ocrTimerRef.current = window.setInterval(() => { void inspectScreen(); }, 5200);
    display.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (activeCaptureRef.current) {
          void stopCaptureRef.current().then(() => {
            setSessionState("paused");
            setSessionNotice("Screen sharing ended. Capture is paused.");
          });
        }
      }, { once: true });
    });
  }, [inspectScreen, selectedSource, startScreenReader, transcribeWindow]);

  const stopCapture = useCallback(async () => {
    activeCaptureRef.current = false;
    if (ocrTimerRef.current !== null) window.clearInterval(ocrTimerRef.current);
    ocrTimerRef.current = null;
    processorRef.current?.disconnect();
    muteRef.current?.disconnect();
    processorRef.current = null;
    muteRef.current = null;
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    micStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") await audioContext.close();
    const worker = ocrWorkerRef.current;
    ocrWorkerRef.current = null;
    if (worker) await worker.terminate();
    audioChunksRef.current = [];
    audioSamplesRef.current = 0;
    audioBusyRef.current = false;
    setOcrProgress("");
  }, []);
  stopCaptureRef.current = stopCapture;

  const beginSession = useCallback(async () => {
    setSourceError("");
    if (!services.model || !services.transcription) {
      setSourceError("Start the local model and transcription services first.");
      return;
    }
    try {
      localStorage.setItem(CONTEXT_KEY, JSON.stringify({ resume, jobDescription }));
      await startCapture();
      setSessionState("live");
      await window.interviewAgent.enterOverlay();
    } catch (error) {
      await stopCapture();
      setSourceError(error instanceof Error ? error.message : "Could not start screen and audio capture.");
    }
  }, [jobDescription, resume, services.model, services.transcription, startCapture, stopCapture]);

  const pauseSession = useCallback(async () => {
    await stopCapture();
    setSessionState("paused");
    setSessionNotice("Capture is paused.");
  }, [stopCapture]);

  const resumeSession = useCallback(async () => {
    try {
      await startCapture();
      setSessionState("live");
      setSessionNotice("");
    } catch (error) {
      setSessionNotice(error instanceof Error ? error.message : "Could not resume capture.");
    }
  }, [startCapture]);

  const endSession = useCallback(async () => {
    await stopCapture();
    if (answerTimerRef.current) window.clearTimeout(answerTimerRef.current);
    setSessionState("prepare");
    setHeardText("");
    setScreenText("");
    setAnswer("");
    setAudioAvailable(false);
    setSessionNotice("");
    lastQuestionRef.current = "";
    await window.interviewAgent.returnToPrepare();
  }, [stopCapture]);

  useEffect(() => () => {
    activeCaptureRef.current = false;
    if (answerTimerRef.current) window.clearTimeout(answerTimerRef.current);
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (audioContextRef.current?.state !== "closed") void audioContextRef.current?.close();
    void ocrWorkerRef.current?.terminate();
  }, []);

  const handleFile = useCallback(async (field: ContextField, file?: File) => {
    if (!file) return;
    setSaveNotice(`Reading ${file.name}…`);
    try {
      const text = await extractDocumentText(file);
      if (field === "resume") setResume((previous) => previous ? `${previous}\n\n${text}` : text);
      else setJobDescription((previous) => previous ? `${previous}\n\n${text}` : text);
      setSaveNotice(`Loaded ${file.name}`);
      window.setTimeout(() => setSaveNotice(""), 2500);
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : "Could not read that file.");
      window.setTimeout(() => setSaveNotice(""), 3500);
    }
  }, []);

  const onFileInput = (field: ContextField) => (event: ChangeEvent<HTMLInputElement>) => {
    void handleFile(field, event.target.files?.[0]);
    event.target.value = "";
  };

  const onFileDrop = (field: ContextField) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void handleFile(field, event.dataTransfer.files?.[0]);
  };

  if (sessionState !== "prepare") {
    return (
      <main className="window-frame overlay-frame">
        <header className="titlebar titlebar-dark">
          <div className="brand brand-light"><span className="brand-mark"><Sparkles size={13} /></span><span>Interview Copilot</span></div>
          <div className="window-actions">
            <button className="window-icon light" onClick={() => void window.interviewAgent.minimize()} aria-label="Minimize"><Minus size={15} /></button>
            <button className="window-icon light" onClick={() => void window.interviewAgent.close()} aria-label="Close"><X size={16} /></button>
          </div>
        </header>

        <div className="overlay-content">
          <div className="live-status-row">
            <span className={`live-badge ${sessionState === "live" ? "" : "paused"}`}>
              {sessionState === "live" ? <><span className="live-pulse" /> LIVE</> : <><Pause size={11} /> PAUSED</>}
            </span>
            <span className="capture-state"><MonitorUp size={14} /> {sessionState === "live" ? "Screen captured" : "Screen paused"}</span>
            <span className="capture-state"><Headphones size={14} /> {sessionState === "live" ? (audioAvailable ? "Audio listening" : "Audio unavailable") : "Audio paused"}</span>
          </div>

          <section className="overlay-section heard-section">
            <div className="section-heading"><span>Heard</span><span className="subtle-heading">{audioLanguage || (sessionState === "live" ? "Live transcription" : "Session paused")}</span></div>
            <p className={`transcript-text ${heardText ? "" : "empty-copy"}`}>
              {heardText ? heardText.slice(-520) : sessionState === "live" ? "Listening for the next question…" : "Resume when you're ready to continue."}
            </p>
          </section>

          <section className="overlay-section answer-section">
            <div className="section-heading"><span>Suggested answer</span>{answerBusy && <LoaderCircle className="spin" size={15} />}</div>
            {answerBusy ? (
              <div className="answer-loading"><span className="answer-loader" /> Shaping a concise answer from your context…</div>
            ) : answer ? (
              <p className="answer-text">{answer}</p>
            ) : (
              <div className="answer-empty"><Sparkles size={16} /><span>A grounded suggestion will appear when a question is heard.</span></div>
            )}
            <p className="answer-footnote">Use this as a guide and answer in your own words.</p>
          </section>

          {(sessionNotice || ocrProgress) && <p className="overlay-notice">{sessionNotice || ocrProgress}</p>}

          {showContext && (
            <section className="context-peek">
              <div><span>Resume</span><small>{resume.length.toLocaleString()} characters loaded</small></div>
              <div><span>Job description</span><small>{jobDescription.length.toLocaleString()} characters loaded</small></div>
              {screenText && <div><span>Visible screen text</span><small>{screenText.slice(0, 260)}</small></div>}
            </section>
          )}

          <div className="overlay-actions">
            {sessionState === "live" ? (
              <>
                <button className="button button-primary overlay-primary" onClick={() => void requestAnswer()} disabled={answerBusy}>
                  {answerBusy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={15} />} Refresh answer
                </button>
                <button className="button button-quiet-dark" onClick={() => void pauseSession()}><Pause size={15} /> Pause</button>
              </>
            ) : (
              <>
                <button className="button button-primary overlay-primary" onClick={() => void resumeSession()}><Play size={15} /> Resume</button>
                <button className="button button-quiet-dark" onClick={() => void endSession()}><Square size={13} /> End session</button>
              </>
            )}
          </div>

          <button className="context-toggle" onClick={() => setShowContext((value) => !value)}>
            <FileText size={13} /> Your context <ChevronDown className={showContext ? "chevron-open" : ""} size={13} />
          </button>
        </div>
        <video ref={videoRef} className="capture-video" muted playsInline />
      </main>
    );
  }

  return (
    <main className="window-frame prepare-frame">
      <header className="titlebar titlebar-light">
        <div className="brand"><span className="brand-mark"><Sparkles size={13} /></span><span>Interview Copilot</span></div>
        <div className="window-actions">
          <button className="window-icon" onClick={() => void window.interviewAgent.minimize()} aria-label="Minimize"><Minus size={15} /></button>
          <button className="window-icon" onClick={() => void window.interviewAgent.close()} aria-label="Close"><X size={16} /></button>
        </div>
      </header>

      <div className="prepare-content">
        <div className="prepare-heading">
          <div>
            <p className="eyebrow">PRIVATE WORKSPACE</p>
            <h1>Prepare your session</h1>
            <p className="heading-subcopy">Add your background so suggestions stay specific to your experience.</p>
          </div>
          <span className="local-label"><span className="local-lock" /> Stays on this device</span>
        </div>

        <div className="context-grid">
          <label className="context-field">
            <span className="field-label">Your resume</span>
            <div className="textarea-wrap" onDragOver={(event) => event.preventDefault()} onDrop={onFileDrop("resume")}>
              <textarea value={resume} onChange={(event) => setResume(event.target.value)} placeholder="Paste your resume here, or add a file." />
              <label className="file-add" title="Add resume file">
                <input type="file" accept=".txt,.md,.pdf,.docx" onChange={onFileInput("resume")} />
                <FolderOpen size={15} /><span>Add file</span>
              </label>
            </div>
            <span className="field-hint">{resume ? `${resume.length.toLocaleString()} characters` : "TXT, MD, PDF, DOCX"}</span>
          </label>
          <label className="context-field">
            <span className="field-label">Job description</span>
            <div className="textarea-wrap" onDragOver={(event) => event.preventDefault()} onDrop={onFileDrop("jobDescription")}>
              <textarea value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="Paste the role description here, or add a file." />
              <label className="file-add" title="Add job description file">
                <input type="file" accept=".txt,.md,.pdf,.docx" onChange={onFileInput("jobDescription")} />
                <FolderOpen size={15} /><span>Add file</span>
              </label>
            </div>
            <span className="field-hint">{jobDescription ? `${jobDescription.length.toLocaleString()} characters` : "TXT, MD, PDF, DOCX"}</span>
          </label>
        </div>

        <section className="capture-setup">
          <div className="capture-setup-heading">
            <div>
              <span className="field-label">Screen and audio</span>
              <p>Choose a window or display. Screen, system audio, and mic stay local; the overlay is not hidden from capture or sharing.</p>
            </div>
            <button className="button button-outline button-small" onClick={() => void refreshSources()} disabled={sourceBusy}>
              {sourceBusy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Refresh
            </button>
          </div>

          {sources.length ? (
            <div className="source-list">
              {sources.map((source) => (
                <button
                  key={source.id}
                  className={`source-item ${selectedSource === source.id ? "selected" : ""}`}
                  onClick={() => void selectSource(source.id)}
                >
                  <img src={source.thumbnail} alt="" />
                  <span className="source-name">{source.name}</span>
                  <span className="source-check">{selectedSource === source.id && <Check size={13} />}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="source-empty"><MonitorUp size={18} /><span>Screen and window choices will appear here.</span></div>
          )}
          {sourceError && <p className="inline-error">{sourceError}</p>}
        </section>

        <section className="services-row">
          <div className="services-title"><span>Local services</span><button className="help-button" title="The local model drafts suggestions; offline Whisper transcribes audio."><CircleHelp size={14} /></button></div>
          <div className="service-state"><StatusDot ready={services.model} /><span>Answer model</span><strong>{services.model ? "Ready" : "Start coding server"}</strong></div>
          <div className="service-state"><StatusDot ready={services.transcription} /><span>Transcription</span><strong>{services.transcription ? "Ready" : "Start interview app"}</strong></div>
        </section>

        <footer className="prepare-footer">
          <span className="save-state">{saveNotice || "Save your resume and role context on this device."}</span>
          <div className="footer-actions">
            <button className="button button-outline" onClick={saveContext}><Check size={15} /> Save context</button>
            <button
              className="button button-primary"
              onClick={() => void beginSession()}
              disabled={!resume.trim() || !jobDescription.trim() || !selectedSource || !services.model || !services.transcription}
            >
              Start session <ChevronRight size={16} />
            </button>
          </div>
        </footer>
      </div>
    </main>
  );
}

export default App;
