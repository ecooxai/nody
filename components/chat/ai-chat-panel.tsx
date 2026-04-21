"use client";

import { type DragEvent, type TouchEvent, type WheelEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  LiveTalkPanel,
  type LiveHistoryControls,
  type LiveHistoryImage,
  type LiveHistoryTargets,
  type LiveSendAttachment,
  type LiveSendHandle,
  type LiveVideoControls,
  type LiveVideoShareState,
  type LiveVideoSource,
} from "@/components/chat/live-talk-panel";
import { Panel } from "@/components/ui/panel";
import {
  loadPreferredLiveCameraDeviceId,
  loadPreferredMicrophoneDeviceId,
  savePreferredLiveCameraDeviceId,
  savePreferredMicrophoneDeviceId,
} from "@/lib/storage/local-cache";
import type { ProviderSettings } from "@/shared/types";
import type {
  AIMessage,
  AIMessageAttachment,
  AIMessagePrompt,
  AIRequestMode,
  AIRequestAttachment,
  AIMediaKind,
  AINoteReference,
  FolderAsset,
  PromptTemplate,
  ProviderName,
  TextSubstitution,
} from "@/shared/types";

type LocalAttachment = {
  id: string;
  kind: AIMediaKind;
  fileName: string;
  mimeType: string;
  source: "upload" | "folder";
  previewUrl: string;
  file?: File;
  assetUrl?: string;
};

type PreviewAttachment = {
  fileName: string;
  kind: AIMediaKind;
  mimeType: string;
  previewUrl: string;
};

type ExternalAttachmentSeed = {
  id: string;
  kind: AIMediaKind;
  fileName: string;
  mimeType: string;
  assetUrl: string;
  previewUrl: string;
};

type TopbarGeneratedImage = {
  id: string;
  fileName: string;
  url: string;
};

type LiveSessionState = {
  connecting: boolean;
  ready: boolean;
  status: string;
};

type MicrophoneSource = {
  deviceId: string;
  label: string;
};

const LOCAL_AUDIO_INPUT_LABEL_PATTERN = /\b(stereo mix|what u hear|loopback|monitor of|blackhole|soundflower|vb-audio|voicemeeter|cable output|system audio|desktop audio)\b/i;
const AUDIO_RECORDING_BITS_PER_SECOND = 128_000;
const AUDIO_RECORDING_INPUT_GAIN = 2.5;

function isLocalSystemAudioInput(label?: string | null) {
  return Boolean(label && LOCAL_AUDIO_INPUT_LABEL_PATTERN.test(label));
}

function isAndroidChrome() {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent;
  return /Android/i.test(userAgent) && /Chrome|Chromium|CriOS/i.test(userAgent) && !/EdgA|Firefox|OPR/i.test(userAgent);
}

function buildSpeechMicAudioConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 1 },
  };
}

const builtInPrompts: PromptTemplate[] = [
  {
    id: "builtin-translate-en",
    name: "Translate",
    content: "Translate the selected text or attached content into natural English. Preserve meaning, tone, and formatting when possible.",
    createdAt: "builtin",
    updatedAt: "builtin",
    builtin: true,
  },
  {
    id: "builtin-correct-writing",
    name: "Correct",
    content: "Correct grammar, spelling, punctuation, and awkward phrasing. Keep the original meaning and voice. Suggest minimal edits when possible.",
    createdAt: "builtin",
    updatedAt: "builtin",
    builtin: true,
  },
  {
    id: "builtin-transcript-srt",
    name: "Transcript",
    content: "Transcribe any attached audio or video. Return a clean transcript and an SRT subtitle file. If speaker turns are clear, separate them cleanly.",
    createdAt: "builtin",
    updatedAt: "builtin",
    builtin: true,
  },
];

const COMPACT_PANEL_HEIGHT = 200;
const SCROLL_EDGE_TOLERANCE = 1;

function canScrollVertically(element: HTMLElement) {
  if (element.scrollHeight <= element.clientHeight + SCROLL_EDGE_TOLERANCE) return false;
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function findVerticalScrollContainer(target: EventTarget | null, boundary: HTMLElement) {
  if (!(target instanceof Node)) return null;

  let current: Node | null = target;
  while (current && boundary.contains(current)) {
    if (current instanceof HTMLElement && canScrollVertically(current)) {
      return current;
    }
    if (current === boundary) break;
    current = current.parentNode;
  }

  return null;
}

function canConsumeVerticalDelta(element: HTMLElement, deltaY: number) {
  if (deltaY < 0) return Math.abs(deltaY) <= element.scrollTop + SCROLL_EDGE_TOLERANCE;
  if (deltaY > 0) {
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    return deltaY <= maxScrollTop - element.scrollTop + SCROLL_EDGE_TOLERANCE;
  }
  return true;
}

function normalizeWheelDeltaY(event: WheelEvent<HTMLElement>) {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function inferMediaKind(mimeType: string): AIMediaKind | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

function inferMediaKindFromFile(file: File): AIMediaKind | null {
  const kind = inferMediaKind(file.type);
  if (kind) return kind;

  const extension = file.name.toLowerCase().split(".").pop();
  if (!extension) return null;
  if (["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"].includes(extension)) return "image";
  if (["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"].includes(extension)) return "audio";
  if (["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"].includes(extension)) return "video";
  return null;
}

function fallbackMimeType(file: File, kind: AIMediaKind) {
  if (file.type) return file.type;

  const extension = file.name.toLowerCase().split(".").pop();
  if (kind === "image") {
    if (extension === "png") return "image/png";
    if (extension === "webp") return "image/webp";
    if (extension === "gif") return "image/gif";
    if (extension === "svg") return "image/svg+xml";
    if (extension === "avif") return "image/avif";
    return "image/jpeg";
  }
  if (kind === "audio") {
    if (extension === "wav") return "audio/wav";
    if (extension === "mp3") return "audio/mpeg";
    if (extension === "m4a") return "audio/mp4";
    if (extension === "ogg" || extension === "oga" || extension === "opus") return "audio/ogg";
    if (extension === "flac") return "audio/flac";
    return "audio/webm";
  }
  if (extension === "mp4" || extension === "m4v") return "video/mp4";
  if (extension === "mov") return "video/quicktime";
  if (extension === "ogv") return "video/ogg";
  return "video/webm";
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64] = result.split(",", 2);
      if (!base64) {
        reject(new Error(`Failed to encode ${file.name}.`));
        return;
      }
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

function revokeAttachmentPreview(attachment: LocalAttachment) {
  if (attachment.source === "upload" && attachment.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

function attachmentBadge(kind: AIMediaKind) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function dragEventHasFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function describeLiveAttachment(attachment: LocalAttachment) {
  return `${attachment.fileName} (${attachment.kind})`;
}

function shouldUseImageGeneration(prompt: string, templates: PromptTemplate[], attachments: LocalAttachment[]) {
  const combined = composePromptTextForModeDetection(prompt, templates).toLowerCase();
  if (!combined.trim()) return false;

  const imageIntentPattern =
    /\b(generate|create|make|draw|design|illustrate|render|paint|mock up|concept art|poster|logo|wallpaper|cover art|thumbnail)\b/;
  const imageEditPattern =
    /\b(edit|restyle|transform|change|replace|remove|add|extend|recolor|retouch|cleanup)\b/;
  const hasImageAttachment = attachments.some((attachment) => attachment.kind === "image");

  if (hasImageAttachment && imageEditPattern.test(combined)) {
    return true;
  }

  return imageIntentPattern.test(combined) && /\b(image|picture|photo|illustration|art|icon|logo|poster|wallpaper|scene|portrait|background)\b/.test(combined);
}

function composePromptTextForModeDetection(messagePrompt: string, templates: PromptTemplate[]) {
  return [messagePrompt.trim(), ...templates.map((template) => template.content.trim())].filter(Boolean).join("\n");
}

function formatSelectedTextContext(selection: string) {
  return `user selected:${selection.trim()}\nendselected\n\n`;
}

function buildReadAloudPrompt(text: string) {
  return [
    "Read the following selected note text aloud exactly as written.",
    "Do not summarize, translate, explain, or add commentary.",
    "Only speak the selected text.",
    "",
    text.trim(),
  ].join("\n");
}

function getPreferredRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const opusCandidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
  ];
  const mp4Candidates = [
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/x-m4a",
  ];
  const candidates = [
    ...(isAndroidChrome() ? opusCandidates : mp4Candidates),
    ...(isAndroidChrome() ? mp4Candidates : opusCandidates),
    "audio/wav",
  ];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return null;
}

function recordingExtensionForMimeType(mimeType: string) {
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

function getPreferredVideoMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return null;
}

function videoExtensionForMimeType(mimeType: string) {
  if (mimeType.includes("mp4")) return "mp4";
  return "webm";
}

async function waitForPaintedVideoFrame(video: HTMLVideoElement) {
  await waitForFrameTicks(2);

  if ("requestVideoFrameCallback" in video) {
    await new Promise<void>((resolve) => {
      const nextVideo = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      };
      nextVideo.requestVideoFrameCallback?.(() => resolve());
    });
    return;
  }

  await waitForFrameTicks(2);
}

function waitForFrameTicks(count: number) {
  return new Promise<void>((resolve) => {
    const step = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => step(remaining - 1));
    };

    step(count);
  });
}

function clampPanelHeight(height: number) {
  if (typeof window === "undefined") {
    return Math.min(Math.max(height, 320), 720);
  }

  const viewportLimitedMax = Math.max(window.innerHeight - 32, 320);
  return Math.min(Math.max(height, 320), viewportLimitedMax);
}

async function listMicrophoneSources() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [] as MicrophoneSource[];
  }

  let devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === "audioinput" && !isLocalSystemAudioInput(device.label));
  if (microphones.some((device) => device.label)) {
    return microphones.map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }));
  }

  let probeStream: MediaStream | null = null;
  try {
    if (navigator.mediaDevices.getUserMedia) {
      probeStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      devices = await navigator.mediaDevices.enumerateDevices();
    }
  } catch {
    return microphones.map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }));
  } finally {
    probeStream?.getTracks().forEach((track) => track.stop());
  }

  return devices
    .filter((device) => device.kind === "audioinput" && !isLocalSystemAudioInput(device.label))
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }));
}

export function AIChatPanel({
  messages,
  busy,
  currentFolderFiles,
  currentFolderName,
  onAsk,
  onApply,
  onAddAttachmentToNote,
  onCreatePrompt,
  onUpdatePrompt,
  onError,
  pendingExternalAttachment,
  onPendingExternalAttachmentHandled,
  prompts,
  provider,
  providerSettings,
  currentNoteBodyMarkdown,
  currentNoteId,
  currentNoteTitle,
  noteCatalog,
  selectedText,
  storedPanelHeight,
  compact,
  onAppendToCurrentNote,
  onInsertGeneratedImageInNote,
  onOpenNote,
  onFindInNote,
  onScrollNote,
  onPanelHeightChange,
  onUploadImageToCurrentFolder,
}: {
  messages: AIMessage[];
  busy: boolean;
  currentFolderFiles: FolderAsset[];
  currentFolderName: string;
  onAsk: (payload: {
    prompt: string;
    attachments: AIRequestAttachment[];
    messageAttachments: AIMessageAttachment[];
    prompts: AIMessagePrompt[];
    mode: AIRequestMode;
    displayPrompt?: string;
  }) => Promise<boolean>;
  onApply: (edits: TextSubstitution[]) => void;
  onAddAttachmentToNote: (attachment: AIMessageAttachment, options?: { lineNumber?: number }) => void;
  onAppendToCurrentNote: (markdown: string) => void;
  onCreatePrompt: (value: Pick<PromptTemplate, "name" | "content">) => Promise<PromptTemplate>;
  onUpdatePrompt: (id: string, value: Pick<PromptTemplate, "name" | "content">) => Promise<PromptTemplate>;
  onError: (message: string) => void;
  pendingExternalAttachment?: ExternalAttachmentSeed | null;
  onPendingExternalAttachmentHandled?: () => void;
  prompts: PromptTemplate[];
  provider: ProviderName;
  providerSettings: ProviderSettings;
  currentNoteBodyMarkdown: string;
  currentNoteId: string;
  currentNoteTitle: string;
  noteCatalog: AINoteReference[];
  selectedText?: string;
  storedPanelHeight?: number | null;
  compact?: boolean;
  onInsertGeneratedImageInNote: (attachment: { fileName: string; mimeType: string; previewUrl: string }, lineNumber?: number) => Promise<boolean>;
  onOpenNote: (target: { noteId?: string; title?: string }) => boolean;
  onFindInNote: (target: { query: string; occurrence?: "first" | "next" | "previous" }) => boolean;
  onScrollNote: (target: { target: "top" | "middle" | "bottom" | "line" | "up" | "down"; lineNumber?: number; pixels?: number }) => boolean;
  onPanelHeightChange?: (height: number) => void;
  onUploadImageToCurrentFolder: (attachment: { fileName: string; mimeType: string; previewUrl: string }) => Promise<unknown>;
}) {
  const supportsMedia = provider === "gemini";
  const supportsLive = provider === "gemini" && Boolean(providerSettings.apiKey) && Boolean(providerSettings.liveModel || providerSettings.model);
  const availablePrompts = [...builtInPrompts, ...prompts];
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<PreviewAttachment | null>(null);
  const [previewPrompt, setPreviewPrompt] = useState<AIMessagePrompt | null>(null);
  const [prompt, setPrompt] = useState("");
  const [fileDropActive, setFileDropActive] = useState(false);
  const [composerCondensed, setComposerCondensed] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [cameraPreviewVisible, setCameraPreviewVisible] = useState(false);
  const [panelHeight, setPanelHeight] = useState(() => clampPanelHeight(storedPanelHeight ?? 640));
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [selectedPrompts, setSelectedPrompts] = useState<PromptTemplate[]>([]);
  const [promptCreateOpen, setPromptCreateOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [promptNameDraft, setPromptNameDraft] = useState("");
  const [promptContentDraft, setPromptContentDraft] = useState("");
  const [creatingPrompt, setCreatingPrompt] = useState(false);
  const [readingSelection, setReadingSelection] = useState(false);
  const [recording, setRecording] = useState(false);
  const [preparingRecording, setPreparingRecording] = useState(false);
  const [cameraPreparing, setCameraPreparing] = useState(false);
  const [cameraRecording, setCameraRecording] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "live">(() => (supportsLive ? "live" : "chat"));
  const [liveConnectionRequested, setLiveConnectionRequested] = useState(() => supportsLive);
  const [liveSessionState, setLiveSessionState] = useState<LiveSessionState>({
    connecting: false,
    ready: false,
    status: "Open the Live tab to start a session.",
  });
  const [liveSendHandle, setLiveSendHandle] = useState<LiveSendHandle | null>(null);
  const [liveVideoControls, setLiveVideoControls] = useState<LiveVideoControls | null>(null);
  const [liveHistoryControls, setLiveHistoryControls] = useState<LiveHistoryControls | null>(null);
  const [imageGenerationActive, setImageGenerationActive] = useState(false);
  const [chatLatestMessageAvailable, setChatLatestMessageAvailable] = useState(false);
  const [liveLatestMessageAvailable, setLiveLatestMessageAvailable] = useState(false);
  const [latestMessageShortcutFlashing, setLatestMessageShortcutFlashing] = useState(false);
  const [generatedImageTrayOpen, setGeneratedImageTrayOpen] = useState(false);
  const [liveVideoSources, setLiveVideoSources] = useState<LiveVideoSource[]>([]);
  const [liveVideoMenuOpen, setLiveVideoMenuOpen] = useState(false);
  const [liveVideoMenuLoading, setLiveVideoMenuLoading] = useState(false);
  const [liveVideoShareMode, setLiveVideoShareMode] = useState<LiveVideoShareState["mode"]>(null);
  const [liveVideoShareCameraMode, setLiveVideoShareCameraMode] = useState<LiveVideoShareState["cameraMode"]>(null);
  const [liveCameraFlashOn, setLiveCameraFlashOn] = useState(true);
  const [liveHistoryTargets, setLiveHistoryTargets] = useState<LiveHistoryTargets>({
    hasCamera: false,
    hasGeneratedImage: false,
    generatedImages: [],
  });
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [composerChromeHeight, setComposerChromeHeight] = useState(0);
  const [liveMicrophoneEnabled, setLiveMicrophoneEnabled] = useState(true);
  const [microphoneSources, setMicrophoneSources] = useState<MicrophoneSource[]>([]);
  const [microphoneMenuOpen, setMicrophoneMenuOpen] = useState(false);
  const [microphoneMenuLoading, setMicrophoneMenuLoading] = useState(false);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState<string | null>(() => loadPreferredMicrophoneDeviceId());
  const [preferredLiveCameraDeviceId, setPreferredLiveCameraDeviceId] = useState<string | null>(() => loadPreferredLiveCameraDeviceId());
  const attachmentsRef = useRef<LocalAttachment[]>([]);
  const fileDropDepthRef = useRef(0);
  const composerItemsRef = useRef<HTMLDivElement>(null);
  const composerChromeRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastAiPanelTouchYRef = useRef<number | null>(null);
  const latestAssistantMessageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingAmplifiedStreamRef = useRef<MediaStream | null>(null);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingAudioGainRef = useRef<GainNode | null>(null);
  const recordingAudioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingTargetRef = useRef<"chat" | "live">("chat");
  const recordHoldActiveRef = useRef(false);
  const microphoneLongPressTimerRef = useRef<number | null>(null);
  const microphoneLongPressTriggeredRef = useRef(false);
  const autoReadSelectionTimerRef = useRef<number | null>(null);
  const lastAutoReadSelectionKeyRef = useRef<string | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraRecorderRef = useRef<MediaRecorder | null>(null);
  const cameraChunksRef = useRef<Blob[]>([]);
  const cameraHoldActiveRef = useRef(false);
  const cameraLongPressTimerRef = useRef<number | null>(null);
  const cameraLongPressTriggeredRef = useRef(false);
  const cameraCaptureHandledRef = useRef(false);
  const pendingComposerScrollRef = useRef(false);
  const latestMessageFlashTimerRef = useRef<number | null>(null);
  const generatedImageTrayRef = useRef<HTMLDivElement>(null);
  const latestGeneratedImageIdRef = useRef<string | null>(null);
  const generatedImageWatcherReadyRef = useRef(false);
  const microphoneMenuRef = useRef<HTMLDivElement>(null);
  const liveVideoMenuRef = useRef<HTMLDivElement>(null);
  const resizePointerIdRef = useRef<number | null>(null);
  const resizeStartYRef = useRef(0);
  const resizeStartHeightRef = useRef(460);
  const latestAssistantMessageId = [...messages].reverse().find((message) => message.role === "assistant")?.id ?? null;
  const previousLatestAssistantMessageIdRef = useRef<string | null>(null);
  const latestChatMessageRole = messages[messages.length - 1]?.role ?? null;
  let latestChatGeneratedImageId: string | null = null;
  let latestChatCameraAttachmentId: string | null = null;
  for (let index = messages.length - 1; index >= 0 && (!latestChatGeneratedImageId || !latestChatCameraAttachmentId); index -= 1) {
    const message = messages[index];
    const attachmentsReversed = [...(message.attachments ?? [])].reverse();
    if (!latestChatGeneratedImageId && message.role === "assistant") {
      latestChatGeneratedImageId =
        attachmentsReversed.find((attachment) => attachment.kind === "image" && Boolean(attachment.url))?.id ?? null;
    }
    if (!latestChatCameraAttachmentId && message.role === "user") {
      latestChatCameraAttachmentId =
        attachmentsReversed.find(
          (attachment) =>
            Boolean(attachment.url) &&
            (attachment.fileName.startsWith("photo-") || attachment.fileName.startsWith("video-")),
        )?.id ?? null;
    }
  }
  const chatGeneratedImages: TopbarGeneratedImage[] = messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.attachments ?? [])
          .filter((attachment) => attachment.kind === "image" && Boolean(attachment.url))
          .map((attachment) => ({
            id: attachment.id,
            fileName: attachment.fileName,
            url: attachment.url ?? "",
          }))
      : [],
  );
  const activeGeneratedImages: TopbarGeneratedImage[] =
    activeTab === "live" ? liveHistoryTargets.generatedImages.map(({ id, fileName, url }: LiveHistoryImage) => ({ id, fileName, url })) : chatGeneratedImages;
  const latestGeneratedImage = activeGeneratedImages[activeGeneratedImages.length - 1] ?? null;
  const displayedPanelHeight = compact ? COMPACT_PANEL_HEIGHT : panelHeight;
  const compactComposerChrome = historyExpanded;
  const composerChromeScale = compactComposerChrome ? 0.5 : 1;
  const composerChromeFrameHeight = composerChromeHeight ? composerChromeHeight * composerChromeScale : undefined;
  const liveConnectButtonActive = activeTab === "live" && supportsLive && liveConnectionRequested;
  const liveConnectButtonReady = liveConnectButtonActive && liveSessionState.ready;
  const showLatestMessageShortcut = activeTab === "live" ? liveLatestMessageAvailable : chatLatestMessageAvailable;
  const showGeneratedImageShortcut =
    imageGenerationActive || (activeTab === "live" ? liveHistoryTargets.hasGeneratedImage : Boolean(latestChatGeneratedImageId));
  const showCameraShortcut =
    activeTab === "live"
      ? liveHistoryTargets.hasCamera
      : cameraPreviewVisible || cameraPreparing || cameraRecording || Boolean(latestChatCameraAttachmentId);
  const liveCameraShortcutFlashing = activeTab === "live" && liveVideoShareMode === "camera" && liveHistoryTargets.hasCamera;
  const selectedTextForReadAloud = selectedText?.trim() ?? "";
  const liveDisconnected = activeTab === "live" && !liveSessionState.ready;
  const composerMenuOpen = microphoneMenuOpen || liveVideoMenuOpen;

  const triggerLatestMessageShortcutFlash = useCallback(() => {
    if (typeof window === "undefined") return;
    if (latestMessageFlashTimerRef.current) {
      window.clearTimeout(latestMessageFlashTimerRef.current);
    }
    setLatestMessageShortcutFlashing(true);
    latestMessageFlashTimerRef.current = window.setTimeout(() => {
      latestMessageFlashTimerRef.current = null;
      setLatestMessageShortcutFlashing(false);
    }, 2600);
  }, []);

  useEffect(() => {
    if (provider !== "gemini" && activeTab === "live") {
      setActiveTab("chat");
    }
  }, [activeTab, provider]);

  useEffect(() => {
    if (activeTab !== "live") {
      setLiveVideoMenuOpen(false);
    }
  }, [activeTab]);

  useEffect(() => {
    savePreferredMicrophoneDeviceId(selectedMicrophoneId);
  }, [selectedMicrophoneId]);

  useEffect(() => {
    savePreferredLiveCameraDeviceId(preferredLiveCameraDeviceId);
  }, [preferredLiveCameraDeviceId]);

  useEffect(() => {
    if (!liveCameraShortcutFlashing) {
      setLiveCameraFlashOn(true);
      return;
    }
    const intervalId = window.setInterval(() => {
      setLiveCameraFlashOn((current) => !current);
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [liveCameraShortcutFlashing]);

  useEffect(() => {
    const element = composerChromeRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const updateLiveComposerHeight = () => {
      setComposerChromeHeight(element.scrollHeight);
    };
    updateLiveComposerHeight();

    const observer = new ResizeObserver(updateLiveComposerHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeTab, provider]);

  useEffect(() => {
    if (!liveVideoMenuOpen && !microphoneMenuOpen && !generatedImageTrayOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (generatedImageTrayRef.current?.contains(target)) return;
      if (liveVideoMenuRef.current?.contains(target)) return;
      if (microphoneMenuRef.current?.contains(target)) return;
      setGeneratedImageTrayOpen(false);
      setLiveVideoMenuOpen(false);
      setMicrophoneMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [generatedImageTrayOpen, liveVideoMenuOpen, microphoneMenuOpen]);

  const focusHistory = useCallback(() => {
    setHistoryExpanded(true);
    setFolderPickerOpen(false);
    setLiveVideoMenuOpen(false);
    setMicrophoneMenuOpen(false);
    setPromptPickerOpen(false);
    if (!promptExpanded) {
      setComposerCondensed(true);
    }
  }, [promptExpanded]);

  const expandComposerChrome = useCallback(() => {
    setHistoryExpanded(false);
  }, []);

  const containAiPanelWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;

    const deltaY = normalizeWheelDeltaY(event);
    const scrollContainer = findVerticalScrollContainer(event.target, event.currentTarget);
    if (!scrollContainer || !canConsumeVerticalDelta(scrollContainer, deltaY)) {
      if (scrollContainer) {
        scrollContainer.scrollTop += deltaY;
      }
      event.preventDefault();
    }
  }, []);

  const rememberAiPanelTouch = useCallback((event: TouchEvent<HTMLDivElement>) => {
    lastAiPanelTouchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const containAiPanelTouch = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) return;

    const currentY = event.touches[0].clientY;
    const previousY = lastAiPanelTouchYRef.current;
    lastAiPanelTouchYRef.current = currentY;
    if (previousY === null) return;

    const deltaY = previousY - currentY;
    if (deltaY === 0) return;

    const scrollContainer = findVerticalScrollContainer(event.target, event.currentTarget);
    if ((!scrollContainer || !canConsumeVerticalDelta(scrollContainer, deltaY)) && event.cancelable) {
      if (scrollContainer) {
        scrollContainer.scrollTop += deltaY;
      }
      event.preventDefault();
    }
  }, []);

  const scrollToChatHistoryTarget = useCallback((selector: string) => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const targets = container.querySelectorAll<HTMLElement>(selector);
    const target = targets[targets.length - 1];
    if (!target) return;
    focusHistory();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusHistory]);

  const scrollToChatGeneratedImage = useCallback((imageId?: string) => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const generatedImages = container.querySelectorAll<HTMLElement>('[data-chat-generated-image="true"]');
    const target = imageId
      ? Array.from(generatedImages).find((image) => image.dataset.chatGeneratedImageId === imageId)
      : generatedImages[generatedImages.length - 1];
    if (!target) return;
    focusHistory();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusHistory]);

  const scrollToGeneratedImage = useCallback((imageId?: string) => {
    if (activeTab === "live") {
      liveHistoryControls?.scrollToGeneratedImage(imageId);
      return;
    }
    scrollToChatGeneratedImage(imageId);
  }, [activeTab, liveHistoryControls, scrollToChatGeneratedImage]);

  const handleGeneratedImageShortcutClick = useCallback(() => {
    scrollToGeneratedImage();
    if (activeGeneratedImages.length > 0) {
      setGeneratedImageTrayOpen(true);
    }
  }, [activeGeneratedImages.length, scrollToGeneratedImage]);

  const pickPreferredDeviceId = <T extends { deviceId: string }>(sources: T[], preferredDeviceId: string | null) =>
    preferredDeviceId && sources.some((source) => source.deviceId === preferredDeviceId)
      ? preferredDeviceId
      : sources[0]?.deviceId ?? null;

  const scrollToCameraTarget = useCallback(() => {
    if (activeTab === "live") {
      liveHistoryControls?.scrollToCamera();
      return;
    }
    const cameraPreview = cameraVideoRef.current?.parentElement;
    if ((cameraPreviewVisible || cameraPreparing || cameraRecording) && cameraPreview) {
      focusHistory();
      cameraPreview.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    scrollToChatHistoryTarget('[data-chat-camera-media="true"]');
  }, [activeTab, cameraPreparing, cameraPreviewVisible, cameraRecording, focusHistory, liveHistoryControls, scrollToChatHistoryTarget]);

  const scrollToLatestChatMessage = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    focusHistory();
    const latestAssistantMessage = latestAssistantMessageRef.current;
    if (latestAssistantMessage) {
      latestAssistantMessage.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
    setChatLatestMessageAvailable(false);
    setLatestMessageShortcutFlashing(false);
  }, [focusHistory]);

  const scrollToLatestMessage = useCallback(() => {
    if (activeTab === "live") {
      liveHistoryControls?.scrollToLatest();
      setLiveLatestMessageAvailable(false);
      setLatestMessageShortcutFlashing(false);
      return;
    }
    scrollToLatestChatMessage();
  }, [activeTab, liveHistoryControls, scrollToLatestChatMessage]);

  const updateChatHistoryScrollState = useCallback(() => {
    const container = messagesContainerRef.current;
    const latestAssistantMessage = latestAssistantMessageRef.current;
    if (!container || !latestAssistantMessage) return;
    const containerRect = container.getBoundingClientRect();
    const latestRect = latestAssistantMessage.getBoundingClientRect();
    const latestMessageInView = latestRect.top >= containerRect.top - 48 && latestRect.top <= containerRect.bottom;
    if (latestMessageInView) {
      setChatLatestMessageAvailable(false);
      setLatestMessageShortcutFlashing(false);
    }
  }, []);

  useEffect(() => {
    const trimmedSelection = selectedText?.trim();
    if (!trimmedSelection) return;
    setPrompt(formatSelectedTextContext(trimmedSelection));
  }, [selectedText]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    if (!pendingExternalAttachment) return;

    if (!supportsMedia) {
      onError("Switch the AI provider to Gemini to attach media.");
      onPendingExternalAttachmentHandled?.();
      return;
    }

    setAttachments((current) => {
      if (current.some((attachment) => attachment.source === "folder" && attachment.assetUrl === pendingExternalAttachment.assetUrl)) {
        return current;
      }
      pendingComposerScrollRef.current = true;
      return [
        ...current,
        {
          id: pendingExternalAttachment.id,
          kind: pendingExternalAttachment.kind,
          fileName: pendingExternalAttachment.fileName,
          mimeType: pendingExternalAttachment.mimeType,
          source: "folder",
          previewUrl: pendingExternalAttachment.previewUrl,
          assetUrl: pendingExternalAttachment.assetUrl,
        },
      ];
    });
    onPendingExternalAttachmentHandled?.();
  }, [onError, onPendingExternalAttachmentHandled, pendingExternalAttachment, supportsMedia]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleWindowResize = () => {
      setPanelHeight((current) => clampPanelHeight(current));
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPanelHeight((current) => clampPanelHeight(current || storedPanelHeight || window.innerHeight * 0.8));
  }, [storedPanelHeight]);

  useEffect(() => {
    onPanelHeightChange?.(panelHeight);
  }, [onPanelHeightChange, panelHeight]);

  useEffect(() => {
    if (!pendingComposerScrollRef.current) return;
    const container = composerItemsRef.current;
    if (!container) return;

    pendingComposerScrollRef.current = false;
    window.requestAnimationFrame(() => {
      container.scrollTo({ left: container.scrollWidth, behavior: "smooth" });
    });
  }, [attachments.length, selectedPrompts.length]);

  useEffect(() => {
    const latestId = latestGeneratedImage?.id ?? null;
    if (!generatedImageWatcherReadyRef.current) {
      generatedImageWatcherReadyRef.current = true;
      latestGeneratedImageIdRef.current = latestId;
      return;
    }

    if (latestId && latestGeneratedImageIdRef.current !== latestId) {
      setGeneratedImageTrayOpen(true);
    }
    latestGeneratedImageIdRef.current = latestId;
  }, [latestGeneratedImage?.id]);

  useEffect(() => {
    if (activeGeneratedImages.length === 0) {
      setGeneratedImageTrayOpen(false);
    }
  }, [activeGeneratedImages.length]);

  useEffect(() => {
    if (!latestAssistantMessageId) {
      previousLatestAssistantMessageIdRef.current = null;
      setChatLatestMessageAvailable(false);
      return;
    }
    if (latestChatMessageRole !== "assistant") return;
    if (previousLatestAssistantMessageIdRef.current === latestAssistantMessageId) return;

    previousLatestAssistantMessageIdRef.current = latestAssistantMessageId;
    if (!promptExpanded) {
      setComposerCondensed(true);
    }
    setChatLatestMessageAvailable(true);
    triggerLatestMessageShortcutFlash();
  }, [latestAssistantMessageId, latestChatMessageRole, promptExpanded, triggerLatestMessageShortcutFlash]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePointerMove = (event: PointerEvent) => {
      if (resizePointerIdRef.current !== event.pointerId) return;
      const deltaY = resizeStartYRef.current - event.clientY;
      setPanelHeight(clampPanelHeight(resizeStartHeightRef.current + deltaY));
    };

    const stopResize = (pointerId?: number) => {
      if (pointerId !== undefined && resizePointerIdRef.current !== pointerId) return;
      resizePointerIdRef.current = null;
    };

    const handlePointerUp = (event: PointerEvent) => {
      stopResize(event.pointerId);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  useEffect(
    () => () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
      mediaRecorderRef.current?.stop?.();
      recordingAmplifiedStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingAudioSourceRef.current?.disconnect();
      recordingAudioGainRef.current?.disconnect();
      recordingAudioDestinationRef.current?.disconnect();
      recordingAudioContextRef.current?.close().catch(() => undefined);
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (microphoneLongPressTimerRef.current) {
        window.clearTimeout(microphoneLongPressTimerRef.current);
      }
      if (autoReadSelectionTimerRef.current) {
        window.clearTimeout(autoReadSelectionTimerRef.current);
      }
      if (cameraLongPressTimerRef.current) {
        window.clearTimeout(cameraLongPressTimerRef.current);
      }
      if (latestMessageFlashTimerRef.current) {
        window.clearTimeout(latestMessageFlashTimerRef.current);
      }
      cameraRecorderRef.current?.stop?.();
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const stopRecordingStream = () => {
    recordingAmplifiedStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingAmplifiedStreamRef.current = null;
    recordingAudioSourceRef.current?.disconnect();
    recordingAudioSourceRef.current = null;
    recordingAudioGainRef.current?.disconnect();
    recordingAudioGainRef.current = null;
    recordingAudioDestinationRef.current?.disconnect();
    recordingAudioDestinationRef.current = null;
    recordingAudioContextRef.current?.close().catch(() => undefined);
    recordingAudioContextRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  };

  const createAmplifiedRecordingStream = async (stream: MediaStream) => {
    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return stream;
    }

    const context = new AudioContextCtor();
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }

    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.gain.value = AUDIO_RECORDING_INPUT_GAIN;
    source.connect(gain);
    gain.connect(destination);

    recordingAudioContextRef.current = context;
    recordingAudioSourceRef.current = source;
    recordingAudioGainRef.current = gain;
    recordingAudioDestinationRef.current = destination;
    recordingAmplifiedStreamRef.current = destination.stream;

    return destination.stream;
  };

  const clearMicrophoneLongPressTimer = () => {
    if (microphoneLongPressTimerRef.current) {
      window.clearTimeout(microphoneLongPressTimerRef.current);
      microphoneLongPressTimerRef.current = null;
    }
  };

  const clearCameraLongPressTimer = () => {
    if (cameraLongPressTimerRef.current) {
      window.clearTimeout(cameraLongPressTimerRef.current);
      cameraLongPressTimerRef.current = null;
    }
  };

  const clearAutoReadSelectionTimer = () => {
    if (autoReadSelectionTimerRef.current) {
      window.clearTimeout(autoReadSelectionTimerRef.current);
      autoReadSelectionTimerRef.current = null;
    }
  };

  const stopCameraStream = () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setCameraPreviewVisible(false);
    if (cameraVideoRef.current) {
      cameraVideoRef.current.pause();
      cameraVideoRef.current.srcObject = null;
    }
  };

  const lockCameraCapture = () => {
    if (cameraCaptureHandledRef.current) return false;
    cameraCaptureHandledRef.current = true;
    return true;
  };

  const requestMicrophoneStream = async (deviceId?: string | null) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Audio recording is not supported in this browser.");
    }

    const audioConstraints = buildSpeechMicAudioConstraints();
    if (deviceId) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            ...audioConstraints,
          },
        });
        if (isLocalSystemAudioInput(stream.getAudioTracks()[0]?.label)) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error("Choose a physical microphone instead of a system or loopback audio source.");
        }
        return stream;
      } catch (error) {
        if (error instanceof Error && error.message.includes("system or loopback audio source")) {
          throw error;
        }
        // Fall back to the browser default microphone when the saved device is unavailable.
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });
    if (isLocalSystemAudioInput(stream.getAudioTracks()[0]?.label)) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Choose a physical microphone instead of a system or loopback audio source.");
    }
    return stream;
  };

  const createFileAttachment = (file: File, kind: AIMediaKind): LocalAttachment => ({
    id: crypto.randomUUID(),
    kind,
    fileName: file.name,
    mimeType: fallbackMimeType(file, kind),
    source: "upload",
    previewUrl: URL.createObjectURL(file),
    file,
  });

  const toPreviewAttachment = (attachment: Pick<PreviewAttachment, "fileName" | "kind" | "mimeType"> & { url?: string }) =>
    attachment.url
      ? {
          fileName: attachment.fileName,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          previewUrl: attachment.url,
        }
      : null;

  const buildMessageAttachment = (attachment: LocalAttachment): AIMessageAttachment => ({
    id: attachment.id,
    fileName: attachment.fileName,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    origin: "uploaded",
    url: attachment.file ? URL.createObjectURL(attachment.file) : attachment.assetUrl ?? attachment.previewUrl,
  });

  const buildMessagePrompt = (template: PromptTemplate): AIMessagePrompt => ({
    id: template.id,
    name: template.name,
    content: template.content,
  });

  const composePrompt = (messagePrompt: string, templates: PromptTemplate[]) => {
    const trimmedPrompt = messagePrompt.trim();
    const sections = templates.map((template, index) => `${index + 1}. ${template.name}\n${template.content.trim()}`);
    return [sections.length ? `Reusable prompts:\n${sections.join("\n\n")}` : "", trimmedPrompt ? `User request:\n${trimmedPrompt}` : ""]
      .filter(Boolean)
      .join("\n\n");
  };

  const composeLivePrompt = (messagePrompt: string, templates: PromptTemplate[], items: LocalAttachment[]) => {
    const basePrompt = composePrompt(messagePrompt, templates);
    const attachmentSummary =
      items.length > 0 ? `Selected files:\n${items.map((attachment, index) => `${index + 1}. ${describeLiveAttachment(attachment)}`).join("\n")}` : "";

    return [basePrompt, attachmentSummary].filter(Boolean).join("\n\n").trim();
  };

  const waitForCameraFrame = async (video: HTMLVideoElement) => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onLoadedData = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Camera preview failed to start."));
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", onLoadedData);
        video.removeEventListener("error", onError);
      };

      video.addEventListener("loadeddata", onLoadedData);
      video.addEventListener("error", onError);
    });
  };

  const appendFiles = (files: File[]) => {
    if (!supportsMedia) {
      onError("Switch the AI provider to Gemini to attach media.");
      return;
    }

    const nextAttachments = files.flatMap((file) => {
      const kind = inferMediaKindFromFile(file);
      if (!kind) return [];
      return [
        {
          id: crypto.randomUUID(),
          kind,
          fileName: file.name,
          mimeType: fallbackMimeType(file, kind),
          source: "upload" as const,
          previewUrl: URL.createObjectURL(file),
          file,
        },
      ];
    });

    if (nextAttachments.length === 0) {
      onError("Only image, audio, and video files are supported.");
      return;
    }

    pendingComposerScrollRef.current = true;
    setAttachments((current) => [...current, ...nextAttachments]);
  };

  const handleFileDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDropDepthRef.current += 1;
    setFileDropActive(true);
  };

  const handleFileDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = supportsMedia ? "copy" : "none";
    setFileDropActive(true);
  };

  const handleFileDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDropDepthRef.current = Math.max(0, fileDropDepthRef.current - 1);
    if (fileDropDepthRef.current === 0) {
      setFileDropActive(false);
    }
  };

  const handleFileDrop = (event: DragEvent<HTMLElement>) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDropDepthRef.current = 0;
    setFileDropActive(false);

    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      appendFiles(files);
    }
  };

  const removeAttachment = (attachmentId: string) => {
    const removedAttachment = attachments.find((attachment) => attachment.id === attachmentId) ?? null;
    setAttachments((current) => {
      const next = current.filter((attachment) => {
        if (attachment.id !== attachmentId) return true;
        revokeAttachmentPreview(attachment);
        return false;
      });
      return next;
    });
    setPreviewAttachment((current) =>
      current && removedAttachment && current.previewUrl === removedAttachment.previewUrl ? null : current,
    );
  };

  const addFolderAsset = (asset: FolderAsset) => {
    if (!supportsMedia) {
      onError("Switch the AI provider to Gemini to attach media.");
      return;
    }

    setAttachments((current) => {
      if (current.some((attachment) => attachment.source === "folder" && attachment.assetUrl === asset.url)) {
        return current;
      }
      pendingComposerScrollRef.current = true;
      return [
        ...current,
        {
          id: asset.id,
          kind: asset.kind,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          source: "folder",
          previewUrl: asset.url,
          assetUrl: asset.url,
        },
      ];
    });
    setFolderPickerOpen(false);
  };

  const attachGeneratedImageForEdit = (attachment: AIMessageAttachment) => {
    if (attachment.kind !== "image" || !attachment.url) {
      onError("Only generated images can be edited.");
      return;
    }
    const imageUrl = attachment.url;

    setAttachments((current) => {
      if (current.some((item) => item.assetUrl === imageUrl || item.previewUrl === imageUrl)) {
        return current;
      }
      pendingComposerScrollRef.current = true;
      return [
        ...current,
        {
          id: attachment.id,
          kind: "image",
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          source: "folder",
          previewUrl: imageUrl,
          assetUrl: imageUrl,
        },
      ];
    });
    setPromptExpanded(true);
    setActiveTab("chat");
  };

  const addPromptTemplate = (template: PromptTemplate) => {
    pendingComposerScrollRef.current = true;
    setSelectedPrompts((current) => (current.some((item) => item.id === template.id) ? current : [...current, template]));
    setPromptPickerOpen(false);
  };

  const removePromptTemplate = (promptId: string) => {
    setSelectedPrompts((current) => current.filter((item) => item.id !== promptId));
    setPreviewPrompt((current) => (current?.id === promptId ? null : current));
  };

  const resetPromptEditor = () => {
    setEditingPromptId(null);
    setPromptCreateOpen(false);
    setPromptNameDraft("");
    setPromptContentDraft("");
  };

  const openPromptEditor = (template?: PromptTemplate) => {
    setPromptPickerOpen(true);
    setPromptCreateOpen(true);
    setEditingPromptId(template?.id ?? null);
    setPromptNameDraft(template?.name ?? "");
    setPromptContentDraft(template?.content ?? "");
  };

  const clearComposer = (options?: { preservePrompts?: boolean }) => {
    attachments.forEach(revokeAttachmentPreview);
    setAttachments([]);
    setPreviewAttachment(null);
    setPreviewPrompt(null);
    if (!options?.preservePrompts) {
      setSelectedPrompts([]);
    }
    setPromptPickerOpen(false);
    resetPromptEditor();
    setPrompt("");
  };

  const savePromptTemplate = async () => {
    const name = promptNameDraft.trim();
    const content = promptContentDraft.trim();
    if (!name || !content || creatingPrompt) return;

    setCreatingPrompt(true);
    try {
      if (editingPromptId) {
        const updated = await onUpdatePrompt(editingPromptId, { name, content });
        setSelectedPrompts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        setPreviewPrompt((current) => (current?.id === updated.id ? buildMessagePrompt(updated) : current));
      } else {
        pendingComposerScrollRef.current = true;
        const created = await onCreatePrompt({ name, content });
        setSelectedPrompts((current) => [...current, created]);
      }
      resetPromptEditor();
      setPromptPickerOpen(true);
    } catch (error) {
      onError(error instanceof Error ? error.message : editingPromptId ? "Failed to update prompt." : "Failed to create prompt.");
    } finally {
      setCreatingPrompt(false);
    }
  };

  const submitPrompt = async (
    items: LocalAttachment[],
    transientItems: LocalAttachment[] = [],
    options?: {
      mode?: AIRequestMode;
      preserveComposer?: boolean;
    },
  ) => {
    try {
      const selectedMessagePrompts = selectedPrompts.map(buildMessagePrompt);
      const finalPrompt = composePrompt(prompt, selectedPrompts);
      const requestAttachments = await Promise.all(
        items.map(async (attachment): Promise<AIRequestAttachment> => ({
          id: attachment.id,
          kind: attachment.kind,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          source: attachment.source,
          assetUrl: attachment.assetUrl,
          dataBase64: attachment.file ? await readFileAsBase64(attachment.file) : undefined,
        })),
      );

      const submittedPrompt = prompt;
      const askPromise = onAsk({
        prompt: finalPrompt,
        attachments: requestAttachments,
        messageAttachments: items.map(buildMessageAttachment),
        prompts: selectedMessagePrompts,
        mode: options?.mode ?? "chat",
      });
      if (submittedPrompt) {
        setPrompt("");
      }

      const sent = await askPromise;

      if (sent) {
        if (!options?.preserveComposer) {
          clearComposer({ preservePrompts: true });
        }
        setFolderPickerOpen(false);
      } else if (submittedPrompt) {
        setPrompt((current) => current || submittedPrompt);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to prepare attachments.");
    } finally {
      transientItems.forEach(revokeAttachmentPreview);
    }
  };

  const handleSend = async () => {
    if (busy || (!prompt.trim() && attachments.length === 0 && selectedPrompts.length === 0)) return;
    const mode: AIRequestMode =
      provider === "gemini" && providerSettings.imageModel.trim() && shouldUseImageGeneration(prompt, selectedPrompts, attachments)
        ? "image"
        : "chat";
    if (mode === "image") {
      setImageGenerationActive(true);
    }
    try {
      await submitPrompt(attachments, [], { mode });
    } finally {
      if (mode === "image") {
        setImageGenerationActive(false);
      }
    }
  };

  const handleReadSelectedText = useCallback(async () => {
    const text = selectedTextForReadAloud;
    if (!text || readingSelection) return false;

    clearAutoReadSelectionTimer();
    const readKey = `${activeTab}:${text}`;

    if (activeTab === "live") {
      if (!liveSendHandle) {
        onError(liveSessionState.status);
        return false;
      }
      const sent = liveSendHandle.sendText(buildReadAloudPrompt(text), {
        displayText: `Read selected text aloud:\n${text}`,
      });
      if (!sent) {
        onError(liveSessionState.status);
        return false;
      }
      lastAutoReadSelectionKeyRef.current = readKey;
      return true;
    }

    setReadingSelection(true);
    try {
      const sent = await onAsk({
        prompt: text,
        attachments: [],
        messageAttachments: [],
        prompts: [],
        mode: "tts",
        displayPrompt: "Read selected text aloud.",
      });
      if (sent) {
        lastAutoReadSelectionKeyRef.current = readKey;
      }
      return sent;
    } finally {
      setReadingSelection(false);
    }
  }, [activeTab, liveSendHandle, liveSessionState.status, onAsk, onError, readingSelection, selectedTextForReadAloud]);

  useEffect(() => {
    clearAutoReadSelectionTimer();

    const text = selectedTextForReadAloud;
    if (!text) {
      lastAutoReadSelectionKeyRef.current = null;
      return;
    }

    const readKey = `${activeTab}:${text}`;
    if (lastAutoReadSelectionKeyRef.current === readKey) return;
    if (provider !== "gemini" || !providerSettings.apiKey) return;
    if (readingSelection) return;
    if (activeTab === "live" && !liveSendHandle) return;
    if (activeTab !== "live" && busy) return;

    autoReadSelectionTimerRef.current = window.setTimeout(() => {
      autoReadSelectionTimerRef.current = null;
      void handleReadSelectedText();
    }, 2000);

    return clearAutoReadSelectionTimer;
  }, [activeTab, busy, handleReadSelectedText, liveSendHandle, provider, providerSettings.apiKey, readingSelection, selectedTextForReadAloud]);

  const handleComposerSubmit = async () => {
    if (activeTab === "live") {
      const supportedLiveAttachments = attachments.filter(
        (attachment) => attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "audio",
      );
      const summaryText = composeLivePrompt(prompt, selectedPrompts, attachments);

      if (!summaryText && supportedLiveAttachments.length === 0) return;
      if (!liveSendHandle) {
        onError(liveSessionState.status);
        return;
      }

      try {
        for (const attachment of supportedLiveAttachments) {
          const sent = await liveSendHandle.sendAttachment({
            kind: attachment.kind,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            file: attachment.file,
            url: attachment.assetUrl ?? attachment.previewUrl,
          } satisfies LiveSendAttachment);
          if (!sent) {
            onError(`Couldn't send ${attachment.fileName} to live talk.`);
            return;
          }
        }
        if (summaryText) {
          const sent = liveSendHandle.sendText(summaryText);
          if (!sent) {
            onError(liveSessionState.status);
            return;
          }
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : "Failed to send media to live talk.");
        return;
      }

      clearComposer({ preservePrompts: true });
      return;
    }

    await handleSend();
  };

  const refreshLiveVideoSources = async () => {
    if (!liveVideoControls) return [];
    setLiveVideoMenuLoading(true);
    try {
      const sources = await liveVideoControls.listSources();
      setLiveVideoSources(sources);
      setPreferredLiveCameraDeviceId((current) => pickPreferredDeviceId(sources, current));
      return sources;
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to load cameras.");
      return [];
    } finally {
      setLiveVideoMenuLoading(false);
    }
  };

  const toggleLiveVideoMenu = async () => {
    if (!liveVideoControls) {
      onError(liveSessionState.status);
      return;
    }
    if (liveVideoMenuOpen) {
      setLiveVideoMenuOpen(false);
      return;
    }
    setPromptPickerOpen(false);
    setFolderPickerOpen(false);
    setLiveVideoMenuOpen(true);
    void refreshLiveVideoSources();
  };

  const startLiveCameraShare = async (deviceId?: string, options?: { video?: boolean }) => {
    if (!liveVideoControls) return;
    try {
      const resolvedDeviceId = deviceId ?? pickPreferredDeviceId(liveVideoSources, preferredLiveCameraDeviceId) ?? undefined;
      if (resolvedDeviceId) {
        setPreferredLiveCameraDeviceId(resolvedDeviceId);
      }
      try {
        await liveVideoControls.startCameraShare(resolvedDeviceId, options);
      } catch (error) {
        if (!resolvedDeviceId) {
          throw error;
        }
        await liveVideoControls.startCameraShare(undefined, options);
      }
      setLiveVideoMenuOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to share the camera.");
    }
  };

  const switchLiveCameraShare = async () => {
    if (!liveVideoControls) return;
    try {
      await liveVideoControls.switchCameraShare();
      void refreshLiveVideoSources();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to switch cameras.");
    }
  };

  const startLiveScreenShare = async (options?: { video?: boolean }) => {
    if (!liveVideoControls) return;
    try {
      await liveVideoControls.startScreenShare(options);
      setLiveVideoMenuOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to share the screen.");
    }
  };

  const refreshMicrophoneSources = async () => {
    setMicrophoneMenuLoading(true);
    try {
      const sources = await listMicrophoneSources();
      setMicrophoneSources(sources);
      setSelectedMicrophoneId((current) => pickPreferredDeviceId(sources, current));
      return sources;
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to load microphones.");
      return [];
    } finally {
      setMicrophoneMenuLoading(false);
    }
  };

  const toggleMicrophoneMenu = async () => {
    if (microphoneMenuOpen) {
      setMicrophoneMenuOpen(false);
      return;
    }
    setPromptPickerOpen(false);
    setFolderPickerOpen(false);
    setLiveVideoMenuOpen(false);
    setMicrophoneMenuOpen(true);
    void refreshMicrophoneSources();
  };

  const selectMicrophoneSource = (deviceId: string) => {
    setSelectedMicrophoneId(deviceId);
    setLiveMicrophoneEnabled(true);
    setMicrophoneMenuOpen(false);
  };

  const disableLiveMicrophone = () => {
    setLiveMicrophoneEnabled(false);
    setMicrophoneMenuOpen(false);
  };

  const enableLiveMicrophone = () => {
    setLiveMicrophoneEnabled(true);
    setMicrophoneMenuOpen(false);
  };

  const handleLiveVideoShareStateChange = useCallback((state: LiveVideoShareState) => {
    setLiveVideoShareMode((current) => (current === state.mode ? current : state.mode));
    setLiveVideoShareCameraMode(state.cameraMode ?? null);
    if (state.mode === "camera" && state.cameraDeviceId) {
      setPreferredLiveCameraDeviceId(state.cameraDeviceId);
    }
  }, []);

  const handleLiveHistoryTargetsChange = useCallback((targets: LiveHistoryTargets) => {
    setLiveHistoryTargets((current) => {
      const sameImages =
        current.generatedImages.length === targets.generatedImages.length &&
        current.generatedImages.every((image, index) => {
          const nextImage = targets.generatedImages[index];
          return nextImage && image.id === nextImage.id && image.url === nextImage.url && image.fileName === nextImage.fileName;
        });
      return current.hasCamera === targets.hasCamera && current.hasGeneratedImage === targets.hasGeneratedImage && sameImages ? current : targets;
    });
  }, []);

  const handleLiveLatestMessageStateChange = useCallback(
    (available: boolean) => {
      if (!available) {
        setLatestMessageShortcutFlashing(false);
      }
      setLiveLatestMessageAvailable((current) => {
        if (available && !current) {
          triggerLatestMessageShortcutFlash();
        }
        return available;
      });
    },
    [triggerLatestMessageShortcutFlash],
  );

  const confirmUploadPreviewImage = () => {
    if (!previewAttachment || previewAttachment.kind !== "image") return;
    if (!window.confirm("Upload this image to the current folder?")) return;
    void onUploadImageToCurrentFolder(previewAttachment);
  };

  const renderGeneratedImageCard = (attachment: AIMessageAttachment) => (
    <div className="group relative overflow-hidden rounded-[16px] border border-ink/10 bg-white shadow-[0_12px_28px_rgba(15,23,42,0.08)]" key={attachment.id}>
      <button
        className="flex w-full items-center justify-center bg-[#f7f1e6] p-3"
        data-chat-generated-image="true"
        data-chat-generated-image-id={attachment.id}
        onClick={() => {
          const preview = toPreviewAttachment(attachment);
          if (preview) setPreviewAttachment(preview);
        }}
        type="button"
      >
        <img alt={attachment.fileName} className="max-h-[220px] w-auto max-w-full object-contain" src={attachment.url} />
      </button>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink/45">Generated image</div>
          <div className="truncate text-xs font-medium text-ink">{attachment.fileName}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
            onClick={() => attachGeneratedImageForEdit(attachment)}
            title="Edit with AI"
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
              <path d="m12.5 7.5 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
            </svg>
          </button>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
            onClick={() => {
              const preview = toPreviewAttachment(attachment);
              if (preview) setPreviewAttachment(preview);
            }}
            title="Large view"
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path d="M14 4h6v6M10 20H4v-6M20 10V4h-6M4 14v6h6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
            </svg>
          </button>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
            onClick={() => onAddAttachmentToNote(attachment)}
            title="Add to note"
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );

  const stopRecordingAndSend = async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    await new Promise<void>((resolve, reject) => {
      recorder.onstop = async () => {
        try {
          const mimeType = recorder.mimeType || "audio/webm";
          const extension = recordingExtensionForMimeType(mimeType);
          const blob = new Blob(recordedChunksRef.current, { type: mimeType });
          recordedChunksRef.current = [];
          const file = new File([blob], `recording-${Date.now()}.${extension}`, {
            type: mimeType,
            lastModified: Date.now(),
          });
          if (recordingTargetRef.current === "live") {
            if (!liveSendHandle) {
              throw new Error(liveSessionState.status);
            }
            const sent = await liveSendHandle.sendAttachment({
              kind: "audio",
              fileName: file.name,
              mimeType: file.type,
              file,
            } satisfies LiveSendAttachment);
            if (!sent) {
              throw new Error("Couldn't send the recording to live talk.");
            }
          } else {
            const recordedAttachment = createFileAttachment(file, "audio");
            await submitPrompt([...attachmentsRef.current, recordedAttachment], [recordedAttachment], { preserveComposer: true });
          }
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          mediaRecorderRef.current = null;
          setRecording(false);
          stopRecordingStream();
        }
      };

      recorder.onerror = () => {
        mediaRecorderRef.current = null;
        recordedChunksRef.current = [];
        setRecording(false);
        stopRecordingStream();
        reject(new Error("Audio recording failed."));
      };

      recorder.stop();
    }).catch((error) => {
      onError(error instanceof Error ? error.message : "Audio recording failed.");
    });
  };

  const startRecording = async () => {
    if (!supportsMedia) {
      onError("Switch the AI provider to Gemini to attach media.");
      return;
    }
    if (recording || preparingRecording) return;
    if (recordingTargetRef.current === "chat" && busy) return;
    if (recordingTargetRef.current === "live" && !liveSendHandle) {
      onError(liveSessionState.status);
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      onError("Audio recording is not supported in this browser.");
      return;
    }

    const mimeType = getPreferredRecordingMimeType();
    if (!mimeType) {
      onError("This browser cannot record audio as m4a, webm, or wav.");
      return;
    }

    setPreparingRecording(true);

    try {
      const stream = await requestMicrophoneStream(selectedMicrophoneId);
      mediaStreamRef.current = stream;
      const recordingStream = await createAmplifiedRecordingStream(stream);
      const resolvedDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? null;
      if (resolvedDeviceId && resolvedDeviceId !== selectedMicrophoneId) {
        setSelectedMicrophoneId(resolvedDeviceId);
      } else if (!resolvedDeviceId && selectedMicrophoneId) {
        setSelectedMicrophoneId(null);
      }
      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(recordingStream, { audioBitsPerSecond: AUDIO_RECORDING_BITS_PER_SECOND, mimeType });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (error) {
      stopRecordingStream();
      onError(error instanceof Error ? error.message : "Microphone access was denied.");
    } finally {
      setPreparingRecording(false);
      if (!recordHoldActiveRef.current && mediaRecorderRef.current?.state === "recording") {
        await stopRecordingAndSend();
      }
    }
  };

  const releaseRecording = async () => {
    recordHoldActiveRef.current = false;
    clearMicrophoneLongPressTimer();
    if (preparingRecording) return;
    if (mediaRecorderRef.current?.state === "recording") {
      await stopRecordingAndSend();
    }
  };

  const beginMicrophoneInteraction = (target: "chat" | "live") => {
    recordHoldActiveRef.current = true;
    recordingTargetRef.current = target;
    microphoneLongPressTriggeredRef.current = false;
    clearMicrophoneLongPressTimer();
    microphoneLongPressTimerRef.current = window.setTimeout(() => {
      microphoneLongPressTimerRef.current = null;
      microphoneLongPressTriggeredRef.current = true;
      if (recordHoldActiveRef.current) {
        void startRecording();
      }
    }, 2000);
  };

  const finishMicrophoneInteraction = async () => {
    if (microphoneLongPressTriggeredRef.current) {
      await releaseRecording();
      return;
    }
    recordHoldActiveRef.current = false;
    clearMicrophoneLongPressTimer();
    await toggleMicrophoneMenu();
  };

  const capturePhotoAndSend = async () => {
    const video = cameraVideoRef.current;
    if (!video || !cameraStreamRef.current) return;
    if (!lockCameraCapture()) return;

    try {
      await waitForCameraFrame(video);
      await waitForPaintedVideoFrame(video);

      const videoTrack = cameraStreamRef.current.getVideoTracks()[0];
      let blob: Blob | null = null;
      const ImageCaptureCtor = (globalThis as { ImageCapture?: new (track: MediaStreamTrack) => { takePhoto: () => Promise<Blob> } })
        .ImageCapture;

      if (videoTrack && ImageCaptureCtor) {
        try {
          const capture = new ImageCaptureCtor(videoTrack);
          blob = await capture.takePhoto();
        } catch {
          blob = null;
        }
      }

      if (!blob) {
        const width = video.videoWidth || 1280;
        const height = video.videoHeight || 720;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Camera capture is not supported in this browser.");
        }
        context.drawImage(video, 0, 0, width, height);
        blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((nextBlob) => {
            if (!nextBlob) {
              reject(new Error("Failed to capture photo."));
              return;
            }
            resolve(nextBlob);
          }, "image/jpeg", 0.92);
        });
      }

      const file = new File([blob], `photo-${Date.now()}.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
      const photoAttachment = createFileAttachment(file, "image");
      setCameraPreparing(false);
      setCameraRecording(false);
      stopCameraStream();
      await submitPrompt([...attachmentsRef.current, photoAttachment], [photoAttachment], { preserveComposer: true });
    } catch (error) {
      setCameraPreparing(false);
      setCameraRecording(false);
      stopCameraStream();
      onError(error instanceof Error ? error.message : "Failed to capture photo.");
    }
  };

  const stopVideoRecordingAndSend = async () => {
    const recorder = cameraRecorderRef.current;
    if (!recorder) return;
    if (!lockCameraCapture()) return;

    await new Promise<void>((resolve, reject) => {
      recorder.onstop = async () => {
        try {
          const mimeType = recorder.mimeType || "video/webm";
          const extension = videoExtensionForMimeType(mimeType);
          const blob = new Blob(cameraChunksRef.current, { type: mimeType });
          cameraChunksRef.current = [];
          const file = new File([blob], `video-${Date.now()}.${extension}`, {
            type: mimeType,
            lastModified: Date.now(),
          });
          const videoAttachment = createFileAttachment(file, "video");
          await submitPrompt([...attachmentsRef.current, videoAttachment], [videoAttachment], { preserveComposer: true });
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          cameraRecorderRef.current = null;
        }
      };

      recorder.onerror = () => {
        cameraRecorderRef.current = null;
        cameraChunksRef.current = [];
        reject(new Error("Video recording failed."));
      };

      recorder.stop();
      setCameraPreparing(false);
      setCameraRecording(false);
      stopCameraStream();
    }).catch((error) => {
      setCameraPreparing(false);
      setCameraRecording(false);
      stopCameraStream();
      onError(error instanceof Error ? error.message : "Video recording failed.");
    });
  };

  const startVideoRecording = () => {
    if (cameraRecorderRef.current?.state === "recording") return;
    if (typeof MediaRecorder === "undefined") {
      onError("Video recording is not supported in this browser.");
      setCameraPreparing(false);
      stopCameraStream();
      return;
    }

    const stream = cameraStreamRef.current;
    if (!stream) return;
    const mimeType = getPreferredVideoMimeType();
    if (!mimeType) {
      onError("This browser cannot record video in a supported format.");
      setCameraPreparing(false);
      stopCameraStream();
      return;
    }

    cameraChunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        cameraChunksRef.current.push(event.data);
      }
    };
    cameraRecorderRef.current = recorder;
    setCameraPreviewVisible(true);
    recorder.start();
    setCameraPreparing(false);
    setCameraRecording(true);
  };

  const startCameraCapture = async () => {
    if (!supportsMedia) {
      onError("Switch the AI provider to Gemini to attach media.");
      return;
    }
    if (busy || recording || preparingRecording || cameraPreparing || cameraRecording) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onError("Camera capture is not supported in this browser.");
      return;
    }

    setCameraPreparing(true);
    cameraCaptureHandledRef.current = false;
    setCameraPreviewVisible(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      const video = cameraVideoRef.current;
      if (!video) {
        throw new Error("Camera preview is unavailable.");
      }
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play().catch(() => undefined);
      await waitForCameraFrame(video);
      if (cameraLongPressTriggeredRef.current && cameraHoldActiveRef.current) {
        startVideoRecording();
        return;
      }

      if (!cameraHoldActiveRef.current) {
        if (cameraLongPressTriggeredRef.current) {
          setCameraPreparing(false);
          stopCameraStream();
          return;
        }
        await capturePhotoAndSend();
      }
    } catch (error) {
      setCameraPreparing(false);
      setCameraRecording(false);
      stopCameraStream();
      onError(error instanceof Error ? error.message : "Camera access was denied.");
    }
  };

  const releaseCameraCapture = async () => {
    cameraHoldActiveRef.current = false;
    clearCameraLongPressTimer();
    if (cameraPreparing && !cameraStreamRef.current) return;
    if (cameraLongPressTriggeredRef.current) {
      if (cameraRecorderRef.current?.state === "recording") {
        await stopVideoRecordingAndSend();
        return;
      }
      setCameraPreparing(false);
      setCameraRecording(false);
      stopCameraStream();
      return;
    }
    if (cameraRecording && cameraRecorderRef.current?.state === "recording") {
      await stopVideoRecordingAndSend();
      return;
    }
    if (cameraStreamRef.current) {
      await capturePhotoAndSend();
    }
  };

  return (
    <Panel
      className={`relative z-0 flex w-full flex-col overflow-visible overscroll-contain border-0 !p-1 shadow-none transition-[height,box-shadow] duration-200 ease-out ${
        fileDropActive ? "ring-2 ring-[#1f6f78]/45" : ""
      }`}
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
      onTouchEndCapture={() => {
        lastAiPanelTouchYRef.current = null;
      }}
      onTouchMoveCapture={containAiPanelTouch}
      onTouchStartCapture={rememberAiPanelTouch}
      onWheelCapture={containAiPanelWheel}
      style={{ height: displayedPanelHeight }}
    >
      <div className="pointer-events-none absolute inset-x-8 -top-3 z-10 h-7 rounded-full bg-ink/20 blur-xl" />
      {fileDropActive ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-[10px] border-2 border-dashed border-[#1f6f78]/55 bg-[#e5f5f7]/70 text-[#1f6f78] backdrop-blur-[2px]"
        >
          <svg aria-hidden="true" className="h-12 w-12 drop-shadow-sm" fill="none" viewBox="0 0 24 24">
            <path d="M12 16V5M8 9l4-4 4 4M5 19h14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          </svg>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 px-0 py-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="inline-flex rounded-full bg-white p-0.5 text-xs shadow-[0_8px_18px_rgba(15,23,42,0.08)]">
            <button
              className={`rounded-full px-2.5 py-1 font-medium transition ${activeTab === "chat" ? "bg-ink text-white" : "text-ink/65 hover:bg-mist"}`}
              onClick={() => setActiveTab("chat")}
              type="button"
            >
              Chat
            </button>
            <button
              className={`rounded-full px-2.5 py-1 font-medium transition ${
                activeTab === "live"
                  ? "bg-ink text-white"
                  : supportsLive
                    ? "text-ink/65 hover:bg-mist"
                    : "cursor-not-allowed text-ink/35"
              }`}
              disabled={!supportsLive}
              onClick={() => setActiveTab("live")}
              title={supportsLive ? "Start live talk" : "Switch to Gemini and save a live model first"}
              type="button"
            >
              Live
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {showLatestMessageShortcut ? (
            <button
              aria-label="Scroll to latest message"
              className={`flex h-7 w-7 items-center justify-center rounded-[4px] border border-[#bb3e2d]/25 bg-[#fff7e8] text-[#bb3e2d] transition hover:border-[#bb3e2d]/40 hover:bg-[#ffeacd] ${
                latestMessageShortcutFlashing ? "animate-pulse ring-2 ring-[#bb3e2d]/35" : ""
              }`}
              onClick={scrollToLatestMessage}
              title="Scroll to latest message"
              type="button"
            >
              <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                <path
                  d="M6 7.5A2.5 2.5 0 0 1 8.5 5h7A2.5 2.5 0 0 1 18 7.5v5A2.5 2.5 0 0 1 15.5 15H11l-4 4v-4.5A2.5 2.5 0 0 1 6 12.5v-5Z"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.7"
                />
                <path d="m12 8.5 2.5 2.5L12 13.5M9.5 11h4.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
              </svg>
            </button>
          ) : null}
          {showGeneratedImageShortcut ? (
            <div className="relative" ref={generatedImageTrayRef}>
              <button
                aria-label={imageGenerationActive ? "Generating image" : "Scroll to generated image"}
                className={`flex h-7 w-7 items-center justify-center rounded-[4px] border transition ${
                  imageGenerationActive
                    ? "border-black bg-black text-white hover:border-black hover:bg-black"
                    : "border-[#1f6f78]/20 bg-[#e5f5f7] text-[#1f6f78] hover:border-[#1f6f78]/35 hover:bg-[#d8eef1]"
                }`}
                onClick={handleGeneratedImageShortcutClick}
                title={imageGenerationActive ? "Generating image" : "Scroll to generated image"}
                type="button"
              >
                <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5v-11Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.7"
                  />
                  <path d="m7.5 16 3.2-3.4 2.3 2.2 2.1-2.8 1.4 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                  <circle cx="9" cy="9" r="1.2" fill="currentColor" />
                </svg>
              </button>
              {generatedImageTrayOpen && activeGeneratedImages.length > 0 ? (
                <div className="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-[232px] rounded-[8px] border border-ink/10 bg-white p-2 shadow-[0_16px_34px_rgba(15,23,42,0.18)] sm:w-[340px]">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink/45">Generated images</div>
                    <button
                      aria-label="Close generated images"
                      className="flex h-6 w-6 items-center justify-center rounded-[4px] text-ink/45 transition hover:bg-mist hover:text-ink"
                      onClick={() => setGeneratedImageTrayOpen(false)}
                      type="button"
                    >
                      <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                        <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex max-h-[224px] flex-wrap gap-2 overflow-auto overscroll-contain pr-1">
                    {activeGeneratedImages.map((image) => {
                      const latest = image.id === latestGeneratedImage?.id;
                      return (
                        <button
                          className={`h-[100px] w-[100px] overflow-hidden rounded-[6px] border bg-[#f7f1e6] transition hover:border-[#1f6f78]/45 ${
                            latest ? "border-[#1f6f78] ring-2 ring-[#1f6f78]/15" : "border-ink/10"
                          }`}
                          key={image.id}
                          onClick={() => {
                            scrollToGeneratedImage(image.id);
                            setGeneratedImageTrayOpen(false);
                          }}
                          title={image.fileName}
                          type="button"
                        >
                          <img alt={image.fileName} className="h-full w-full object-cover" src={image.url} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {showCameraShortcut ? (
            <button
              aria-label="Scroll to camera"
              className={`flex h-7 w-7 items-center justify-center rounded-[4px] border transition ${
                liveCameraShortcutFlashing
                  ? liveCameraFlashOn
                    ? "border-[#15803d] bg-[#15803d] text-white hover:border-[#166534] hover:bg-[#166534]"
                    : "border-[#86efac] bg-[#dcfce7] text-[#166534] hover:border-[#4ade80] hover:bg-[#bbf7d0]"
                  : "border-ink/10 bg-white text-ink hover:border-ink/25 hover:bg-mist"
              }`}
              onClick={scrollToCameraTarget}
              title="Scroll to camera"
              type="button"
            >
              <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                <path
                  d="M5.5 8.5A1.5 1.5 0 0 1 7 7h2l1.2-1.5h3.6L15 7h2a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 17 18H7a1.5 1.5 0 0 1-1.5-1.5v-8Z"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.7"
                />
                <circle cx="12" cy="12.5" r="3" stroke="currentColor" strokeWidth="1.7" />
              </svg>
            </button>
          ) : null}
          {activeTab === "live" && supportsLive ? (
            <button
              aria-label={liveConnectionRequested ? "Disconnect live talk" : "Connect live talk"}
              className={`flex h-8 w-8 items-center justify-center rounded-[4px] border transition ${
                liveConnectButtonReady
                  ? "border-[#bb3e2d] bg-[#bb3e2d] text-white hover:border-[#a93526] hover:bg-[#a93526]"
                  : liveConnectButtonActive
                    ? "border-[#1f6f78] bg-[#1f6f78] text-white hover:border-[#195d65] hover:bg-[#195d65]"
                  : "border-ink/10 bg-white text-ink hover:border-ink/20 hover:bg-mist"
              }`}
              onClick={() => setLiveConnectionRequested((current) => !current)}
              title={liveConnectionRequested ? "Disconnect live talk" : "Connect live talk"}
              type="button"
            >
              <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                <path d="M12 4.5v7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                <path d="M8 6.8a7 7 0 1 0 8 0" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
              </svg>
            </button>
          ) : null}
          <button
            className="flex h-8 w-8 cursor-ns-resize touch-none items-center justify-center rounded-[4px] bg-white text-ink/45 transition hover:bg-mist"
            onPointerDown={(event) => {
              resizePointerIdRef.current = event.pointerId;
              resizeStartYRef.current = event.clientY;
              resizeStartHeightRef.current = panelHeight;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            title="Resize panel"
            type="button"
          >
            <svg aria-hidden="true" className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24">
              <path
                d="M12 4V20M8.5 7.5L12 4l3.5 3.5M8.5 16.5L12 20l3.5-3.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
              <path d="M7 12H17" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
            </svg>
          </button>
        </div>
      </div>

      {provider === "gemini" ? (
        <>
      <div
        className={`min-h-0 shrink-0 transition-[height] duration-200 ease-out ${composerMenuOpen ? "overflow-visible" : "overflow-hidden"}`}
        style={composerChromeFrameHeight === undefined ? undefined : { height: composerChromeFrameHeight }}
      >
        <div
          className="origin-top-left transition-transform duration-200 ease-out"
          onFocusCapture={expandComposerChrome}
          onPointerDownCapture={expandComposerChrome}
          ref={composerChromeRef}
          style={{
            transform: `scale(${composerChromeScale})`,
            width: compactComposerChrome ? "200%" : "100%",
          }}
        >
      <input
        accept="image/*,audio/*,video/*"
        className="hidden"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) appendFiles(files);
          event.target.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />

      <textarea
        className={`hide-scrollbar w-full resize-none overflow-y-auto rounded-[10px] border px-4 py-3 text-sm leading-6 overscroll-contain transition-[height,background-color,border-color,color] duration-200 ease-out ${
          liveDisconnected
            ? "border-ink/10 bg-[#e8e8e8] text-ink/55 placeholder:text-ink/40"
            : "border-pine/40 bg-[#fffdf8] text-ink placeholder:text-ink/35"
        }`}
        onChange={(event) => {
          setComposerCondensed(false);
          setPrompt(event.target.value);
        }}
        onFocus={() => {
          setComposerFocused(true);
          setComposerCondensed(false);
        }}
        onBlur={() => setComposerFocused(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void handleComposerSubmit();
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file))
            .filter((file) => Boolean(inferMediaKindFromFile(file)));
          if (files.length === 0) return;
          event.preventDefault();
          appendFiles(files);
        }}
        placeholder={
          activeTab === "live"
            ? liveSessionState.ready
              ? "Live talk on, speak with AI now."
              : liveSessionState.status
            : supportsMedia
              ? "Ask Gemini about this note. Press Enter to send, Shift+Enter for a new line."
              : "Send the whole document or ask questions. Press Enter to send, Shift+Enter for a new line."
        }
        style={{ height: composerFocused ? (promptExpanded ? 300 : composerCondensed ? 50 : 130) : 44 }}
        value={prompt}
      />

      {selectedPrompts.length > 0 || attachments.length > 0 ? (
        <div className="mt-3 flex gap-2 overflow-x-auto overscroll-contain pb-1" ref={composerItemsRef}>
          {selectedPrompts.map((selectedPrompt) => (
            <div className="relative shrink-0" key={selectedPrompt.id}>
              <button
                className="group flex h-11 w-[172px] items-center gap-2 overflow-hidden rounded-[10px] border border-ink/10 bg-white px-2 py-2 text-left transition hover:border-ink/25 hover:bg-mist"
                onClick={() => setPreviewPrompt(buildMessagePrompt(selectedPrompt))}
                type="button"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-mist text-ink/70">
                  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                    <path d="M7 7.5h10M7 12h10M7 16.5h6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink/45">Prompt</div>
                  <div className="truncate text-xs font-medium text-ink">{selectedPrompt.name}</div>
                </div>
              </button>
              <button
                aria-label={`Remove ${selectedPrompt.name}`}
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-ink shadow-sm transition hover:bg-mist"
                onClick={() => removePromptTemplate(selectedPrompt.id)}
                type="button"
              >
                <svg aria-hidden="true" className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
          ))}

          {attachments.map((attachment) => (
            <div className="relative shrink-0" key={attachment.id}>
              <button
                className="group flex h-11 w-[172px] items-center gap-2 overflow-hidden rounded-[10px] border border-ink/10 bg-white px-2 py-2 text-left transition hover:border-ink/25 hover:bg-mist"
                onClick={() =>
                  setPreviewAttachment(
                    toPreviewAttachment({
                      fileName: attachment.fileName,
                      kind: attachment.kind,
                      mimeType: attachment.mimeType,
                      url: attachment.previewUrl,
                    }),
                  )
                }
                type="button"
              >
                {attachment.kind === "image" ? (
                  <img alt={attachment.fileName} className="h-7 w-7 shrink-0 rounded-[8px] object-cover" src={attachment.previewUrl} />
                ) : attachment.kind === "video" ? (
                  <video className="h-7 w-7 shrink-0 rounded-[8px] object-cover" muted playsInline preload="metadata" src={attachment.previewUrl} />
                ) : (
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-mist text-ink/70">
                    <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                      <path d="M9 15V9l8-2v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                      <circle cx="7.5" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                      <circle cx="16.5" cy="14.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                    </svg>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink/45">{attachmentBadge(attachment.kind)}</div>
                  <div className="truncate text-xs font-medium text-ink">{attachment.fileName}</div>
                </div>
              </button>
              <button
                aria-label={`Remove ${attachment.fileName}`}
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-ink shadow-sm transition hover:bg-mist"
                onClick={() => removeAttachment(attachment.id)}
                type="button"
              >
                <svg aria-hidden="true" className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="relative mt-3 flex flex-wrap items-center justify-between gap-2 px-0">
        <div className="flex items-center gap-2">
          <button
            aria-expanded={promptPickerOpen}
            aria-label="Add prompt"
            className="relative flex h-10 w-10 items-center justify-center rounded-[10px] border border-ink/10 bg-white text-ink transition hover:border-ink/30 hover:bg-mist"
            onClick={() => {
              setPromptPickerOpen((current) => !current);
              setFolderPickerOpen(false);
            }}
            title="Add prompt"
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
            </svg>
            {selectedPrompts.length > 0 ? (
              <span className="absolute -right-1 -top-1 rounded-full bg-mist px-1.5 py-0.5 text-[9px] font-semibold leading-none text-ink/70">
                {selectedPrompts.length}
              </span>
            ) : null}
          </button>
          <button
            aria-label="Upload media"
            className="flex h-10 w-10 items-center justify-center rounded-[4px] border border-ink/10 bg-white text-ink transition hover:border-ink/30 hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!supportsMedia}
            onClick={() => {
              setPromptPickerOpen(false);
              fileInputRef.current?.click();
            }}
            title={supportsMedia ? "Upload media" : "Switch to Gemini to upload media"}
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path d="M12 16V6M8.5 9.5 12 6l3.5 3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
              <path d="M5 16.5V19h14v-2.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
            </svg>
          </button>
          <button
            aria-expanded={folderPickerOpen}
            aria-label="Choose file from current folder"
            className="flex h-10 w-10 items-center justify-center rounded-[4px] border border-ink/10 bg-white text-ink transition hover:border-ink/30 hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!supportsMedia}
            onClick={() => {
              setPromptPickerOpen(false);
              setFolderPickerOpen((current) => !current);
            }}
            title={supportsMedia ? "Choose file from current folder" : "Switch to Gemini to attach workspace files"}
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path
                d="M4 7.5A1.5 1.5 0 0 1 5.5 6H10l1.4 1.5h7.1A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-10Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.6"
              />
              <path d="M8 12h8M12 8v8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
            </svg>
          </button>
          <button
            aria-label={promptExpanded ? "Collapse prompt" : "Expand prompt"}
            className="flex h-10 w-10 items-center justify-center rounded-[4px] border border-ink/10 bg-white text-ink transition hover:border-ink/30 hover:bg-mist"
            onClick={() => setPromptExpanded((current) => !current)}
            title={promptExpanded ? "Collapse prompt" : "Expand prompt"}
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              {promptExpanded ? (
                <path
                  d="M8 10l4-4l4 4M8 14l4 4l4-4"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                />
              ) : (
                <path
                  d="M14 4h6v6M10 20H4v-6M20 10V4h-6M4 14v6h6"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                />
              )}
            </svg>
          </button>
          {selectedTextForReadAloud ? (
            <button
              aria-label="Read selected text aloud"
              className="flex h-10 w-10 items-center justify-center rounded-[4px] border border-[#1f6f78]/20 bg-[#e5f5f7] text-[#1f6f78] transition hover:border-[#1f6f78]/35 hover:bg-[#d8eef1] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!providerSettings.apiKey || readingSelection || (activeTab === "live" ? !liveSendHandle : busy)}
              onClick={() => void handleReadSelectedText()}
              title={activeTab === "live" ? "Read selected text in Live" : "Generate read-aloud audio"}
              type="button"
            >
              {readingSelection ? (
                <span className="text-[10px] font-medium uppercase tracking-[0.18em]">...</span>
              ) : (
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path d="M5 10v4h3l4 3.5v-11L8 10H5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
                  <path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
                </svg>
              )}
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <div className={`relative ${microphoneMenuOpen ? "z-[90]" : ""}`} ref={microphoneMenuRef}>
            <button
              aria-expanded={microphoneMenuOpen}
              aria-label={recording ? "Release to stop recording" : "Quick tap for microphones, hold 2 seconds to record audio"}
              className={`flex h-10 w-10 items-center justify-center rounded-[4px] border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                recording
                  ? "border-[#bb3e2d] bg-[#bb3e2d] text-white"
                  : activeTab === "live" && liveMicrophoneEnabled
                    ? "border-[#1f6f78] bg-[#e5f5f7] text-[#1f6f78]"
                    : "border-ink/10 bg-white text-ink hover:border-ink/30 hover:bg-mist"
              }`}
              disabled={!supportsMedia || cameraPreparing || cameraRecording}
              onPointerCancel={() => {
                recordHoldActiveRef.current = false;
                clearMicrophoneLongPressTimer();
                if (microphoneLongPressTriggeredRef.current) {
                  void releaseRecording();
                }
              }}
              onPointerDown={(event) => {
                beginMicrophoneInteraction(activeTab === "live" ? "live" : "chat");
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                void finishMicrophoneInteraction();
              }}
              title={
                supportsMedia
                  ? recording
                    ? "Release to stop and send audio"
                    : "Tap for microphone choices, hold 2 seconds to record"
                  : "Switch to Gemini to use microphones"
              }
              type="button"
            >
              {preparingRecording ? (
                <span className="text-[10px] font-medium uppercase tracking-[0.18em]">...</span>
              ) : (
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M12 4.5a2.5 2.5 0 0 1 2.5 2.5v4.5a2.5 2.5 0 0 1-5 0V7a2.5 2.5 0 0 1 2.5-2.5Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                  <path d="M7.5 11.5a4.5 4.5 0 0 0 9 0M12 16v3.5M9 19.5h6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              )}
            </button>
            {microphoneMenuOpen ? (
              <div className="absolute bottom-12 right-0 z-[100] grid min-w-[240px] gap-2 rounded-[16px] border border-ink/10 bg-white p-3 shadow-[0_18px_38px_rgba(15,23,42,0.16)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Microphones</div>
                    <div className="text-xs text-ink/55">
                      {activeTab === "live"
                        ? liveMicrophoneEnabled
                          ? "Live microphone is enabled."
                          : "Live microphone is disabled."
                        : "Choose a microphone or hold to record."}
                    </div>
                  </div>
                  <button
                    className="rounded-full border border-ink/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink transition hover:border-ink/20 hover:bg-mist"
                    onClick={() => (liveMicrophoneEnabled ? disableLiveMicrophone() : enableLiveMicrophone())}
                    type="button"
                  >
                    {liveMicrophoneEnabled ? "Disable" : "Enable"}
                  </button>
                </div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Available microphones</div>
                {microphoneMenuLoading ? (
                  <div className="rounded-[12px] border border-dashed border-ink/10 px-3 py-3 text-xs text-ink/45">Loading microphones...</div>
                ) : microphoneSources.length === 0 ? (
                  <button
                    className="rounded-[12px] border border-dashed border-ink/10 px-3 py-3 text-left text-xs text-ink/55 transition hover:border-ink/20 hover:bg-mist"
                    onClick={() => void refreshMicrophoneSources()}
                    type="button"
                  >
                    Refresh microphone list
                  </button>
                ) : (
                  microphoneSources.map((source) => {
                    const selected = selectedMicrophoneId === source.deviceId;
                    return (
                      <button
                        className={`rounded-[12px] border px-3 py-2 text-left text-sm transition ${
                          selected ? "border-[#1f6f78] bg-[#e5f5f7] text-[#1f6f78]" : "border-ink/10 bg-[#fffdfa] text-ink hover:border-ink/20 hover:bg-mist"
                        }`}
                        key={source.deviceId}
                        onClick={() => selectMicrophoneSource(source.deviceId)}
                        type="button"
                      >
                        {source.label}
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
          {activeTab === "live" ? (
            <div className={`relative ${liveVideoMenuOpen ? "z-[90]" : ""}`} ref={liveVideoMenuRef}>
              <button
                aria-expanded={liveVideoMenuOpen}
                aria-label={liveVideoShareMode ? "Manage live video share" : "Share camera or screen"}
                className={`flex h-10 w-10 items-center justify-center rounded-[4px] border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  liveVideoShareMode ? "border-[#1f6f78] bg-[#e5f5f7] text-[#1f6f78]" : "border-ink/10 bg-white text-ink hover:border-ink/30 hover:bg-mist"
                }`}
                disabled={!liveSendHandle}
                onClick={() => void toggleLiveVideoMenu()}
                title={liveVideoShareMode ? "Manage live video share" : "Share camera or screen"}
                type="button"
              >
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M4.5 7.5A1.5 1.5 0 0 1 6 6h8a1.5 1.5 0 0 1 1.5 1.5v1.3l3-2A1 1 0 0 1 20 7.6v8.8a1 1 0 0 1-1.5.8l-3-2v1.3A1.5 1.5 0 0 1 14 18H6a1.5 1.5 0 0 1-1.5-1.5v-9Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.7"
                  />
                </svg>
              </button>
              {liveVideoMenuOpen ? (
                <div className="absolute bottom-12 right-0 z-[100] grid min-w-[240px] gap-2 rounded-[16px] border border-ink/10 bg-white p-3 shadow-[0_18px_38px_rgba(15,23,42,0.16)]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Live video</div>
                      <div className="text-xs text-ink/55">
                        {liveVideoShareMode
                          ? liveVideoShareMode === "camera"
                            ? liveVideoShareCameraMode === "video"
                              ? "Currently sharing camera video."
                              : "Currently sharing camera snapshots."
                            : "Currently sharing screen."
                          : "Share camera snapshots, camera video, or your screen."}
                      </div>
                    </div>
                    <button
                      className="rounded-full border border-ink/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink transition hover:border-ink/20 hover:bg-mist"
                      onClick={() => {
                        liveVideoControls?.stopVideoShare();
                        setLiveVideoMenuOpen(false);
                      }}
                      type="button"
                    >
                      Disable
                    </button>
                  </div>
                  <button
                    className="flex items-center justify-between rounded-[12px] border border-ink/10 bg-[#fffdfa] px-3 py-2 text-left text-sm text-ink transition hover:border-ink/20 hover:bg-mist"
                    onClick={() => void switchLiveCameraShare()}
                    type="button"
                  >
                    <span>Switch camera</span>
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path d="M6.5 8.5A6 6 0 0 1 17 6.2M17.5 15.5A6 6 0 0 1 7 17.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
                      <path d="M17 3.5v2.8h-2.8M7 20.5v-2.8h2.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
                    </svg>
                  </button>
                  <button
                    className="flex items-center justify-between rounded-[12px] border border-ink/10 bg-[#fffdfa] px-3 py-2 text-left text-sm text-ink transition hover:border-ink/20 hover:bg-mist"
                    onClick={() => void startLiveScreenShare()}
                    type="button"
                  >
                    <span>Share screen snapshot</span>
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v8A1.5 1.5 0 0 1 18.5 16h-13A1.5 1.5 0 0 1 4 14.5v-8Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
                      <path d="M9 19h6M12 16v3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
                    </svg>
                  </button>
                  <button
                    className="flex items-center justify-between rounded-[12px] border border-ink/10 bg-[#fffdfa] px-3 py-2 text-left text-sm text-ink transition hover:border-ink/20 hover:bg-mist"
                    onClick={() => void startLiveScreenShare({ video: true })}
                    type="button"
                  >
                    <span>Share screen video</span>
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path
                        d="M4.5 7.5A1.5 1.5 0 0 1 6 6h8a1.5 1.5 0 0 1 1.5 1.5v1.3l3-2A1 1 0 0 1 20 7.6v8.8a1 1 0 0 1-1.5.8l-3-2v1.3A1.5 1.5 0 0 1 14 18H6a1.5 1.5 0 0 1-1.5-1.5v-9Z"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.6"
                      />
                    </svg>
                  </button>
                  <button
                    className="flex items-center justify-between rounded-[12px] border border-ink/10 bg-[#fffdfa] px-3 py-2 text-left text-sm text-ink transition hover:border-ink/20 hover:bg-mist"
                    onClick={() => void startLiveCameraShare(undefined, { video: false })}
                    type="button"
                  >
                    <span>Share camera snapshots</span>
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path
                        d="M4.5 7.5A1.5 1.5 0 0 1 6 6h8a1.5 1.5 0 0 1 1.5 1.5v1.3l3-2A1 1 0 0 1 20 7.6v8.8a1 1 0 0 1-1.5.8l-3-2v1.3A1.5 1.5 0 0 1 14 18H6a1.5 1.5 0 0 1-1.5-1.5v-9Z"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.6"
                      />
                    </svg>
                  </button>
                  <button
                    className="flex items-center justify-between rounded-[12px] border border-ink/10 bg-[#fffdfa] px-3 py-2 text-left text-sm text-ink transition hover:border-ink/20 hover:bg-mist"
                    onClick={() => void startLiveCameraShare(undefined, { video: true })}
                    type="button"
                  >
                    <span>Share camera video</span>
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path
                        d="M4.5 7.5A1.5 1.5 0 0 1 6 6h8a1.5 1.5 0 0 1 1.5 1.5v1.3l3-2A1 1 0 0 1 20 7.6v8.8a1 1 0 0 1-1.5.8l-3-2v1.3A1.5 1.5 0 0 1 14 18H6a1.5 1.5 0 0 1-1.5-1.5v-9Z"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.6"
                      />
                    </svg>
                  </button>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Camera devices</div>
                  {liveVideoMenuLoading ? (
                    <div className="rounded-[12px] border border-dashed border-ink/10 px-3 py-3 text-xs text-ink/45">Loading cameras...</div>
                  ) : liveVideoSources.length === 0 ? (
                    <button
                      className="rounded-[12px] border border-dashed border-ink/10 px-3 py-3 text-left text-xs text-ink/55 transition hover:border-ink/20 hover:bg-mist"
                      onClick={() => void refreshLiveVideoSources()}
                      type="button"
                    >
                      Refresh camera list
                    </button>
                  ) : (
                    liveVideoSources.map((source) => {
                      const selected = preferredLiveCameraDeviceId === source.deviceId;
                      return (
                        <button
                          className={`rounded-[12px] border px-3 py-2 text-left text-sm transition ${
                            selected ? "border-[#1f6f78] bg-[#e5f5f7] text-[#1f6f78]" : "border-ink/10 bg-[#fffdfa] text-ink hover:border-ink/20 hover:bg-mist"
                          }`}
                          key={source.deviceId}
                          onClick={() => void startLiveCameraShare(source.deviceId)}
                          type="button"
                        >
                          {source.label}
                        </button>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {activeTab === "chat" ? (
            <button
                aria-label={cameraRecording ? "Release to stop video recording" : "Click for photo, hold for video"}
                className={`flex h-10 w-10 items-center justify-center rounded-[4px] border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  cameraRecording
                    ? "border-[#1f6f78] bg-[#1f6f78] text-white"
                    : cameraPreparing
                      ? "border-[#1f6f78] bg-[#e5f5f7] text-[#1f6f78]"
                      : "border-ink/10 bg-white text-ink hover:border-ink/30 hover:bg-mist"
                }`}
                disabled={!supportsMedia || busy || preparingRecording || recording}
                onPointerCancel={() => void releaseCameraCapture()}
                onPointerDown={(event) => {
                  cameraHoldActiveRef.current = true;
                  cameraLongPressTriggeredRef.current = false;
                  clearCameraLongPressTimer();
                  cameraLongPressTimerRef.current = window.setTimeout(() => {
                    cameraLongPressTimerRef.current = null;
                    cameraLongPressTriggeredRef.current = true;
                    if (cameraHoldActiveRef.current && cameraStreamRef.current && cameraRecorderRef.current?.state !== "recording") {
                      startVideoRecording();
                    }
                  }, 2000);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  void startCameraCapture();
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  void releaseCameraCapture();
                }}
                title={
                  supportsMedia
                    ? cameraRecording
                      ? "Release to stop and send video"
                      : "Click for photo, hold 2 seconds for video"
                    : "Switch to Gemini to use camera capture"
                }
                type="button"
              >
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M5.5 8.5A1.5 1.5 0 0 1 7 7h2l1.2-1.5h3.6L15 7h2a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 17 18H7a1.5 1.5 0 0 1-1.5-1.5v-8Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.7"
                  />
                  <circle cx="12" cy="12.5" r="3" stroke="currentColor" strokeWidth="1.7" />
                </svg>
              </button>
          ) : null}
          <button
            aria-label={activeTab === "live" ? "Send to live" : "Ask"}
            className="flex h-10 w-10 items-center justify-center rounded-[4px] bg-ember text-ink transition hover:bg-ember/90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={
              activeTab === "live"
                ? !liveSendHandle || (!prompt.trim() && attachments.length === 0 && selectedPrompts.length === 0)
                : busy || preparingRecording || recording || cameraPreparing || cameraRecording || (!prompt.trim() && attachments.length === 0 && selectedPrompts.length === 0)
            }
            onClick={() => void handleComposerSubmit()}
            type="button"
          >
            {activeTab === "live" && liveSessionState.connecting ? (
              <span className="text-[10px] font-medium uppercase tracking-[0.18em]">...</span>
            ) : busy ? (
              <span className="text-[10px] font-medium uppercase tracking-[0.18em]">...</span>
            ) : (
              <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                <path
                  d="M5 12h12M13 6l6 6-6 6"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                />
              </svg>
            )}
          </button>
        </div>

      {promptPickerOpen ? (
          <div className="mt-3 flex max-h-[360px] w-full flex-col overflow-hidden rounded-[18px] border border-ink/10 bg-white p-3 shadow-[0_12px_28px_rgba(15,23,42,0.08)]">
            <div className="mb-3 shrink-0 flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Prompt Library</div>
                <div className="text-xs text-ink/55">Saved prompts</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-full border border-ink/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink transition hover:border-ink/20 hover:bg-mist"
                  onClick={() => {
                    if (promptCreateOpen) {
                      resetPromptEditor();
                      return;
                    }
                    openPromptEditor();
                  }}
                  type="button"
                >
                  {promptCreateOpen ? "Close" : "Create"}
                </button>
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                  onClick={() => setPromptPickerOpen(false)}
                  type="button"
                >
                  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                  </svg>
                </button>
              </div>
            </div>
            {promptCreateOpen ? (
              <div className="mb-3 shrink-0 grid gap-2 rounded-[10px] border border-ink/10 bg-mist/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/55">
                    {editingPromptId ? "Edit Prompt" : "Create Prompt"}
                  </div>
                  {editingPromptId ? (
                    <button
                      className="rounded-full border border-ink/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink transition hover:border-ink/20 hover:bg-white"
                      onClick={resetPromptEditor}
                      type="button"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
                <input
                  className="rounded-[10px] border border-ink/10 bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/35 focus:border-ink/30"
                  onChange={(event) => setPromptNameDraft(event.target.value)}
                  placeholder="Prompt name"
                  value={promptNameDraft}
                />
                <textarea
                  className="min-h-28 rounded-[10px] border border-ink/10 bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/35 focus:border-ink/30"
                  onChange={(event) => setPromptContentDraft(event.target.value)}
                  placeholder="Prompt content"
                  value={promptContentDraft}
                />
                <div className="flex justify-end">
                  <button
                    className="rounded-[10px] bg-ink px-3 py-2 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={creatingPrompt || !promptNameDraft.trim() || !promptContentDraft.trim()}
                    onClick={() => void savePromptTemplate()}
                    type="button"
                  >
                    {creatingPrompt ? "Saving..." : editingPromptId ? "Save changes" : "Save prompt"}
                  </button>
                </div>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 touch-pan-y">
              <div className="flex flex-wrap gap-2">
              {availablePrompts.map((item) => {
                const selected = selectedPrompts.some((promptItem) => promptItem.id === item.id);
                return (
                  <div className="relative" key={item.id}>
                    <button
                      className={`flex h-[100px] w-[140px] flex-col overflow-hidden rounded-[12px] border px-4 py-4 text-left transition ${
                        selected ? "border-ink bg-mist" : "border-ink/10 bg-[#fffdfa] hover:border-ink/20 hover:bg-mist"
                      }`}
                      onClick={() => addPromptTemplate(item)}
                      type="button"
                    >
                      <div className="min-w-0 pr-3">
                        <div className="line-clamp-2 break-words text-[10px] font-semibold leading-4 text-ink">{item.name}</div>
                        <div className="mt-2 line-clamp-3 break-words text-[9px] leading-3 text-ink/50">{item.content}</div>
                      </div>
                    </button>
                    {!item.builtin ? (
                      <button
                        aria-label={`Edit ${item.name}`}
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-[8px] border border-ink/10 bg-white/95 text-ink transition hover:border-ink/20 hover:bg-mist"
                        onClick={() => openPromptEditor(item)}
                        type="button"
                      >
                        <svg aria-hidden="true" className="h-3 w-3" fill="none" viewBox="0 0 24 24">
                          <path
                            d="M4 20h4l9.5-9.5a1.4 1.4 0 0 0 0-2L15.5 6a1.4 1.4 0 0 0-2 0L4 15.5V20Z"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.6"
                          />
                          <path d="M12.5 7l4.5 4.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                );
              })}
              </div>
            </div>
          </div>
        ) : null}

        {folderPickerOpen ? (
          <div className="mt-3 w-full rounded-[18px] border border-ink/10 bg-white p-3 shadow-[0_12px_28px_rgba(15,23,42,0.08)]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Current Folder Files</div>
                <div className="text-xs text-ink/55">{currentFolderName}</div>
              </div>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                onClick={() => setFolderPickerOpen(false)}
                type="button"
              >
                <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
            <div className="max-h-52 overflow-auto overscroll-contain pr-1">
              {currentFolderFiles.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-ink/10 px-3 py-4 text-sm text-ink/45">
                  No image, audio, or video files in this folder yet.
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {currentFolderFiles.map((asset) => (
                    <button
                      className="flex items-start justify-between gap-3 rounded-[14px] border border-ink/10 bg-[#fffdfa] px-3 py-3 text-left transition hover:border-ink/20 hover:bg-mist"
                      key={asset.id}
                      onClick={() => addFolderAsset(asset)}
                      type="button"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">{asset.fileName}</div>
                        <div className="mt-1 text-xs text-ink/45">{asset.mimeType}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/55">
                        {attachmentBadge(asset.kind)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
        </div>
      </div>

      <div className={`${compactComposerChrome ? "mt-1" : "mt-4"} min-h-0 flex-1 transition-[margin] duration-200 ease-out`}>
        <div
          className="h-full overflow-auto overscroll-contain rounded-[4px] bg-mist/80 pb-0 pl-3 pr-0 pt-3"
          hidden={activeTab !== "chat"}
          onClick={() => {
            focusHistory();
            if (!promptExpanded) {
              setComposerCondensed(true);
            }
          }}
          onPointerDown={focusHistory}
          onScroll={updateChatHistoryScrollState}
          onTouchMove={focusHistory}
          onWheel={focusHistory}
          ref={messagesContainerRef}
        >
          <div className="flex flex-col gap-3">
            {messages.map((message) => {
              const edits = message.substitutions ?? [];
              const generatedImageAttachments =
                message.role === "assistant"
                  ? (message.attachments ?? []).filter((attachment) => attachment.kind === "image" && attachment.url)
                  : [];
              const generatedAudioAttachments =
                message.role === "assistant"
                  ? (message.attachments ?? []).filter((attachment) => attachment.kind === "audio" && attachment.url && attachment.origin === "generated")
                  : [];
              const compactAttachments =
                message.role === "assistant"
                  ? (message.attachments ?? []).filter(
                      (attachment) =>
                        (attachment.kind !== "image" || !attachment.url) &&
                        !(attachment.kind === "audio" && attachment.url && attachment.origin === "generated"),
                    )
                  : (message.attachments ?? []);
              return (
                <div
                  className={`max-w-[92%] rounded-[4px] px-3 py-2 text-sm ${message.role === "assistant" ? "bg-white" : "self-end bg-ink text-white"}`}
                  key={message.id}
                  ref={message.id === latestAssistantMessageId ? latestAssistantMessageRef : null}
                  style={message.role === "user" ? { minWidth: "min(400px, 92%)" } : undefined}
                >
                  {message.prompts?.length || compactAttachments.length ? (
                    <div className="flex gap-2 overflow-x-auto overscroll-contain pb-1">
                      {message.prompts?.map((promptItem) => (
                        <button
                          className={`shrink-0 rounded-[10px] border px-3 py-2 text-left text-xs transition ${
                            message.role === "assistant"
                              ? "border-ink/10 bg-mist text-ink hover:border-ink/20"
                              : "border-white/10 bg-white/10 text-white hover:bg-white/15"
                          }`}
                          key={promptItem.id}
                          onClick={() => setPreviewPrompt(promptItem)}
                          type="button"
                        >
                          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] opacity-70">Prompt</div>
                          <div className="max-w-48 truncate font-medium">{promptItem.name}</div>
                        </button>
                      ))}
                      {compactAttachments.map((attachment) => {
                        const cardTone =
                          message.role === "assistant"
                            ? "border-ink/10 bg-mist text-ink hover:border-ink/20"
                            : "border-white/10 bg-white/10 text-white hover:bg-white/15";
                        const labelTone = message.role === "assistant" ? "text-ink/45" : "text-white/65";
                        const iconTone = message.role === "assistant" ? "bg-white text-ink/70" : "bg-white/10 text-white/80";
                        const cameraCapture =
                          message.role === "user" && (attachment.fileName.startsWith("photo-") || attachment.fileName.startsWith("video-"));
                        return (
                          <button
                            className={`flex h-11 w-[172px] shrink-0 items-center gap-2 overflow-hidden rounded-[10px] border px-2 py-2 text-left transition ${cardTone}`}
                            data-chat-camera-media={cameraCapture ? "true" : undefined}
                            data-chat-camera-media-id={cameraCapture ? attachment.id : undefined}
                            disabled={!attachment.url}
                            key={attachment.id}
                            onClick={() => {
                              const preview = toPreviewAttachment(attachment);
                              if (preview) setPreviewAttachment(preview);
                            }}
                            type="button"
                          >
                            {attachment.kind === "image" && attachment.url ? (
                              <img alt={attachment.fileName} className="h-7 w-7 shrink-0 rounded-[8px] object-cover" src={attachment.url} />
                            ) : null}
                            {attachment.kind === "video" && attachment.url ? (
                              <video className="h-7 w-7 shrink-0 rounded-[8px] object-cover" muted playsInline preload="metadata" src={attachment.url} />
                            ) : null}
                            {attachment.kind === "audio" ? (
                              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] ${iconTone}`}>
                                <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                                  <path d="M9 15V9l8-2v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                                  <circle cx="7.5" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                                  <circle cx="16.5" cy="14.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                                </svg>
                              </div>
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <div className={`text-[9px] font-semibold uppercase tracking-[0.14em] ${labelTone}`}>
                                {attachmentBadge(attachment.kind)}
                              </div>
                              <div className="truncate text-xs font-medium">{attachment.fileName}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {generatedImageAttachments.length > 0 ? (
                    <div className={`${message.prompts?.length || compactAttachments.length ? "mt-3" : ""} grid gap-3 sm:grid-cols-2`}>
                      {generatedImageAttachments.map((attachment) => renderGeneratedImageCard(attachment))}
                    </div>
                  ) : null}
                  {generatedAudioAttachments.length > 0 ? (
                    <div
                      className={`${
                        message.prompts?.length || compactAttachments.length || generatedImageAttachments.length ? "mt-3" : ""
                      } grid gap-2`}
                    >
                      {generatedAudioAttachments.map((attachment) => (
                        <div className="rounded-[8px] border border-ink/10 bg-mist/70 px-3 py-3" key={attachment.id}>
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink/45">Read aloud</div>
                              <div className="truncate text-xs font-medium text-ink">{attachment.fileName}</div>
                            </div>
                          </div>
                          <audio className="h-10 w-full" controls preload="metadata" src={attachment.url} />
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div
                    className={`${
                      message.prompts?.length || compactAttachments.length || generatedImageAttachments.length || generatedAudioAttachments.length ? "mt-3" : ""
                    } whitespace-pre-wrap break-words`}
                  >
                    {message.content}
                  </div>
                  {message.role === "assistant" && edits.length > 0 ? (
                    <div className="mt-3 grid gap-2">
                      {edits.map((edit, index) => (
                        <div className="rounded-[14px] border border-ink/10 bg-[#fff7e8] px-3 py-3" key={`${message.id}:edit:${index}`}>
                          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink/45">Suggested replace</div>
                          <div className="mt-2 whitespace-pre-wrap break-words text-sm text-[#8c5c54] line-through">{edit.find}</div>
                          <div className="mt-2 whitespace-pre-wrap break-words text-sm text-[#1f6f78]">{edit.replace}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div aria-hidden="true" className="shrink-0 rounded-t-[20px]" style={{ height: 300 }} />
          </div>
        </div>

        <div className="h-full p-0" hidden={activeTab !== "live"}>
          <LiveTalkPanel
            active={activeTab === "live"}
            currentNoteBodyMarkdown={currentNoteBodyMarkdown}
            currentNoteId={currentNoteId}
            currentNoteTitle={currentNoteTitle}
            currentSelectedText={selectedTextForReadAloud}
            microphoneDeviceId={selectedMicrophoneId}
            microphoneEnabled={liveMicrophoneEnabled}
            noteCatalog={noteCatalog}
            onError={onError}
            onApplyEdits={onApply}
            onAppendToCurrentNote={onAppendToCurrentNote}
            onHistoryInteract={focusHistory}
            onHistoryTargetsChange={handleLiveHistoryTargetsChange}
            onImageGenerationStateChange={setImageGenerationActive}
            onInsertGeneratedImageInNote={onInsertGeneratedImageInNote}
            onFindInNote={onFindInNote}
            onLatestMessageStateChange={handleLiveLatestMessageStateChange}
            onOpenNote={onOpenNote}
            onScrollNote={onScrollNote}
            onRegisterHistoryControls={setLiveHistoryControls}
            onRegisterSend={setLiveSendHandle}
            onRegisterVideoControls={setLiveVideoControls}
            onSessionStateChange={setLiveSessionState}
            onDisconnectRequest={() => setLiveConnectionRequested(false)}
            onVideoShareStateChange={handleLiveVideoShareStateChange}
            onUploadImageToCurrentFolder={onUploadImageToCurrentFolder}
            providerSettings={providerSettings}
            sessionRequested={supportsLive && liveConnectionRequested}
            speechPrompt={composePrompt(prompt, selectedPrompts)}
          />
        </div>
      </div>

      {previewAttachment ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4">
          <div className="max-h-[92vh] w-full max-w-[90vw] overflow-auto rounded-[16px] border border-white/10 bg-[#fff9ef] p-4 shadow-[0_20px_42px_rgba(15,23,42,0.24)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">{attachmentBadge(previewAttachment.kind)}</div>
                <div className="truncate text-sm font-medium text-ink">{previewAttachment.fileName}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {previewAttachment.kind === "image" ? (
                  <button
                    aria-label="Upload image to current folder"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                    onClick={confirmUploadPreviewImage}
                    title="Upload to current folder"
                    type="button"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path d="M12 16V5M8 9l4-4 4 4M5 19h14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                    </svg>
                  </button>
                ) : null}
                <button
                  aria-label="Close preview"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                  onClick={() => setPreviewAttachment(null)}
                  type="button"
                >
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="mt-3 flex justify-center overflow-auto rounded-[12px] border border-ink/10 bg-black/5 p-2">
              {previewAttachment.kind === "image" ? (
                <img alt={previewAttachment.fileName} className="h-auto max-w-[90%] object-contain" src={previewAttachment.previewUrl} />
              ) : previewAttachment.kind === "video" ? (
                <video autoPlay className="max-h-[320px] w-full rounded-[8px]" controls playsInline src={previewAttachment.previewUrl} />
              ) : (
                <audio autoPlay className="w-full" controls src={previewAttachment.previewUrl} />
              )}
            </div>
          </div>
        </div>
      ) : null}
      {previewPrompt ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-lg rounded-[16px] border border-white/10 bg-[#fff9ef] p-4 shadow-[0_20px_42px_rgba(15,23,42,0.24)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Prompt</div>
                <div className="truncate text-sm font-medium text-ink">{previewPrompt.name}</div>
              </div>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                onClick={() => setPreviewPrompt(null)}
                type="button"
              >
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
            <div className="mt-3 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-[12px] border border-ink/10 bg-white px-3 py-3 text-sm leading-6 text-ink">
              {previewPrompt.content}
            </div>
          </div>
        </div>
      ) : null}
      <div
        className={`pointer-events-none absolute left-3 top-3 z-20 inline-flex max-w-[calc(100%_-_24px)] overflow-hidden rounded-[8px] border border-white/20 bg-black shadow-[0_14px_32px_rgba(0,0,0,0.28)] transition-opacity ${
          cameraPreviewVisible ? "opacity-100" : "opacity-0"
        }`}
        data-chat-camera-preview="true"
      >
        <video className="h-[150px] w-auto max-w-full object-contain" muted playsInline ref={cameraVideoRef} />
      </div>
      </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-md rounded-[4px] border border-ink/10 bg-mist/40 px-4 py-6 text-sm text-ink/65">
            Live talk is only available with the Gemini provider.
          </div>
        </div>
      )}
    </Panel>
  );
}
