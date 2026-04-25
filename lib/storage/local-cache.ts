import type { DocumentRecord, LiveRecordingSettings } from "@/shared/types";
import { normalizeStoredMarkdown } from "@/lib/editor/markdown";
import { defaultLiveRecordingSettings } from "@/lib/providers/defaults";

const CACHE_KEY = "nody.active-document";
const RECENT_DOCUMENT_IDS_KEY = "nody.recent-documents";
const AI_PANEL_HEIGHT_KEY = "nody.ai-panel-height";
const PREFERRED_MICROPHONE_DEVICE_ID_KEY = "nody.preferred-microphone-device-id";
const PREFERRED_LIVE_CAMERA_DEVICE_ID_KEY = "nody.preferred-live-camera-device-id";
const LIVE_RECORDING_SETTINGS_KEY = "nody.live-recording-settings";

export function loadCachedDocument() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DocumentRecord & { bodyHtml?: string };
    return {
      ...parsed,
      bodyMarkdown: normalizeStoredMarkdown(parsed.bodyMarkdown ?? parsed.bodyHtml ?? ""),
    } satisfies DocumentRecord;
  } catch {
    return null;
  }
}

export function saveCachedDocument(document: DocumentRecord) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CACHE_KEY, JSON.stringify(document));
}

export function loadRecentDocumentIds() {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(RECENT_DOCUMENT_IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function saveRecentDocumentIds(ids: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(RECENT_DOCUMENT_IDS_KEY, JSON.stringify(ids));
}

export function loadAiPanelHeight() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(AI_PANEL_HEIGHT_KEY);
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function saveAiPanelHeight(height: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AI_PANEL_HEIGHT_KEY, String(height));
}

export function loadPreferredMicrophoneDeviceId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(PREFERRED_MICROPHONE_DEVICE_ID_KEY);
}

export function savePreferredMicrophoneDeviceId(deviceId: string | null) {
  if (typeof window === "undefined") return;
  if (deviceId) {
    window.localStorage.setItem(PREFERRED_MICROPHONE_DEVICE_ID_KEY, deviceId);
    return;
  }
  window.localStorage.removeItem(PREFERRED_MICROPHONE_DEVICE_ID_KEY);
}

export function loadPreferredLiveCameraDeviceId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(PREFERRED_LIVE_CAMERA_DEVICE_ID_KEY);
}

export function savePreferredLiveCameraDeviceId(deviceId: string | null) {
  if (typeof window === "undefined") return;
  if (deviceId) {
    window.localStorage.setItem(PREFERRED_LIVE_CAMERA_DEVICE_ID_KEY, deviceId);
    return;
  }
  window.localStorage.removeItem(PREFERRED_LIVE_CAMERA_DEVICE_ID_KEY);
}

export function loadLiveRecordingSettings(): LiveRecordingSettings {
  if (typeof window === "undefined") return { ...defaultLiveRecordingSettings };
  const raw = window.localStorage.getItem(LIVE_RECORDING_SETTINGS_KEY);
  if (!raw) return { ...defaultLiveRecordingSettings };
  try {
    const parsed = JSON.parse(raw) as Partial<LiveRecordingSettings>;
    const recordingGain = Number(parsed.recordingGain);
    return {
      ...defaultLiveRecordingSettings,
      ...parsed,
      recordingGain: [1, 2, 3, 4].includes(recordingGain) ? recordingGain : defaultLiveRecordingSettings.recordingGain,
    };
  } catch {
    return { ...defaultLiveRecordingSettings };
  }
}

export function saveLiveRecordingSettings(settings: LiveRecordingSettings) {
  if (typeof window === "undefined") return;
  const recordingGain = Number(settings.recordingGain);
  window.localStorage.setItem(
    LIVE_RECORDING_SETTINGS_KEY,
    JSON.stringify({
      ...defaultLiveRecordingSettings,
      ...settings,
      recordingGain: [1, 2, 3, 4].includes(recordingGain) ? recordingGain : defaultLiveRecordingSettings.recordingGain,
    }),
  );
}
