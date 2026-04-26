import type { LiveRecordingSettings, ProviderName, ProviderSettings } from "@/shared/types";

export const defaultLiveRecordingSettings: LiveRecordingSettings = {
  autoGainControl: false,
  echoCancellation: false,
  noiseSuppression: false,
  recordingGain: 2,
  standbyEnabled: true,
};

export const providerDefaults: Record<
  ProviderName,
  { apiUrl: string; model: string; liveModel: string; imageModel: string }
> = {
  openai: {
    apiUrl: "https://api.openai.com",
    model: "gpt-4.1-mini",
    liveModel: "",
    imageModel: "",
  },
  gemini: {
    apiUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-flash-latest",
    liveModel: "gemini-3.1-flash-live-preview",
    imageModel: "gemini-3.1-flash-image-preview",
  },
};

export function createDefaultSettings(): ProviderSettings {
  return {
    provider: "gemini",
    apiUrl: providerDefaults.gemini.apiUrl,
    apiKey: "",
    model: providerDefaults.gemini.model,
    liveApiKey: "",
    liveModel: providerDefaults.gemini.liveModel,
    imageApiKey: "",
    imageModel: providerDefaults.gemini.imageModel,
    liveRecording: { ...defaultLiveRecordingSettings },
  };
}
