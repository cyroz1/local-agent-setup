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
    checkServices(): Promise<{
      model: boolean;
      transcription: boolean;
      speakerRecognition: boolean;
      voiceProfile: boolean;
    }>;
    transcribe(wavBytes: ArrayBuffer, identifySpeaker?: boolean): Promise<{
      text: string;
      language?: string;
      speaker?: "you" | "interviewer" | "unknown";
      speakerSimilarity?: number | null;
    }>;
    enrollVoice(wavBytes: ArrayBuffer): Promise<{ status: string; voiceProfile: boolean }>;
    clearVoiceProfile(): Promise<{ status: string; voiceProfile: boolean }>;
    suggestAnswer(payload: {
      resume: string;
      jobDescription: string;
      question: string;
      requestId?: number;
    }): Promise<string>;
    onAnswerChunk(callback: (payload: { requestId?: number; text: string }) => void): () => void;
  };
}
