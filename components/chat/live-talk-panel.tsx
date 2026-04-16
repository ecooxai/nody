"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { stripMarkdown } from "@/lib/editor/markdown";
import type { AIMediaKind, ProviderSettings } from "@/shared/types";

type LiveGeneratedImage = {
  id: string;
  fileName: string;
  mimeType: string;
  url: string;
  dataBase64: string;
};

type LiveTurn = {
  id: string;
  role: "user" | "assistant" | "status";
  content: string;
  audioUrl?: string;
  images?: LiveGeneratedImage[];
};

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
  sendText: (text: string) => boolean;
};

export type LiveVideoSource = {
  deviceId: string;
  label: string;
};

export type LiveVideoControls = {
  listSources: () => Promise<LiveVideoSource[]>;
  startCameraShare: (deviceId?: string) => Promise<boolean>;
  startScreenShare: () => Promise<boolean>;
  stopVideoShare: () => void;
};

export type LiveVideoShareState = {
  mode: "camera" | "screen" | null;
};

type LiveImageContext = {
  id: string;
  kind: "image";
  fileName: string;
  mimeType: string;
  source: "upload" | "folder";
  dataBase64: string;
};

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
    "If the user wants to change an uploaded image or a previously generated image, you must call generate_image with the edit request.",
    "Do not answer that you will only describe the current image or combine text instructions manually.",
    "The app keeps the most recent uploaded or generated image as the current source image and automatically uploads it to the image API when you call generate_image for an edit.",
    "When the user says modify, change, edit, restyle, remove something from, add something to, or make variations of the current image, treat that as an image edit request and call the tool.",
    "After the tool returns, briefly describe what was generated and mention any notable constraints or variations.",
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
  microphoneDeviceId,
  microphoneEnabled,
  onError,
  onRegisterSend,
  onRegisterVideoControls,
  onSessionStateChange,
  onVideoShareStateChange,
  providerSettings,
}: {
  active: boolean;
  currentNoteBodyMarkdown: string;
  currentNoteTitle: string;
  microphoneDeviceId?: string | null;
  microphoneEnabled?: boolean;
  onError: (message: string) => void;
  onRegisterSend?: ((send: LiveSendHandle | null) => void) | undefined;
  onRegisterVideoControls?: ((controls: LiveVideoControls | null) => void) | undefined;
  onSessionStateChange?: ((state: LiveSessionState) => void) | undefined;
  onVideoShareStateChange?: ((state: LiveVideoShareState) => void) | undefined;
  providerSettings: ProviderSettings;
}) {
  const [sessionRequested, setSessionRequested] = useState(active);
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Open the Live tab to start a session.");
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [previewImage, setPreviewImage] = useState<LiveGeneratedImage | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamDeviceIdRef = useRef<string | null>(null);
  const microphoneAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const microphoneProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const microphoneSinkRef = useRef<GainNode | null>(null);
  const nextAudioTimeRef = useRef(0);
  const liveAssistantTurnIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const microphoneCaptureEnabledRef = useRef(active && (microphoneEnabled ?? true));
  const preferredMicrophoneDeviceIdRef = useRef<string | null>(microphoneDeviceId ?? null);
  const requestMicrophoneRef = useRef<() => Promise<MediaStream | null>>(async () => null);
  const resetMicrophoneRef = useRef(() => {});
  const noteContext = useMemo(() => buildNoteContext(currentNoteTitle, currentNoteBodyMarkdown), [currentNoteBodyMarkdown, currentNoteTitle]);
  const noteContextRef = useRef(noteContext);
  const noteTitleRef = useRef(currentNoteTitle);
  const noteBodyMarkdownRef = useRef(currentNoteBodyMarkdown);
  const onVideoShareStateChangeRef = useRef(onVideoShareStateChange);
  const sendLiveHandleRef = useRef<LiveSendHandle>({
    sendText: () => false,
    sendAttachment: async () => false,
  });
  const socketSessionIdRef = useRef(0);
  const userTurnIdRef = useRef<string | null>(null);
  const userAudioChunksRef = useRef<Uint8Array[]>([]);
  const userAudioActiveRef = useRef(false);
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
  const cancelledToolCallIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useEffect(() => {
    noteContextRef.current = noteContext;
    noteTitleRef.current = currentNoteTitle;
    noteBodyMarkdownRef.current = currentNoteBodyMarkdown;
  }, [noteContext]);

  useEffect(() => {
    preferredMicrophoneDeviceIdRef.current = microphoneDeviceId ?? null;
    const shouldCapture = active && (microphoneEnabled ?? true);
    microphoneCaptureEnabledRef.current = shouldCapture;
    if (active) {
      setSessionRequested(true);
    }
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
    onSessionStateChange?.({ connecting, ready, status });
  }, [connecting, onSessionStateChange, ready, status]);

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
    if (!sessionRequested) {
      setConnecting(false);
      setReady(false);
      setStatus("Open the Live tab to start a session.");
      return;
    }

    if (!providerSettings.apiKey) {
      setConnecting(false);
      setReady(false);
      setStatus("Save your Gemini API key to start live talk.");
      return;
    }

    const model = (providerSettings.liveModel || "").trim() || "gemini-3.1-flash-live-preview";
    if (!model) {
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
      if (microphoneStreamRef.current && microphoneStreamDeviceIdRef.current === preferredDeviceId) {
        return microphoneStreamRef.current;
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
          if (rms >= 0.018) {
            userAudioActiveRef.current = true;
            userAudioTrailingSilenceMsRef.current = 0;
            userAudioChunksRef.current.push(base64ToUint8Array(encodedAudio));
          } else if (userAudioActiveRef.current && userAudioTrailingSilenceMsRef.current < 700) {
            userAudioTrailingSilenceMsRef.current += chunkDurationMs;
            userAudioChunksRef.current.push(base64ToUint8Array(encodedAudio));
          } else if (userAudioActiveRef.current) {
            userAudioActiveRef.current = false;
            userAudioTrailingSilenceMsRef.current = 0;
          }

          socketConnection.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: encodedAudio,
                  mimeType: "audio/pcm;rate=16000",
                },
              },
            }),
          );
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

    const updateUserTurn = (content: string) => {
      if (!content.trim()) return;
      const id = ensureUserTurn();
      setTurns((current) =>
        current.map((turn) => (turn.id === id ? { ...turn, content } : turn)),
      );
    };

    const finalizeUserAudio = () => {
      const userTurnId = userTurnIdRef.current;
      if (!userTurnId) {
        userAudioChunksRef.current = [];
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
      }
      userTurnIdRef.current = null;
      userAudioChunksRef.current = [];
      userAudioActiveRef.current = false;
      userAudioTrailingSilenceMsRef.current = 0;
    };

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
    };

    const appendImagesToAssistantTurn = (images: LiveGeneratedImage[]) => {
      if (images.length === 0) return;
      const existingId = liveAssistantTurnIdRef.current ?? createAssistantTurn();
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
    };

    const sendSetup = () => {
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
                functionDeclarations: [generateImageFunctionDeclaration],
              },
            ],
          },
        }),
      );
    };

    const updateVideoShareState = (mode: "camera" | "screen" | null) => {
      videoShareModeRef.current = mode;
      onVideoShareStateChangeRef.current?.({ mode });
    };

    const stopVideoShare = () => {
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
      updateVideoShareState(null);
    };

    const sendVideoFrame = () => {
      const socketConnection = socketRef.current;
      const videoElement = videoShareElementRef.current;
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN || !videoElement) {
        return;
      }
      if (videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || videoElement.videoWidth <= 0 || videoElement.videoHeight <= 0) {
        return;
      }

      const canvas = videoShareCanvasRef.current ?? document.createElement("canvas");
      videoShareCanvasRef.current = canvas;
      const maxWidth = 1280;
      const ratio = maxWidth / Math.max(videoElement.videoWidth, 1);
      canvas.width = videoElement.videoWidth > maxWidth ? Math.max(1, Math.round(videoElement.videoWidth * ratio)) : videoElement.videoWidth;
      canvas.height =
        videoElement.videoWidth > maxWidth ? Math.max(1, Math.round(videoElement.videoHeight * ratio)) : videoElement.videoHeight;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      const [, dataBase64] = dataUrl.split(",", 2);
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

    const startVideoShare = async (stream: MediaStream, mode: "camera" | "screen") => {
      const socketConnection = socketRef.current;
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Live talk is not connected.");
      }

      stopVideoShare();
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
      sendVideoFrame();
      videoShareIntervalRef.current = window.setInterval(sendVideoFrame, 900);
      updateVideoShareState(mode);
      setStatus(mode === "camera" ? "Sharing camera with Gemini." : "Sharing your screen with Gemini.");
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
      await startVideoShare(stream, "camera");
      return true;
    };

    const startScreenShare = async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Screen sharing is not supported in this browser.");
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      await startVideoShare(stream, "screen");
      return true;
    };

    const sendLiveText = (text: string) => {
      const socketConnection = socketRef.current;
      const trimmedText = text.trim();
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN || !trimmedText) {
        return false;
      }

      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            text: trimmedText,
          },
        }),
      );
      setTurns((current) => [...current, { id: crypto.randomUUID(), role: "user", content: trimmedText }]);
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
        setTurns((current) => [...current, { id: crypto.randomUUID(), role: "user", content: `Sent audio clip: ${attachment.fileName}` }]);
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

      appendImagesToAssistantTurn(images);
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
    };

    const handleToolCall = async (toolCall: NonNullable<Extract<LiveMessage, { toolCall?: unknown }>["toolCall"]>) => {
      const functionCalls = toolCall.functionCalls ?? [];
      if (functionCalls.length === 0) {
        return;
      }

      setStatus("Gemini requested a tool. Generating image...");
      const functionResponses = await Promise.all(
        functionCalls.map(async (call) => {
          try {
            if (call.name !== "generate_image") {
              return {
                id: call.id ?? "",
                name: call.name ?? "unknown_tool",
                response: {
                  ok: false,
                  error: `Unsupported tool: ${call.name ?? "unknown"}.`,
                },
              };
            }
            return await runGenerateImageTool(call);
          } catch (error) {
            return {
              id: call.id ?? "",
              name: call.name ?? "generate_image",
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
      setStatus("Tool response sent to Gemini.");
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
      startScreenShare,
      stopVideoShare,
    });

    socket.onopen = async () => {
      try {
        const context = createAudioContext();
        if (context?.state === "suspended") {
          await context.resume();
        }
        sendSetup();
        setConnecting(false);
        setStatus("Connected. Seeding the current note...");
        void requestMicrophone();
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
      setConnecting(false);
      setReady(false);
      setStatus("Live talk connection failed.");
    };

    socket.onclose = (event) => {
      if (socketSessionIdRef.current !== socketSessionId || closing) {
        return;
      }
      setConnecting(false);
      setReady(false);
      setStatus(event.reason ? `Live talk ended (${event.code}: ${event.reason}).` : `Live talk ended (${event.code}).`);
    };

    return () => {
      closing = true;
      socketRef.current = null;
      socket.close();
      stopVideoShare();
      microphoneCaptureEnabledRef.current = false;
      resetMicrophone();
      nextAudioTimeRef.current = 0;
      userAudioChunksRef.current = [];
      userAudioActiveRef.current = false;
      userAudioTrailingSilenceMsRef.current = 0;
      assistantAudioChunksRef.current = [];
      cancelledToolCallIdsRef.current.clear();
      liveAssistantTurnIdRef.current = null;
      userTurnIdRef.current = null;
      sendLiveHandleRef.current = {
        sendText: () => false,
        sendAttachment: async () => false,
      };
      onRegisterSend?.(null);
      onRegisterVideoControls?.(null);
    };
  }, [
    onError,
    onRegisterSend,
    onRegisterVideoControls,
    providerSettings.apiKey,
    providerSettings.apiUrl,
    providerSettings.liveModel,
    providerSettings.model,
    sessionRequested,
  ]);

  const hiddenStatuses = new Set([
    "Open the Live tab to start a session.",
    "Connected. Seeding the current note...",
    "Live talk ready.",
    "Sent.",
  ]);
  const showStatus = !hiddenStatuses.has(status);

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2 bg-transparent p-[5px]">
      {showStatus ? (
        <div className="bg-mist/40 px-2 py-1 text-sm text-ink/70">{status}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto bg-transparent p-[5px]">
        <div className="flex flex-col gap-2">
          {turns.length === 0 ? (
            <div className="px-2 py-3 text-sm text-ink/45">
              The conversation will appear here once Gemini starts speaking.
            </div>
          ) : null}
          {turns.map((turn) => (
            <div
              className={`rounded-[4px] px-3 py-2 text-sm ${
                turn.role === "assistant" ? "bg-white" : turn.role === "user" ? "self-end bg-ink text-white" : "bg-mist text-ink/60"
              } ${turn.role === "user" ? "max-w-[80%]" : "max-w-[92%]"}`}
              key={turn.id}
            >
              {turn.content ? <div className="whitespace-pre-wrap break-words">{turn.content}</div> : null}
              {turn.images?.length ? (
                <div className="mt-2 grid gap-2">
                  {turn.images.map((image) => (
                    <button
                      className="block overflow-hidden rounded-[10px] border border-ink/10 bg-[#f7f1e6] text-left"
                      key={image.id}
                      onClick={() => setPreviewImage(image)}
                      type="button"
                    >
                      <img alt={image.fileName} className="h-[150px] w-full object-cover" src={image.url} />
                    </button>
                  ))}
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
          ))}
        </div>
      </div>

      {previewImage ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-4xl rounded-[16px] border border-white/10 bg-[#fff9ef] p-4 shadow-[0_20px_42px_rgba(15,23,42,0.24)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Image</div>
                <div className="truncate text-sm font-medium text-ink">{previewImage.fileName}</div>
              </div>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                onClick={() => setPreviewImage(null)}
                type="button"
              >
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
            <div className="mt-3 overflow-hidden rounded-[12px] border border-ink/10 bg-black/5 p-2">
              <img alt={previewImage.fileName} className="max-h-[80vh] w-full object-contain" src={previewImage.url} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
