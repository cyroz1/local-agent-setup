import { ChangeEvent, CSSProperties, DragEvent, useCallback, useEffect, useRef, useState } from "react";
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
  MousePointer2,
} from "lucide-react";
import { createWorker, PSM } from "tesseract.js";

type Source = { id: string; name: string; thumbnail: string };
type Services = { model: boolean; transcription: boolean };
type SessionState = "prepare" | "live" | "paused";
type ContextField = "resume" | "jobDescription";

const CONTEXT_KEY = "interview-copilot-context-v1";
const OPACITY_KEY = "interview-copilot-overlay-opacity-v1";
const SPEECH_RMS_THRESHOLD = 0.003;
const SPEECH_END_SILENCE_MS = 700;
const SPEECH_PREROLL_SECONDS = 0.2;
const MAX_UTTERANCE_SECONDS = 24;
const SCREEN_QUESTION_AUDIO_PRIORITY_MS = 10_000;
const DUPLICATE_QUESTION_WINDOW_MS = 12_000;

type QuestionSource = "audio" | "screen";
type PendingAnswer = { question: string; requestId: number };

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

function loadOverlayOpacity() {
  const saved = Number(localStorage.getItem(OPACITY_KEY));
  return Number.isFinite(saved) && saved >= 65 && saved <= 100 ? saved : 92;
}

function normalizeForMatch(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu)?.join(" ") || "";
}

const QUESTION_START_PATTERN = /^(?:(?:and|so|okay|all right|now|next|well|um|uh)\s+)*(?:(?:can|could|would)\s+you(?:\s+(?:tell me|describe|explain|walk me through|speak to))?|tell me (?:about|how|why|what)|walk me through|give me an example|describe|explain|what(?:'s|\s+is|\s+are|\s+did|\s+do|\s+would)?|why|how|when|where|who|which|could|would|can|do|does|did|is|are|have|has)\b/i;

function questionLike(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = normalizeForMatch(clean).split(" ").filter(Boolean);
  const hasQuestionOpening = QUESTION_START_PATTERN.test(clean);
  return hasQuestionOpening && (words.length >= 5 || (words.length >= 3 && /\?\s*$/.test(clean)));
}

function extractQuestionCandidate(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";

  const parts = clean.split(/(?<=[?!.])\s+/).map((part) => part.trim()).filter(Boolean);
  const questions = parts.filter(questionLike);
  if (questions.length) return questions[questions.length - 1];
  return questionLike(clean) ? clean : "";
}

function extractScreenQuestion(lines: string[]) {
  const candidates: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index].replace(/\s+/g, " ").trim();
    if (!QUESTION_START_PATTERN.test(firstLine)) continue;

    let candidate = firstLine;
    for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
      if (/[?!.]\s*$/.test(candidate) || QUESTION_START_PATTERN.test(lines[next].trim())) break;
      candidate = `${candidate} ${lines[next].replace(/\s+/g, " ").trim()}`.trim();
    }
    const question = extractQuestionCandidate(candidate);
    if (question) candidates.push(question);
  }
  return candidates[candidates.length - 1] || "";
}

function similarSignature(left: string, right: string) {
  if (!left || !right) return false;
  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  let shared = 0;
  leftWords.forEach((word) => { if (rightWords.has(word)) shared += 1; });
  const union = leftWords.size + rightWords.size - shared;
  return union > 0 && shared / union >= 0.86;
}

function looksLikeQuestionEcho(text: string) {
  return /^(?:tell me about|describe|walk me through|can you tell me|what is your|what did you|what would you|how did you|how would you|why did you|why do you|give me an example)\b/i.test(text.trim());
}

function conservativeAnswer(question: string, resume: string) {
  const normalizedQuestion = question.toLowerCase();
  const normalizedResume = resume.toLowerCase();
  const asksPersonalMotivation = /\b(?:what led you to|what inspired you to|what motivated you to|why did you choose|why did you decide|what made you choose|what drew you to|why are you interested in|why do you want to|what is your reason for)\b/i.test(normalizedQuestion);
  const resumeStatesMotivation = /\b(?:i chose .{0,50} because|i decided .{0,50} because|i was inspired|i was motivated|my motivation|my passion|my interest in|what led me to|because i wanted to)\b/i.test(normalizedResume);
  if (asksPersonalMotivation && !resumeStatesMotivation) {
    return "The resume doesn’t record my specific personal reason for that choice. I’d add my genuine reason here, then connect it to the relevant experience and projects in my background.";
  }

  const asksForSpecificCustomerStory = /\b(?:difficult|challenging|tough|complex)\b.{0,80}\b(?:customer|support|issue|incident|situation|problem)\b/i.test(normalizedQuestion);
  const resumeContainsSpecificStory = /\b(?:one time|for example|a customer (?:called|came|had|needed)|i (?:helped|handled|worked with) a customer|as a result|the result was)\b/i.test(normalizedResume);
  if (asksForSpecificCustomerStory && !resumeContainsSpecificStory) {
    return "The resume doesn’t include a detailed customer incident, so I don’t want to invent one. Add a real example here with the customer’s issue, the steps you took, and the outcome.";
  }

  const asksBootTroubleshooting = /\bhow (?:do|would|can) you\b/i.test(normalizedQuestion)
    && /\b(?:diagnos|troubleshoot)\w*\b/i.test(normalizedQuestion)
    && /\b(?:boot|start)\w*\b/i.test(normalizedQuestion);
  if (asksBootTroubleshooting) {
    return "I’d first confirm power, cables, and any POST or error indicators, then check whether BIOS/UEFI detects the memory and storage and verify the boot order. If the hardware is detected, I’d use recovery tools and logs to isolate the bootloader or operating system; if not, I’d test the affected hardware.";
  }
  return "";
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
  const clickThroughShortcut = navigator.platform.startsWith("Mac") ? "⌘⌥⇧O" : "Ctrl+Alt+Shift+O";
  const savedContext = useRef(loadSavedContext()).current;
  const [resume, setResume] = useState<string>(savedContext.resume);
  const [jobDescription, setJobDescription] = useState<string>(savedContext.jobDescription);
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [services, setServices] = useState<Services>({ model: false, transcription: false });
  const [sessionState, setSessionState] = useState<SessionState>("prepare");
  const [overlayOpacity, setOverlayOpacity] = useState(loadOverlayOpacity);
  const [clickThrough, setClickThrough] = useState(false);
  const [screenText, setScreenText] = useState("");
  const [activeQuestion, setActiveQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const answerRef = useRef("");
  const [answerBusy, setAnswerBusy] = useState(false);
  const answerBusyRef = useRef(false);
  const pendingAnswerRef = useRef<PendingAnswer | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [ocrProgress, setOcrProgress] = useState("");
  const [audioLanguage, setAudioLanguage] = useState("");
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioSignal, setAudioSignal] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const muteRef = useRef<GainNode | null>(null);
  const ocrWorkerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null);
  const ocrTimerRef = useRef<number | null>(null);
  const preRollChunksRef = useRef<Float32Array[]>([]);
  const preRollSamplesRef = useRef(0);
  const speechChunksRef = useRef<Float32Array[]>([]);
  const speechSamplesRef = useRef(0);
  const speechActiveRef = useRef(false);
  const captureGenerationRef = useRef(0);
  const transcriptionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const audioSignalRef = useRef(false);
  const lastAudioSignalAtRef = useRef(0);
  const activeCaptureRef = useRef(false);
  const ocrBusyRef = useRef(false);
  const lastQuestionRef = useRef("");
  const lastQuestionAtRef = useRef(0);
  const lastAudioQuestionAtRef = useRef(0);
  const answerRequestIdRef = useRef(0);
  const activeQuestionRef = useRef("");
  const screenTextRef = useRef("");
  const resumeRef = useRef(resume);
  const jobRef = useRef(jobDescription);
  const stopCaptureRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => { resumeRef.current = resume; }, [resume]);
  useEffect(() => { jobRef.current = jobDescription; }, [jobDescription]);
  useEffect(() => { screenTextRef.current = screenText; }, [screenText]);
  useEffect(() => window.interviewAgent.onClickThroughChanged(setClickThrough), []);

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

  const requestAnswer = useCallback((questionText: string) => {
    const question = questionText.trim();
    if (!question) return;

    const request = { question, requestId: ++answerRequestIdRef.current };
    if (answerBusyRef.current) {
      pendingAnswerRef.current = request;
      return;
    }

    answerBusyRef.current = true;
    setAnswerBusy(true);
    setSessionNotice("");
    void (async () => {
      let current: PendingAnswer | null = request;
      while (current) {
        try {
          const verifiedContextFallback = conservativeAnswer(current.question, resumeRef.current);
          const suggestion = verifiedContextFallback || await window.interviewAgent.suggestAnswer({
              resume: resumeRef.current,
              jobDescription: jobRef.current,
              question: current.question,
            });
          if (current.requestId === answerRequestIdRef.current) {
            const nextAnswer = looksLikeQuestionEcho(suggestion)
              ? "I couldn't find a grounded answer in the resume context. Add a verified detail and refresh."
              : suggestion || "I could not form a clear answer from the available context yet.";
            answerRef.current = nextAnswer;
            setAnswer(nextAnswer);
          }
        } catch (error) {
          if (current.requestId === answerRequestIdRef.current) {
            setSessionNotice(error instanceof Error ? error.message : "The local answer service is unavailable.");
          }
        }

        current = pendingAnswerRef.current;
        pendingAnswerRef.current = null;
      }
      answerBusyRef.current = false;
      setAnswerBusy(false);
    })();
  }, []);

  const considerQuestion = useCallback((text: string, source: QuestionSource) => {
    const question = source === "screen"
      ? extractScreenQuestion(text.split(/\r?\n/))
      : extractQuestionCandidate(text);
    if (!question) return;

    const now = Date.now();
    if (source === "screen" && now - lastAudioQuestionAtRef.current < SCREEN_QUESTION_AUDIO_PRIORITY_MS) return;
    const signature = normalizeForMatch(question).slice(-420);
    if (!signature) return;
    if (
      now - lastQuestionAtRef.current < DUPLICATE_QUESTION_WINDOW_MS
      && (signature === lastQuestionRef.current || similarSignature(signature, lastQuestionRef.current))
    ) return;

    lastQuestionRef.current = signature;
    lastQuestionAtRef.current = now;
    if (source === "audio") lastAudioQuestionAtRef.current = now;
    activeQuestionRef.current = question;
    setActiveQuestion(question);
    answerRef.current = "";
    setAnswer("");
    void requestAnswer(question);
  }, [requestAnswer]);

  const appendHeard = useCallback((text: string, language?: string) => {
    if (!text.trim()) return;
    considerQuestion(text, "audio");
    if (language) setAudioLanguage(language);
  }, [considerQuestion]);

  const transcribeWindow = useCallback((samples: Float32Array, sampleRate: number, generation: number) => {
    if (samples.length < sampleRate * 0.35) return;
    transcriptionQueueRef.current = transcriptionQueueRef.current
      .then(async () => {
        if (generation !== captureGenerationRef.current) return;
        const wav = floatToWav(samples, sampleRate);
        const result = await window.interviewAgent.transcribe(wav);
        if (generation === captureGenerationRef.current) appendHeard(result.text, result.language);
      })
      .catch(() => {
        if (generation === captureGenerationRef.current) {
          setSessionNotice("Local transcription stopped responding. Check the transcription service.");
        }
      });
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
      const answerWords = answerRef.current.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
      const answerPhrases: string[] = [];
      for (let index = 0; index + 4 <= answerWords.length; index += 2) {
        answerPhrases.push(answerWords.slice(index, index + 4).join(" "));
      }
      const questionWords = activeQuestionRef.current.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
      const questionPhrases: string[] = [];
      for (let index = 0; index + 4 <= questionWords.length; index += 2) {
        questionPhrases.push(questionWords.slice(index, index + 4).join(" "));
      }
      const visibleLines = data.text
        .split(/\r?\n/)
        .filter((line) => {
          const normalized = line.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim();
          const isAnswer = answerPhrases.some((phrase) => normalized.includes(phrase));
          const isActiveQuestion = questionPhrases.some((phrase) => normalized.includes(phrase));
          const isOverlayChrome = /interview copilot|suggested answer|audio listening|screen captured|screen text ready|reading screen|use as a guide|pause session|click-through|visible in screen capture|opacity|live transcription|shaping a concise answer|grounded suggestion|listening for the next question|refresh answer|your context|current question|\blive\b|\bpaused\b/i.test(line);
          return !isAnswer && !isActiveQuestion && !isOverlayChrome;
        });
      const text = visibleLines
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2400);
      if (text && normalizeForMatch(text) !== normalizeForMatch(screenTextRef.current)) {
        screenTextRef.current = text;
        setScreenText(text);
        considerQuestion(visibleLines.join("\n"), "screen");
      }
      setOcrProgress("Screen text ready");
    } catch {
      setOcrProgress("Screen text unavailable");
    } finally {
      ocrBusyRef.current = false;
    }
  }, [considerQuestion]);

  const startCapture = useCallback(async () => {
    if (!selectedSource) throw new Error("Choose a screen or window first.");
    setSessionNotice("");
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    void audioContext.resume().catch(() => setSessionNotice("Audio processing could not start. Check audio permissions; screen text capture remains available."));
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 10 } },
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

    if (audioContext.state === "suspended") {
      await audioContext.resume().catch(() => setSessionNotice("Audio processing could not start. Check audio permissions; screen text capture remains available."));
    }
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
    preRollChunksRef.current = [];
    preRollSamplesRef.current = 0;
    speechChunksRef.current = [];
    speechSamplesRef.current = 0;
    speechActiveRef.current = false;
    const captureGeneration = ++captureGenerationRef.current;
    activeCaptureRef.current = true;
    audioSignalRef.current = false;
    lastAudioSignalAtRef.current = 0;
    setAudioSignal(false);

    processor.onaudioprocess = (event) => {
      if (!activeCaptureRef.current) return;
      const incoming = new Float32Array(event.inputBuffer.getChannelData(0));
      let energy = 0;
      for (let index = 0; index < incoming.length; index += 4) energy += incoming[index] * incoming[index];
      const rms = Math.sqrt(energy / Math.max(1, Math.ceil(incoming.length / 4)));
      const now = Date.now();
      if (rms > SPEECH_RMS_THRESHOLD) {
        lastAudioSignalAtRef.current = now;
        if (!audioSignalRef.current) {
          audioSignalRef.current = true;
          setAudioSignal(true);
        }
      } else if (audioSignalRef.current && now - lastAudioSignalAtRef.current > 1500) {
        audioSignalRef.current = false;
        setAudioSignal(false);
      }

      if (!speechActiveRef.current) {
        preRollChunksRef.current.push(incoming);
        preRollSamplesRef.current += incoming.length;
        const maxPreRollSamples = Math.floor(audioContext.sampleRate * SPEECH_PREROLL_SECONDS);
        let excessSamples = preRollSamplesRef.current - maxPreRollSamples;
        while (excessSamples > 0 && preRollChunksRef.current.length) {
          const first = preRollChunksRef.current[0];
          if (first.length <= excessSamples) {
            preRollChunksRef.current.shift();
            preRollSamplesRef.current -= first.length;
            excessSamples -= first.length;
          } else {
            preRollChunksRef.current[0] = first.slice(excessSamples);
            preRollSamplesRef.current -= excessSamples;
            excessSamples = 0;
          }
        }

        if (rms > SPEECH_RMS_THRESHOLD) {
          speechActiveRef.current = true;
          speechChunksRef.current = preRollChunksRef.current;
          speechSamplesRef.current = preRollSamplesRef.current;
          preRollChunksRef.current = [];
          preRollSamplesRef.current = 0;
          lastAudioSignalAtRef.current = now;
        }
        return;
      }

      speechChunksRef.current.push(incoming);
      speechSamplesRef.current += incoming.length;
      const silenceEnded = rms <= SPEECH_RMS_THRESHOLD
        && now - lastAudioSignalAtRef.current >= SPEECH_END_SILENCE_MS;
      const maxUtteranceReached = speechSamplesRef.current >= audioContext.sampleRate * MAX_UTTERANCE_SECONDS;
      if (silenceEnded || maxUtteranceReached) {
        const utterance = takeSamples(speechChunksRef.current, speechSamplesRef.current);
        speechChunksRef.current = [];
        speechSamplesRef.current = 0;
        speechActiveRef.current = false;
        preRollChunksRef.current = [];
        preRollSamplesRef.current = 0;
        transcribeWindow(utterance, audioContext.sampleRate, captureGeneration);
      }
    };

    try {
      await startScreenReader();
    } catch {
      setOcrProgress("Offline screen reader files are missing. Run setup-interview-agent.ps1 again.");
    }
    if (ocrTimerRef.current !== null) window.clearInterval(ocrTimerRef.current);
    ocrTimerRef.current = window.setInterval(() => { void inspectScreen(); }, 1500);
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
    captureGenerationRef.current += 1;
    transcriptionQueueRef.current = Promise.resolve();
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
    preRollChunksRef.current = [];
    preRollSamplesRef.current = 0;
    speechChunksRef.current = [];
    speechSamplesRef.current = 0;
    speechActiveRef.current = false;
    audioSignalRef.current = false;
    lastAudioSignalAtRef.current = 0;
    setAudioSignal(false);
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
      await stopCapture();
      setSessionNotice(error instanceof Error ? error.message : "Could not resume capture.");
    }
  }, [startCapture, stopCapture]);

  const endSession = useCallback(async () => {
    await stopCapture();
    answerRequestIdRef.current += 1;
    pendingAnswerRef.current = null;
    setSessionState("prepare");
    setScreenText("");
    screenTextRef.current = "";
    setActiveQuestion("");
    activeQuestionRef.current = "";
    setAnswer("");
    answerRef.current = "";
    setAudioAvailable(false);
    setSessionNotice("");
    lastQuestionRef.current = "";
    lastQuestionAtRef.current = 0;
    lastAudioQuestionAtRef.current = 0;
    await window.interviewAgent.returnToPrepare();
  }, [stopCapture]);

  useEffect(() => () => {
    activeCaptureRef.current = false;
    answerRequestIdRef.current += 1;
    pendingAnswerRef.current = null;
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
    const overlayStyle = { "--overlay-alpha": String(overlayOpacity / 100) } as CSSProperties;
    return (
      <main className="window-frame overlay-frame" style={overlayStyle}>
        <header className="titlebar titlebar-dark">
          <div className="brand brand-light"><span className="brand-mark"><Sparkles size={13} /></span><span>Interview Copilot</span></div>
          <div className="window-actions">
            <label className="opacity-control" title="Overlay opacity">
              <span>Opacity</span>
              <input
                aria-label="Overlay opacity"
                type="range"
                min="65"
                max="100"
                value={overlayOpacity}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setOverlayOpacity(next);
                  localStorage.setItem(OPACITY_KEY, String(next));
                }}
              />
            </label>
            <button
              className={`window-icon light ${clickThrough ? "active" : ""}`}
              onClick={() => void window.interviewAgent.setClickThrough(!clickThrough).then(setClickThrough)}
              aria-label={clickThrough ? "Turn click-through off" : "Turn click-through on"}
              aria-pressed={clickThrough}
              title={clickThrough ? `Click-through on · ${clickThroughShortcut} to restore pointer input` : `Click-through · ${clickThroughShortcut} toggles it`}
            ><MousePointer2 size={14} /></button>
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
            <span className="capture-state"><Headphones size={14} /> {sessionState === "live" ? (audioAvailable ? (audioSignal ? "Audio signal detected" : "Audio listening") : "Audio unavailable") : "Audio paused"}</span>
          </div>

          <section className="overlay-section heard-section">
            <div className="section-heading"><span>Current question</span><span className="subtle-heading">{audioLanguage || (sessionState === "live" ? "Listening" : "Session paused")}</span></div>
            <p className={`transcript-text ${activeQuestion ? "" : "empty-copy"}`}>
              {activeQuestion || (sessionState === "live" ? "Listening for a complete question…" : "Resume when you're ready to continue.")}
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
          {clickThrough && <p className="overlay-notice">Click-through is temporary (20s) · press {clickThroughShortcut} to restore pointer input.</p>}

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
                <button className="button button-primary overlay-primary" onClick={() => void requestAnswer(activeQuestionRef.current)} disabled={answerBusy || !activeQuestion}>
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
          <p className="overlay-visibility-note">This overlay remains visible in screen capture.</p>
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
            <span className="field-label">Job description (optional)</span>
            <div className="textarea-wrap" onDragOver={(event) => event.preventDefault()} onDrop={onFileDrop("jobDescription")}>
              <textarea value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} placeholder="Add a role description to tailor suggestions, if available." />
              <label className="file-add" title="Add job description file">
                <input type="file" accept=".txt,.md,.pdf,.docx" onChange={onFileInput("jobDescription")} />
                <FolderOpen size={15} /><span>Add file</span>
              </label>
            </div>
            <span className="field-hint">{jobDescription ? `${jobDescription.length.toLocaleString()} characters` : "Optional · TXT, MD, PDF, DOCX"}</span>
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
              disabled={!resume.trim() || !selectedSource || !services.model || !services.transcription}
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
