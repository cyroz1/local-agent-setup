/// <reference types="vite/client" />

interface Window {
  interviewAgent: {
    listSources(): Promise<Array<{ id: string; name: string; thumbnail: string }>>;
    selectSource(sourceId: string): Promise<boolean>;
    enterOverlay(): Promise<void>;
    returnToPrepare(): Promise<void>;
    setClickThrough(enabled: boolean): Promise<boolean>;
    onClickThroughChanged(callback: (enabled: boolean) => void): () => void;
    minimize(): Promise<void>;
    close(): Promise<void>;
    checkServices(): Promise<{ model: boolean; transcription: boolean }>;
    transcribe(wavBytes: ArrayBuffer): Promise<{ text: string; language?: string }>;
    suggestAnswer(payload: {
      resume: string;
      jobDescription: string;
      question: string;
    }): Promise<string>;
  };
}
