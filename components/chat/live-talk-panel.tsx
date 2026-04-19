"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { stripMarkdown } from "@/lib/editor/markdown";
import type { AIMediaKind, ProviderSettings, TextSubstitution } from "@/shared/types";

type LiveGeneratedImage = {
  id: string;
  fileName: string;
  mimeType: string;
  origin: "camera" | "generated";
  url: string;
  dataBase64: string;
};

type LiveTurn = {
  id: string;
  role: "user" | "assistant" | "status";
  content: string;
  audioUrl?: string;
  images?: LiveGeneratedImage[];
  substitutions?: TextSubstitution[];
  videoStream?: MediaStream | null;
  videoMode?: "camera" | "screen";
};

type ScreenShareSendMode = "screenshot" | "video";

type LiveMessage =
  | {
      setupComplete?: unknown;
      serverContent?: {
        turnComplete?: boolean;
        interrupted?: boolean;
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        modelTurn?: {
          parts?: Array<{
            text?: string;
            inlineData?: { data?: string; mimeType?: string };
          }>;
        };
      };
      goAway?: { timeLeft?: string };
      sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
      toolCall?: {
        functionCalls?: Array<{
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        }>;
      };
      toolCallCancellation?: {
        ids?: string[];
      };
    }
  | {
      error?: { message?: string };
    };

type LiveSessionState = {
  connecting: boolean;
  ready: boolean;
  status: string;
};

export type LiveSendAttachment = {
  kind: AIMediaKind;
  fileName: string;
  mimeType: string;
  file?: File;
  url?: string;
};

export type LiveSendHandle = {
  sendAttachment: (attachment: LiveSendAttachment) => Promise<boolean>;
  sendText: (text: string, options?: { displayText?: string }) => boolean;
};

export type LiveVideoSource = {
  deviceId: string;
  label: string;
};

export type LiveVideoControls = {
  listSources: () => Promise<LiveVideoSource[]>;
  startCameraShare: (deviceId?: string) => Promise<boolean>;
  switchCameraShare: () => Promise<boolean>;
  startScreenShare: (options?: { video?: boolean }) => Promise<boolean>;
  stopVideoShare: () => void;
};

export type LiveVideoShareState = {
  mode: "camera" | "screen" | null;
  cameraDeviceId?: string | null;
  screenMode?: ScreenShareSendMode | null;
};

export type LiveHistoryControls = {
  scrollToLatest: () => void;
  scrollToCamera: () => void;
  scrollToGeneratedImage: (imageId?: string) => void;
};

export type LiveHistoryImage = {
  id: string;
  fileName: string;
  url: string;
};

export type LiveHistoryTargets = {
  hasCamera: boolean;
  hasGeneratedImage: boolean;
  generatedImages: LiveHistoryImage[];
};

type LiveImageContext = {
  id: string;
  kind: "image";
  fileName: string;
  mimeType: string;
  source: "upload" | "folder";
  dataBase64: string;
};

const LIVE_IMAGE_GENERATION_NOTICE = "i'll generate image now";

function formatSelectedTextContext(selection: string) {
  return `user selected:${selection.trim()}\nendselected\n\n`;
}

function LiveStreamPreview({
  className,
  stream,
}: {
  className?: string;
  stream: MediaStream;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(() => undefined);
    return () => {
      element.pause();
      element.srcObject = null;
    };
  }, [stream]);

  return <video autoPlay className={className} muted playsInline ref={videoRef} />;
}

function base64ToUint8Array(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pcm16ToFloat32Array(bytes: Uint8Array) {
  const sampleCount = Math.floor(bytes.length / 2);
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }

  return samples;
}

function resampleFloat32Array(input: Float32Array, inputRate: number, outputRate: number) {
  if (inputRate === outputRate) {
    return input;
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const weight = position - leftIndex;
    output[index] = input[leftIndex] * (1 - weight) + input[rightIndex] * weight;
  }

  return output;
}

function float32ToBase64Pcm16(input: Float32Array) {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < input.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, input[index] ?? 0));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function audioBufferToMonoFloat32Array(buffer: AudioBuffer) {
  if (buffer.numberOfChannels <= 1) {
    return buffer.getChannelData(0);
  }

  const mono = new Float32Array(buffer.length);
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex += 1) {
      mono[sampleIndex] += (channel[sampleIndex] ?? 0) / buffer.numberOfChannels;
    }
  }
  return mono;
}

async function decodeAudioBlobToPcm16ChunksBase64(blob: Blob, sampleRate = 16000, chunkSize = 3200) {
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Audio decoding is not supported in this browser.");
  }

  const context = new AudioContextCtor();
  try {
    const sourceBuffer = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(sourceBuffer.slice(0));
    const mono = audioBufferToMonoFloat32Array(decoded);
    const resampled = resampleFloat32Array(mono, decoded.sampleRate, sampleRate);
    const chunks: string[] = [];

    for (let offset = 0; offset < resampled.length; offset += chunkSize) {
      chunks.push(float32ToBase64Pcm16(resampled.subarray(offset, Math.min(offset + chunkSize, resampled.length))));
    }

    return chunks;
  } finally {
    context.close().catch(() => undefined);
  }
}

function pcm16ChunksToWavUrl(chunks: Uint8Array[], sampleRate: number) {
  const dataLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (dataLength === 0) {
    return null;
  }

  const wavBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wavBuffer);
  const bytes = new Uint8Array(wavBuffer);
  let offset = 0;

  const writeString = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index));
      offset += 1;
    }
  };

  writeString("RIFF");
  view.setUint32(offset, 36 + dataLength, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * 2, true);
  offset += 4;
  view.setUint16(offset, 2, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, dataLength, true);
  offset += 4;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return URL.createObjectURL(new Blob([wavBuffer], { type: "audio/wav" }));
}

function base64ToObjectUrl(base64: string, mimeType: string) {
  const bytes = base64ToUint8Array(base64);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function buildLiveWebSocketUrl(apiUrl: string, apiKey: string) {
  const base = apiUrl.replace(/\/$/, "");
  const wsBase = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${wsBase}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}&alt=ws`;
}

function buildNoteContext(title: string, bodyMarkdown: string) {
  const noteText = stripMarkdown(bodyMarkdown);
  const content = noteText ? `${title}\n\n${noteText}` : `${title}\n\nThis note is currently empty.`;
  return [
    "You are a live voice assistant inside a note editor.",
    "Use the current note as the active context for the conversation.",
    "Keep responses concise, conversational, and helpful.",
    "If the user asks you to create, generate, draw, design, render, or edit an image, call the generate_image tool instead of claiming you cannot generate images.",
    `Before calling generate_image, first reply exactly: ${LIVE_IMAGE_GENERATION_NOTICE}`,
    "If the user asks you to rewrite, edit, fix, shorten, expand, or transform the note text, call suggest_note_edits.",
    "If the user wants to change an uploaded image or a previously generated image, you must call generate_image with the edit request.",
    "Do not answer that you will only describe the current image or combine text instructions manually.",
    "The app keeps the most recent uploaded or generated image as the current source image and automatically uploads it to the image API when you call generate_image for an edit.",
    "When the user says modify, change, edit, restyle, remove something from, add something to, or make variations of the current image, treat that as an image edit request and call the tool.",
    "After the tool returns, briefly describe what was generated and mention any notable constraints or variations.",
    "If the user asks you to look through their camera, inspect a physical object, read a page in front of the device, or watch something in the room, call start_camera_share.",
    "If the user asks to switch, flip, or change cameras, call switch_camera_share. This is useful on phones with more than one camera.",
    "If the user asks you to take, shoot, snap, or capture a photo/image from the current camera feed, call capture_camera_shot.",
    "If the user asks you to see their screen, browser tab, desktop, app, code editor, or UI, call start_screen_share with screenshot mode unless they explicitly ask for live or continuous screen video.",
    "Screenshot screen sharing sends one current screen image with each user turn. Prefer it over live screen video to save tokens.",
    "If you need a specific camera, call list_available_cameras first.",
    "If the user asks to stop sharing video, call stop_video_share.",
    "Do not tell the user to press the camera or screen-share UI if a tool call can do it. Use the tool call so the browser can prompt for permission.",
    "If it is unclear whether the user means camera or screen, ask a short clarifying question.",
    "When the note content is shared, respond with a spoken-style answer that helps the user explore it.",
    "",
    "Current note:",
    content,
  ].join("\n");
}

const generateImageFunctionDeclaration = {
  name: "generate_image",
  description:
    "Generate or edit an image with the configured Gemini image model. Use this whenever the user asks for an image, illustration, photo, icon, poster, wallpaper, or image edit. If the user refers to an uploaded image or the last generated image, treat the request as an image edit. For edits, the app automatically uploads the current source image to the image API when this tool is called.",
  parameters: {
    type: "OBJECT",
    properties: {
      prompt: {
        type: "STRING",
        description:
          "The full image generation prompt. Include the user's requested subject, style, composition, and any editing instructions.",
      },
      aspect_ratio: {
        type: "STRING",
        description: "Optional aspect ratio like 1:1, 4:3, 3:4, 16:9, or 9:16.",
      },
    },
    required: ["prompt"],
  },
};

const suggestNoteEditsFunctionDeclaration = {
  name: "suggest_note_edits",
  description:
    "Suggest precise replace-based note edits for the current note. Use this when the user asks to rewrite, fix, shorten, expand, or change the note text itself.",
  parameters: {
    type: "OBJECT",
    properties: {
      prompt: {
        type: "STRING",
        description:
          "The user's requested note edit instruction. Include what to change, rewrite, fix, or replace in the note.",
      },
    },
    required: ["prompt"],
  },
};

const listAvailableCamerasFunctionDeclaration = {
  name: "list_available_cameras",
  description:
    "List the cameras that the browser can share with the live session. Use this when the user asks what cameras are available or when you need to choose a specific camera.",
  parameters: {
    type: "OBJECT",
    properties: {},
  },
};

const startCameraShareFunctionDeclaration = {
  name: "start_camera_share",
  description:
    "Start camera sharing so Gemini can see the user's camera feed in the live session. Use this when the user wants to show something in front of the camera.",
  parameters: {
    type: "OBJECT",
    properties: {
      device_id: {
        type: "STRING",
        description: "Optional camera device id returned by list_available_cameras.",
      },
    },
  },
};

const switchCameraShareFunctionDeclaration = {
  name: "switch_camera_share",
  description:
    "Switch the live camera share to the next available camera. Use this when the user asks to switch, flip, or change cameras, especially on a phone with front and rear cameras.",
  parameters: {
    type: "OBJECT",
    properties: {},
  },
};

const captureCameraShotFunctionDeclaration = {
  name: "capture_camera_shot",
  description:
    "Capture a still image from the active live camera feed. Use this when the user asks to take, shoot, snap, or capture a photo/image from the camera. If camera sharing is not active, call start_camera_share first.",
  parameters: {
    type: "OBJECT",
    properties: {},
  },
};

const startScreenShareFunctionDeclaration = {
  name: "start_screen_share",
  description:
    "Start screen sharing so Gemini can see the user's screen. Use screenshot mode by default to receive one still image with each user turn. Use video mode only when the user explicitly asks for live/continuous screen video.",
  parameters: {
    type: "OBJECT",
    properties: {
      mode: {
        type: "STRING",
        description: "Optional. Use 'screenshot' by default. Use 'video' only for explicit live or continuous screen video requests.",
      },
    },
  },
};

const stopVideoShareFunctionDeclaration = {
  name: "stop_video_share",
  description: "Stop the current camera or screen share in the live session.",
  parameters: {
    type: "OBJECT",
    properties: {},
  },
};

async function readWebSocketMessageText(data: MessageEvent["data"]) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data);
}

function shouldEditWithLiveImage(prompt: string, hasImageContext: boolean) {
  if (!hasImageContext) return false;

  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;

  const editVerbPattern =
    /\b(edit|restyle|transform|change|replace|remove|add|extend|expand|recolor|retouch|cleanup|crop|erase|modify|adjust|turn)\b/;
  const imageReferencePattern =
    /\b(this image|that image|the image|uploaded image|attached image|source image|previous image|last image|generated image|same image|same photo|same picture)\b/;
  const pronounEditPattern = /\b(make|turn|change|edit|transform)\s+(it|this|that)\b/;

  return editVerbPattern.test(normalized) || imageReferencePattern.test(normalized) || pronounEditPattern.test(normalized);
}

function readBlobAsBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read media."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64] = result.split(",", 2);
      if (!base64) {
        reject(new Error("Failed to encode media."));
        return;
      }
      resolve(base64);
    };
    reader.readAsDataURL(blob);
  });
}

async function waitForVideoFrame(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const handleLoadedData = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Video preview failed to start."));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("error", handleError);
    };

    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("error", handleError);
  });
}

async function loadAttachmentBlob(attachment: LiveSendAttachment) {
  if (attachment.file) {
    return attachment.file;
  }
  if (!attachment.url) {
    throw new Error(`"${attachment.fileName}" is missing file data.`);
  }
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to load ${attachment.fileName}.`);
  }
  return response.blob();
}

async function captureVideoFrameAsJpegBase64(blob: Blob) {
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.src = objectUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await video.play().catch(() => undefined);
    await waitForVideoFrame(video);
    video.pause();

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Video frame capture is not supported in this browser.");
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frameBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((nextBlob) => {
        if (!nextBlob) {
          reject(new Error("Failed to capture a video frame."));
          return;
        }
        resolve(nextBlob);
      }, "image/jpeg", 0.9);
    });
    return readBlobAsBase64(frameBlob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function LiveTalkPanel({
  active,
  currentNoteBodyMarkdown,
  currentNoteTitle,
  currentSelectedText,
  microphoneDeviceId,
  microphoneEnabled,
  onApplyEdits,
  onError,
  onRegisterSend,
  onRegisterVideoControls,
  onRegisterHistoryControls,
  onHistoryInteract,
  onHistoryTargetsChange,
  onImageGenerationStateChange,
  onLatestMessageStateChange,
  onSessionStateChange,
  onVideoShareStateChange,
  onUploadImageToCurrentFolder,
  providerSettings,
  sessionRequested,
}: {
  active: boolean;
  currentNoteBodyMarkdown: string;
  currentNoteTitle: string;
  currentSelectedText?: string;
  microphoneDeviceId?: string | null;
  microphoneEnabled?: boolean;
  onApplyEdits?: (edits: TextSubstitution[]) => void;
  onError: (message: string) => void;
  onRegisterSend?: ((send: LiveSendHandle | null) => void) | undefined;
  onRegisterVideoControls?: ((controls: LiveVideoControls | null) => void) | undefined;
  onRegisterHistoryControls?: ((controls: LiveHistoryControls | null) => void) | undefined;
  onHistoryInteract?: (() => void) | undefined;
  onHistoryTargetsChange?: ((targets: LiveHistoryTargets) => void) | undefined;
  onImageGenerationStateChange?: ((generating: boolean) => void) | undefined;
  onLatestMessageStateChange?: ((available: boolean) => void) | undefined;
  onSessionStateChange?: ((state: LiveSessionState) => void) | undefined;
  onVideoShareStateChange?: ((state: LiveVideoShareState) => void) | undefined;
  onUploadImageToCurrentFolder?: ((attachment: { fileName: string; mimeType: string; previewUrl: string }) => Promise<void>) | undefined;
  providerSettings: ProviderSettings;
  sessionRequested: boolean;
}) {
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Open the Live tab to start a session.");
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [previewImage, setPreviewImage] = useState<LiveGeneratedImage | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [focusedVideoTurnId, setFocusedVideoTurnId] = useState<string | null>(null);
  const [expandedVideoTurnIds, setExpandedVideoTurnIds] = useState<Set<string>>(() => new Set());
  const [activeVideoTurnId, setActiveVideoTurnId] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<{ id: string; content: string } | null>(null);
  const liveHistoryRef = useRef<HTMLDivElement>(null);
  const wasNearLiveHistoryBottomRef = useRef(true);
  const historyNoticeTimerRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamDeviceIdRef = useRef<string | null>(null);
  const microphoneAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const microphoneProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const microphoneSinkRef = useRef<GainNode | null>(null);
  const nextAudioTimeRef = useRef(0);
  const assistantPlaybackMutedUntilRef = useRef(0);
  const liveAssistantTurnIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const activeRef = useRef(active);
  const microphoneCaptureEnabledRef = useRef(active && (microphoneEnabled ?? true));
  const microphoneEnabledRef = useRef(microphoneEnabled ?? true);
  const preferredMicrophoneDeviceIdRef = useRef<string | null>(microphoneDeviceId ?? null);
  const requestMicrophoneRef = useRef<() => Promise<MediaStream | null>>(async () => null);
  const resetMicrophoneRef = useRef(() => {});
  const noteContext = useMemo(() => buildNoteContext(currentNoteTitle, currentNoteBodyMarkdown), [currentNoteBodyMarkdown, currentNoteTitle]);
  const noteContextRef = useRef(noteContext);
  const noteTitleRef = useRef(currentNoteTitle);
  const noteBodyMarkdownRef = useRef(currentNoteBodyMarkdown);
  const onApplyEditsRef = useRef(onApplyEdits);
  const onVideoShareStateChangeRef = useRef(onVideoShareStateChange);
  const sendLiveHandleRef = useRef<LiveSendHandle>({
    sendText: () => false,
    sendAttachment: async () => false,
  });
  const socketSessionIdRef = useRef(0);
  const userTurnIdRef = useRef<string | null>(null);
  const userAudioChunksRef = useRef<Uint8Array[]>([]);
  const pendingUserAudioChunksRef = useRef<Array<{ encodedAudio: string; bytes: Uint8Array }>>([]);
  const userAudioActiveRef = useRef(false);
  const userAudioSpeechStartMsRef = useRef(0);
  const userAudioTrailingSilenceMsRef = useRef(0);
  const assistantAudioChunksRef = useRef<Uint8Array[]>([]);
  const audioUrlsRef = useRef<string[]>([]);
  const generatedImageUrlsRef = useRef<string[]>([]);
  const latestImageContextRef = useRef<LiveImageContext | null>(null);
  const videoShareStreamRef = useRef<MediaStream | null>(null);
  const videoShareElementRef = useRef<HTMLVideoElement | null>(null);
  const videoShareCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoShareIntervalRef = useRef<number | null>(null);
  const videoShareModeRef = useRef<"camera" | "screen" | null>(null);
  const screenShareSendModeRef = useRef<ScreenShareSendMode | null>(null);
  const currentCameraDeviceIdRef = useRef<string | null>(null);
  const currentCameraLabelRef = useRef<string | null>(null);
  const videoShareTurnIdRef = useRef<string | null>(null);
  const captureVideoShareShotRef = useRef<() => Promise<void>>(async () => {});
  const cancelledToolCallIdsRef = useRef<Set<string>>(new Set());
  const finalizeUserAudioRef = useRef(() => {});
  const appliedNoteContextRef = useRef(noteContext);
  const currentSelectedTextRef = useRef(currentSelectedText?.trim() ?? "");
  const userAudioSelectionContextRef = useRef("");
  const noteReconnectTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pendingGeneratedImageScrollRef = useRef(false);

  const showHistoryNotice = useCallback((content: string) => {
    if (historyNoticeTimerRef.current) {
      window.clearTimeout(historyNoticeTimerRef.current);
    }
    setHistoryNotice({
      id: `notice:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      content,
    });
    wasNearLiveHistoryBottomRef.current = true;
    historyNoticeTimerRef.current = window.setTimeout(() => {
      historyNoticeTimerRef.current = null;
      setHistoryNotice(null);
    }, 5000);
  }, []);

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useEffect(() => {
    noteContextRef.current = noteContext;
    noteTitleRef.current = currentNoteTitle;
    noteBodyMarkdownRef.current = currentNoteBodyMarkdown;
    currentSelectedTextRef.current = currentSelectedText?.trim() ?? "";
  }, [currentSelectedText, noteContext]);

  useEffect(
    () => () => {
      if (noteReconnectTimerRef.current) {
        window.clearTimeout(noteReconnectTimerRef.current);
        noteReconnectTimerRef.current = null;
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (historyNoticeTimerRef.current) {
        window.clearTimeout(historyNoticeTimerRef.current);
        historyNoticeTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!sessionRequested || !ready || noteContext === appliedNoteContextRef.current) {
      if (noteReconnectTimerRef.current) {
        window.clearTimeout(noteReconnectTimerRef.current);
        noteReconnectTimerRef.current = null;
      }
      return;
    }

    if (noteReconnectTimerRef.current) {
      window.clearTimeout(noteReconnectTimerRef.current);
    }

    noteReconnectTimerRef.current = window.setTimeout(() => {
      noteReconnectTimerRef.current = null;
      setStatus("Reconnecting live talk with the updated note...");
      setConnectionRevision((current) => current + 1);
    }, 3000);

    return () => {
      if (noteReconnectTimerRef.current) {
        window.clearTimeout(noteReconnectTimerRef.current);
        noteReconnectTimerRef.current = null;
      }
    };
  }, [noteContext, ready, sessionRequested]);

  useEffect(() => {
    activeRef.current = active;
    microphoneEnabledRef.current = microphoneEnabled ?? true;
    preferredMicrophoneDeviceIdRef.current = microphoneDeviceId ?? null;
    const shouldCapture = active && (microphoneEnabled ?? true);
    microphoneCaptureEnabledRef.current = shouldCapture;
    if (!shouldCapture) {
      resetMicrophoneRef.current();
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      resetMicrophoneRef.current();
      void requestMicrophoneRef.current();
    }
  }, [active, microphoneDeviceId, microphoneEnabled]);

  useEffect(() => {
    onVideoShareStateChangeRef.current = onVideoShareStateChange;
  }, [onVideoShareStateChange]);

  useEffect(() => {
    onApplyEditsRef.current = onApplyEdits;
  }, [onApplyEdits]);

  useEffect(() => {
    onSessionStateChange?.({ connecting, ready, status });
  }, [connecting, onSessionStateChange, ready, status]);

  const toggleVideoTurnZoom = (turnId: string) => {
    setExpandedVideoTurnIds((current) => {
      const next = new Set(current);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  };

  const captureVideoShareShot = async () => {
    await captureVideoShareShotRef.current();
  };

  const confirmUploadPreviewImage = () => {
    if (!previewImage || !onUploadImageToCurrentFolder) return;
    if (!window.confirm("Upload this image to the current folder?")) return;
    void onUploadImageToCurrentFolder({
      fileName: previewImage.fileName,
      mimeType: previewImage.mimeType,
      previewUrl: previewImage.url,
    });
  };

  const orderedTurns = useMemo(() => {
    if (!activeVideoTurnId) return turns;
    const activeVideoTurn = turns.find((turn) => turn.id === activeVideoTurnId && turn.videoStream);
    if (!activeVideoTurn) return turns;
    return [...turns.filter((turn) => turn.id !== activeVideoTurnId), activeVideoTurn];
  }, [activeVideoTurnId, turns]);
  const generatedHistoryImages = useMemo(
    () =>
      orderedTurns.flatMap((turn) =>
        (turn.images ?? [])
          .filter((image) => image.origin === "generated")
          .map((image) => ({
            id: image.id,
            fileName: image.fileName,
            url: image.url,
          })),
      ),
    [orderedTurns],
  );

  const setLatestMessageAvailable = useCallback((available: boolean) => {
    onLatestMessageStateChange?.(available);
  }, [onLatestMessageStateChange]);

  const updateLiveHistoryScrollState = useCallback(() => {
    const container = liveHistoryRef.current;
    if (!container) return;
    const activeVideo = container.querySelector<HTMLElement>('[data-active-live-video="true"]');
    const liveTurns = container.querySelectorAll<HTMLElement>('[data-live-turn="true"]');
    const latestTurn = liveTurns[liveTurns.length - 1];
    const containerRect = container.getBoundingClientRect();
    const activeVideoRect = activeVideo?.getBoundingClientRect();
    const latestTurnRect = latestTurn?.getBoundingClientRect();
    const activeVideoInView = Boolean(
      activeVideoRect && activeVideoRect.bottom <= containerRect.bottom + 48 && activeVideoRect.bottom >= containerRect.top,
    );
    const latestTurnInView = Boolean(
      latestTurnRect && latestTurnRect.top >= containerRect.top - 48 && latestTurnRect.top <= containerRect.bottom,
    );
    const nearLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 48 || activeVideoInView || latestTurnInView;
    wasNearLiveHistoryBottomRef.current = nearLatest;
    setLatestMessageAvailable(!nearLatest);
  }, [setLatestMessageAvailable]);

  const scrollToLiveLatest = useCallback(() => {
    const container = liveHistoryRef.current;
    if (!container) return;
    onHistoryInteract?.();
    const activeVideo = container.querySelector<HTMLElement>('[data-active-live-video="true"]');
    if (activeVideo) {
      activeVideo.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      const liveTurns = container.querySelectorAll<HTMLElement>('[data-live-turn="true"]');
      const latestTurn = liveTurns[liveTurns.length - 1];
      if (latestTurn) {
        latestTurn.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      }
    }
    wasNearLiveHistoryBottomRef.current = true;
    setLatestMessageAvailable(false);
  }, [onHistoryInteract, setLatestMessageAvailable]);

  const scrollToLiveCamera = useCallback(() => {
    const container = liveHistoryRef.current;
    if (!container) return;
    const activeVideo = container.querySelector<HTMLElement>('[data-active-live-video="true"]');
    if (!activeVideo) return;
    onHistoryInteract?.();
    activeVideo.scrollIntoView({ behavior: "smooth", block: "start" });
    wasNearLiveHistoryBottomRef.current = true;
    setLatestMessageAvailable(false);
  }, [onHistoryInteract, setLatestMessageAvailable]);

  const scrollToLiveGeneratedImage = useCallback((imageId?: string) => {
    const container = liveHistoryRef.current;
    if (!container) return;
    const generatedImages = container.querySelectorAll<HTMLElement>('[data-live-generated-image="true"]');
    const target = imageId
      ? Array.from(generatedImages).find((image) => image.dataset.liveGeneratedImageId === imageId)
      : generatedImages[generatedImages.length - 1];
    if (!target) return;
    onHistoryInteract?.();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    wasNearLiveHistoryBottomRef.current = true;
    setLatestMessageAvailable(false);
  }, [onHistoryInteract, setLatestMessageAvailable]);

  useEffect(() => {
    if (!onRegisterHistoryControls) return;
    onRegisterHistoryControls({
      scrollToLatest: scrollToLiveLatest,
      scrollToCamera: scrollToLiveCamera,
      scrollToGeneratedImage: scrollToLiveGeneratedImage,
    });
    return () => onRegisterHistoryControls(null);
  }, [onRegisterHistoryControls, scrollToLiveCamera, scrollToLiveGeneratedImage, scrollToLiveLatest]);

  useEffect(() => {
    onHistoryTargetsChange?.({
      hasCamera: orderedTurns.some((turn) => Boolean(turn.videoStream && turn.videoMode === "camera")),
      hasGeneratedImage: generatedHistoryImages.length > 0,
      generatedImages: generatedHistoryImages,
    });
  }, [generatedHistoryImages, onHistoryTargetsChange, orderedTurns]);

  useEffect(() => {
    if (!onRegisterSend) return;
    onRegisterSend(sendLiveHandleRef.current);
    return () => onRegisterSend(null);
  }, [onRegisterSend]);

  useEffect(
    () => () => {
      audioUrlsRef.current.forEach((audioUrl) => URL.revokeObjectURL(audioUrl));
      audioUrlsRef.current = [];
      generatedImageUrlsRef.current.forEach((imageUrl) => URL.revokeObjectURL(imageUrl));
      generatedImageUrlsRef.current = [];
    },
    [],
  );

  useEffect(() => {
    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    if (!sessionRequested) {
      clearReconnectTimer();
      setConnecting(false);
      setReady(false);
      setStatus("Live talk disconnected.");
      return;
    }

    if (!providerSettings.apiKey) {
      clearReconnectTimer();
      setConnecting(false);
      setReady(false);
      setStatus("Save your Gemini API key to start live talk.");
      return;
    }

    const model = (providerSettings.liveModel || "").trim() || "gemini-3.1-flash-live-preview";
    if (!model) {
      clearReconnectTimer();
      setConnecting(false);
      setReady(false);
      setStatus("Set a Gemini live model in provider settings first.");
      return;
    }

    const url = buildLiveWebSocketUrl(providerSettings.apiUrl, providerSettings.apiKey);
    setConnecting(true);
    setReady(false);
    setStatus("Connecting to Gemini Live...");
    const socket = new WebSocket(url);
    const socketSessionId = socketSessionIdRef.current + 1;
    socketSessionIdRef.current = socketSessionId;
    socketRef.current = socket;
    let closing = false;

    const scheduleReconnect = (message: string) => {
      if (reconnectTimerRef.current) {
        return;
      }
      setConnecting(false);
      setReady(false);
      setStatus(`${message} Reconnecting...`);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        setConnectionRevision((current) => current + 1);
      }, 1500);
    };

    const createAudioContext = () => {
      if (audioContextRef.current) return audioContextRef.current;
      const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return null;
      const context = new AudioContextCtor();
      audioContextRef.current = context;
      nextAudioTimeRef.current = context.currentTime;
      return context;
    };

    const resetMicrophone = () => {
      microphoneProcessorRef.current?.disconnect();
      microphoneProcessorRef.current = null;
      microphoneSourceRef.current?.disconnect();
      microphoneSourceRef.current = null;
      microphoneSinkRef.current?.disconnect();
      microphoneSinkRef.current = null;
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      microphoneStreamDeviceIdRef.current = null;
      microphoneAudioContextRef.current?.close().catch(() => undefined);
      microphoneAudioContextRef.current = null;
    };

    const requestMicrophone = async () => {
      const preferredDeviceId = preferredMicrophoneDeviceIdRef.current;
      const existingStream = microphoneStreamRef.current;
      const existingTracks = existingStream?.getAudioTracks() ?? [];
      const existingStreamLive = existingStream?.active && existingTracks.some((track) => track.readyState === "live");
      if (existingStream && microphoneStreamDeviceIdRef.current === preferredDeviceId && existingStreamLive) {
        return existingStream;
      }
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        return null;
      }

      try {
        resetMicrophone();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: preferredDeviceId
            ? {
                deviceId: { exact: preferredDeviceId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              }
            : {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
        });
        microphoneStreamRef.current = stream;
        microphoneStreamDeviceIdRef.current = stream.getAudioTracks()[0]?.getSettings().deviceId ?? preferredDeviceId ?? null;
        stream.getAudioTracks().forEach((track) => {
          track.addEventListener(
            "ended",
            () => {
              if (!microphoneCaptureEnabledRef.current) return;
              resetMicrophone();
              if (socketRef.current?.readyState === WebSocket.OPEN) {
                window.setTimeout(() => void requestMicrophoneRef.current(), 300);
              }
            },
            { once: true },
          );
        });
        const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) {
          return stream;
        }

        const audioContext = microphoneAudioContextRef.current ?? new AudioContextCtor();
        microphoneAudioContextRef.current = audioContext;
        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }

        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        const sink = audioContext.createGain();
        sink.gain.value = 0;

        processor.onaudioprocess = (event) => {
          if (!microphoneCaptureEnabledRef.current) return;
          const socketConnection = socketRef.current;
          if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) return;

          if (performance.now() < assistantPlaybackMutedUntilRef.current) {
            if (userAudioActiveRef.current) {
              userAudioActiveRef.current = false;
              userAudioSpeechStartMsRef.current = 0;
              userAudioTrailingSilenceMsRef.current = 0;
              finalizeUserAudioRef.current();
            }
            pendingUserAudioChunksRef.current = [];
            userAudioSpeechStartMsRef.current = 0;
            return;
          }

          const input = event.inputBuffer.getChannelData(0);
          const resampled = resampleFloat32Array(input, audioContext.sampleRate, 16000);
          if (resampled.length === 0) return;
          const encodedAudio = float32ToBase64Pcm16(resampled);

          let sumSquares = 0;
          for (let index = 0; index < resampled.length; index += 1) {
            const sample = resampled[index] ?? 0;
            sumSquares += sample * sample;
          }
          const rms = Math.sqrt(sumSquares / resampled.length);
          const chunkDurationMs = (resampled.length / 16000) * 1000;
          const audioBytes = base64ToUint8Array(encodedAudio);
          const sendAudioChunk = (chunk: string) => {
            socketConnection.send(
              JSON.stringify({
                realtimeInput: {
                  audio: {
                    data: chunk,
                    mimeType: "audio/pcm;rate=16000",
                  },
                },
              }),
            );
          };
          const sendAudioStreamEnd = () => {
            socketConnection.send(
              JSON.stringify({
                realtimeInput: {
                  audioStreamEnd: true,
                },
              }),
            );
          };

          if (rms >= 0.018 && !userAudioActiveRef.current) {
            pendingUserAudioChunksRef.current.push({ encodedAudio, bytes: audioBytes });
            userAudioSpeechStartMsRef.current += chunkDurationMs;
            if (userAudioSpeechStartMsRef.current < 180) {
              return;
            }
            userAudioSelectionContextRef.current = sendSelectedTextContext(socketConnection);
            ensureUserTurn();
            userAudioActiveRef.current = true;
            userAudioTrailingSilenceMsRef.current = 0;
            for (const chunk of pendingUserAudioChunksRef.current) {
              sendAudioChunk(chunk.encodedAudio);
              userAudioChunksRef.current.push(chunk.bytes);
            }
            pendingUserAudioChunksRef.current = [];
            userAudioSpeechStartMsRef.current = 0;
            return;
          }

          if (rms >= 0.018 && userAudioActiveRef.current) {
            userAudioTrailingSilenceMsRef.current = 0;
            sendAudioChunk(encodedAudio);
            userAudioChunksRef.current.push(audioBytes);
            return;
          }

          if (userAudioActiveRef.current && userAudioTrailingSilenceMsRef.current < 450) {
            userAudioTrailingSilenceMsRef.current += chunkDurationMs;
            sendAudioChunk(encodedAudio);
            userAudioChunksRef.current.push(audioBytes);
            return;
          }

          if (userAudioActiveRef.current) {
            userAudioTrailingSilenceMsRef.current += chunkDurationMs;
            if (userAudioTrailingSilenceMsRef.current >= 850) {
              userAudioActiveRef.current = false;
              userAudioSpeechStartMsRef.current = 0;
              userAudioTrailingSilenceMsRef.current = 0;
              const screenImage = sendScreenSnapshotForTurn("speech");
              if (screenImage) {
                appendImagesToUserTurn([screenImage], userTurnIdRef.current);
              }
              sendAudioStreamEnd();
              finalizeUserAudioRef.current();
            }
            return;
          }

          pendingUserAudioChunksRef.current = [];
          userAudioSpeechStartMsRef.current = 0;
        };

        source.connect(processor);
        processor.connect(sink);
        sink.connect(audioContext.destination);

        microphoneSourceRef.current = source;
        microphoneProcessorRef.current = processor;
        microphoneSinkRef.current = sink;

        return stream;
      } catch {
        setStatus("Microphone access was not granted. Text live chat still works.");
        return null;
      }
    };

    requestMicrophoneRef.current = requestMicrophone;
    resetMicrophoneRef.current = resetMicrophone;

    const ensureUserTurn = () => {
      const existingId = userTurnIdRef.current;
      if (existingId) {
        return existingId;
      }
      const id = crypto.randomUUID();
      userTurnIdRef.current = id;
      setTurns((current) => [...current, { id, role: "user", content: "" }]);
      return id;
    };

    const sendSelectedTextContext = (socketConnection: WebSocket) => {
      const selection = currentSelectedTextRef.current.trim();
      if (!selection) return "";
      const context = formatSelectedTextContext(selection);
      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            text: context,
          },
        }),
      );
      return context;
    };

    const withActiveSelectionContext = (content: string) => {
      const selectionContext = userAudioSelectionContextRef.current.trim();
      const trimmedContent = content.trim();
      return [selectionContext, trimmedContent].filter(Boolean).join("\n\n");
    };

    const updateUserTurn = (content: string) => {
      if (!content.trim()) return;
      const id = ensureUserTurn();
      const nextContent = withActiveSelectionContext(content);
      setTurns((current) =>
        current.map((turn) => (turn.id === id ? { ...turn, content: nextContent } : turn)),
      );
      moveVideoShareTurnToEnd();
    };

    const videoShareContent = (mode: "camera" | "screen") =>
      mode === "camera"
        ? "Shared camera with Gemini."
        : screenShareSendModeRef.current === "video"
          ? "Shared screen video with Gemini."
          : "Shared screen screenshots with Gemini.";

    const moveVideoShareTurnToEnd = () => {
      const turnId = videoShareTurnIdRef.current;
      if (!turnId) return;
      setTurns((current) => {
        const turnIndex = current.findIndex((turn) => turn.id === turnId);
        if (turnIndex < 0 || turnIndex === current.length - 1) return current;
        const turn = current[turnIndex];
        return [...current.slice(0, turnIndex), ...current.slice(turnIndex + 1), turn];
      });
    };

    const upsertVideoShareTurn = (stream: MediaStream, mode: "camera" | "screen") => {
      const turnId = videoShareTurnIdRef.current ?? crypto.randomUUID();
      videoShareTurnIdRef.current = turnId;
      setActiveVideoTurnId(turnId);
      setFocusedVideoTurnId(turnId);
      setTurns((current) => {
        const withoutVideoTurn = current.filter((turn) => turn.id !== turnId);
        return [
          ...withoutVideoTurn,
          {
            id: turnId,
            role: "user",
            content: videoShareContent(mode),
            videoStream: stream,
            videoMode: mode,
          },
        ];
      });
    };

    const finalizeUserAudio = () => {
      const userTurnId = userTurnIdRef.current;
      if (!userTurnId) {
        userAudioChunksRef.current = [];
        pendingUserAudioChunksRef.current = [];
        userAudioSpeechStartMsRef.current = 0;
        userAudioSelectionContextRef.current = "";
        userAudioActiveRef.current = false;
        userAudioTrailingSilenceMsRef.current = 0;
        return;
      }
      const audioUrl = pcm16ChunksToWavUrl(userAudioChunksRef.current, 16000);
      if (audioUrl) {
        audioUrlsRef.current.push(audioUrl);
        setTurns((current) =>
          current.map((turn) => (turn.id === userTurnId ? { ...turn, audioUrl } : turn)),
        );
        moveVideoShareTurnToEnd();
      }
      userTurnIdRef.current = null;
      userAudioSelectionContextRef.current = "";
      userAudioChunksRef.current = [];
      pendingUserAudioChunksRef.current = [];
      userAudioSpeechStartMsRef.current = 0;
      userAudioActiveRef.current = false;
      userAudioTrailingSilenceMsRef.current = 0;
    };
    finalizeUserAudioRef.current = finalizeUserAudio;

    const createAssistantTurn = () => {
      const existingId = liveAssistantTurnIdRef.current;
      if (existingId) {
        return existingId;
      }
      const id = crypto.randomUUID();
      liveAssistantTurnIdRef.current = id;
      setTurns((current) => [...current, { id, role: "assistant", content: "" }]);
      return id;
    };

    const updateAssistantTurn = (content: string) => {
      if (!content.trim()) return;
      const existingId = liveAssistantTurnIdRef.current ?? createAssistantTurn();
      setTurns((current) => {
        let updated = false;
        const next = current.map((turn) => {
          if (turn.id !== existingId) return turn;
          updated = true;
          return { ...turn, content: `${turn.content}${content}` };
        });
        return updated ? next : [...current, { id: existingId, role: "assistant", content }];
      });
      moveVideoShareTurnToEnd();
    };

    const announceImageGenerationStart = () => {
      const existingId = liveAssistantTurnIdRef.current ?? createAssistantTurn();
      liveAssistantTurnIdRef.current = existingId;
      setTurns((current) => {
        let updated = false;
        const next = current.map((turn) => {
          if (turn.id !== existingId) return turn;
          updated = true;
          const leadingWhitespaceLength = turn.content.length - turn.content.trimStart().length;
          const leadingWhitespace = turn.content.slice(0, leadingWhitespaceLength);
          const trimmedContent = turn.content.trimStart();
          if (!trimmedContent) {
            return { ...turn, content: LIVE_IMAGE_GENERATION_NOTICE };
          }
          if (trimmedContent.toLowerCase().startsWith(LIVE_IMAGE_GENERATION_NOTICE)) {
            return {
              ...turn,
              content: `${leadingWhitespace}${LIVE_IMAGE_GENERATION_NOTICE}${trimmedContent.slice(LIVE_IMAGE_GENERATION_NOTICE.length)}`,
            };
          }
          return {
            ...turn,
            content: `${LIVE_IMAGE_GENERATION_NOTICE}\n\n${turn.content}`,
          };
        });
        return updated ? next : [...current, { id: existingId, role: "assistant", content: LIVE_IMAGE_GENERATION_NOTICE }];
      });
      moveVideoShareTurnToEnd();
      return existingId;
    };

    const appendImagesToAssistantTurn = (images: LiveGeneratedImage[], targetTurnId?: string) => {
      if (images.length === 0) return;
      const existingId = targetTurnId ?? liveAssistantTurnIdRef.current ?? createAssistantTurn();
      liveAssistantTurnIdRef.current = existingId;
      setTurns((current) => {
        let updated = false;
        const next = current.map((turn) => {
          if (turn.id !== existingId) return turn;
          updated = true;
          return {
            ...turn,
            images: [...(turn.images ?? []), ...images],
          };
        });
        return updated ? next : [...current, { id: existingId, role: "assistant", content: "", images }];
      });
      moveVideoShareTurnToEnd();
    };

    const appendImagesToUserTurn = (images: LiveGeneratedImage[], targetTurnId?: string | null) => {
      if (images.length === 0) return;
      const existingId = targetTurnId ?? crypto.randomUUID();
      setTurns((current) => {
        let updated = false;
        const next = current.map((turn) => {
          if (turn.id !== existingId) return turn;
          updated = true;
          return {
            ...turn,
            images: [...(turn.images ?? []), ...images],
          };
        });
        return updated ? next : [...current, { id: existingId, role: "user", content: "", images }];
      });
      moveVideoShareTurnToEnd();
    };

    const appendEditsToAssistantTurn = (substitutions: TextSubstitution[], message?: string) => {
      if (substitutions.length === 0 && !message?.trim()) return;
      const existingId = liveAssistantTurnIdRef.current ?? createAssistantTurn();
      setTurns((current) => {
        let updated = false;
        const next = current.map((turn) => {
          if (turn.id !== existingId) return turn;
          updated = true;
          return {
            ...turn,
            content: message?.trim() ? `${turn.content}${turn.content ? "\n\n" : ""}${message.trim()}` : turn.content,
            substitutions: substitutions.length > 0 ? [...(turn.substitutions ?? []), ...substitutions] : turn.substitutions,
          };
        });
        return updated
          ? next
          : [
              ...current,
              {
                id: existingId,
                role: "assistant",
                content: message?.trim() ?? "",
                substitutions,
              },
            ];
      });
      moveVideoShareTurnToEnd();
    };

    const finalizeAssistantAudio = () => {
      const assistantTurnId = liveAssistantTurnIdRef.current;
      if (!assistantTurnId) {
        assistantAudioChunksRef.current = [];
        return;
      }
      const audioUrl = pcm16ChunksToWavUrl(assistantAudioChunksRef.current, 24000);
      if (audioUrl) {
        audioUrlsRef.current.push(audioUrl);
        setTurns((current) =>
          current.map((turn) => (turn.id === assistantTurnId ? { ...turn, audioUrl } : turn)),
        );
      }
      assistantAudioChunksRef.current = [];
    };

    const resetAssistantTurn = () => {
      liveAssistantTurnIdRef.current = null;
    };

    const playAudioChunk = (base64Audio: string) => {
      const context = createAudioContext();
      if (!context) return;

      const samples = pcm16ToFloat32Array(base64ToUint8Array(base64Audio));
      if (samples.length === 0) return;

      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(nextAudioTimeRef.current, context.currentTime);
      source.start(startAt);
      nextAudioTimeRef.current = startAt + buffer.duration;
      const mutedUntil = performance.now() + Math.max(0, nextAudioTimeRef.current - context.currentTime) * 1000 + 350;
      assistantPlaybackMutedUntilRef.current = Math.max(assistantPlaybackMutedUntilRef.current, mutedUntil);
    };

    const sendSetup = () => {
      appliedNoteContextRef.current = noteContextRef.current;
      socket.send(
        JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: "Zephyr",
                  },
                },
              },
            },
            systemInstruction: {
              parts: [
                {
                  text: noteContextRef.current,
                },
              ],
            },
            tools: [
              {
                functionDeclarations: [
                  generateImageFunctionDeclaration,
                  suggestNoteEditsFunctionDeclaration,
                  listAvailableCamerasFunctionDeclaration,
                  startCameraShareFunctionDeclaration,
                  switchCameraShareFunctionDeclaration,
                  captureCameraShotFunctionDeclaration,
                  startScreenShareFunctionDeclaration,
                  stopVideoShareFunctionDeclaration,
                ],
              },
            ],
          },
        }),
      );
    };

    const updateVideoShareState = (
      mode: "camera" | "screen" | null,
      cameraDeviceId?: string | null,
      screenMode?: ScreenShareSendMode | null,
    ) => {
      videoShareModeRef.current = mode;
      screenShareSendModeRef.current = mode === "screen" ? screenMode ?? "screenshot" : null;
      currentCameraDeviceIdRef.current = mode === "camera" ? cameraDeviceId ?? null : null;
      onVideoShareStateChangeRef.current?.({
        mode,
        cameraDeviceId: currentCameraDeviceIdRef.current,
        screenMode: screenShareSendModeRef.current,
      });
    };

    const clearVideoShareTurn = (message: string) => {
      const turnId = videoShareTurnIdRef.current;
      if (!turnId) return;
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                content: message,
                videoStream: null,
                videoMode: undefined,
              }
            : turn,
        ),
      );
      setFocusedVideoTurnId((current) => (current === turnId ? null : current));
      setActiveVideoTurnId((current) => (current === turnId ? null : current));
      setExpandedVideoTurnIds((current) => {
        if (!current.has(turnId)) return current;
        const next = new Set(current);
        next.delete(turnId);
        return next;
      });
      videoShareTurnIdRef.current = null;
    };

    const stopVideoShare = (options?: { replacing?: boolean }) => {
      const previousMode = videoShareModeRef.current;
      if (videoShareIntervalRef.current) {
        window.clearInterval(videoShareIntervalRef.current);
        videoShareIntervalRef.current = null;
      }
      videoShareStreamRef.current?.getTracks().forEach((track) => track.stop());
      videoShareStreamRef.current = null;
      if (videoShareElementRef.current) {
        videoShareElementRef.current.pause();
        videoShareElementRef.current.srcObject = null;
      }
      videoShareElementRef.current = null;
      videoShareCanvasRef.current = null;
      currentCameraLabelRef.current = null;
      updateVideoShareState(null);
      if (!options?.replacing && previousMode) {
        clearVideoShareTurn(previousMode === "camera" ? "Camera sharing stopped." : "Screen sharing stopped.");
      }
    };

    const captureVideoFrameBase64 = (maxWidth = 1280, quality = 0.82) => {
      const videoElement = videoShareElementRef.current;
      if (!videoElement) {
        return null;
      }
      if (videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || videoElement.videoWidth <= 0 || videoElement.videoHeight <= 0) {
        return null;
      }

      const canvas = videoShareCanvasRef.current ?? document.createElement("canvas");
      videoShareCanvasRef.current = canvas;
      const ratio = maxWidth / Math.max(videoElement.videoWidth, 1);
      canvas.width = videoElement.videoWidth > maxWidth ? Math.max(1, Math.round(videoElement.videoWidth * ratio)) : videoElement.videoWidth;
      canvas.height =
        videoElement.videoWidth > maxWidth ? Math.max(1, Math.round(videoElement.videoHeight * ratio)) : videoElement.videoHeight;

      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const [, dataBase64] = dataUrl.split(",", 2);
      return dataBase64 || null;
    };

    const sendVideoFrame = () => {
      const socketConnection = socketRef.current;
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) {
        return;
      }
      const dataBase64 = captureVideoFrameBase64();
      if (!dataBase64) return;

      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            video: {
              data: dataBase64,
              mimeType: "image/jpeg",
            },
          },
        }),
      );
    };

    const sendScreenSnapshotForTurn = (reason: "speech" | "text" | "audio") => {
      const socketConnection = socketRef.current;
      if (
        videoShareModeRef.current !== "screen" ||
        screenShareSendModeRef.current !== "screenshot" ||
        !socketConnection ||
        socketConnection.readyState !== WebSocket.OPEN
      ) {
        return null;
      }

      const dataBase64 = captureVideoFrameBase64(1280, 0.82);
      if (!dataBase64) return null;
      const image: LiveGeneratedImage = {
        id: crypto.randomUUID(),
        fileName: `screen-shot-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
        origin: "camera",
        url: base64ToObjectUrl(dataBase64, "image/jpeg"),
        dataBase64,
      };
      generatedImageUrlsRef.current.push(image.url);
      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            video: {
              data: dataBase64,
              mimeType: "image/jpeg",
            },
          },
        }),
      );
      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            text:
              reason === "speech"
                ? "Current screen screenshot captured at the end of the user's spoken turn."
                : reason === "audio"
                  ? "Current screen screenshot captured with the user's audio message."
                  : "Current screen screenshot captured with the user's text message.",
          },
        }),
      );
      return image;
    };

    const startVideoShare = async (
      stream: MediaStream,
      mode: "camera" | "screen",
      cameraDeviceId?: string | null,
      options?: { screenMode?: ScreenShareSendMode },
    ) => {
      const socketConnection = socketRef.current;
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Live talk is not connected.");
      }

      stopVideoShare({ replacing: true });
      videoShareStreamRef.current = stream;

      const videoElement = document.createElement("video");
      videoElement.srcObject = stream;
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.autoplay = true;
      videoShareElementRef.current = videoElement;

      const handleTrackEnded = () => {
        stopVideoShare();
        setStatus("Video share stopped.");
      };
      stream.getTracks().forEach((track) => track.addEventListener("ended", handleTrackEnded, { once: true }));

      await videoElement.play().catch(() => undefined);
      await waitForVideoFrame(videoElement);
      const screenMode = mode === "screen" ? options?.screenMode ?? "screenshot" : null;
      if (mode === "camera" || screenMode === "video") {
        sendVideoFrame();
        videoShareIntervalRef.current = window.setInterval(sendVideoFrame, 900);
      }
      const videoTrack = stream.getVideoTracks()[0];
      const resolvedCameraDeviceId = mode === "camera" ? videoTrack?.getSettings().deviceId ?? cameraDeviceId ?? null : null;
      currentCameraLabelRef.current = mode === "camera" ? videoTrack?.label ?? null : null;
      updateVideoShareState(mode, resolvedCameraDeviceId, screenMode);
      upsertVideoShareTurn(stream, mode);
      setStatus(
        mode === "camera"
          ? "Sharing camera with Gemini."
          : screenMode === "video"
            ? "Sharing your screen video with Gemini."
            : "Screen screenshot sharing ready.",
      );
    };

    const listSources = async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
        return [];
      }

      let devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      if (cameras.some((device) => device.label)) {
        return cameras.map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      }

      let probeStream: MediaStream | null = null;
      try {
        if (navigator.mediaDevices.getUserMedia) {
          probeStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          devices = await navigator.mediaDevices.enumerateDevices();
        }
      } catch {
        return cameras.map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      } finally {
        probeStream?.getTracks().forEach((track) => track.stop());
      }

      return devices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
    };

    const startCameraShare = async (deviceId?: string) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera sharing is not supported in this browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? {
              deviceId: { exact: deviceId },
            }
          : {
              facingMode: { ideal: "user" },
            },
        audio: false,
      });
      await startVideoShare(stream, "camera", deviceId ?? null);
      return true;
    };

    const findNextCameraSource = async () => {
      const cameras = await listSources();
      if (cameras.length <= 1) {
        return { cameras, nextSource: null };
      }

      const activeVideoTrack = videoShareStreamRef.current?.getVideoTracks()[0];
      const currentDeviceId = currentCameraDeviceIdRef.current ?? activeVideoTrack?.getSettings().deviceId ?? null;
      const currentLabel = currentCameraLabelRef.current ?? activeVideoTrack?.label ?? null;
      const currentIndex = cameras.findIndex(
        (camera) => (currentDeviceId ? camera.deviceId === currentDeviceId : false) || (currentLabel ? camera.label === currentLabel : false),
      );
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % cameras.length : 0;
      return { cameras, nextSource: cameras[nextIndex] ?? null };
    };

    const switchCameraShare = async () => {
      if (videoShareModeRef.current === "screen") {
        throw new Error("Stop screen sharing before switching cameras.");
      }

      const { cameras, nextSource } = await findNextCameraSource();
      if (!nextSource) {
        throw new Error(cameras.length === 0 ? "No cameras were found." : "No other camera is available.");
      }

      await startCameraShare(nextSource.deviceId);
      return true;
    };

    const startScreenShare = async (options?: { video?: boolean }) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Screen sharing is not supported in this browser.");
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      await startVideoShare(stream, "screen", null, { screenMode: options?.video ? "video" : "screenshot" });
      return true;
    };

    const captureCurrentCameraShot = async () => {
      const socketConnection = socketRef.current;
      const videoElement = videoShareElementRef.current;
      if (videoShareModeRef.current !== "camera" || !videoElement) {
        throw new Error("Start camera sharing before taking a shot.");
      }
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) {
        throw new Error("Live talk is not connected.");
      }

      await waitForVideoFrame(videoElement);
      const width = videoElement.videoWidth || 1280;
      const height = videoElement.videoHeight || 720;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Camera shot capture is not supported in this browser.");
      }
      context.drawImage(videoElement, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      const [, dataBase64] = dataUrl.split(",", 2);
      if (!dataBase64) {
        throw new Error("Failed to capture a camera shot.");
      }

      const image: LiveGeneratedImage = {
        id: crypto.randomUUID(),
        fileName: `camera-shot-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
        origin: "camera",
        url: base64ToObjectUrl(dataBase64, "image/jpeg"),
        dataBase64,
      };
      generatedImageUrlsRef.current.push(image.url);
      latestImageContextRef.current = {
        id: image.id,
        kind: "image",
        fileName: image.fileName,
        mimeType: image.mimeType,
        source: "upload",
        dataBase64: image.dataBase64,
      };

      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            video: {
              data: dataBase64,
              mimeType: image.mimeType,
            },
          },
        }),
      );
      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            text: "The user captured a still image from the current camera feed. This is now the current image available for future image edit calls.",
          },
        }),
      );

      const videoTurnId = videoShareTurnIdRef.current;
      setTurns((current) => {
        const videoTurn = videoTurnId ? current.find((turn) => turn.id === videoTurnId) : undefined;
        const withoutVideoTurn = videoTurnId ? current.filter((turn) => turn.id !== videoTurnId) : current;
        return [
          ...withoutVideoTurn,
          {
            id: crypto.randomUUID(),
            role: "user",
            content: "Shot image from camera.",
            images: [image],
          },
          ...(videoTurn ? [videoTurn] : []),
        ];
      });
      setStatus("Captured a camera shot.");
      return image;
    };

    captureVideoShareShotRef.current = async () => {
      try {
        await captureCurrentCameraShot();
      } catch (error) {
        onError(error instanceof Error ? error.message : "Failed to capture a camera shot.");
      }
    };

    const sendLiveText = (text: string, options?: { displayText?: string }) => {
      const socketConnection = socketRef.current;
      const trimmedText = text.trim();
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN || !trimmedText) {
        return false;
      }

      const screenImage = sendScreenSnapshotForTurn("text");
      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            text: trimmedText,
          },
        }),
      );
      setTurns((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: options?.displayText?.trim() || trimmedText,
          images: screenImage ? [screenImage] : undefined,
        },
      ]);
      moveVideoShareTurnToEnd();
      setStatus("Sent.");
      return true;
    };

    const sendLiveAttachment = async (attachment: LiveSendAttachment) => {
      const socketConnection = socketRef.current;
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) {
        return false;
      }

      const blob = await loadAttachmentBlob(attachment);
      if (attachment.kind === "audio") {
        const selectionContext = sendSelectedTextContext(socketConnection);
        const screenImage = sendScreenSnapshotForTurn("audio");
        const chunks = await decodeAudioBlobToPcm16ChunksBase64(blob);
        for (const chunk of chunks) {
          socketConnection.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: chunk,
                  mimeType: "audio/pcm;rate=16000",
                },
              },
            }),
          );
        }
        setTurns((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "user",
            content: [selectionContext, `Sent audio clip: ${attachment.fileName}`].filter(Boolean).join("\n\n"),
            images: screenImage ? [screenImage] : undefined,
          },
        ]);
        moveVideoShareTurnToEnd();
        setStatus(`${attachment.fileName} sent to live talk.`);
        return true;
      }

      let encodedFrame: string | null = null;
      if (attachment.kind === "image") {
        encodedFrame = await readBlobAsBase64(blob);
        latestImageContextRef.current = {
          id: crypto.randomUUID(),
          kind: "image",
          fileName: attachment.fileName,
          mimeType: attachment.mimeType || blob.type || "image/jpeg",
          source: "upload",
          dataBase64: encodedFrame,
        };
      } else if (attachment.kind === "video") {
        encodedFrame = await captureVideoFrameAsJpegBase64(blob);
      } else {
        return false;
      }

      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            video: {
              data: encodedFrame,
              mimeType: attachment.kind === "image" ? attachment.mimeType || blob.type || "image/jpeg" : "image/jpeg",
            },
          },
        }),
      );
      if (attachment.kind === "image") {
        socketConnection.send(
          JSON.stringify({
            realtimeInput: {
              text:
                "The user uploaded a source image. This is now the current image available for future generate_image edit calls.",
            },
          }),
        );
        setTurns((current) => [...current, { id: crypto.randomUUID(), role: "user", content: `Sent image: ${attachment.fileName}` }]);
        moveVideoShareTurnToEnd();
      }
      setStatus(`${attachment.fileName} sent to live talk.`);
      return true;
    };

    const runGenerateImageTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const callId = typeof call.id === "string" ? call.id : "";
      const prompt = typeof call.args?.prompt === "string" ? call.args.prompt.trim() : "";
      const aspectRatio = typeof call.args?.aspect_ratio === "string" ? call.args.aspect_ratio.trim() : "";

      if (!prompt) {
        return {
          id: callId,
          name: call.name ?? "generate_image",
          response: {
            ok: false,
            error: "Missing prompt.",
          },
        };
      }

      const requestPrompt = aspectRatio ? `${prompt}\n\nRequested aspect ratio: ${aspectRatio}` : prompt;
      const imageContext = latestImageContextRef.current;
      const attachments = shouldEditWithLiveImage(requestPrompt, Boolean(imageContext)) && imageContext ? [imageContext] : undefined;
      const assistantTurnId = announceImageGenerationStart();
      onImageGenerationStateChange?.(true);
      try {
        const response = await apiClient.askAi({
          prompt: requestPrompt,
          title: noteTitleRef.current,
          bodyMarkdown: noteBodyMarkdownRef.current,
          mode: "image",
          attachments,
        });

        if (cancelledToolCallIdsRef.current.has(callId)) {
          return {
            id: callId,
            name: call.name ?? "generate_image",
            response: {
              ok: false,
              cancelled: true,
            },
          };
        }

        const images: LiveGeneratedImage[] = (response.attachments ?? [])
          .filter((attachment) => attachment.kind === "image" && attachment.dataBase64.trim())
          .map((attachment) => {
            const url = base64ToObjectUrl(attachment.dataBase64, attachment.mimeType);
            generatedImageUrlsRef.current.push(url);
            return {
              id: crypto.randomUUID(),
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              origin: "generated",
              url,
              dataBase64: attachment.dataBase64,
            };
          });

        const latestGeneratedImage = images[images.length - 1];
        if (latestGeneratedImage) {
          latestImageContextRef.current = {
            id: latestGeneratedImage.id,
            kind: "image",
            fileName: latestGeneratedImage.fileName,
            mimeType: latestGeneratedImage.mimeType,
            source: "folder",
            dataBase64: latestGeneratedImage.dataBase64,
          };
        }

        if (images.length > 0) {
          pendingGeneratedImageScrollRef.current = true;
        }
        appendImagesToAssistantTurn(images, assistantTurnId);
        setStatus(images.length > 0 ? "Generated image from live tool." : "Live tool returned no image.");

        return {
          id: callId,
          name: call.name ?? "generate_image",
          response: {
            ok: images.length > 0,
            message: response.answer,
            image_count: images.length,
            current_source_image_updated: images.length > 0,
            images: images.map((image) => ({
              file_name: image.fileName,
              mime_type: image.mimeType,
            })),
          },
        };
      } finally {
        onImageGenerationStateChange?.(false);
      }
    };

    const runSuggestNoteEditsTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const callId = typeof call.id === "string" ? call.id : "";
      const prompt = typeof call.args?.prompt === "string" ? call.args.prompt.trim() : "";

      if (!prompt) {
        return {
          id: callId,
          name: call.name ?? "suggest_note_edits",
          response: {
            ok: false,
            error: "Missing prompt.",
          },
        };
      }

      const response = await apiClient.askAi({
        prompt,
        title: noteTitleRef.current,
        bodyMarkdown: noteBodyMarkdownRef.current,
        mode: "chat",
      });

      if (cancelledToolCallIdsRef.current.has(callId)) {
        return {
          id: callId,
          name: call.name ?? "suggest_note_edits",
          response: {
            ok: false,
            cancelled: true,
          },
        };
      }

      appendEditsToAssistantTurn(response.substitutions, response.answer);
      setStatus(response.substitutions.length > 0 ? "Prepared note edits from live tool." : "Live edit tool returned no replaceable text.");
      if (response.substitutions.length > 0) {
        onApplyEditsRef.current?.(response.substitutions);
      }

      return {
        id: callId,
        name: call.name ?? "suggest_note_edits",
        response: {
          ok: response.substitutions.length > 0,
          message: response.answer,
          substitution_count: response.substitutions.length,
          substitutions: response.substitutions.map((edit) => ({
            find: edit.find,
            replace: edit.replace,
            all: Boolean(edit.all),
          })),
        },
      };
    };

    const runListAvailableCamerasTool = async (call: { id?: string; name?: string }) => {
      const cameras = await listSources();
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "list_available_cameras",
        response: {
          ok: true,
          active_share: videoShareModeRef.current,
          cameras: cameras.map((camera) => ({
            device_id: camera.deviceId,
            label: camera.label,
          })),
        },
      };
    };

    const runStartCameraShareTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const deviceId = typeof call.args?.device_id === "string" && call.args.device_id.trim() ? call.args.device_id.trim() : undefined;
      const started = await startCameraShare(deviceId);
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "start_camera_share",
        response: {
          ok: started,
          mode: started ? "camera" : null,
          device_id: currentCameraDeviceIdRef.current ?? deviceId ?? null,
          message: started ? "Camera sharing started." : "Camera sharing was not started.",
        },
      };
    };

    const runSwitchCameraShareTool = async (call: { id?: string; name?: string }) => {
      const started = await switchCameraShare();
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "switch_camera_share",
        response: {
          ok: started,
          mode: started ? "camera" : null,
          device_id: currentCameraDeviceIdRef.current,
          message: started ? "Switched to the next camera." : "Camera was not switched.",
        },
      };
    };

    const runCaptureCameraShotTool = async (call: { id?: string; name?: string }) => {
      const image = await captureCurrentCameraShot();
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "capture_camera_shot",
        response: {
          ok: true,
          file_name: image.fileName,
          mime_type: image.mimeType,
          message: "Captured a still image from the current camera feed.",
          current_source_image_updated: true,
        },
      };
    };

    const runStartScreenShareTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const requestedMode = typeof call.args?.mode === "string" ? call.args.mode.toLowerCase() : "";
      const useVideo = /\b(video|live|continuous|stream)\b/.test(requestedMode);
      const started = await startScreenShare({ video: useVideo });
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "start_screen_share",
        response: {
          ok: started,
          mode: started ? "screen" : null,
          screen_mode: started ? (useVideo ? "video" : "screenshot") : null,
          message: started
            ? useVideo
              ? "Screen video sharing started."
              : "Screen screenshot sharing started."
            : "Screen sharing was not started.",
        },
      };
    };

    const runStopVideoShareTool = async (call: { id?: string; name?: string }) => {
      const previousMode = videoShareModeRef.current;
      stopVideoShare();
      setStatus("Video share stopped.");
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "stop_video_share",
        response: {
          ok: true,
          stopped: previousMode !== null,
          previous_mode: previousMode,
        },
      };
    };

    const handleToolCall = async (toolCall: NonNullable<Extract<LiveMessage, { toolCall?: unknown }>["toolCall"]>) => {
      const functionCalls = toolCall.functionCalls ?? [];
      if (functionCalls.length === 0) {
        return;
      }

      setStatus("Gemini requested a live tool.");
      const functionResponses = await Promise.all(
        functionCalls.map(async (call) => {
          try {
            switch (call.name) {
              case "generate_image":
                return await runGenerateImageTool(call);
              case "suggest_note_edits":
                return await runSuggestNoteEditsTool(call);
              case "list_available_cameras":
                return await runListAvailableCamerasTool(call);
              case "start_camera_share":
                return await runStartCameraShareTool(call);
              case "switch_camera_share":
                return await runSwitchCameraShareTool(call);
              case "capture_camera_shot":
                return await runCaptureCameraShotTool(call);
              case "start_screen_share":
                return await runStartScreenShareTool(call);
              case "stop_video_share":
                return await runStopVideoShareTool(call);
              default:
                return {
                  id: call.id ?? "",
                  name: call.name ?? "unknown_tool",
                  response: {
                    ok: false,
                    error: `Unsupported tool: ${call.name ?? "unknown"}.`,
                  },
                };
            }
          } catch (error) {
            return {
              id: call.id ?? "",
              name: call.name ?? "unknown_tool",
              response: {
                ok: false,
                error: error instanceof Error ? error.message : "Tool execution failed.",
              },
            };
          }
        }),
      );

      const socketConnection = socketRef.current;
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) {
        return;
      }

      socketConnection.send(
        JSON.stringify({
          toolResponse: {
            functionResponses,
          },
        }),
      );
      setStatus("Live talk ready.");
      showHistoryNotice("Tool response sent to Gemini.");
    };

    const liveSendHandle: LiveSendHandle = {
      sendAttachment: sendLiveAttachment,
      sendText: sendLiveText,
    };
    sendLiveHandleRef.current = liveSendHandle;
    onRegisterSend?.(liveSendHandle);
    onRegisterVideoControls?.({
      listSources,
      startCameraShare,
      switchCameraShare,
      startScreenShare,
      stopVideoShare,
    });

    socket.onopen = async () => {
      try {
        clearReconnectTimer();
        const context = createAudioContext();
        if (context?.state === "suspended") {
          await context.resume();
        }
        sendSetup();
        setConnecting(false);
        setStatus("Connected. Seeding the current note...");
        microphoneCaptureEnabledRef.current = activeRef.current && microphoneEnabledRef.current;
        if (microphoneCaptureEnabledRef.current) {
          void requestMicrophone();
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : "Failed to start live talk.");
      }
    };

    socket.onmessage = async (event) => {
      if (socketSessionIdRef.current !== socketSessionId) {
        return;
      }

      try {
        const payload = JSON.parse(await readWebSocketMessageText(event.data)) as LiveMessage;

        if ("error" in payload && payload.error) {
          setConnecting(false);
          setReady(false);
          setStatus(payload.error.message ?? "Live talk failed.");
          onError(payload.error.message ?? "Live talk failed.");
          return;
        }

        if ("setupComplete" in payload) {
          setReady(true);
          setStatus("Live talk ready.");
          return;
        }

        if ("serverContent" in payload && payload.serverContent) {
          const serverContent = payload.serverContent;
          if (serverContent.inputTranscription?.text) {
            updateUserTurn(serverContent.inputTranscription.text);
          }
          const assistantTurnStarted = Boolean(serverContent.outputTranscription?.text || serverContent.modelTurn?.parts?.length);
          if (assistantTurnStarted) {
            finalizeUserAudio();
          }
          if (serverContent.outputTranscription?.text) {
            updateAssistantTurn(serverContent.outputTranscription.text);
          }
          for (const part of serverContent.modelTurn?.parts ?? []) {
            if (part.text) {
              updateAssistantTurn(part.text);
            }
            if (part.inlineData?.data) {
              createAssistantTurn();
              moveVideoShareTurnToEnd();
              assistantAudioChunksRef.current.push(base64ToUint8Array(part.inlineData.data));
              playAudioChunk(part.inlineData.data);
            }
          }
          if (serverContent.interrupted) {
            setStatus("Live response interrupted.");
            finalizeAssistantAudio();
            resetAssistantTurn();
          }
          if (serverContent.turnComplete) {
            finalizeUserAudio();
            finalizeAssistantAudio();
            resetAssistantTurn();
          }
          return;
        }

        if ("toolCall" in payload && payload.toolCall) {
          await handleToolCall(payload.toolCall);
          return;
        }

        if ("toolCallCancellation" in payload && payload.toolCallCancellation) {
          for (const id of payload.toolCallCancellation.ids ?? []) {
            if (typeof id === "string" && id) {
              cancelledToolCallIdsRef.current.add(id);
            }
          }
          setStatus("Cancelled an in-flight live tool call.");
          return;
        }

        if ("goAway" in payload && payload.goAway) {
          setStatus(`Server closing soon${payload.goAway.timeLeft ? ` in ${payload.goAway.timeLeft}` : ""}.`);
          return;
        }

        if ("sessionResumptionUpdate" in payload && payload.sessionResumptionUpdate) {
          return;
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : "Live talk failed.");
      }
    };

    socket.onerror = () => {
      if (socketSessionIdRef.current !== socketSessionId) {
        return;
      }
      scheduleReconnect("Live talk connection failed.");
    };

    socket.onclose = (event) => {
      if (socketSessionIdRef.current !== socketSessionId || closing) {
        return;
      }
      scheduleReconnect(event.reason ? `Live talk ended (${event.code}: ${event.reason}).` : `Live talk ended (${event.code}).`);
    };

    return () => {
      closing = true;
      clearReconnectTimer();
      socketRef.current = null;
      socket.close();
      stopVideoShare();
      microphoneCaptureEnabledRef.current = false;
      resetMicrophone();
      nextAudioTimeRef.current = 0;
      assistantPlaybackMutedUntilRef.current = 0;
      userAudioChunksRef.current = [];
      pendingUserAudioChunksRef.current = [];
      userAudioActiveRef.current = false;
      userAudioSpeechStartMsRef.current = 0;
      userAudioTrailingSilenceMsRef.current = 0;
      assistantAudioChunksRef.current = [];
      cancelledToolCallIdsRef.current.clear();
      liveAssistantTurnIdRef.current = null;
      userTurnIdRef.current = null;
      sendLiveHandleRef.current = {
        sendText: () => false,
        sendAttachment: async () => false,
      };
      captureVideoShareShotRef.current = async () => {};
      onRegisterSend?.(null);
      onRegisterVideoControls?.(null);
    };
  }, [
    connectionRevision,
    onImageGenerationStateChange,
    onError,
    onRegisterSend,
    onRegisterVideoControls,
    providerSettings.apiKey,
    providerSettings.apiUrl,
    providerSettings.liveModel,
    providerSettings.model,
    sessionRequested,
    showHistoryNotice,
  ]);

  useEffect(() => {
    const container = liveHistoryRef.current;
    if (!container) return;

    const frameId = window.requestAnimationFrame(() => {
      if (pendingGeneratedImageScrollRef.current) {
        pendingGeneratedImageScrollRef.current = false;
      }
      updateLiveHistoryScrollState();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [historyNotice, orderedTurns, status, updateLiveHistoryScrollState]);

  const hiddenStatuses = new Set([
    "Open the Live tab to start a session.",
    "Connected. Seeding the current note...",
    "Live talk ready.",
    "Sent.",
  ]);
  const showStatus = !hiddenStatuses.has(status);

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-0 bg-transparent p-0">
      {showStatus ? (
        <div className="bg-mist/40 px-2 py-1 text-sm text-ink/70">{status}</div>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-auto bg-transparent p-0"
        onPointerDown={onHistoryInteract}
        onScroll={updateLiveHistoryScrollState}
        onTouchMove={onHistoryInteract}
        onWheel={onHistoryInteract}
        ref={liveHistoryRef}
      >
        <div className="flex flex-col gap-2">
          {orderedTurns.length === 0 ? (
            <div className="px-2 py-3 text-sm text-ink/45">
              The conversation will appear here once Gemini starts speaking.
            </div>
          ) : null}
          {orderedTurns.map((turn) => {
            const videoControlsVisible = focusedVideoTurnId === turn.id;
            const videoExpanded = expandedVideoTurnIds.has(turn.id);
            return (
              <div
                className={`rounded-[4px] px-3 py-2 text-sm ${
                  turn.role === "assistant" ? "bg-white" : turn.role === "user" ? "self-end bg-ink text-white" : "bg-mist text-ink/60"
                } ${turn.role === "user" ? "max-w-[92%]" : "max-w-[92%]"}`}
                data-active-live-video={turn.id === activeVideoTurnId && turn.videoStream ? "true" : undefined}
                data-live-turn="true"
                key={turn.id}
                style={turn.role === "user" ? { minWidth: "min(400px, 92%)" } : undefined}
              >
                {turn.images?.length ? (
                  <div className={`${turn.content || turn.videoStream ? "mb-2" : ""} grid gap-2`}>
                    {turn.images.map((image) => (
                      <button
                        className="flex overflow-hidden rounded-[8px] border border-ink/10 bg-[#f7f1e6] p-3 text-left"
                        data-live-generated-image={image.origin === "generated" ? "true" : undefined}
                        data-live-generated-image-id={image.origin === "generated" ? image.id : undefined}
                        key={image.id}
                        onClick={() => setPreviewImage(image)}
                        type="button"
                      >
                        <img
                          alt={image.fileName}
                          className={`${turn.role === "user" ? "h-[150px]" : "max-h-[240px]"} w-auto max-w-full object-contain`}
                          src={image.url}
                        />
                      </button>
                    ))}
                  </div>
                ) : null}
                {turn.content ? <div className="whitespace-pre-wrap break-words">{turn.content}</div> : null}
                {turn.videoStream ? (
                  <div
                    className="group relative mt-2 inline-flex max-w-full overflow-hidden rounded-[8px] border border-white/10 bg-black/20"
                    onClick={() => setFocusedVideoTurnId(turn.id)}
                    role="presentation"
                  >
                    <LiveStreamPreview
                      className={`${videoExpanded ? "h-[300px]" : "h-[150px]"} w-auto max-w-full object-contain`}
                      stream={turn.videoStream}
                    />
                    <button
                      aria-label={videoExpanded ? "Shrink camera video" : "Zoom camera video"}
                      className={`absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-[8px] bg-transparent text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.75)] transition hover:bg-white/10 ${
                        videoControlsVisible
                          ? "pointer-events-auto opacity-100"
                          : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setFocusedVideoTurnId(turn.id);
                        toggleVideoTurnZoom(turn.id);
                      }}
                      title={videoExpanded ? "Shrink" : "Zoom"}
                      type="button"
                    >
                      <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                        {videoExpanded ? (
                          <path
                            d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.8"
                          />
                        ) : (
                          <path
                            d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.8"
                          />
                        )}
                      </svg>
                    </button>
                    {turn.videoMode === "camera" ? (
                      <button
                        aria-label="Take camera shot"
                        className="absolute left-2 top-2 flex h-8 w-8 items-center justify-center rounded-[8px] bg-transparent text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.75)] transition hover:bg-white/10"
                        onClick={(event) => {
                          event.stopPropagation();
                          setFocusedVideoTurnId(turn.id);
                          void captureVideoShareShot();
                        }}
                        title="Shot"
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
                  </div>
                ) : null}
                {turn.role === "assistant" && turn.substitutions?.length ? (
                  <div className="mt-3 grid gap-2">
                    {turn.substitutions.map((edit, index) => (
                      <div className="rounded-[14px] border border-ink/10 bg-[#fff7e8] px-3 py-3" key={`${turn.id}:edit:${index}`}>
                        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink/45">Suggested replace</div>
                        <div className="mt-2 whitespace-pre-wrap break-words text-sm text-[#8c5c54] line-through">{edit.find}</div>
                        <div className="mt-2 whitespace-pre-wrap break-words text-sm text-[#1f6f78]">{edit.replace}</div>
                      </div>
                    ))}
                    {onApplyEdits ? (
                      <div className="flex justify-end">
                        <button
                          className="rounded-full border border-ink/10 bg-mist px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink transition hover:border-ink/20 hover:bg-[#efe5d3]"
                          onClick={() => onApplyEdits(turn.substitutions ?? [])}
                          type="button"
                        >
                          Review in editor
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {turn.audioUrl ? (
                  <audio
                    className={`mt-2 h-10 w-full ${turn.role === "user" ? "[color-scheme:dark]" : ""}`}
                    controls
                    preload="metadata"
                    src={turn.audioUrl}
                  />
                ) : null}
              </div>
            );
          })}
          {historyNotice ? (
            <div className="self-center rounded-[4px] bg-mist/80 px-2 py-1 text-xs text-ink/65" key={historyNotice.id}>
              {historyNotice.content}
            </div>
          ) : null}
          <div aria-hidden="true" className="shrink-0 rounded-t-[20px]" style={{ height: 300 }} />
        </div>
      </div>

      {previewImage ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4">
          <div className="max-h-[92vh] w-full max-w-[90vw] overflow-auto rounded-[16px] border border-white/10 bg-[#fff9ef] p-4 shadow-[0_20px_42px_rgba(15,23,42,0.24)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Image</div>
                <div className="truncate text-sm font-medium text-ink">{previewImage.fileName}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {onUploadImageToCurrentFolder ? (
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
                  onClick={() => setPreviewImage(null)}
                  type="button"
                >
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="mt-3 flex justify-center overflow-auto rounded-[12px] border border-ink/10 bg-black/5 p-2">
              <img alt={previewImage.fileName} className="h-auto max-w-[90%] object-contain" src={previewImage.url} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
