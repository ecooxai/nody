"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent, type WheelEvent } from "react";

import { apiClient } from "@/lib/api/client";
import { stripMarkdown } from "@/lib/editor/markdown";
import { defaultLiveRecordingSettings } from "@/lib/providers/defaults";
import type { AIMediaKind, AINoteReference, AIResponseAttachment, LiveRecordingSettings, ProviderSettings, TextSubstitution } from "@/shared/types";

type GeneratedImageMetadata = Pick<AIResponseAttachment, "model" | "width" | "height" | "resolution" | "aspectRatio" | "imageSize">;

type LiveGeneratedImage = {
  id: string;
  fileName: string;
  mimeType: string;
  origin: "camera" | "generated";
  url: string;
  dataBase64: string;
} & GeneratedImageMetadata;

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

type CameraShareSendMode = "snapshot" | "video";
type ScreenShareSendMode = "screenshot" | "video";

type LiveMessage =
  | {
      setupComplete?: unknown;
      serverContent?: {
        generationComplete?: boolean;
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
  listening: boolean;
  standby: boolean;
  connecting: boolean;
  ready: boolean;
  status: string;
};

const HIDDEN_LIVE_STATUSES = new Set([
  "Open the Live tab to start a session.",
  "Connected. Seeding the current note...",
  "Live talk ready.",
  "Sent.",
]);

const LIVE_ASSISTANT_PLAYBACK_GAIN = 0.9;
const LIVE_AUDIO_STREAM_SAMPLE_RATE = 16000;
const LIVE_AUDIO_ANALYSIS_SAMPLE_RATE = 1000;
const LIVE_AUDIO_STREAM_PROCESSOR_BUFFER_SIZE = 4096;
const LIVE_MICROPHONE_LEVEL_REFERENCE_RMS = 0.12;
const LIVE_MICROPHONE_STALE_CHECK_INTERVAL_MS = 1200;
const LIVE_MICROPHONE_DETECTOR_WATCHDOG_INTERVAL_MS = 3_000;
const LIVE_MICROPHONE_STALE_TIMEOUT_MS = 3200;
const LIVE_SPEECH_HIGH_PASS_CUTOFF_HZ = 80;
const LIVE_SPEECH_LOW_PASS_CUTOFF_HZ = 7000;
const LIVE_SPEECH_NOISE_GATE_FLOOR_RMS = 0.004;
const LIVE_SPEECH_NOISE_GATE_OPEN_RMS = 0.018;
const LIVE_SPEECH_NOISE_GATE_MIN_GAIN = 0.25;
const LIVE_STANDBY_REPLY_TIMEOUT_MS = 60_000;
const LIVE_STANDBY_INTERACTION_IDLE_DELAY_MS = 2_000;
const LIVE_PLAYBACK_STALE_RESUME_GRACE_MS = 3_000;
const LIVE_STANDBY_PREROLL_MS = 5_000;
const LIVE_STANDBY_BUFFER_LIMIT_MS = 30_000;
const LIVE_STANDBY_NOISE_CALIBRATION_MS = 1_500;
const LIVE_STANDBY_SPEECH_PREROLL_MS = 2_000;
const LIVE_STANDBY_VOICE_TRIGGER_DB = 8;
const LIVE_STANDBY_VOICE_STRONG_TRIGGER_DB = 16;
const LIVE_STANDBY_VOICE_TRIGGER_MS = 900;
const LIVE_STANDBY_VOICE_BURST_WINDOW_MS = 2_000;
const LIVE_STANDBY_VOICE_BURST_TRIGGER_COUNT = 3;
const LIVE_STANDBY_VOICE_BURST_RESET_DB = 3;
const LIVE_STANDBY_NOISE_UPDATE_DB = 4;
const LIVE_STANDBY_RECONNECT_GRACE_MS = 2_500;
const LIVE_SPEECH_END_TRIGGER_DB = 3;
const LIVE_SPEECH_END_MIN_SPEECH_MS = 350;
const LIVE_SPEECH_END_TRAILING_SILENCE_MS = 1_200;
const LIVE_SPEECH_FORCE_SEND_MS = 30_000;
const LIVE_RECONNECT_TRANSCRIPT_MAX_CHARS = 6000;
const LOCAL_AUDIO_INPUT_LABEL_PATTERN = /\b(stereo mix|what u hear|loopback|monitor of|blackhole|soundflower|vb-audio|voicemeeter|cable output|system audio|desktop audio)\b/i;
const LIVE_SCROLL_EDGE_TOLERANCE = 1;

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
  startCameraShare: (deviceId?: string, options?: { video?: boolean }) => Promise<boolean>;
  switchCameraShare: () => Promise<boolean>;
  startScreenShare: (options?: { video?: boolean }) => Promise<boolean>;
  stopVideoShare: () => void;
};

export type LiveAssistantAudioControls = {
  stop: () => void;
};

export type LiveVideoShareState = {
  mode: "camera" | "screen" | null;
  cameraDeviceId?: string | null;
  cameraMode?: CameraShareSendMode | null;
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
} & GeneratedImageMetadata;

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

type PendingLiveAction =
  | {
      kind: "text";
      text: string;
      options?: { displayText?: string };
    }
  | {
      kind: "attachment";
      attachment: LiveSendAttachment;
      resolve: (value: boolean) => void;
      reject: (error: unknown) => void;
    };

const LIVE_IMAGE_GENERATION_NOTICE = "i'll generate image now";
const LIVE_CONTEXT_TOKEN_LIMIT = 16_000;

type SpeechHighPassState = {
  previousInput: number;
  previousOutput: number;
};

type SpeechLowPassState = {
  previousOutput: number;
};

type SpeechNoiseGateState = {
  currentGain: number;
};

type LiveTurnRecorderSession = {
  chunks: Uint8Array[];
  turnId: string;
};

function estimateTokenCount(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
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

  if (inputRate > outputRate) {
    for (let index = 0; index < outputLength; index += 1) {
      const inputStart = index * ratio;
      const inputEnd = inputStart + ratio;
      const firstSampleIndex = Math.floor(inputStart);
      const lastSampleIndex = Math.min(input.length - 1, Math.ceil(inputEnd) - 1);
      let weightedSum = 0;
      let weightTotal = 0;

      for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
        const overlapStart = Math.max(inputStart, sampleIndex);
        const overlapEnd = Math.min(inputEnd, sampleIndex + 1);
        const weight = Math.max(0, overlapEnd - overlapStart);
        weightedSum += (input[sampleIndex] ?? 0) * weight;
        weightTotal += weight;
      }

      output[index] = weightTotal > 0 ? weightedSum / weightTotal : 0;
    }

    return output;
  }

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const weight = position - leftIndex;
    output[index] = input[leftIndex] * (1 - weight) + input[rightIndex] * weight;
  }

  return output;
}

function float32ToPcm16Bytes(input: Float32Array) {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < input.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, input[index] ?? 0));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return bytes;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function concatenateBytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function float32ToBase64Pcm16(input: Float32Array) {
  return bytesToBase64(float32ToPcm16Bytes(input));
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

function getLiveRecordingCaptureGain(settings: LiveRecordingSettings) {
  return [1, 2, 3, 4].includes(settings.recordingGain) ? settings.recordingGain : defaultLiveRecordingSettings.recordingGain;
}

function isAndroidChromeBrowser() {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent.toLowerCase();
  return userAgent.includes("android") && (userAgent.includes("chrome") || userAgent.includes("chromium"));
}

function canScrollVertically(element: HTMLElement) {
  if (element.scrollHeight <= element.clientHeight + LIVE_SCROLL_EDGE_TOLERANCE) return false;
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

function normalizeWheelDeltaY(event: WheelEvent<HTMLElement>) {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function buildLiveMicAudioConstraints(settings: LiveRecordingSettings): MediaTrackConstraints {
  return {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    channelCount: { ideal: 1 },
    sampleSize: { ideal: 16 },
  };
}

function preferSpeechQualityAudio(stream: MediaStream) {
  stream.getAudioTracks().forEach((track) => {
    if ("contentHint" in track) {
      track.contentHint = "speech";
    }
  });
}

function normalizeLiveRecordingSettings(settings?: Partial<LiveRecordingSettings>): LiveRecordingSettings {
  return { ...defaultLiveRecordingSettings, ...(settings ?? {}) };
}

function createSpeechAudioContext() {
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  return new AudioContextCtor();
}

function createSpeechHighPassState(): SpeechHighPassState {
  return { previousInput: 0, previousOutput: 0 };
}

function createSpeechLowPassState(): SpeechLowPassState {
  return { previousOutput: 0 };
}

function createSpeechNoiseGateState(): SpeechNoiseGateState {
  return { currentGain: 1 };
}

function highPassSpeechSamples(samples: Float32Array, sampleRate: number, state?: SpeechHighPassState) {
  if (samples.length === 0) return samples;

  const filtered = new Float32Array(samples.length);
  const rc = 1 / (2 * Math.PI * LIVE_SPEECH_HIGH_PASS_CUTOFF_HZ);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  let previousInput = state?.previousInput ?? samples[0] ?? 0;
  let previousOutput = state?.previousOutput ?? 0;

  for (let index = 0; index < samples.length; index += 1) {
    const currentInput = samples[index] ?? 0;
    const currentOutput = alpha * (previousOutput + currentInput - previousInput);
    filtered[index] = currentOutput;
    previousInput = currentInput;
    previousOutput = currentOutput;
  }

  if (state) {
    state.previousInput = previousInput;
    state.previousOutput = previousOutput;
  }

  return filtered;
}

function lowPassSpeechSamples(samples: Float32Array, sampleRate: number, state?: SpeechLowPassState) {
  if (samples.length === 0) return samples;

  const filtered = new Float32Array(samples.length);
  const rc = 1 / (2 * Math.PI * LIVE_SPEECH_LOW_PASS_CUTOFF_HZ);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  let previousOutput = state?.previousOutput ?? samples[0] ?? 0;

  for (let index = 0; index < samples.length; index += 1) {
    const currentInput = samples[index] ?? 0;
    previousOutput += alpha * (currentInput - previousOutput);
    filtered[index] = previousOutput;
  }

  if (state) {
    state.previousOutput = previousOutput;
  }

  return filtered;
}

function gateQuietSpeechNoise(samples: Float32Array, sampleRate: number, state?: SpeechNoiseGateState) {
  if (samples.length === 0) return samples;

  const gated = new Float32Array(samples.length);
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.02));
  let currentGain = state?.currentGain ?? 1;

  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const end = Math.min(offset + frameSize, samples.length);
    let sumSquares = 0;
    for (let index = offset; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, end - offset));
    const openness = Math.max(
      0,
      Math.min(1, (rms - LIVE_SPEECH_NOISE_GATE_FLOOR_RMS) / (LIVE_SPEECH_NOISE_GATE_OPEN_RMS - LIVE_SPEECH_NOISE_GATE_FLOOR_RMS)),
    );
    const targetGain = LIVE_SPEECH_NOISE_GATE_MIN_GAIN + (1 - LIVE_SPEECH_NOISE_GATE_MIN_GAIN) * openness;

    for (let index = offset; index < end; index += 1) {
      currentGain += (targetGain - currentGain) * 0.2;
      gated[index] = (samples[index] ?? 0) * currentGain;
    }
  }

  if (state) {
    state.currentGain = currentGain;
  }

  return gated;
}

function cleanSpeechSamples(
  samples: Float32Array,
  sampleRate: number,
  states?: {
    highPass?: SpeechHighPassState;
    lowPass?: SpeechLowPassState;
    noiseGate?: SpeechNoiseGateState;
  },
) {
  const highPassed = highPassSpeechSamples(samples, sampleRate, states?.highPass);
  const lowPassed = lowPassSpeechSamples(highPassed, sampleRate, states?.lowPass);
  return gateQuietSpeechNoise(lowPassed, sampleRate, states?.noiseGate);
}

function amplifySpeechSamples(samples: Float32Array, gain: number) {
  const amplified = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const lifted = (samples[index] ?? 0) * gain;
    amplified[index] = Math.tanh(lifted);
  }
  return amplified;
}

function normalizeMicrophoneUiLevel(rms: number) {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.max(0, Math.min(1, Math.sqrt(Math.min(1, rms / LIVE_MICROPHONE_LEVEL_REFERENCE_RMS))));
}

async function decodeAudioBlobToPcm16ChunksBase64(blob: Blob, sampleRate = 16000, chunkSize = 3200) {
  const context = createSpeechAudioContext();
  if (!context) {
    throw new Error("Audio decoding is not supported in this browser.");
  }

  try {
    const sourceBuffer = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(sourceBuffer.slice(0));
    const mono = audioBufferToMonoFloat32Array(decoded);
    const cleaned = cleanSpeechSamples(mono, decoded.sampleRate);
    const resampled = resampleFloat32Array(cleaned, decoded.sampleRate, sampleRate);
    const data = float32ToBase64Pcm16(resampled);
    const chunks: string[] = [];

    for (let offset = 0; offset < resampled.length; offset += chunkSize) {
      chunks.push(float32ToBase64Pcm16(resampled.subarray(offset, Math.min(offset + chunkSize, resampled.length))));
    }

    return {
      chunks,
      data,
      durationMs: (resampled.length / sampleRate) * 1000,
    };
  } finally {
    context.close().catch(() => undefined);
  }
}

function pcm16BytesToWavBytes(pcmBytes: Uint8Array, sampleRate: number) {
  const dataLength = pcmBytes.byteLength;
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
  bytes.set(pcmBytes, offset);
  return wavBuffer;
}

function pcm16ChunksToWavUrl(chunks: Uint8Array[], sampleRate: number) {
  const dataLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (dataLength === 0) {
    return null;
  }

  const pcmBytes = new Uint8Array(dataLength);
  let offset = 0;
  for (const chunk of chunks) {
    pcmBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return URL.createObjectURL(new Blob([pcm16BytesToWavBytes(pcmBytes, sampleRate)], { type: "audio/wav" }));
}

function base64ToObjectUrl(base64: string, mimeType: string) {
  const bytes = base64ToUint8Array(base64);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function generatedImageMetadata(attachment: GeneratedImageMetadata) {
  return {
    ...(attachment.model ? { model: attachment.model } : {}),
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
    ...(attachment.resolution ? { resolution: attachment.resolution } : {}),
    ...(attachment.aspectRatio ? { aspectRatio: attachment.aspectRatio } : {}),
    ...(attachment.imageSize ? { imageSize: attachment.imageSize } : {}),
  };
}

function formatGeneratedImageMetadata(image: GeneratedImageMetadata) {
  const resolution = image.resolution || (image.width && image.height ? `${image.width}x${image.height}` : "");
  return [resolution ? `Resolution ${resolution}` : "", image.model ? `Model ${image.model}` : ""].filter(Boolean).join(" | ");
}

function isLocalSystemAudioInput(label?: string | null) {
  return Boolean(label && LOCAL_AUDIO_INPUT_LABEL_PATTERN.test(label));
}

function buildLiveWebSocketUrl(apiUrl: string, apiKey: string) {
  const base = apiUrl.replace(/\/$/, "");
  const wsBase = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${wsBase}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}&alt=ws`;
}

function trimToLastChars(text: string, maxChars: number) {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function buildLiveTranscriptText(turns: LiveTurn[]) {
  const transcript = turns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => {
      const speaker = turn.role === "user" ? "user" : "AI";
      const message = turn.content.trim() || (turn.images?.length ? "[image turn]" : "[audio turn]");
      return turn.role === "user" ? `${speaker}:\n ${message}` : `${speaker}:\n${message}`;
    })
    .join("\n\n");

  return trimToLastChars(transcript, LIVE_RECONNECT_TRANSCRIPT_MAX_CHARS);
}

function buildNoteContext(noteId: string, title: string, bodyMarkdown: string, noteCatalog: AINoteReference[]) {
  const noteText = stripMarkdown(bodyMarkdown);
  const content = noteText ? `${title}\n\n${noteText}` : `${title}\n\nThis note is currently empty.`;
  const availableNotes =
    noteCatalog.length > 0
      ? noteCatalog
          .map((note, index) => {
            const folder = note.folderName?.trim() ? `, folder: ${note.folderName.trim()}` : "";
            return `${index + 1}. id: ${note.id}, title: ${note.title}${folder}`;
          })
          .join("\n")
      : "No other notes are available.";
  return [
    "You are a live voice assistant inside a note editor.",
    "Use the current note as the active context for the conversation.",
    "Keep responses concise, conversational, and helpful.",
    "The app provides every available note name below. If the user asks to open or switch to a note by name, call open_note with the exact note id or title.",
    "If the user asks to scroll within the note, call scroll_note with a target of top, middle, bottom, line, up, or down. Use line_number for line targets and pixels for up/down when helpful.",
    "If the user asks to find text in the note or jump to the next match, call find_note with the search query and occurrence when relevant.",
    "If the user asks you to create, generate, draw, design, render, or edit an image, first ask for a clear spoken confirmation such as 'generate image' or 'do not generate' and do not call generate_image until the user confirms.",
    `When you do generate an image after confirmation, first reply exactly: ${LIVE_IMAGE_GENERATION_NOTICE}`,
    "If the user asks to upload the current/generated image to the current folder, call upload_current_image.",
    "If the user asks to insert the current/generated image into the note, call insert_current_image. Include line_number when the user says a line number, for example insert image at line 12.",
    "If the user asks to take a camera shot and insert it into the note, call capture_camera_shot and include line_number when they give a line number.",
    "If the user asks you to rewrite, edit, fix, shorten, expand, or transform the note text, call suggest_note_edits.",
    "If the user wants to change an uploaded image or a previously generated image, you must call generate_image with the edit request.",
    "Do not answer that you will only describe the current image or combine text instructions manually.",
    "The app keeps the most recent uploaded or generated image as the current source image and automatically uploads it to the image API when you call generate_image for an edit.",
    "The image tool defaults to a 1024x1024 1:1 image unless the user requests another aspect ratio.",
    "When the user says modify, change, edit, restyle, remove something from, add something to, or make variations of the current image, treat that as an image edit request and call the tool.",
    "After the tool returns, briefly describe what was generated and mention the image resolution and model returned by the tool.",
    "If the user asks you to look through their camera, inspect a physical object, read a page in front of the device, or watch something in the room, call start_camera_share.",
    "Camera sharing uses snapshot mode by default. Snapshot mode does not send images automatically; call capture_camera_shot when the user's request needs a camera image.",
    "If the user explicitly asks for live or continuous camera video, call start_camera_share with mode set to video.",
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
    `Current note id: ${noteId || "unsaved"}`,
    "",
    "Available notes:",
    availableNotes,
    "",
    "Current note:",
    content,
  ].join("\n");
}

const generateImageFunctionDeclaration = {
  name: "generate_image",
  description:
    "Generate or edit an image with the configured Gemini image model. Use this whenever the user asks for an image, illustration, photo, icon, poster, wallpaper, or image edit. If the user refers to an uploaded image or the last generated image, treat the request as an image edit. For edits, the app automatically uploads the current source image to the image API when this tool is called. Defaults to a 1024x1024 1:1 image unless the user asks for another aspect ratio.",
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
        description: "Optional aspect ratio like 1:1, 4:3, 3:4, 16:9, or 9:16. Omit it when the user did not ask for another aspect ratio.",
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

const openNoteFunctionDeclaration = {
  name: "open_note",
  description:
    "Open a note in the app by exact note id or title. Use this when the user asks to open, switch to, or show a note by name.",
  parameters: {
    type: "OBJECT",
    properties: {
      note_id: {
        type: "STRING",
        description: "Exact note id from Available notes when known.",
      },
      title: {
        type: "STRING",
        description: "Exact note title from Available notes.",
      },
    },
  },
};

const scrollNoteFunctionDeclaration = {
  name: "scroll_note",
  description:
    "Scroll within the current note. Use this for requests like go to line 100, scroll to the top, scroll to the bottom, scroll down 300 pixels, or scroll to the middle.",
  parameters: {
    type: "OBJECT",
    properties: {
      target: {
        type: "STRING",
        description: "Scroll target: top, middle, bottom, line, up, or down.",
      },
      line_number: {
        type: "NUMBER",
        description: "Optional 1-based line number when target is line.",
      },
      pixels: {
        type: "NUMBER",
        description: "Optional pixel distance when target is up or down.",
      },
    },
    required: ["target"],
  },
};

const findNoteFunctionDeclaration = {
  name: "find_note",
  description:
    "Find text in the current note and move to the matching content. Use this for requests like show me the part about kids or next match.",
  parameters: {
    type: "OBJECT",
    properties: {
      query: {
        type: "STRING",
        description: "The text to find in the current note.",
      },
      occurrence: {
        type: "STRING",
        description: "Optional match selection: first, next, or previous.",
      },
    },
    required: ["query"],
  },
};

const uploadCurrentImageFunctionDeclaration = {
  name: "upload_current_image",
  description:
    "Upload the current image, usually the latest generated image, to the current folder. Use this when the user asks to save or upload the generated/current image.",
  parameters: {
    type: "OBJECT",
    properties: {},
  },
};

const insertCurrentImageFunctionDeclaration = {
  name: "insert_current_image",
  description:
    "Insert the current image, usually the latest generated image, into the current note. If the user gives a line number, insert before that 1-based line and move existing content down.",
  parameters: {
    type: "OBJECT",
    properties: {
      line_number: {
        type: "NUMBER",
        description: "Optional 1-based note line number. Insert before this line.",
      },
    },
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
    "Start camera sharing in the live session. Use snapshot mode by default; snapshot mode only opens the preview and does not send an image. After starting the camera, call capture_camera_shot when the user's request needs visual inspection. Use video mode only when the user explicitly asks for live or continuous camera video.",
  parameters: {
    type: "OBJECT",
    properties: {
      device_id: {
        type: "STRING",
        description: "Optional camera device id returned by list_available_cameras.",
      },
      mode: {
        type: "STRING",
        description: "Optional. Use 'snapshot' by default. Use 'video' only for explicit live or continuous camera video requests.",
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
    "Capture a still image from the active live camera feed. Use this when the user asks to take, shoot, snap, or capture a photo/image from the camera. If camera sharing is not active, call start_camera_share first. Provide an optional line number if the user wants the shot inserted into the note.",
  parameters: {
    type: "OBJECT",
    properties: {
      line_number: {
        type: "NUMBER",
        description: "Optional 1-based note line number. Insert before this line after capturing the photo.",
      },
    },
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
  currentNoteId,
  currentNoteTitle,
  microphoneDeviceId,
  microphoneEnabled,
  noteCatalog,
  onApplyEdits,
  onAppendToCurrentNote,
  onDisconnectRequest,
  onError,
  onRegisterSend,
  onRegisterVideoControls,
  onRegisterHistoryControls,
  onRegisterAssistantAudioControls,
  onAssistantAudioPlayingChange,
  onHistoryInteract,
  onHistoryTargetsChange,
  onImageGenerationStateChange,
  onInsertGeneratedImageInNote,
  onLatestMessageStateChange,
  onLiveSpeechSent,
  onMicrophoneLevelChange,
  onOpenNote,
  onFindInNote,
  onScrollNote,
  onSessionStateChange,
  onVideoShareStateChange,
  onUploadImageToCurrentFolder,
  providerSettings,
  sessionRequested,
  speechAttachments,
  speechPrompt,
}: {
  active: boolean;
  currentNoteBodyMarkdown: string;
  currentNoteId: string;
  currentNoteTitle: string;
  microphoneDeviceId?: string | null;
  microphoneEnabled?: boolean;
  noteCatalog: AINoteReference[];
  onApplyEdits?: (edits: TextSubstitution[]) => void;
  onAppendToCurrentNote: (markdown: string) => void;
  onDisconnectRequest: () => void;
  onError: (message: string) => void;
  onRegisterSend?: ((send: LiveSendHandle | null) => void) | undefined;
  onRegisterVideoControls?: ((controls: LiveVideoControls | null) => void) | undefined;
  onRegisterHistoryControls?: ((controls: LiveHistoryControls | null) => void) | undefined;
  onRegisterAssistantAudioControls?: ((controls: LiveAssistantAudioControls | null) => void) | undefined;
  onAssistantAudioPlayingChange?: ((playing: boolean) => void) | undefined;
  onHistoryInteract?: (() => void) | undefined;
  onHistoryTargetsChange?: ((targets: LiveHistoryTargets) => void) | undefined;
  onImageGenerationStateChange?: ((generating: boolean) => void) | undefined;
  onInsertGeneratedImageInNote: (attachment: { fileName: string; mimeType: string; previewUrl: string }, lineNumber?: number) => Promise<boolean>;
  onLatestMessageStateChange?: ((available: boolean) => void) | undefined;
  onLiveSpeechSent?: (() => void) | undefined;
  onMicrophoneLevelChange?: ((level: number) => void) | undefined;
  onOpenNote: (target: { noteId?: string; title?: string }) => boolean;
  onFindInNote: (target: { query: string; occurrence?: "first" | "next" | "previous" }) => boolean;
  onScrollNote: (target: { target: "top" | "middle" | "bottom" | "line" | "up" | "down"; lineNumber?: number; pixels?: number }) => boolean;
  onSessionStateChange?: ((state: LiveSessionState) => void) | undefined;
  onVideoShareStateChange?: ((state: LiveVideoShareState) => void) | undefined;
  onUploadImageToCurrentFolder?: ((attachment: { fileName: string; mimeType: string; previewUrl: string }) => Promise<unknown>) | undefined;
  providerSettings: ProviderSettings;
  sessionRequested: boolean;
  speechAttachments?: LiveSendAttachment[];
  speechPrompt?: string;
}) {
  const initialLiveRecordingSettings = normalizeLiveRecordingSettings(providerSettings.liveRecording);
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Open the Live tab to start a session.");
  const [socketRequested, setSocketRequested] = useState(() => !initialLiveRecordingSettings.standbyEnabled);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [previewImage, setPreviewImage] = useState<LiveGeneratedImage | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [focusedVideoTurnId, setFocusedVideoTurnId] = useState<string | null>(null);
  const [expandedVideoTurnIds, setExpandedVideoTurnIds] = useState<Set<string>>(() => new Set());
  const [activeVideoTurnId, setActiveVideoTurnId] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<{ id: string; content: string } | null>(null);
  const [transientStatusNotice, setTransientStatusNotice] = useState<string | null>(null);
  const [assistantAudioPlayingTurnId, setAssistantAudioPlayingTurnId] = useState<string | null>(null);
  const liveHistoryRef = useRef<HTMLDivElement>(null);
  const lastLiveHistoryTouchYRef = useRef<number | null>(null);
  const turnsRef = useRef<LiveTurn[]>([]);
  const wasNearLiveHistoryBottomRef = useRef(true);
  const historyNoticeTimerRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamDeviceIdRef = useRef<string | null>(null);
  const microphoneUsesVideoAudioTrackRef = useRef(false);
  const microphoneRestoreTimerIdsRef = useRef<number[]>([]);
  const microphoneAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const microphoneGainRef = useRef<GainNode | null>(null);
  const microphoneProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const microphoneSinkGainRef = useRef<GainNode | null>(null);
  const microphoneLastFrameAtRef = useRef(0);
  const microphoneRefreshInFlightRef = useRef(false);
  const microphoneHighPassStateRef = useRef<SpeechHighPassState>(createSpeechHighPassState());
  const microphoneLowPassStateRef = useRef<SpeechLowPassState>(createSpeechLowPassState());
  const microphoneNoiseGateStateRef = useRef<SpeechNoiseGateState>(createSpeechNoiseGateState());
  const microphoneStreamingPausedRef = useRef(false);
  const webappPlaybackCountRef = useRef(0);
  const webappPlaybackResumeTimerRef = useRef<number | null>(null);
  const webappPlaybackWatchdogTimerIdsRef = useRef<number[]>([]);
  const webappPlayingMediaElementsRef = useRef<Set<HTMLMediaElement>>(new Set());
  const pauseLiveSpeechRecordingRef = useRef(() => {});
  const resumeLiveSpeechRecordingRef = useRef(() => {});
  const assistantPlaybackGainRef = useRef<GainNode | null>(null);
  const assistantPlaybackSourceReleasesRef = useRef<Set<() => void>>(new Set());
  const assistantPlaybackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const assistantAudioPlayingTurnIdRef = useRef<string | null>(null);
  const assistantAudioStoppedTurnIdRef = useRef<string | null>(null);
  const onFindInNoteRef = useRef(onFindInNote);
  const onMicrophoneLevelChangeRef = useRef(onMicrophoneLevelChange);
  const onScrollNoteRef = useRef(onScrollNote);
  const nextAudioTimeRef = useRef(0);
  const assistantPlaybackMutedUntilRef = useRef(0);
  const liveAssistantTurnIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const connectingRef = useRef(false);
  const activeRef = useRef(active);
  const sessionRequestedRef = useRef(sessionRequested);
  const socketRequestedRef = useRef(!initialLiveRecordingSettings.standbyEnabled);
  const microphoneCaptureEnabledRef = useRef(sessionRequested && active && (microphoneEnabled ?? true));
  const microphoneEnabledRef = useRef(microphoneEnabled ?? true);
  const preferredMicrophoneDeviceIdRef = useRef<string | null>(microphoneDeviceId ?? null);
  const liveRecordingSettingsRef = useRef<LiveRecordingSettings>(initialLiveRecordingSettings);
  const requestMicrophoneRef = useRef<(options?: { force?: boolean }) => Promise<MediaStream | null>>(async () => null);
  const refreshMicrophoneRef = useRef<() => Promise<void>>(async () => {});
  const resetMicrophoneRef = useRef(() => {});
  const noteContext = useMemo(
    () => buildNoteContext(currentNoteId, currentNoteTitle, currentNoteBodyMarkdown, noteCatalog),
    [currentNoteBodyMarkdown, currentNoteId, currentNoteTitle, noteCatalog],
  );
  const noteContextRef = useRef(noteContext);
  const noteCatalogRef = useRef(noteCatalog);
  const noteTitleRef = useRef(currentNoteTitle);
  const noteBodyMarkdownRef = useRef(currentNoteBodyMarkdown);
  const onApplyEditsRef = useRef(onApplyEdits);
  const onAppendToCurrentNoteRef = useRef(onAppendToCurrentNote);
  const onDisconnectRequestRef = useRef(onDisconnectRequest);
  const onInsertGeneratedImageInNoteRef = useRef(onInsertGeneratedImageInNote);
  const onOpenNoteRef = useRef(onOpenNote);
  const onLiveSpeechSentRef = useRef(onLiveSpeechSent);
  const onVideoShareStateChangeRef = useRef(onVideoShareStateChange);
  const speechPromptRef = useRef(speechPrompt ?? "");
  const sendLiveHandleRef = useRef<LiveSendHandle>({
    sendText: () => false,
    sendAttachment: async () => false,
  });
  const socketSessionIdRef = useRef(0);
  const userTurnIdRef = useRef<string | null>(null);
  const userAudioUrlAppliedTurnIdRef = useRef<string | null>(null);
  const userAudioChunksRef = useRef<Uint8Array[]>([]);
  const liveTurnRecorderSessionRef = useRef<LiveTurnRecorderSession | null>(null);
  const pendingUserAudioChunksRef = useRef<Uint8Array[]>([]);
  const pendingUserAudioBase64ChunksRef = useRef<string[]>([]);
  const pendingUserAudioChunkDurationsRef = useRef<number[]>([]);
  const pendingUserAudioDurationMsRef = useRef(0);
  const userAudioActiveRef = useRef(false);
  const userAudioSentToModelRef = useRef(false);
  const userAudioStreamEndedRef = useRef(false);
  const userAudioSpeechDurationMsRef = useRef(0);
  const userAudioSpeechStartMsRef = useRef(0);
  const userAudioTrailingSilenceMsRef = useRef(0);
  const assistantAudioChunksRef = useRef<Uint8Array[]>([]);
  const audioUrlsRef = useRef<string[]>([]);
  const generatedImageUrlsRef = useRef<string[]>([]);
  const latestImageContextRef = useRef<LiveImageContext | null>(null);
  const latestImagePreviewRef = useRef<({ fileName: string; mimeType: string; previewUrl: string } & GeneratedImageMetadata) | null>(null);
  const liveImageInsertInFlightRef = useRef<Set<string>>(new Set());
  const lastLiveImageInsertRef = useRef<{ key: string; insertedAt: number } | null>(null);
  const cameraShotInsertInFlightRef = useRef<Set<string>>(new Set());
  const lastCameraShotRequestRef = useRef<Map<string, number>>(new Map());
  const videoShareStreamRef = useRef<MediaStream | null>(null);
  const videoShareElementRef = useRef<HTMLVideoElement | null>(null);
  const videoShareCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoShareIntervalRef = useRef<number | null>(null);
  const videoShareFrameInFlightRef = useRef(false);
  const videoShareModeRef = useRef<"camera" | "screen" | null>(null);
  const cameraShareSendModeRef = useRef<CameraShareSendMode | null>(null);
  const screenShareSendModeRef = useRef<ScreenShareSendMode | null>(null);
  const currentCameraDeviceIdRef = useRef<string | null>(null);
  const currentCameraLabelRef = useRef<string | null>(null);
  const videoShareIdleTimerRef = useRef<number | null>(null);
  const stopVideoShareRef = useRef<(options?: { replacing?: boolean }) => void>(() => {});
  const videoShareTurnIdRef = useRef<string | null>(null);
  const captureVideoShareShotRef = useRef<() => Promise<void>>(async () => {});
  const cancelledToolCallIdsRef = useRef<Set<string>>(new Set());
  const finalizeUserAudioRef = useRef(() => {});
  const appliedNoteContextRef = useRef(noteContext);
  const userAudioPromptContextRef = useRef("");
  const noteReconnectTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const assistantReplyTimeoutRef = useRef<number | null>(null);
  const webappInteractionPointerCountRef = useRef(0);
  const webappInteractionActiveUntilRef = useRef(0);
  const pendingGeneratedImageScrollRef = useRef(false);
  const liveContextTokensRef = useRef(0);
  const contextLimitHandlingRef = useRef(false);
  const standbyPreRollRef = useRef<Array<{ bytes: Uint8Array; base64: string; durationMs: number }>>([]);
  const standbyPreRollDurationMsRef = useRef(0);
  const standbyNoiseFloorDbRef = useRef<number | null>(null);
  const standbyNoiseCalibrationMsRef = useRef(0);
  const standbySpeechBoostMsRef = useRef(0);
  const standbyVoiceBurstTimesRef = useRef<number[]>([]);
  const standbyVoiceBurstActiveRef = useRef(false);
  const standbyReconnectBlockedUntilRef = useRef(0);
  const voiceActivationPendingRef = useRef(false);
  const pendingSpeechReadyToSendRef = useRef(false);
  const pendingSpeechSendingRef = useRef(false);
  const pendingSpeechVideoRef = useRef<{ data: string; mimeType: string } | null>(null);
  const queuedLiveActionsRef = useRef<PendingLiveAction[]>([]);
  const performLiveTextSendRef = useRef<(text: string, options?: { displayText?: string }) => boolean>(() => false);
  const performLiveAttachmentSendRef = useRef<(attachment: LiveSendAttachment) => Promise<boolean>>(async () => false);
  const prepareSpeechTurnRef = useRef<(socketConnection: WebSocket) => Promise<void> | void>(() => {});
  const flushPendingSpeechAudioRef = useRef<() => Promise<void> | void>(() => {});
  const speechAttachmentsRef = useRef<LiveSendAttachment[]>(speechAttachments ?? []);

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

  const beginWebappPlayback = useCallback(() => {
    if (webappPlaybackResumeTimerRef.current) {
      window.clearTimeout(webappPlaybackResumeTimerRef.current);
      webappPlaybackResumeTimerRef.current = null;
    }
    webappPlaybackCountRef.current += 1;
    pauseLiveSpeechRecordingRef.current();
  }, []);

  const endWebappPlayback = useCallback(() => {
    webappPlaybackCountRef.current = Math.max(0, webappPlaybackCountRef.current - 1);
    if (webappPlaybackCountRef.current === 0) {
      const resumeDelayMs = Math.max(0, assistantPlaybackMutedUntilRef.current - performance.now());
      if (resumeDelayMs > 0) {
        webappPlaybackResumeTimerRef.current = window.setTimeout(() => {
          webappPlaybackResumeTimerRef.current = null;
          if (webappPlaybackCountRef.current === 0) {
            resumeLiveSpeechRecordingRef.current();
          }
        }, resumeDelayMs);
        return;
      }
      resumeLiveSpeechRecordingRef.current();
    }
  }, []);

  const clearExpiredPlaybackPause = useCallback(() => {
    if (webappPlaybackResumeTimerRef.current) {
      window.clearTimeout(webappPlaybackResumeTimerRef.current);
      webappPlaybackResumeTimerRef.current = null;
    }
    webappPlaybackWatchdogTimerIdsRef.current.forEach((timerId) => window.clearTimeout(timerId));
    webappPlaybackWatchdogTimerIdsRef.current = [];
    webappPlaybackCountRef.current = 0;
    assistantPlaybackMutedUntilRef.current = 0;
    microphoneStreamingPausedRef.current = false;
  }, []);

  const stopAssistantAudioPlayback = useCallback(() => {
    assistantAudioStoppedTurnIdRef.current = assistantAudioPlayingTurnIdRef.current;
    const releases = Array.from(assistantPlaybackSourceReleasesRef.current);
    assistantPlaybackSourceReleasesRef.current.clear();
    for (const release of releases) {
      release();
    }
    const sources = Array.from(assistantPlaybackSourcesRef.current);
    assistantPlaybackSourcesRef.current.clear();
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already stopped sources are harmless.
      }
      try {
        source.disconnect();
      } catch {
        // Already disconnected sources are harmless.
      }
    }
    if (audioContextRef.current) {
      nextAudioTimeRef.current = audioContextRef.current.currentTime;
    } else {
      nextAudioTimeRef.current = 0;
    }
    clearExpiredPlaybackPause();
    assistantAudioPlayingTurnIdRef.current = null;
    setAssistantAudioPlayingTurnId(null);
  }, [clearExpiredPlaybackPause]);

  useEffect(() => {
    onAssistantAudioPlayingChange?.(Boolean(assistantAudioPlayingTurnId));
  }, [assistantAudioPlayingTurnId, onAssistantAudioPlayingChange]);

  useEffect(() => {
    if (!onRegisterAssistantAudioControls) return;
    onRegisterAssistantAudioControls({ stop: stopAssistantAudioPlayback });
    return () => onRegisterAssistantAudioControls(null);
  }, [onRegisterAssistantAudioControls, stopAssistantAudioPlayback]);

  const hasAudibleWebappPlayback = useCallback(() => {
    for (const element of webappPlayingMediaElementsRef.current) {
      if (!element.paused && !element.ended && !element.muted && element.volume > 0) {
        return true;
      }
    }
    return false;
  }, []);

  const clearAssistantReplyTimeout = useCallback(() => {
    if (assistantReplyTimeoutRef.current) {
      window.clearTimeout(assistantReplyTimeoutRef.current);
      assistantReplyTimeoutRef.current = null;
    }
  }, []);

  const getWebappInteractionDelayMs = useCallback(() => {
    if (webappInteractionPointerCountRef.current > 0) {
      return LIVE_STANDBY_INTERACTION_IDLE_DELAY_MS;
    }
    return Math.max(0, webappInteractionActiveUntilRef.current - performance.now());
  }, []);

  const sendUserAudioStreamEnd = useCallback(() => {
    if (userAudioStreamEndedRef.current || !userAudioSentToModelRef.current) {
      return false;
    }

    const socketConnection = socketRef.current;
    if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) {
      return false;
    }

    socketConnection.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    userAudioStreamEndedRef.current = true;
    userAudioTrailingSilenceMsRef.current = 0;
    return true;
  }, []);

  const standbyStatusMessage = useCallback(() => {
    return liveRecordingSettingsRef.current.standbyEnabled
      ? "Standby listening. Speak a few words or send a message to reconnect."
      : "Live talk disconnected.";
  }, []);

  const resetStandbyVoiceActivationState = useCallback((options?: { resetNoiseFloor?: boolean }) => {
    if (options?.resetNoiseFloor) {
      standbyNoiseFloorDbRef.current = null;
      standbyNoiseCalibrationMsRef.current = 0;
    } else if (standbyNoiseFloorDbRef.current !== null) {
      standbyNoiseCalibrationMsRef.current = LIVE_STANDBY_NOISE_CALIBRATION_MS;
    }
    standbySpeechBoostMsRef.current = 0;
    standbyVoiceBurstTimesRef.current = [];
    standbyVoiceBurstActiveRef.current = false;
  }, []);

  const finalizeSpeechCaptureState = useCallback(() => {
    finalizeUserAudioRef.current();
    clearAssistantReplyTimeout();
    standbyPreRollRef.current = [];
    standbyPreRollDurationMsRef.current = 0;
    resetStandbyVoiceActivationState();
    voiceActivationPendingRef.current = false;
    pendingSpeechReadyToSendRef.current = false;
    pendingSpeechSendingRef.current = false;
    pendingSpeechVideoRef.current = null;
  }, [clearAssistantReplyTimeout, resetStandbyVoiceActivationState]);

  const enterStandby = useCallback((message?: string) => {
    if (!sessionRequestedRef.current) return;
    clearAssistantReplyTimeout();
    setConnecting(false);
    setReady(false);
    setSocketRequested(false);
    finalizeSpeechCaptureState();
    standbyReconnectBlockedUntilRef.current = performance.now() + LIVE_STANDBY_RECONNECT_GRACE_MS;
    standbyPreRollRef.current = [];
    standbyPreRollDurationMsRef.current = 0;
    resetStandbyVoiceActivationState({ resetNoiseFloor: true });
    setStatus(message ?? standbyStatusMessage());
  }, [clearAssistantReplyTimeout, finalizeSpeechCaptureState, resetStandbyVoiceActivationState, standbyStatusMessage]);

  const armAssistantReplyTimeout = useCallback(() => {
    clearAssistantReplyTimeout();
    if (!sessionRequestedRef.current || !liveRecordingSettingsRef.current.standbyEnabled) return;
    const enterStandbyWhenIdle = () => {
      const interactionDelayMs = getWebappInteractionDelayMs();
      if (interactionDelayMs > 0) {
        assistantReplyTimeoutRef.current = window.setTimeout(() => {
          assistantReplyTimeoutRef.current = null;
          enterStandbyWhenIdle();
        }, interactionDelayMs);
        return;
      }
      enterStandby("No AI reply for 60 seconds. Back in standby listening.");
    };
    assistantReplyTimeoutRef.current = window.setTimeout(() => {
      assistantReplyTimeoutRef.current = null;
      if (sendUserAudioStreamEnd()) {
        setStatus("No AI reply yet. Ending the current audio stream...");
        assistantReplyTimeoutRef.current = window.setTimeout(() => {
          assistantReplyTimeoutRef.current = null;
          enterStandbyWhenIdle();
        }, LIVE_STANDBY_REPLY_TIMEOUT_MS);
        return;
      }
      enterStandbyWhenIdle();
    }, LIVE_STANDBY_REPLY_TIMEOUT_MS);
  }, [clearAssistantReplyTimeout, enterStandby, getWebappInteractionDelayMs, sendUserAudioStreamEnd]);

  const buildConnectionAudioNotice = useCallback(() => {
    const enabledProcessing = [
      liveRecordingSettingsRef.current.echoCancellation ? "echo cancellation" : "",
      liveRecordingSettingsRef.current.noiseSuppression ? "noise reduction" : "",
      liveRecordingSettingsRef.current.autoGainControl ? "auto gain" : "",
    ].filter(Boolean);

    if (enabledProcessing.length === 0) return "";

    const verb = enabledProcessing.length === 1 ? "is" : "are";
    return `Browser ${enabledProcessing.join(" and ")} ${verb} enabled for this live connection.`;
  }, []);

  const queueLiveAction = useCallback((action: PendingLiveAction) => {
    queuedLiveActionsRef.current.push(action);
  }, []);

  const flushQueuedLiveActions = useCallback(async () => {
    if (queuedLiveActionsRef.current.length === 0) return;
    const pending = [...queuedLiveActionsRef.current];
    queuedLiveActionsRef.current = [];
    for (const action of pending) {
      if (action.kind === "text") {
        const sent = performLiveTextSendRef.current(action.text, action.options);
        if (!sent) {
          queuedLiveActionsRef.current.unshift(action);
          break;
        }
        continue;
      }
      try {
        const sent = await performLiveAttachmentSendRef.current(action.attachment);
        action.resolve(sent);
        if (!sent) {
          queueLiveAction(action);
          break;
        }
      } catch (error) {
        action.reject(error);
      }
    }
  }, [queueLiveAction]);

  const requestSocketConnection = useCallback((message?: string) => {
    if (!sessionRequestedRef.current) {
      return false;
    }
    if (readyRef.current || connectingRef.current || socketRequestedRef.current) {
      return true;
    }
    setSocketRequested(true);
    setStatus(message ?? "Connecting to Gemini Live...");
    return true;
  }, []);

  const appendStandbyPreRoll = useCallback((bytes: Uint8Array, base64: string, durationMs: number) => {
    standbyPreRollRef.current.push({ bytes, base64, durationMs });
    standbyPreRollDurationMsRef.current += durationMs;
    while (
      standbyPreRollRef.current.length > 0 &&
      standbyPreRollDurationMsRef.current > LIVE_STANDBY_PREROLL_MS
    ) {
      const shifted = standbyPreRollRef.current.shift();
      standbyPreRollDurationMsRef.current = Math.max(0, standbyPreRollDurationMsRef.current - (shifted?.durationMs ?? 0));
    }
  }, []);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    onMicrophoneLevelChangeRef.current = onMicrophoneLevelChange;
  }, [onMicrophoneLevelChange]);

  useEffect(() => {
    const isAudibleMediaElement = (target: EventTarget | null): target is HTMLMediaElement =>
      target instanceof HTMLMediaElement && !target.muted && target.volume > 0;

    const handleMediaPlaybackStart = (event: Event) => {
      const element = event.target;
      if (!isAudibleMediaElement(element) || webappPlayingMediaElementsRef.current.has(element)) return;
      webappPlayingMediaElementsRef.current.add(element);
      beginWebappPlayback();
    };

    const handleMediaPlaybackStop = (event: Event) => {
      const element = event.target;
      if (!(element instanceof HTMLMediaElement) || !webappPlayingMediaElementsRef.current.delete(element)) return;
      endWebappPlayback();
    };

    document.addEventListener("play", handleMediaPlaybackStart, true);
    document.addEventListener("playing", handleMediaPlaybackStart, true);
    document.addEventListener("pause", handleMediaPlaybackStop, true);
    document.addEventListener("ended", handleMediaPlaybackStop, true);
    document.addEventListener("emptied", handleMediaPlaybackStop, true);
    document.addEventListener("abort", handleMediaPlaybackStop, true);

    return () => {
      document.removeEventListener("play", handleMediaPlaybackStart, true);
      document.removeEventListener("playing", handleMediaPlaybackStart, true);
      document.removeEventListener("pause", handleMediaPlaybackStop, true);
      document.removeEventListener("ended", handleMediaPlaybackStop, true);
      document.removeEventListener("emptied", handleMediaPlaybackStop, true);
      document.removeEventListener("abort", handleMediaPlaybackStop, true);
      const playingElements = webappPlayingMediaElementsRef.current.size;
      webappPlayingMediaElementsRef.current.clear();
      webappPlaybackCountRef.current = Math.max(0, webappPlaybackCountRef.current - playingElements);
      if (webappPlaybackResumeTimerRef.current) {
        window.clearTimeout(webappPlaybackResumeTimerRef.current);
        webappPlaybackResumeTimerRef.current = null;
      }
    };
  }, [beginWebappPlayback, endWebappPlayback]);

  useEffect(() => {
    const markKeyboardInteraction = () => {
      webappInteractionActiveUntilRef.current = performance.now() + LIVE_STANDBY_INTERACTION_IDLE_DELAY_MS;
    };
    const handlePointerDown = () => {
      webappInteractionPointerCountRef.current += 1;
      markKeyboardInteraction();
    };
    const handlePointerUp = () => {
      webappInteractionPointerCountRef.current = Math.max(0, webappInteractionPointerCountRef.current - 1);
      markKeyboardInteraction();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerUp, true);
    window.addEventListener("keydown", markKeyboardInteraction, true);
    window.addEventListener("beforeinput", markKeyboardInteraction, true);
    window.addEventListener("input", markKeyboardInteraction, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerUp, true);
      window.removeEventListener("keydown", markKeyboardInteraction, true);
      window.removeEventListener("beforeinput", markKeyboardInteraction, true);
      window.removeEventListener("input", markKeyboardInteraction, true);
      webappInteractionPointerCountRef.current = 0;
      webappInteractionActiveUntilRef.current = 0;
    };
  }, []);

  const clearVideoShareIdleTimer = () => {
    if (videoShareIdleTimerRef.current) {
      window.clearTimeout(videoShareIdleTimerRef.current);
      videoShareIdleTimerRef.current = null;
    }
  };

  const armVideoShareIdleTimer = () => {
    const activeVideoMode =
      videoShareModeRef.current === "camera"
        ? cameraShareSendModeRef.current
        : videoShareModeRef.current === "screen"
          ? screenShareSendModeRef.current
          : null;
    if (activeVideoMode !== "video") return;

    clearVideoShareIdleTimer();
    videoShareIdleTimerRef.current = window.setTimeout(() => {
      const stillActiveMode =
        videoShareModeRef.current === "camera"
          ? cameraShareSendModeRef.current
          : videoShareModeRef.current === "screen"
            ? screenShareSendModeRef.current
            : null;
      if (stillActiveMode !== "video") return;
      stopVideoShareRef.current();
      setStatus("Video share stopped after 1 minute of inactivity.");
    }, 60_000);
  };

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useEffect(() => {
    connectingRef.current = connecting;
  }, [connecting]);

  useEffect(() => {
    sessionRequestedRef.current = sessionRequested;
  }, [sessionRequested]);

  useEffect(() => {
    socketRequestedRef.current = socketRequested;
  }, [socketRequested]);

  useEffect(() => {
    noteContextRef.current = noteContext;
    noteCatalogRef.current = noteCatalog;
    noteTitleRef.current = currentNoteTitle;
    noteBodyMarkdownRef.current = currentNoteBodyMarkdown;
  }, [currentNoteId, currentNoteTitle, currentNoteBodyMarkdown, noteCatalog, noteContext]);

  useEffect(() => {
    onOpenNoteRef.current = onOpenNote;
    onFindInNoteRef.current = onFindInNote;
    onScrollNoteRef.current = onScrollNote;
  }, [onFindInNote, onOpenNote, onScrollNote]);

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
      if (assistantReplyTimeoutRef.current) {
        window.clearTimeout(assistantReplyTimeoutRef.current);
        assistantReplyTimeoutRef.current = null;
      }
      microphoneRestoreTimerIdsRef.current.forEach((timerId) => window.clearTimeout(timerId));
      microphoneRestoreTimerIdsRef.current = [];
      onMicrophoneLevelChangeRef.current?.(0);
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
    liveRecordingSettingsRef.current = normalizeLiveRecordingSettings(providerSettings.liveRecording);
    if (!sessionRequested) {
      setSocketRequested(false);
      return;
    }
    if (!liveRecordingSettingsRef.current.standbyEnabled) {
      setSocketRequested(true);
      return;
    }
    if (!readyRef.current && !connectingRef.current && !voiceActivationPendingRef.current && queuedLiveActionsRef.current.length === 0) {
      setSocketRequested(false);
      setStatus(standbyStatusMessage());
    }
  }, [providerSettings.liveRecording, sessionRequested, standbyStatusMessage]);

  useEffect(() => {
    activeRef.current = active;
    microphoneEnabledRef.current = microphoneEnabled ?? true;
    preferredMicrophoneDeviceIdRef.current = microphoneDeviceId ?? null;
    liveRecordingSettingsRef.current = normalizeLiveRecordingSettings(providerSettings.liveRecording);
    const shouldCapture = sessionRequested && active && (microphoneEnabled ?? true);
    microphoneCaptureEnabledRef.current = shouldCapture;
    if (!shouldCapture) {
      resetMicrophoneRef.current();
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN || liveRecordingSettingsRef.current.standbyEnabled) {
      resetMicrophoneRef.current();
      void requestMicrophoneRef.current();
    }
  }, [
    active,
    microphoneDeviceId,
    microphoneEnabled,
    providerSettings.liveRecording,
    providerSettings.liveRecording?.autoGainControl,
    providerSettings.liveRecording?.echoCancellation,
    providerSettings.liveRecording?.noiseSuppression,
    providerSettings.liveRecording?.recordingGain,
    sessionRequested,
  ]);

  useEffect(() => {
    if (!sessionRequested) {
      onMicrophoneLevelChangeRef.current?.(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      if (!microphoneCaptureEnabledRef.current) {
        onMicrophoneLevelChangeRef.current?.(0);
        return;
      }

      const stream = microphoneStreamRef.current;
      const processor = microphoneProcessorRef.current;
      const audioContext = microphoneAudioContextRef.current;
      const track = stream?.getAudioTracks()[0] ?? null;
      const now = performance.now();
      if (
        webappPlaybackCountRef.current > 0 &&
        assistantPlaybackMutedUntilRef.current > 0 &&
        now > assistantPlaybackMutedUntilRef.current + LIVE_PLAYBACK_STALE_RESUME_GRACE_MS &&
        !hasAudibleWebappPlayback()
      ) {
        clearExpiredPlaybackPause();
      }
      const mutedByPlayback =
        microphoneStreamingPausedRef.current ||
        webappPlaybackCountRef.current > 0 ||
        now < assistantPlaybackMutedUntilRef.current ||
        hasAudibleWebappPlayback();

      if (mutedByPlayback) {
        onMicrophoneLevelChangeRef.current?.(0);
        return;
      }

      if (audioContext?.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }

      if (!stream || !stream.active || !processor || !track || track.readyState !== "live") {
        if (microphoneLastFrameAtRef.current > 0 || stream) {
          void refreshMicrophoneRef.current();
        }
        return;
      }

      if (microphoneLastFrameAtRef.current > 0 && now - microphoneLastFrameAtRef.current > LIVE_MICROPHONE_STALE_TIMEOUT_MS) {
        void refreshMicrophoneRef.current();
      }
    }, LIVE_MICROPHONE_STALE_CHECK_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [clearExpiredPlaybackPause, hasAudibleWebappPlayback, sessionRequested]);

  useEffect(() => {
    if (!sessionRequested) return;

    const intervalId = window.setInterval(() => {
      if (!microphoneCaptureEnabledRef.current) return;

      const stream = microphoneStreamRef.current;
      const track = stream?.getAudioTracks()[0] ?? null;
      const processor = microphoneProcessorRef.current;
      const audioContext = microphoneAudioContextRef.current;
      const now = performance.now();

      if (
        webappPlaybackCountRef.current > 0 &&
        assistantPlaybackMutedUntilRef.current > 0 &&
        now > assistantPlaybackMutedUntilRef.current + LIVE_PLAYBACK_STALE_RESUME_GRACE_MS &&
        !hasAudibleWebappPlayback()
      ) {
        clearExpiredPlaybackPause();
      }

      if (audioContext?.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }

      const mutedByPlayback =
        microphoneStreamingPausedRef.current ||
        webappPlaybackCountRef.current > 0 ||
        now < assistantPlaybackMutedUntilRef.current ||
        hasAudibleWebappPlayback();
      if (mutedByPlayback) {
        return;
      }

      const detectorMissing =
        !stream ||
        !stream.active ||
        !track ||
        track.readyState !== "live" ||
        !processor ||
        !processor.onaudioprocess ||
        !audioContext ||
        audioContext.state === "closed";
      const detectorStale =
        microphoneLastFrameAtRef.current > 0 &&
        now - microphoneLastFrameAtRef.current > LIVE_MICROPHONE_DETECTOR_WATCHDOG_INTERVAL_MS;

      if (detectorMissing || detectorStale) {
        void refreshMicrophoneRef.current();
      }
    }, LIVE_MICROPHONE_DETECTOR_WATCHDOG_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [clearExpiredPlaybackPause, hasAudibleWebappPlayback, sessionRequested]);

  useEffect(() => {
    onVideoShareStateChangeRef.current = onVideoShareStateChange;
  }, [onVideoShareStateChange]);

  useEffect(() => {
    onApplyEditsRef.current = onApplyEdits;
  }, [onApplyEdits]);

  useEffect(() => {
    onAppendToCurrentNoteRef.current = onAppendToCurrentNote;
  }, [onAppendToCurrentNote]);

  useEffect(() => {
    onDisconnectRequestRef.current = onDisconnectRequest;
  }, [onDisconnectRequest]);

  useEffect(() => {
    onInsertGeneratedImageInNoteRef.current = onInsertGeneratedImageInNote;
  }, [onInsertGeneratedImageInNote]);

  useEffect(() => {
    onOpenNoteRef.current = onOpenNote;
  }, [onOpenNote]);

  useEffect(() => {
    onLiveSpeechSentRef.current = onLiveSpeechSent;
  }, [onLiveSpeechSent]);

  useEffect(() => {
    speechPromptRef.current = speechPrompt ?? "";
  }, [speechPrompt]);

  useEffect(() => {
    speechAttachmentsRef.current = speechAttachments ?? [];
  }, [speechAttachments]);

  useEffect(() => {
    const listening = sessionRequested;
    const standby = listening && !ready && !connecting;
    onSessionStateChange?.({ listening, standby, connecting, ready, status });
  }, [connecting, onSessionStateChange, ready, sessionRequested, status]);

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
            ...generatedImageMetadata(image),
          })),
      ),
    [orderedTurns],
  );
  const userAudioDisplay = useMemo(() => {
    const inlineIds = new Set<string>();
    const foldedClips: Array<{ id: string; audioUrl: string; label: string }> = [];
    const pendingAudioOnlyTurns: LiveTurn[] = [];

    const flushPendingAudioOnlyTurns = () => {
      if (pendingAudioOnlyTurns.length === 0) return;
      const inlineTurn = pendingAudioOnlyTurns[pendingAudioOnlyTurns.length - 1];
      if (inlineTurn) {
        inlineIds.add(inlineTurn.id);
      }
      for (const turn of pendingAudioOnlyTurns.slice(0, -1)) {
        if (!turn.audioUrl) continue;
        foldedClips.push({
          id: turn.id,
          audioUrl: turn.audioUrl,
          label: `Spoken clip ${foldedClips.length + 1}`,
        });
      }
      pendingAudioOnlyTurns.length = 0;
    };

    for (const turn of orderedTurns) {
      if (turn.role === "user" && turn.audioUrl) {
        if (turn.content.trim()) {
          flushPendingAudioOnlyTurns();
          inlineIds.add(turn.id);
        } else {
          pendingAudioOnlyTurns.push(turn);
        }
        continue;
      }
      flushPendingAudioOnlyTurns();
    }

    flushPendingAudioOnlyTurns();
    return {
      foldedClips,
      foldedIds: new Set(foldedClips.map((clip) => clip.id)),
      inlineIds,
    };
  }, [orderedTurns]);

  const setLatestMessageAvailable = useCallback((available: boolean) => {
    onLatestMessageStateChange?.(available);
  }, [onLatestMessageStateChange]);

  const updateLiveHistoryScrollState = useCallback(() => {
    const container = liveHistoryRef.current;
    if (!container) return;
    const nearLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    wasNearLiveHistoryBottomRef.current = nearLatest;
    setLatestMessageAvailable(!nearLatest);
  }, [setLatestMessageAvailable]);

  const containLiveHistoryWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;

    event.stopPropagation();
    onHistoryInteract?.();
    const deltaY = normalizeWheelDeltaY(event);
    const scrollContainer = findVerticalScrollContainer(event.target, event.currentTarget);
    if (scrollContainer) {
      scrollContainer.scrollTop += deltaY;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    updateLiveHistoryScrollState();
  }, [onHistoryInteract, updateLiveHistoryScrollState]);

  const rememberLiveHistoryTouch = useCallback((event: TouchEvent<HTMLDivElement>) => {
    lastLiveHistoryTouchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const containLiveHistoryTouch = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) return;

    event.stopPropagation();
    onHistoryInteract?.();
    const currentY = event.touches[0].clientY;
    const previousY = lastLiveHistoryTouchYRef.current;
    lastLiveHistoryTouchYRef.current = currentY;
    if (previousY === null) return;

    const deltaY = previousY - currentY;
    if (deltaY === 0) return;

    const scrollContainer = findVerticalScrollContainer(event.target, event.currentTarget);
    if (scrollContainer) {
      scrollContainer.scrollTop += deltaY;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    updateLiveHistoryScrollState();
  }, [onHistoryInteract, updateLiveHistoryScrollState]);

  const scrollToLiveLatest = useCallback(() => {
    const container = liveHistoryRef.current;
    if (!container) return;
    onHistoryInteract?.();
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
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

  const sendTextToLive = useCallback((text: string, options?: { displayText?: string }) => {
    const trimmedText = text.trim();
    if (!trimmedText || !sessionRequestedRef.current) {
      return false;
    }
    if (readyRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
      return performLiveTextSendRef.current(trimmedText, options);
    }
    queueLiveAction({
      kind: "text",
      text: trimmedText,
      options,
    });
    return requestSocketConnection("Connecting to Gemini Live...");
  }, [queueLiveAction, requestSocketConnection]);

  const sendAttachmentToLive = useCallback(async (attachment: LiveSendAttachment) => {
    if (!sessionRequestedRef.current) {
      return false;
    }
    if (readyRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
      return performLiveAttachmentSendRef.current(attachment);
    }
    return await new Promise<boolean>((resolve, reject) => {
      queueLiveAction({
        kind: "attachment",
        attachment,
        resolve,
        reject,
      });
      if (!requestSocketConnection("Connecting to Gemini Live...")) {
        reject(new Error("Live talk is not enabled."));
      }
    });
  }, [queueLiveAction, requestSocketConnection]);

  useEffect(() => {
    if (!onRegisterSend) return;
    if (!sessionRequested) {
      onRegisterSend(null);
      return;
    }
    const handle: LiveSendHandle = {
      sendText: sendTextToLive,
      sendAttachment: sendAttachmentToLive,
    };
    sendLiveHandleRef.current = handle;
    onRegisterSend(handle);
    return () => onRegisterSend(null);
  }, [onRegisterSend, sendAttachmentToLive, sendTextToLive, sessionRequested]);

  useEffect(() => {
    const resetMicrophone = () => {
      pauseLiveSpeechRecordingRef.current = () => {};
      resumeLiveSpeechRecordingRef.current = () => {};
      microphoneStreamingPausedRef.current = false;
      microphoneLastFrameAtRef.current = 0;
      microphoneProcessorRef.current?.disconnect();
      microphoneProcessorRef.current = null;
      microphoneSinkGainRef.current?.disconnect();
      microphoneSinkGainRef.current = null;
      microphoneGainRef.current?.disconnect();
      microphoneGainRef.current = null;
      microphoneSourceRef.current?.disconnect();
      microphoneSourceRef.current = null;
      if (!microphoneUsesVideoAudioTrackRef.current) {
        microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      }
      microphoneStreamRef.current = null;
      microphoneStreamDeviceIdRef.current = null;
      microphoneUsesVideoAudioTrackRef.current = false;
      microphoneAudioContextRef.current?.close().catch(() => undefined);
      microphoneAudioContextRef.current = null;
      const recorderSession = liveTurnRecorderSessionRef.current;
      if (recorderSession) {
        liveTurnRecorderSessionRef.current = null;
      }
      microphoneHighPassStateRef.current = createSpeechHighPassState();
      microphoneLowPassStateRef.current = createSpeechLowPassState();
      microphoneNoiseGateStateRef.current = createSpeechNoiseGateState();
      standbyPreRollRef.current = [];
      standbyPreRollDurationMsRef.current = 0;
      resetStandbyVoiceActivationState({ resetNoiseFloor: true });
      pendingSpeechReadyToSendRef.current = false;
      pendingSpeechSendingRef.current = false;
      pendingSpeechVideoRef.current = null;
      onMicrophoneLevelChangeRef.current?.(0);
    };

    const trimPendingUserAudio = () => {
      while (pendingUserAudioChunksRef.current.length > 0 && pendingUserAudioDurationMsRef.current > LIVE_STANDBY_BUFFER_LIMIT_MS) {
        pendingUserAudioChunksRef.current.shift();
        pendingUserAudioBase64ChunksRef.current.shift();
        pendingUserAudioDurationMsRef.current -= pendingUserAudioChunkDurationsRef.current.shift() ?? 0;
      }
      pendingUserAudioDurationMsRef.current = Math.max(0, pendingUserAudioDurationMsRef.current);
    };

    const requestMicrophone = async (options?: { force?: boolean }) => {
      const forceRefresh = Boolean(options?.force);
      const preferredDeviceId = preferredMicrophoneDeviceIdRef.current;
      const now = performance.now();
      const audiblePlaybackActive =
        webappPlaybackCountRef.current > 0 || now < assistantPlaybackMutedUntilRef.current || hasAudibleWebappPlayback();
      const existingStream = microphoneStreamRef.current;
      const existingTracks = existingStream?.getAudioTracks() ?? [];
      const existingStreamLive = existingStream?.active && existingTracks.some((track) => track.readyState === "live");
      const existingDetectorLive =
        Boolean(microphoneProcessorRef.current?.onaudioprocess) && microphoneAudioContextRef.current?.state !== "closed";
      const existingVideoAudio = microphoneUsesVideoAudioTrackRef.current && videoShareModeRef.current === "camera";
      const existingPreferredDevice = preferredDeviceId ? microphoneStreamDeviceIdRef.current === preferredDeviceId : true;
      if (!forceRefresh && existingStream && existingStreamLive && existingDetectorLive && (existingVideoAudio || existingPreferredDevice)) {
        return existingStream;
      }
      if (audiblePlaybackActive) {
        return existingStreamLive ? existingStream : null;
      }
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        return null;
      }

      try {
        resetMicrophone();
        const audioConstraints = buildLiveMicAudioConstraints(liveRecordingSettingsRef.current);
        const fallbackCameraAudioTrack =
          isAndroidChromeBrowser() && videoShareModeRef.current === "camera"
            ? videoShareStreamRef.current?.getAudioTracks().find((track) => track.readyState === "live") ?? null
            : null;
        let usesVideoAudioTrack = false;
        let stream: MediaStream | null = null;

        const openStandaloneMicrophone = async () => {
          if (preferredDeviceId) {
            try {
              return await navigator.mediaDevices.getUserMedia({
                audio: {
                  deviceId: { exact: preferredDeviceId },
                  ...audioConstraints,
                },
              });
            } catch {
              // Fall back to the browser default microphone when the saved device is unavailable.
            }
          }

          return await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
          });
        };

        try {
          stream = await openStandaloneMicrophone();
        } catch (error) {
          if (!fallbackCameraAudioTrack) {
            throw error;
          }
          stream = new MediaStream([fallbackCameraAudioTrack]);
          usesVideoAudioTrack = true;
        }

        if (!stream) {
          return null;
        }
        const audioTrack = stream.getAudioTracks()[0];
        if (isLocalSystemAudioInput(audioTrack?.label)) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error("Choose a physical microphone instead of a system or loopback audio source.");
        }
        preferSpeechQualityAudio(stream);
        microphoneStreamRef.current = stream;
        microphoneStreamDeviceIdRef.current = audioTrack?.getSettings().deviceId ?? preferredDeviceId ?? null;
        microphoneUsesVideoAudioTrackRef.current = usesVideoAudioTrack;
        const initialAudioContext = createSpeechAudioContext();
        if (initialAudioContext) {
          try {
            const audioContext = microphoneAudioContextRef.current ?? initialAudioContext;
            microphoneAudioContextRef.current = audioContext;
            if (audioContext.state === "suspended") {
              void audioContext.resume().catch(() => undefined);
            }
            const source = audioContext.createMediaStreamSource(stream);
            const gain = audioContext.createGain();
            const processor = audioContext.createScriptProcessor(LIVE_AUDIO_STREAM_PROCESSOR_BUFFER_SIZE, 1, 1);
            const sinkGain = audioContext.createGain();
            gain.gain.value = 1;
            sinkGain.gain.value = 0;
            source.connect(gain);
            gain.connect(processor);
            processor.connect(sinkGain);
            sinkGain.connect(audioContext.destination);
            microphoneSourceRef.current = source;
            microphoneGainRef.current = gain;
            microphoneProcessorRef.current = processor;
            microphoneSinkGainRef.current = sinkGain;
            microphoneLastFrameAtRef.current = performance.now();

            pauseLiveSpeechRecordingRef.current = () => {
              microphoneStreamingPausedRef.current = true;
              onMicrophoneLevelChangeRef.current?.(0);
            };

            resumeLiveSpeechRecordingRef.current = () => {
              if (!microphoneCaptureEnabledRef.current || !stream.active) return;
              if (webappPlaybackCountRef.current > 0 || performance.now() < assistantPlaybackMutedUntilRef.current) return;
              microphoneStreamingPausedRef.current = false;
            };

            processor.onaudioprocess = (event) => {
              if (!microphoneCaptureEnabledRef.current || microphoneStreamingPausedRef.current || !stream.active) return;
              const inputChannel = event.inputBuffer.numberOfChannels > 0 ? event.inputBuffer.getChannelData(0) : null;
              if (!inputChannel || inputChannel.length === 0) return;

              const resampled = resampleFloat32Array(inputChannel, audioContext.sampleRate, LIVE_AUDIO_STREAM_SAMPLE_RATE);
              if (resampled.length === 0) return;
              const cleaned = cleanSpeechSamples(resampled, LIVE_AUDIO_STREAM_SAMPLE_RATE, {
                highPass: microphoneHighPassStateRef.current,
                lowPass: microphoneLowPassStateRef.current,
                noiseGate: microphoneNoiseGateStateRef.current,
              });
              const processed = amplifySpeechSamples(cleaned, getLiveRecordingCaptureGain(liveRecordingSettingsRef.current));
              const durationMs = (resampled.length / LIVE_AUDIO_STREAM_SAMPLE_RATE) * 1000;
              const pcm16Bytes = float32ToPcm16Bytes(processed);
              liveTurnRecorderSessionRef.current?.chunks.push(pcm16Bytes);
              const base64Pcm16 = float32ToBase64Pcm16(processed);
              appendStandbyPreRoll(pcm16Bytes, base64Pcm16, durationMs);
              const analysisSamples = resampleFloat32Array(processed, LIVE_AUDIO_STREAM_SAMPLE_RATE, LIVE_AUDIO_ANALYSIS_SAMPLE_RATE);
              let sumSquares = 0;
              for (let index = 0; index < analysisSamples.length; index += 1) {
                const sample = analysisSamples[index] ?? 0;
                sumSquares += sample * sample;
              }
              const rms = Math.sqrt(sumSquares / Math.max(1, analysisSamples.length));
              microphoneLastFrameAtRef.current = performance.now();
              onMicrophoneLevelChangeRef.current?.(normalizeMicrophoneUiLevel(rms));
              const currentDb = 20 * Math.log10(Math.max(rms, 1e-6));

              if (
                userAudioSentToModelRef.current ||
                userAudioStreamEndedRef.current ||
                pendingSpeechReadyToSendRef.current ||
                pendingSpeechSendingRef.current
              ) {
                return;
              }

              if (performance.now() < standbyReconnectBlockedUntilRef.current) {
                standbyPreRollRef.current = [];
                standbyPreRollDurationMsRef.current = 0;
                standbyNoiseFloorDbRef.current =
                  standbyNoiseFloorDbRef.current === null ? currentDb : standbyNoiseFloorDbRef.current * 0.75 + currentDb * 0.25;
                standbyNoiseCalibrationMsRef.current = Math.min(
                  LIVE_STANDBY_NOISE_CALIBRATION_MS,
                  standbyNoiseCalibrationMsRef.current + durationMs,
                );
                standbySpeechBoostMsRef.current = 0;
                standbyVoiceBurstTimesRef.current = [];
                standbyVoiceBurstActiveRef.current = false;
                return;
              }

              const appendPendingSpeechChunk = () => {
                pendingUserAudioChunksRef.current.push(pcm16Bytes);
                pendingUserAudioBase64ChunksRef.current.push(base64Pcm16);
                pendingUserAudioChunkDurationsRef.current.push(durationMs);
                pendingUserAudioDurationMsRef.current += durationMs;
                trimPendingUserAudio();
                userAudioChunksRef.current.push(pcm16Bytes);
              };

              const markPendingSpeechReadyIfSilent = () => {
                const noiseFloorDb = standbyNoiseFloorDbRef.current;
                const speechActive = noiseFloorDb === null || currentDb >= noiseFloorDb + LIVE_SPEECH_END_TRIGGER_DB;
                if (speechActive) {
                  userAudioSpeechDurationMsRef.current += durationMs;
                  userAudioTrailingSilenceMsRef.current = 0;
                } else {
                  userAudioTrailingSilenceMsRef.current += durationMs;
                  const smoothing = currentDb <= noiseFloorDb + LIVE_STANDBY_NOISE_UPDATE_DB ? 0.04 : 0.002;
                  standbyNoiseFloorDbRef.current = noiseFloorDb * (1 - smoothing) + currentDb * smoothing;
                }

                const enoughSpeech = userAudioSpeechDurationMsRef.current >= LIVE_SPEECH_END_MIN_SPEECH_MS;
                const silenceEndedTurn = userAudioTrailingSilenceMsRef.current >= LIVE_SPEECH_END_TRAILING_SILENCE_MS;
                const captureWindowFull = pendingUserAudioDurationMsRef.current >= LIVE_SPEECH_FORCE_SEND_MS;
                if (enoughSpeech && (silenceEndedTurn || captureWindowFull)) {
                  pendingSpeechReadyToSendRef.current = true;
                  voiceActivationPendingRef.current = false;
                  void flushPendingSpeechAudioRef.current();
                }
              };

              if (voiceActivationPendingRef.current || (socketRequestedRef.current && pendingUserAudioBase64ChunksRef.current.length > 0)) {
                appendPendingSpeechChunk();
                markPendingSpeechReadyIfSilent();
                return;
              }

              const currentNoiseFloorDb = standbyNoiseFloorDbRef.current;
              if (currentNoiseFloorDb === null) {
                standbyNoiseFloorDbRef.current = currentDb;
                standbyNoiseCalibrationMsRef.current = durationMs;
                standbySpeechBoostMsRef.current = 0;
                return;
              }

              if (standbyNoiseCalibrationMsRef.current < LIVE_STANDBY_NOISE_CALIBRATION_MS) {
                standbyNoiseCalibrationMsRef.current += durationMs;
                standbyNoiseFloorDbRef.current = currentNoiseFloorDb * 0.75 + currentDb * 0.25;
                standbySpeechBoostMsRef.current = 0;
                return;
              }

              const volumeLiftDb = currentDb - currentNoiseFloorDb;
              const now = performance.now();
              const recentBurstTimes = standbyVoiceBurstTimesRef.current.filter(
                (burstTime) => now - burstTime <= LIVE_STANDBY_VOICE_BURST_WINDOW_MS,
              );
              if (volumeLiftDb >= LIVE_STANDBY_VOICE_TRIGGER_DB) {
                if (!standbyVoiceBurstActiveRef.current) {
                  recentBurstTimes.push(now);
                }
                standbyVoiceBurstActiveRef.current = true;
                standbyVoiceBurstTimesRef.current = recentBurstTimes;
                standbySpeechBoostMsRef.current += durationMs * (volumeLiftDb >= LIVE_STANDBY_VOICE_STRONG_TRIGGER_DB ? 2 : 1);
              } else {
                if (volumeLiftDb <= LIVE_STANDBY_VOICE_BURST_RESET_DB) {
                  standbyVoiceBurstActiveRef.current = false;
                }
                standbyVoiceBurstTimesRef.current = recentBurstTimes;
                standbySpeechBoostMsRef.current = Math.max(0, standbySpeechBoostMsRef.current - durationMs);
                const smoothing = volumeLiftDb <= LIVE_STANDBY_NOISE_UPDATE_DB ? 0.08 : 0.005;
                standbyNoiseFloorDbRef.current = currentNoiseFloorDb * (1 - smoothing) + currentDb * smoothing;
              }

              if (
                standbySpeechBoostMsRef.current < LIVE_STANDBY_VOICE_TRIGGER_MS &&
                standbyVoiceBurstTimesRef.current.length < LIVE_STANDBY_VOICE_BURST_TRIGGER_COUNT
              ) {
                return;
              }

              voiceActivationPendingRef.current = true;
              pendingSpeechReadyToSendRef.current = false;
              standbySpeechBoostMsRef.current = 0;
              standbyVoiceBurstTimesRef.current = [];
              standbyVoiceBurstActiveRef.current = false;
              const speechStartChunks: typeof standbyPreRollRef.current = [];
              const speechStartTargetMs = LIVE_STANDBY_VOICE_TRIGGER_MS + LIVE_STANDBY_SPEECH_PREROLL_MS + 500;
              let speechStartDurationMs = 0;
              for (let index = standbyPreRollRef.current.length - 1; index >= 0; index -= 1) {
                const chunk = standbyPreRollRef.current[index];
                if (!chunk) continue;
                speechStartChunks.unshift(chunk);
                speechStartDurationMs += chunk.durationMs;
                if (speechStartDurationMs >= speechStartTargetMs) {
                  break;
                }
              }
              pendingUserAudioChunksRef.current = speechStartChunks.map((chunk) => chunk.bytes);
              pendingUserAudioBase64ChunksRef.current = speechStartChunks.map((chunk) => chunk.base64);
              pendingUserAudioChunkDurationsRef.current = speechStartChunks.map((chunk) => chunk.durationMs);
              pendingUserAudioDurationMsRef.current = speechStartDurationMs;
              userAudioChunksRef.current = [...pendingUserAudioChunksRef.current];
              userAudioSpeechDurationMsRef.current = LIVE_SPEECH_END_MIN_SPEECH_MS;
              userAudioTrailingSilenceMsRef.current = 0;
              setStatus(readyRef.current ? "Speech detected. Waiting for silence..." : "Speech detected. Connecting to Gemini Live...");
              void requestSocketConnection("Speech detected. Connecting to Gemini Live...");
            };
          } catch {
            setStatus("Live microphone streaming is not supported in this browser. Text live chat still works.");
          }
        }
        stream.getAudioTracks().forEach((track) => {
          track.addEventListener(
            "ended",
            () => {
              if (!microphoneCaptureEnabledRef.current) return;
              resetMicrophone();
              window.setTimeout(() => void requestMicrophoneRef.current(), 300);
            },
            { once: true },
          );
        });
        if (microphoneProcessorRef.current) {
          return stream;
        }
        setStatus("Live microphone streaming is not supported in this browser. Text live chat still works.");
        return stream;
      } catch (error) {
        onMicrophoneLevelChangeRef.current?.(0);
        setStatus(error instanceof Error ? `${error.message} Text live chat still works.` : "Microphone access was not granted. Text live chat still works.");
        return null;
      }
    };

    const refreshMicrophone = async () => {
      if (!microphoneCaptureEnabledRef.current || microphoneRefreshInFlightRef.current) return;
      microphoneRefreshInFlightRef.current = true;
      try {
        await requestMicrophone({ force: true });
      } finally {
        microphoneRefreshInFlightRef.current = false;
      }
    };

    requestMicrophoneRef.current = requestMicrophone;
    refreshMicrophoneRef.current = refreshMicrophone;
    resetMicrophoneRef.current = resetMicrophone;
    if (
      microphoneCaptureEnabledRef.current &&
      (socketRef.current?.readyState === WebSocket.OPEN || liveRecordingSettingsRef.current.standbyEnabled)
    ) {
      void requestMicrophone();
    }

    return () => {
      requestMicrophoneRef.current = async () => null;
      refreshMicrophoneRef.current = async () => {};
      resetMicrophoneRef.current = () => {};
      resetMicrophone();
    };
  }, [
    appendStandbyPreRoll,
    armAssistantReplyTimeout,
    hasAudibleWebappPlayback,
    requestSocketConnection,
    resetStandbyVoiceActivationState,
    sendUserAudioStreamEnd,
  ]);

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
      clearAssistantReplyTimeout();
      setConnecting(false);
      setReady(false);
      setSocketRequested(false);
      queuedLiveActionsRef.current.forEach((action) => {
        if (action.kind === "attachment") {
          action.reject(new Error("Live talk was turned off."));
        }
      });
      queuedLiveActionsRef.current = [];
      finalizeSpeechCaptureState();
      performLiveTextSendRef.current = () => false;
      performLiveAttachmentSendRef.current = async () => false;
      prepareSpeechTurnRef.current = () => {};
      flushPendingSpeechAudioRef.current = () => {};
      onRegisterVideoControls?.(null);
      setStatus("Live talk disconnected.");
      return;
    }

    if (!socketRequested) {
      clearReconnectTimer();
      clearAssistantReplyTimeout();
      setConnecting(false);
      setReady(false);
      performLiveTextSendRef.current = () => false;
      performLiveAttachmentSendRef.current = async () => false;
      prepareSpeechTurnRef.current = () => {};
      flushPendingSpeechAudioRef.current = () => {};
      onRegisterVideoControls?.(null);
      setStatus(standbyStatusMessage());
      return;
    }

    const liveApiKey = (providerSettings.liveApiKey || providerSettings.apiKey).trim();
    if (!liveApiKey) {
      clearReconnectTimer();
      setConnecting(false);
      setReady(false);
      setStatus("Save your Gemini global or live API key to start live talk.");
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

    const url = buildLiveWebSocketUrl(providerSettings.apiUrl, liveApiKey);
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
      const gain = context.createGain();
      gain.gain.value = LIVE_ASSISTANT_PLAYBACK_GAIN;
      gain.connect(context.destination);
      assistantPlaybackGainRef.current = gain;
      nextAudioTimeRef.current = context.currentTime;
      return context;
    };

    const ensureUserTurn = (defaults?: { content?: string; images?: LiveGeneratedImage[] }) => {
      const existingId = userTurnIdRef.current;
      if (existingId) {
        return existingId;
      }
      const id = crypto.randomUUID();
      userTurnIdRef.current = id;
      setTurns((current) => [
        ...current,
        {
          id,
          role: "user",
          content: defaults?.content ?? "",
          images: defaults?.images?.length ? defaults.images : undefined,
        },
      ]);
      return id;
    };

    const discardLiveTurnRecorder = (session = liveTurnRecorderSessionRef.current) => {
      if (!session) return;
      if (liveTurnRecorderSessionRef.current === session) {
        liveTurnRecorderSessionRef.current = null;
      }
    };

    const stopLiveTurnRecorder = async (session = liveTurnRecorderSessionRef.current) => {
      if (!session) {
        return null;
      }

      if (liveTurnRecorderSessionRef.current === session) {
        liveTurnRecorderSessionRef.current = null;
      }
      return session.chunks.length > 0 ? new Blob([pcm16BytesToWavBytes(concatenateBytes(session.chunks), LIVE_AUDIO_STREAM_SAMPLE_RATE)], { type: "audio/wav" }) : null;
    };

    const startLiveTurnRecorder = (turnId: string) => {
      const stream = microphoneStreamRef.current;
      if (!stream?.active) return;
      const existingSession = liveTurnRecorderSessionRef.current;
      if (existingSession?.turnId === turnId) return;

      discardLiveTurnRecorder(existingSession);

      liveTurnRecorderSessionRef.current = {
        chunks: [],
        turnId,
      };
    };

    const buildSpeechPromptContext = () => {
      const prompt = speechPromptRef.current.trim();
      if (!prompt) return "";
      const context = `Live prompt instructions:\n${prompt}`;
      recordLiveContextUsage(context);
      return context;
    };

    const withActiveSelectionContext = (content: string) => {
      const promptContext = userAudioPromptContextRef.current.trim();
      const trimmedContent = content.trim();
      return [promptContext, trimmedContent].filter(Boolean).join("\n\n");
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

    const applyCapturedUserAudioUrl = (turnId: string | null, chunks: Uint8Array[]) => {
      if (!turnId || chunks.length === 0 || userAudioUrlAppliedTurnIdRef.current === turnId) {
        return;
      }
      const audioUrl = pcm16ChunksToWavUrl(chunks, LIVE_AUDIO_STREAM_SAMPLE_RATE);
      if (!audioUrl) return;
      userAudioUrlAppliedTurnIdRef.current = turnId;
      audioUrlsRef.current.push(audioUrl);
      setTurns((current) =>
        current.map((turn) => (turn.id === turnId ? { ...turn, audioUrl } : turn)),
      );
      moveVideoShareTurnToEnd();
    };

    const videoShareContent = (mode: "camera" | "screen") =>
      mode === "camera"
        ? cameraShareSendModeRef.current === "video"
          ? "Camera video sharing ready."
          : "Camera snapshot sharing ready."
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
      const streamedChunks = [...userAudioChunksRef.current];
      const recorderSession = liveTurnRecorderSessionRef.current;
      const applyUserAudioUrl = (audioUrl: string | null) => {
        if (!audioUrl || !userTurnId || userAudioUrlAppliedTurnIdRef.current === userTurnId) return;
        userAudioUrlAppliedTurnIdRef.current = userTurnId;
        audioUrlsRef.current.push(audioUrl);
        setTurns((current) =>
          current.map((turn) => (turn.id === userTurnId ? { ...turn, audioUrl } : turn)),
        );
        moveVideoShareTurnToEnd();
      };

      if (userTurnId && streamedChunks.length > 0) {
        discardLiveTurnRecorder(recorderSession);
        applyUserAudioUrl(pcm16ChunksToWavUrl(streamedChunks, LIVE_AUDIO_STREAM_SAMPLE_RATE));
      } else if (userTurnId && recorderSession) {
        void (async () => {
          const recorderBlob = await stopLiveTurnRecorder(recorderSession);
          const recorderAudioUrl = recorderBlob && recorderBlob.size > 0 ? URL.createObjectURL(recorderBlob) : null;
          applyUserAudioUrl(recorderAudioUrl);
        })();
      } else {
        discardLiveTurnRecorder();
      }
      userTurnIdRef.current = null;
      userAudioPromptContextRef.current = "";
      userAudioChunksRef.current = [];
      pendingUserAudioChunksRef.current = [];
      pendingUserAudioBase64ChunksRef.current = [];
      pendingUserAudioChunkDurationsRef.current = [];
      pendingUserAudioDurationMsRef.current = 0;
      pendingSpeechReadyToSendRef.current = false;
      pendingSpeechSendingRef.current = false;
      pendingSpeechVideoRef.current = null;
      userAudioSpeechStartMsRef.current = 0;
      userAudioActiveRef.current = false;
      userAudioSentToModelRef.current = false;
      userAudioStreamEndedRef.current = false;
      userAudioSpeechDurationMsRef.current = 0;
      userAudioTrailingSilenceMsRef.current = 0;
      userAudioUrlAppliedTurnIdRef.current = null;
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

    const appendAssistantToolMessage = (message: string) => {
      const trimmedMessage = message.trim();
      if (!trimmedMessage) return;
      const existingId = liveAssistantTurnIdRef.current ?? createAssistantTurn();
      setTurns((current) => {
        let updated = false;
        const next = current.map((turn) => {
          if (turn.id !== existingId) return turn;
          updated = true;
          const existingContent = turn.content.trimEnd();
          return {
            ...turn,
            content: existingContent ? `${existingContent}\n\n${trimmedMessage}` : trimmedMessage,
          };
        });
        return updated ? next : [...current, { id: existingId, role: "assistant", content: trimmedMessage }];
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
      if (assistantAudioStoppedTurnIdRef.current === liveAssistantTurnIdRef.current) {
        assistantAudioStoppedTurnIdRef.current = null;
      }
      liveAssistantTurnIdRef.current = null;
    };

    const playAudioChunk = (base64Audio: string, turnId: string) => {
      if (assistantAudioStoppedTurnIdRef.current === turnId) return;
      const context = createAudioContext();
      if (!context) return;
      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }
      const gain = assistantPlaybackGainRef.current;

      const samples = pcm16ToFloat32Array(base64ToUint8Array(base64Audio));
      if (samples.length === 0) return;

      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain ?? context.destination);
      const startAt = Math.max(nextAudioTimeRef.current, context.currentTime);
      let playbackTracked = false;
      let watchdogTimerId: number | null = null;
      const releasePlayback = () => {
        if (!playbackTracked) return;
        playbackTracked = false;
        assistantPlaybackSourceReleasesRef.current.delete(releasePlayback);
        assistantPlaybackSourcesRef.current.delete(source);
        if (watchdogTimerId !== null) {
          window.clearTimeout(watchdogTimerId);
          webappPlaybackWatchdogTimerIdsRef.current = webappPlaybackWatchdogTimerIdsRef.current.filter((timerId) => timerId !== watchdogTimerId);
          watchdogTimerId = null;
        }
        try {
          source.disconnect();
        } catch {
          // Already disconnected sources are harmless.
        }
        endWebappPlayback();
        if (assistantPlaybackSourcesRef.current.size === 0) {
          assistantAudioPlayingTurnIdRef.current = null;
          setAssistantAudioPlayingTurnId(null);
        }
      };
      source.onended = releasePlayback;
      beginWebappPlayback();
      playbackTracked = true;
      assistantPlaybackSourceReleasesRef.current.add(releasePlayback);
      assistantPlaybackSourcesRef.current.add(source);
      assistantAudioPlayingTurnIdRef.current = turnId;
      setAssistantAudioPlayingTurnId(turnId);
      try {
        source.start(startAt);
      } catch {
        releasePlayback();
        return;
      }
      nextAudioTimeRef.current = startAt + buffer.duration;
      const mutedUntil = performance.now() + Math.max(0, nextAudioTimeRef.current - context.currentTime) * 1000 + 350;
      assistantPlaybackMutedUntilRef.current = Math.max(assistantPlaybackMutedUntilRef.current, mutedUntil);
      const watchdogDelayMs = Math.max(0, startAt + buffer.duration - context.currentTime) * 1000 + 1_000;
      watchdogTimerId = window.setTimeout(releasePlayback, watchdogDelayMs);
      webappPlaybackWatchdogTimerIdsRef.current.push(watchdogTimerId);
    };

    const sendSetup = () => {
      appliedNoteContextRef.current = noteContextRef.current;
      const transcriptContext = buildLiveTranscriptText(turnsRef.current);
      const liveContext = [
        noteContextRef.current,
        transcriptContext
          ? [
              "",
              `Previous live chat transcript, last ${LIVE_RECONNECT_TRANSCRIPT_MAX_CHARS} characters:`,
              transcriptContext,
            ].join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      liveContextTokensRef.current = estimateTokenCount(liveContext);
      contextLimitHandlingRef.current = false;
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
                  text: liveContext,
                },
              ],
            },
            tools: [
              {
                functionDeclarations: [
                  generateImageFunctionDeclaration,
                  suggestNoteEditsFunctionDeclaration,
                  openNoteFunctionDeclaration,
                  scrollNoteFunctionDeclaration,
                  findNoteFunctionDeclaration,
                  uploadCurrentImageFunctionDeclaration,
                  insertCurrentImageFunctionDeclaration,
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
      cameraMode?: CameraShareSendMode | null,
      screenMode?: ScreenShareSendMode | null,
    ) => {
      videoShareModeRef.current = mode;
      cameraShareSendModeRef.current = mode === "camera" ? cameraMode ?? "snapshot" : null;
      screenShareSendModeRef.current = mode === "screen" ? screenMode ?? "screenshot" : null;
      currentCameraDeviceIdRef.current = mode === "camera" ? cameraDeviceId ?? null : null;
      onVideoShareStateChangeRef.current?.({
        mode,
        cameraDeviceId: currentCameraDeviceIdRef.current,
        cameraMode: cameraShareSendModeRef.current,
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

    const restoreStandaloneMicrophoneAfterVideoShare = () => {
      if (!microphoneCaptureEnabledRef.current) {
        return;
      }

      microphoneRestoreTimerIdsRef.current.forEach((timerId) => window.clearTimeout(timerId));
      microphoneRestoreTimerIdsRef.current = [];
      resetMicrophoneRef.current();
      for (const delayMs of [350, 1_200, 2_500]) {
        const timerId = window.setTimeout(async () => {
          if (!microphoneCaptureEnabledRef.current || videoShareModeRef.current === "camera") {
            return;
          }
          await requestMicrophoneRef.current();
        }, delayMs);
        microphoneRestoreTimerIdsRef.current.push(timerId);
      }
    };

    const stopVideoShare = (options?: { replacing?: boolean }) => {
      const previousMode = videoShareModeRef.current;
      const shouldRestoreMicrophone = previousMode === "camera" && !options?.replacing && microphoneCaptureEnabledRef.current;
      clearVideoShareIdleTimer();
      if (videoShareIntervalRef.current) {
        window.clearInterval(videoShareIntervalRef.current);
        videoShareIntervalRef.current = null;
      }
      videoShareFrameInFlightRef.current = false;
      videoShareStreamRef.current?.getTracks().forEach((track) => track.stop());
      videoShareStreamRef.current = null;
      if (videoShareElementRef.current) {
        videoShareElementRef.current.pause();
        videoShareElementRef.current.srcObject = null;
      }
      videoShareElementRef.current = null;
      videoShareCanvasRef.current = null;
      currentCameraLabelRef.current = null;
      cameraShareSendModeRef.current = null;
      updateVideoShareState(null);
      if (!options?.replacing && previousMode) {
        clearVideoShareTurn(previousMode === "camera" ? "Camera sharing stopped." : "Screen sharing stopped.");
      }
      if (shouldRestoreMicrophone) {
        restoreStandaloneMicrophoneAfterVideoShare();
      }
    };
    stopVideoShareRef.current = stopVideoShare;

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

    const captureVideoFrameBase64Async = async (maxWidth = 960, quality = 0.68) => {
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

      const frameBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((nextBlob) => resolve(nextBlob), "image/jpeg", quality);
      });
      if (!frameBlob) return null;
      return readBlobAsBase64(frameBlob);
    };

    const markLatestImageContext = (image: LiveGeneratedImage) => {
      latestImageContextRef.current = {
        id: image.id,
        kind: "image",
        fileName: image.fileName,
        mimeType: image.mimeType,
        source: "upload",
        dataBase64: image.dataBase64,
      };
      latestImagePreviewRef.current = {
        fileName: image.fileName,
        mimeType: image.mimeType,
        previewUrl: image.url,
        ...generatedImageMetadata(image),
      };
    };

    const sendVideoFrame = async () => {
      const socketConnection = socketRef.current;
      if (
        !socketConnection ||
        socketConnection.readyState !== WebSocket.OPEN ||
        (videoShareModeRef.current !== "screen" && cameraShareSendModeRef.current !== "video") ||
        videoShareFrameInFlightRef.current
      ) {
        return;
      }
      videoShareFrameInFlightRef.current = true;
      let dataBase64: string | null = null;
      try {
        const screenVideo = videoShareModeRef.current === "screen";
        dataBase64 = await captureVideoFrameBase64Async(screenVideo ? 720 : 960, screenVideo ? 0.54 : 0.68);
      } finally {
        videoShareFrameInFlightRef.current = false;
      }
      if (!dataBase64 || socketConnection.readyState !== WebSocket.OPEN) return;

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
      recordLiveContextUsage("", 1);
    };

    const sendScreenSnapshotForTurn = (reason: "speech" | "text" | "audio", options?: { send?: boolean }) => {
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
      if (options?.send ?? true) {
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
      }
      recordLiveContextUsage(reason, 1);
      return image;
    };

    const collectSpeechSelectedVisuals = async () => {
      const selectedVisuals = speechAttachmentsRef.current.filter((attachment) => attachment.kind === "image" || attachment.kind === "video");
      if (selectedVisuals.length === 0) {
        return [];
      }

      const sentImages: LiveGeneratedImage[] = [];
      for (const attachment of selectedVisuals) {
        try {
          const blob = await loadAttachmentBlob(attachment);
          const isVideo = attachment.kind === "video";
          const dataBase64 = isVideo ? await captureVideoFrameAsJpegBase64(blob) : await readBlobAsBase64(blob);
          const mimeType = isVideo ? "image/jpeg" : attachment.mimeType || blob.type || "image/jpeg";
          const imageUrl = isVideo ? base64ToObjectUrl(dataBase64, mimeType) : attachment.url ?? base64ToObjectUrl(dataBase64, mimeType);
          if (isVideo || !attachment.url) {
            generatedImageUrlsRef.current.push(imageUrl);
          }
          const image: LiveGeneratedImage = {
            id: crypto.randomUUID(),
            fileName: attachment.fileName,
            mimeType,
            origin: "camera",
            url: imageUrl,
            dataBase64,
          };
          sentImages.push(image);
          if (!isVideo) {
            markLatestImageContext(image);
          }
        } catch (error) {
          onError(error instanceof Error ? error.message : `Couldn't send ${attachment.fileName} with spoken turn.`);
        }
      }

      if (sentImages.length > 0) {
        recordLiveContextUsage("Selected visual media included with spoken turn.", sentImages.length);
      }
      return sentImages;
    };

    prepareSpeechTurnRef.current = async (socketConnection: WebSocket) => {
      if (userAudioSentToModelRef.current) return;
      const promptContext = buildSpeechPromptContext();
      const selectedImages = await collectSpeechSelectedVisuals();
      userAudioPromptContextRef.current = promptContext;
      if (promptContext || selectedImages.length > 0) {
        onLiveSpeechSentRef.current?.();
      }
      const screenImage = selectedImages.length === 0 ? sendScreenSnapshotForTurn("speech", { send: false }) : null;
      const turnImages = [...selectedImages, screenImage].filter((image): image is LiveGeneratedImage => Boolean(image));
      const combinedVideo = selectedImages[0] ?? screenImage ?? null;
      pendingSpeechVideoRef.current = combinedVideo
        ? {
            data: combinedVideo.dataBase64,
            mimeType: combinedVideo.mimeType,
          }
        : null;
      const turnId = ensureUserTurn({
        content: promptContext,
        images: turnImages,
      });
      startLiveTurnRecorder(turnId);
      userAudioSentToModelRef.current = true;
      userAudioStreamEndedRef.current = false;
      userAudioActiveRef.current = true;
      armVideoShareIdleTimer();
    };

    flushPendingSpeechAudioRef.current = async () => {
      const socketConnection = socketRef.current;
      if (!pendingSpeechReadyToSendRef.current || pendingSpeechSendingRef.current) {
        return;
      }
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN || pendingUserAudioBase64ChunksRef.current.length === 0) {
        void requestSocketConnection("Speech captured. Connecting to Gemini Live...");
        return;
      }
      pendingSpeechSendingRef.current = true;
      setStatus("Speech captured. Sending to Gemini Live...");
      try {
        await prepareSpeechTurnRef.current(socketConnection);
        const promptContext = userAudioPromptContextRef.current.trim();
        const video = pendingSpeechVideoRef.current;
        const audioData = bytesToBase64(concatenateBytes(pendingUserAudioChunksRef.current));
        socketConnection.send(
          JSON.stringify({
            realtimeInput: {
              ...(promptContext ? { text: promptContext } : {}),
              ...(video ? { video } : {}),
              audio: {
                data: audioData,
                mimeType: `audio/pcm;rate=${LIVE_AUDIO_STREAM_SAMPLE_RATE}`,
              },
            },
          }),
        );
        sendUserAudioStreamEnd();
        applyCapturedUserAudioUrl(userTurnIdRef.current, [...userAudioChunksRef.current]);
      } catch (error) {
        onError(error instanceof Error ? error.message : "Failed to send captured speech to live talk.");
        pendingSpeechSendingRef.current = false;
        return;
      }
      pendingUserAudioChunksRef.current = [];
      pendingUserAudioBase64ChunksRef.current = [];
      pendingUserAudioChunkDurationsRef.current = [];
      pendingUserAudioDurationMsRef.current = 0;
      pendingSpeechReadyToSendRef.current = false;
      pendingSpeechSendingRef.current = false;
      pendingSpeechVideoRef.current = null;
      voiceActivationPendingRef.current = false;
      userAudioSpeechDurationMsRef.current = Math.max(userAudioSpeechDurationMsRef.current, LIVE_SPEECH_END_MIN_SPEECH_MS);
      armAssistantReplyTimeout();
    };

    const startVideoShare = async (
      stream: MediaStream,
      mode: "camera" | "screen",
      cameraDeviceId?: string | null,
      options?: { cameraMode?: CameraShareSendMode; screenMode?: ScreenShareSendMode },
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
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", handleTrackEnded, { once: true }));

      await videoElement.play().catch(() => undefined);
      await waitForVideoFrame(videoElement);
      const cameraMode = mode === "camera" ? options?.cameraMode ?? "snapshot" : null;
      const screenMode = mode === "screen" ? options?.screenMode ?? "screenshot" : null;
      if ((mode === "screen" && screenMode === "video") || (mode === "camera" && cameraMode === "video")) {
        const frameIntervalMs = mode === "screen" ? 2500 : 1200;
        sendVideoFrame();
        videoShareIntervalRef.current = window.setInterval(sendVideoFrame, frameIntervalMs);
      }
      const videoTrack = stream.getVideoTracks()[0];
      const resolvedCameraDeviceId = mode === "camera" ? videoTrack?.getSettings().deviceId ?? cameraDeviceId ?? null : null;
      currentCameraLabelRef.current = mode === "camera" ? videoTrack?.label ?? null : null;
      updateVideoShareState(mode, resolvedCameraDeviceId, cameraMode, screenMode);
      upsertVideoShareTurn(stream, mode);
      setStatus(
        mode === "camera"
          ? cameraMode === "video"
            ? "Camera video sharing ready."
            : "Camera snapshot sharing ready."
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

    const startCameraShare = async (deviceId?: string, options?: { video?: boolean }) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera sharing is not supported in this browser.");
      }

      const videoConstraints = deviceId
        ? {
            deviceId: { exact: deviceId },
          }
        : {
            facingMode: { ideal: "user" },
          };
      const includeCameraMicrophone = isAndroidChromeBrowser() && microphoneCaptureEnabledRef.current;
      if (includeCameraMicrophone) {
        resetMicrophoneRef.current();
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: includeCameraMicrophone ? buildLiveMicAudioConstraints(liveRecordingSettingsRef.current) : false,
        });
      } catch (error) {
        if (!includeCameraMicrophone) {
          throw error;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: buildLiveMicAudioConstraints(liveRecordingSettingsRef.current),
          });
        } catch {
          throw new Error("Android Chrome could not open camera and microphone together. Tap the camera button once so the browser can grant both streams.");
        }
      }
      await startVideoShare(stream, "camera", deviceId ?? null, { cameraMode: options?.video ? "video" : "snapshot" });
      if (includeCameraMicrophone) {
        await requestMicrophoneRef.current({ force: true });
        window.setTimeout(() => void requestMicrophoneRef.current({ force: true }), 800);
      }
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

      await startCameraShare(nextSource.deviceId, { video: cameraShareSendModeRef.current === "video" });
      return true;
    };

    const startScreenShare = async (options?: { video?: boolean }) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Screen sharing is not supported in this browser.");
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 5, max: 10 },
        },
        audio: false,
      });
      await startVideoShare(stream, "screen", null, { screenMode: options?.video ? "video" : "screenshot" });
      return true;
    };

    const refreshMicrophoneAfterCameraShot = async () => {
      if (!microphoneCaptureEnabledRef.current || videoShareModeRef.current !== "camera") {
        return;
      }
      if (!isAndroidChromeBrowser() && microphoneProcessorRef.current) {
        return;
      }

      microphoneRestoreTimerIdsRef.current.forEach((timerId) => window.clearTimeout(timerId));
      microphoneRestoreTimerIdsRef.current = [];
      resetMicrophoneRef.current();
      await requestMicrophoneRef.current({ force: true });

      for (const delayMs of [500, 1_500]) {
        const timerId = window.setTimeout(async () => {
          if (!microphoneCaptureEnabledRef.current || videoShareModeRef.current !== "camera") {
            return;
          }
          await requestMicrophoneRef.current({ force: true });
        }, delayMs);
        microphoneRestoreTimerIdsRef.current.push(timerId);
      }
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
      markLatestImageContext(image);

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
      await refreshMicrophoneAfterCameraShot();
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
      const turnImages = [screenImage].filter((image): image is LiveGeneratedImage => Boolean(image));
      socketConnection.send(
        JSON.stringify({
          realtimeInput: {
            text: trimmedText,
          },
        }),
      );
      recordLiveContextUsage(trimmedText, turnImages.length);
      setTurns((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: options?.displayText?.trim() || trimmedText,
          images: turnImages.length > 0 ? turnImages : undefined,
        },
      ]);
      moveVideoShareTurnToEnd();
      setStatus("Sent.");
      armVideoShareIdleTimer();
      armAssistantReplyTimeout();
      return true;
    };

    const sendLiveAttachment = async (attachment: LiveSendAttachment) => {
      const socketConnection = socketRef.current;
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN) {
        return false;
      }

      const blob = await loadAttachmentBlob(attachment);
      if (attachment.kind === "audio") {
        const promptContext = buildSpeechPromptContext();
        const screenImage = sendScreenSnapshotForTurn("audio", { send: false });
        const turnImages = [screenImage].filter((image): image is LiveGeneratedImage => Boolean(image));
        const audioUrl = URL.createObjectURL(blob);
        audioUrlsRef.current.push(audioUrl);
        setTurns((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "user",
            content: [promptContext, `Sent audio clip: ${attachment.fileName}`].filter(Boolean).join("\n\n"),
            audioUrl,
            images: turnImages.length > 0 ? turnImages : undefined,
          },
        ]);
        moveVideoShareTurnToEnd();
        setStatus(`${attachment.fileName} recorded.`);

        const decodedAudio = await decodeAudioBlobToPcm16ChunksBase64(blob);
        socketConnection.send(
          JSON.stringify({
            realtimeInput: {
              ...(promptContext ? { text: promptContext } : {}),
              ...(screenImage
                ? {
                    video: {
                      data: screenImage.dataBase64,
                      mimeType: screenImage.mimeType,
                    },
                  }
                : {}),
              audio: {
                data: decodedAudio.data,
                mimeType: "audio/pcm;rate=16000",
              },
            },
          }),
        );
        socketConnection.send(
          JSON.stringify({
            realtimeInput: {
              audioStreamEnd: true,
            },
          }),
        );
        setStatus(`${attachment.fileName} sent to live talk.`);
        armVideoShareIdleTimer();
        armAssistantReplyTimeout();
        recordLiveContextUsage(`Sent audio clip: ${attachment.fileName}`, turnImages.length);
        return true;
      }

      let encodedFrame: string | null = null;
      if (attachment.kind === "image") {
        encodedFrame = await readBlobAsBase64(blob);
        const imagePreviewUrl = attachment.url ?? base64ToObjectUrl(encodedFrame, attachment.mimeType || blob.type || "image/jpeg");
        if (!attachment.url) {
          generatedImageUrlsRef.current.push(imagePreviewUrl);
        }
        latestImageContextRef.current = {
          id: crypto.randomUUID(),
          kind: "image",
          fileName: attachment.fileName,
          mimeType: attachment.mimeType || blob.type || "image/jpeg",
          source: "upload",
          dataBase64: encodedFrame,
        };
        latestImagePreviewRef.current = {
          fileName: attachment.fileName,
          mimeType: attachment.mimeType || blob.type || "image/jpeg",
          previewUrl: imagePreviewUrl,
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
        recordLiveContextUsage(`The user uploaded a source image: ${attachment.fileName}`, 1);
        setTurns((current) => [...current, { id: crypto.randomUUID(), role: "user", content: `Sent image: ${attachment.fileName}` }]);
        moveVideoShareTurnToEnd();
      } else if (attachment.kind === "video") {
        recordLiveContextUsage(`The user sent a video frame: ${attachment.fileName}`, 1);
      }
      setStatus(`${attachment.fileName} sent to live talk.`);
      armVideoShareIdleTimer();
      armAssistantReplyTimeout();
      return true;
    };

    performLiveTextSendRef.current = sendLiveText;
    performLiveAttachmentSendRef.current = sendLiveAttachment;

    const disconnectForContextLimit = async () => {
      if (contextLimitHandlingRef.current) return;
      contextLimitHandlingRef.current = true;
      setStatus("Live context exceeded 16k tokens. Summarizing before disconnect...");
      try {
        const transcript = buildLiveTranscriptText(turnsRef.current);
        const response = await apiClient.askAi({
          prompt: [
            "Summarize the important content from this live chat so it can be preserved at the end of the note.",
            "Keep decisions, user instructions, generated-image descriptions, note changes, open questions, and next steps.",
            "Use concise markdown bullets.",
            "",
            "Live chat transcript:",
            transcript || "No transcript text was captured.",
          ].join("\n"),
          title: noteTitleRef.current,
          bodyMarkdown: noteBodyMarkdownRef.current,
          mode: "chat",
          availableNotes: noteCatalogRef.current,
        });
        const summary = [
          `## Live chat summary (${new Date().toLocaleString()})`,
          "",
          response.answer.trim(),
        ].join("\n");
        onAppendToCurrentNoteRef.current(summary);
        const notice = "Live context passed 16k tokens. I saved a summary at the end of the note and disconnected live talk.";
        setTurns((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: notice,
          },
        ]);
        showHistoryNotice(notice);
        setStatus(notice);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to summarize live context before disconnect.";
        onError(message);
        setStatus(`Live context passed 16k tokens. Disconnecting without summary: ${message}`);
      } finally {
        onDisconnectRequestRef.current();
      }
    };

    const recordLiveContextUsage = (text: string, imageCount = 0) => {
      liveContextTokensRef.current += estimateTokenCount(text) + imageCount * 1200;
      if (liveContextTokensRef.current > LIVE_CONTEXT_TOKEN_LIMIT) {
        void disconnectForContextLimit();
      }
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
          availableNotes: noteCatalogRef.current,
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
              ...generatedImageMetadata(attachment),
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
          latestImagePreviewRef.current = {
            fileName: latestGeneratedImage.fileName,
            mimeType: latestGeneratedImage.mimeType,
            previewUrl: latestGeneratedImage.url,
            ...generatedImageMetadata(latestGeneratedImage),
          };
        }

        if (images.length > 0) {
          pendingGeneratedImageScrollRef.current = true;
        }
        appendImagesToAssistantTurn(images, assistantTurnId);
        if (images.length > 0 && response.answer.trim()) {
          appendAssistantToolMessage(response.answer);
        }
        setStatus(
          images.length > 0
            ? `Generated image from live tool.${latestGeneratedImage && formatGeneratedImageMetadata(latestGeneratedImage) ? ` ${formatGeneratedImageMetadata(latestGeneratedImage)}.` : ""}`
            : "Live tool returned no image.",
        );

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
              resolution: image.resolution || (image.width && image.height ? `${image.width}x${image.height}` : undefined),
              model: image.model,
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
        availableNotes: noteCatalogRef.current,
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

    const runOpenNoteTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const noteId = typeof call.args?.note_id === "string" ? call.args.note_id.trim() : "";
      const title = typeof call.args?.title === "string" ? call.args.title.trim() : "";
      const opened = onOpenNoteRef.current({
        ...(noteId ? { noteId } : {}),
        ...(title ? { title } : {}),
      });
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "open_note",
        response: {
          ok: opened,
          note_id: noteId || null,
          title: title || null,
          message: opened ? "Opened the requested note." : "The requested note was not found.",
        },
      };
    };

    const runScrollNoteTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const target = typeof call.args?.target === "string" ? call.args.target.trim() : "";
      const lineNumber = typeof call.args?.line_number === "number" && Number.isFinite(call.args.line_number) ? Math.max(1, Math.floor(call.args.line_number)) : undefined;
      const pixels = typeof call.args?.pixels === "number" && Number.isFinite(call.args.pixels) ? Math.max(1, Math.floor(call.args.pixels)) : undefined;
      const ok = ["top", "middle", "bottom", "line", "up", "down"].includes(target)
        ? onScrollNoteRef.current({
            target: target as "top" | "middle" | "bottom" | "line" | "up" | "down",
            ...(lineNumber ? { lineNumber } : {}),
            ...(pixels ? { pixels } : {}),
          })
        : false;
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "scroll_note",
        response: {
          ok,
          target: target || null,
          line_number: lineNumber ?? null,
          pixels: pixels ?? null,
          message: ok ? "Scrolled the note." : "The note could not be scrolled.",
        },
      };
    };

    const runFindNoteTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const query = typeof call.args?.query === "string" ? call.args.query.trim() : "";
      const occurrence = typeof call.args?.occurrence === "string" ? call.args.occurrence.trim() : "";
      const ok = query
        ? onFindInNoteRef.current({
            query,
            ...(occurrence === "first" || occurrence === "next" || occurrence === "previous" ? { occurrence } : {}),
          })
        : false;
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "find_note",
        response: {
          ok,
          query: query || null,
          occurrence: occurrence || null,
          message: ok ? "Found the requested text in the note." : "The text was not found in the note.",
        },
      };
    };

    const runUploadCurrentImageTool = async (call: { id?: string; name?: string }) => {
      const image = latestImagePreviewRef.current;
      if (!image || !onUploadImageToCurrentFolder) {
        return {
          id: typeof call.id === "string" ? call.id : "",
          name: call.name ?? "upload_current_image",
          response: {
            ok: false,
            error: "No current image is available to upload.",
          },
        };
      }

      await onUploadImageToCurrentFolder(image);
      setStatus("Uploaded current image to the current folder.");
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "upload_current_image",
        response: {
          ok: true,
          file_name: image.fileName,
          mime_type: image.mimeType,
          message: "Uploaded the current image to the current folder.",
        },
      };
    };

    const insertLiveImageOnce = async (
      image: { fileName: string; mimeType: string; previewUrl: string },
      lineNumber?: number,
    ) => {
      const key = `${image.previewUrl}:${lineNumber ?? "cursor"}`;
      const recentInsert = lastLiveImageInsertRef.current;
      if (liveImageInsertInFlightRef.current.has(key) || (recentInsert?.key === key && Date.now() - recentInsert.insertedAt < 15000)) {
        return { inserted: false, duplicate: true };
      }

      liveImageInsertInFlightRef.current.add(key);
      try {
        const inserted = await onInsertGeneratedImageInNoteRef.current(image, lineNumber);
        if (inserted) {
          lastLiveImageInsertRef.current = { key, insertedAt: Date.now() };
        }
        return { inserted, duplicate: false };
      } finally {
        liveImageInsertInFlightRef.current.delete(key);
      }
    };

    const runInsertCurrentImageTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const image = latestImagePreviewRef.current;
      const rawLineNumber = call.args?.line_number;
      const lineNumber = typeof rawLineNumber === "number" && Number.isFinite(rawLineNumber) ? Math.max(1, Math.floor(rawLineNumber)) : undefined;
      if (!image) {
        appendAssistantToolMessage("No current image is available to insert.");
        return {
          id: typeof call.id === "string" ? call.id : "",
          name: call.name ?? "insert_current_image",
          response: {
            ok: false,
            error: "No current image is available to insert.",
          },
        };
      }

      const { inserted, duplicate } = await insertLiveImageOnce(image, lineNumber);
      const message = inserted
        ? lineNumber
          ? `Inserted ${image.fileName} before line ${lineNumber}.`
          : `Inserted ${image.fileName} into the current note.`
        : duplicate
          ? `Skipped a duplicate insert for ${image.fileName}.`
          : `${image.fileName} was not inserted into the current note.`;
      appendAssistantToolMessage(message);
      setStatus(inserted ? "Inserted current image into the note." : duplicate ? "Skipped duplicate image insert." : "Current image was not inserted.");
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "insert_current_image",
        response: {
          ok: inserted || duplicate,
          file_name: image.fileName,
          mime_type: image.mimeType,
          line_number: lineNumber ?? null,
          duplicate_suppressed: duplicate,
          message: inserted
            ? lineNumber
              ? `Inserted the current image before line ${lineNumber}.`
              : "Inserted the current image into the note."
            : duplicate
              ? "Skipped a duplicate image insert for the same current image."
            : "The current image was not inserted.",
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
      const requestedMode = typeof call.args?.mode === "string" ? call.args.mode.toLowerCase() : "";
      const useVideo = /\b(video|live|continuous|stream)\b/.test(requestedMode);
      const started = await startCameraShare(deviceId, { video: useVideo });
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: call.name ?? "start_camera_share",
        response: {
          ok: started,
          mode: started ? "camera" : null,
          device_id: currentCameraDeviceIdRef.current ?? deviceId ?? null,
          camera_mode: cameraShareSendModeRef.current,
          message: started
            ? cameraShareSendModeRef.current === "video"
              ? "Camera video sharing started."
              : "Camera snapshot sharing started. No camera image was sent; call capture_camera_shot when a visual answer needs one."
            : "Camera sharing was not started.",
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
          camera_mode: cameraShareSendModeRef.current,
          message: started ? "Switched to the next camera." : "Camera was not switched.",
        },
      };
    };

    const runCaptureCameraShotTool = async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const rawLineNumber = call.args?.line_number;
      const lineNumber = typeof rawLineNumber === "number" && Number.isFinite(rawLineNumber) ? Math.max(1, Math.floor(rawLineNumber)) : undefined;
      const captureInsertKey = lineNumber ? `line:${lineNumber}` : "capture-only";
      const lastRequestAt = lastCameraShotRequestRef.current.get(captureInsertKey) ?? 0;
      if (cameraShotInsertInFlightRef.current.has(captureInsertKey) || Date.now() - lastRequestAt < 15000) {
        return {
          id: typeof call.id === "string" ? call.id : "",
          name: call.name ?? "capture_camera_shot",
          response: {
            ok: true,
            duplicate_suppressed: true,
            line_number: lineNumber ?? null,
            inserted_into_note: false,
            message: "Skipped a duplicate camera shot request.",
          },
        };
      }

      cameraShotInsertInFlightRef.current.add(captureInsertKey);
      let completed = false;
      try {
        const image = await captureCurrentCameraShot();
        const { inserted, duplicate } = lineNumber
          ? await insertLiveImageOnce(
              {
                fileName: image.fileName,
                mimeType: image.mimeType,
                previewUrl: image.url,
              },
              lineNumber,
            )
          : { inserted: false, duplicate: false };
        const response = {
          id: typeof call.id === "string" ? call.id : "",
          name: call.name ?? "capture_camera_shot",
          response: {
            ok: true,
            file_name: image.fileName,
            mime_type: image.mimeType,
            message: duplicate ? "Skipped a duplicate camera shot insert." : "Captured a still image from the current camera feed.",
            current_source_image_updated: true,
            line_number: lineNumber ?? null,
            inserted_into_note: inserted,
            duplicate_suppressed: duplicate,
          },
        };
        completed = true;
        return response;
      } finally {
        if (completed) {
          lastCameraShotRequestRef.current.set(captureInsertKey, Date.now());
        }
        cameraShotInsertInFlightRef.current.delete(captureInsertKey);
      }
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

      clearAssistantReplyTimeout();
      finalizeUserAudio();
      setStatus("Gemini requested a live tool.");
      const functionResponses = await Promise.all(
        functionCalls.map(async (call) => {
          try {
            switch (call.name) {
              case "generate_image":
                return await runGenerateImageTool(call);
              case "suggest_note_edits":
                return await runSuggestNoteEditsTool(call);
              case "open_note":
                return await runOpenNoteTool(call);
              case "scroll_note":
                return await runScrollNoteTool(call);
              case "find_note":
                return await runFindNoteTool(call);
              case "upload_current_image":
                return await runUploadCurrentImageTool(call);
              case "insert_current_image":
                return await runInsertCurrentImageTool(call);
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
      resetAssistantTurn();
      setStatus("Live talk ready.");
      showHistoryNotice("Tool response sent to Gemini.");
    };

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
        createAudioContext();
        sendSetup();
        setConnecting(false);
        const audioNotice = buildConnectionAudioNotice();
        if (audioNotice) {
          showHistoryNotice(audioNotice);
        }
        setStatus(audioNotice ? `Connected. ${audioNotice}` : "Connected. Seeding the current note...");
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
          flushPendingSpeechAudioRef.current();
          await flushQueuedLiveActions();
          return;
        }

        if ("serverContent" in payload && payload.serverContent) {
          const serverContent = payload.serverContent;
          if (serverContent.inputTranscription?.text) {
            recordLiveContextUsage(serverContent.inputTranscription.text);
            updateUserTurn(serverContent.inputTranscription.text);
          }
          const assistantTurnStarted = Boolean(serverContent.outputTranscription?.text || serverContent.modelTurn?.parts?.length);
          if (assistantTurnStarted) {
            clearAssistantReplyTimeout();
            clearVideoShareIdleTimer();
            finalizeUserAudio();
          }
          if (serverContent.outputTranscription?.text) {
            recordLiveContextUsage(serverContent.outputTranscription.text);
            updateAssistantTurn(serverContent.outputTranscription.text);
          }
          for (const part of serverContent.modelTurn?.parts ?? []) {
            if (part.text) {
              recordLiveContextUsage(part.text);
              updateAssistantTurn(part.text);
            }
            if (part.inlineData?.data) {
              const assistantTurnId = createAssistantTurn();
              moveVideoShareTurnToEnd();
              assistantAudioChunksRef.current.push(base64ToUint8Array(part.inlineData.data));
              playAudioChunk(part.inlineData.data, assistantTurnId);
            }
          }
          if (serverContent.interrupted) {
            setStatus("Live response interrupted.");
            finalizeAssistantAudio();
            resetAssistantTurn();
          }
          if (serverContent.generationComplete || serverContent.turnComplete) {
            finalizeUserAudio();
            finalizeAssistantAudio();
          }
          if (serverContent.turnComplete) {
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
      clearVideoShareIdleTimer();
      socketRef.current = null;
      socket.close();
      stopVideoShare();
      webappPlaybackWatchdogTimerIdsRef.current.forEach((timerId) => window.clearTimeout(timerId));
      webappPlaybackWatchdogTimerIdsRef.current = [];
      assistantPlaybackSourceReleasesRef.current.clear();
      assistantPlaybackSourcesRef.current.forEach((source) => {
        try {
          source.stop();
        } catch {
          // Already stopped sources are harmless.
        }
        try {
          source.disconnect();
        } catch {
          // Already disconnected sources are harmless.
        }
      });
      assistantPlaybackSourcesRef.current.clear();
      webappPlaybackCountRef.current = 0;
      nextAudioTimeRef.current = 0;
      assistantPlaybackMutedUntilRef.current = 0;
      assistantAudioPlayingTurnIdRef.current = null;
      assistantAudioStoppedTurnIdRef.current = null;
      setAssistantAudioPlayingTurnId(null);
      assistantAudioChunksRef.current = [];
      cancelledToolCallIdsRef.current.clear();
      liveAssistantTurnIdRef.current = null;
      prepareSpeechTurnRef.current = () => {};
      flushPendingSpeechAudioRef.current = () => {};
      performLiveTextSendRef.current = () => false;
      performLiveAttachmentSendRef.current = async () => false;
      captureVideoShareShotRef.current = async () => {};
      onRegisterVideoControls?.(null);
    };
  }, [
    beginWebappPlayback,
    buildConnectionAudioNotice,
    clearAssistantReplyTimeout,
    connectionRevision,
    endWebappPlayback,
    finalizeSpeechCaptureState,
    flushQueuedLiveActions,
    onImageGenerationStateChange,
    onError,
    onRegisterVideoControls,
    providerSettings.apiUrl,
    providerSettings.apiKey,
    providerSettings.liveApiKey,
    providerSettings.liveModel,
    providerSettings.model,
    sessionRequested,
    socketRequested,
    standbyStatusMessage,
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

  const showStandbyNotice = status.toLowerCase().includes("standby listening");
  const showStatus = !HIDDEN_LIVE_STATUSES.has(status) && !showStandbyNotice;

  useEffect(() => {
    if (!showStatus) {
      setTransientStatusNotice(null);
      return;
    }

    setTransientStatusNotice(status);
    const timerId = window.setTimeout(() => {
      setTransientStatusNotice(null);
    }, 2000);

    return () => window.clearTimeout(timerId);
  }, [showStatus, status]);

  const bottomNoticeContent = historyNotice?.content ?? (showStandbyNotice ? "Standby Listening ...." : transientStatusNotice);

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-0 bg-transparent p-0">
      <div
        className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-[4px] bg-mist/75 p-2 pb-0 touch-pan-y"
        onPointerDown={onHistoryInteract}
        onScroll={updateLiveHistoryScrollState}
        onTouchEndCapture={() => {
          lastLiveHistoryTouchYRef.current = null;
        }}
        onTouchMoveCapture={containLiveHistoryTouch}
        onTouchStartCapture={rememberLiveHistoryTouch}
        onWheelCapture={containLiveHistoryWheel}
        ref={liveHistoryRef}
      >
        <div className="flex min-h-full flex-col gap-1.5">
          {orderedTurns.map((turn) => {
            if (userAudioDisplay.foldedIds.has(turn.id)) {
              return null;
            }
            const videoControlsVisible = focusedVideoTurnId === turn.id;
            const videoExpanded = expandedVideoTurnIds.has(turn.id);
            return (
              <div
                className={`rounded-[4px] px-2.5 py-1.5 text-[13px] leading-5 ${
                  turn.role === "assistant" ? "bg-white text-ink" : turn.role === "user" ? "self-end bg-[#fff7e8] text-ink" : "bg-mist text-ink/60"
                } ${turn.role === "user" ? "max-w-[92%]" : "max-w-[92%]"}`}
                data-active-live-video={turn.id === activeVideoTurnId && turn.videoStream ? "true" : undefined}
                data-live-turn="true"
                key={turn.id}
                style={turn.role === "user" ? { minWidth: "min(320px, 92%)" } : undefined}
              >
                {turn.images?.length ? (
                  <div className={`${turn.content || turn.videoStream ? "mb-2" : ""} grid gap-2`}>
                    {turn.images.map((image) => (
                      <button
                        className="flex flex-col overflow-hidden rounded-[6px] bg-[#f7f1e6] p-2 text-left transition hover:opacity-90"
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
                        {image.origin === "generated" && formatGeneratedImageMetadata(image) ? (
                          <span className="mt-2 truncate text-[10px] text-ink/55">{formatGeneratedImageMetadata(image)}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {turn.role === "user" && turn.audioUrl && userAudioDisplay.inlineIds.has(turn.id) ? (
                  <audio className={turn.content ? "mb-2 h-10 w-full" : "h-10 w-full"} controls preload="metadata" src={turn.audioUrl} />
                ) : null}
                {turn.content ? <div className="whitespace-pre-wrap break-words">{turn.content}</div> : null}
                {turn.videoStream ? (
                  <div
                    className="group relative mt-2 inline-flex max-w-full overflow-hidden rounded-[6px] bg-black/20"
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
                  <div className="mt-2 grid gap-1.5">
                    {turn.substitutions.map((edit, index) => (
                      <div className="rounded-[6px] bg-[#fff7e8] px-2 py-2" key={`${turn.id}:edit:${index}`}>
                        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink/45">Suggested replace</div>
                        <div className="mt-2 whitespace-pre-wrap break-words text-sm text-[#8c5c54] line-through">{edit.find}</div>
                        <div className="mt-2 whitespace-pre-wrap break-words text-sm text-[#1f6f78]">{edit.replace}</div>
                      </div>
                    ))}
                    {onApplyEdits ? (
                      <div className="flex justify-end">
                        <button
                          className="rounded-[4px] bg-mist px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-ink transition hover:bg-[#efe5d3]"
                          onClick={() => onApplyEdits(turn.substitutions ?? [])}
                          type="button"
                        >
                          Review in editor
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {turn.audioUrl && turn.role !== "user" ? (
                  <audio className="mt-2 h-10 w-full" controls preload="metadata" src={turn.audioUrl} />
                ) : null}
              </div>
            );
          })}
          {userAudioDisplay.foldedClips.length > 0 ? (
            <details className="self-end rounded-[4px] bg-[#fff7e8] px-2.5 py-1.5 text-[13px] leading-5 text-ink" style={{ minWidth: "min(320px, 92%)", maxWidth: "92%" }}>
              <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-[0.14em] text-ink/55">
                User audio clips ({userAudioDisplay.foldedClips.length})
              </summary>
              <div className="mt-2 grid gap-2">
                {userAudioDisplay.foldedClips.map((clip, index) => (
                  <div className="rounded-[6px] bg-white/70 p-2" key={clip.id}>
                    <div className="mb-2 truncate text-xs text-ink/55">
                      {index + 1}. {clip.label}
                    </div>
                    <audio className="h-10 w-full" controls preload="metadata" src={clip.audioUrl} />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {orderedTurns.length === 0 ? (
            <div className="mt-auto px-1 py-2 text-sm text-ink/45">
              Live transcript history appears here once you send live audio or Gemini starts speaking.
            </div>
          ) : null}
          {orderedTurns.length > 0 ? <div aria-hidden="true" className="shrink-0 rounded-t-[20px]" style={{ height: 128 }} /> : null}
        </div>
      </div>
      {bottomNoticeContent ? (
        <div className="pointer-events-none absolute inset-x-2 bottom-3 z-20 flex justify-center" key={historyNotice?.id ?? "standby-listening-notice"}>
          <div
            aria-live={showStandbyNotice && !historyNotice ? "polite" : undefined}
            className="max-w-full rounded-[4px] bg-white/90 px-2 py-1 text-center text-xs text-ink/65 shadow-[0_8px_18px_rgba(15,23,42,0.10)]"
          >
            {bottomNoticeContent}
          </div>
        </div>
      ) : null}

      {previewImage ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4">
          <div className="max-h-[92vh] w-full max-w-[90vw] overflow-auto rounded-[8px] bg-[#fff9ef] p-3 shadow-[0_18px_36px_rgba(15,23,42,0.2)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Image</div>
                <div className="truncate text-sm font-medium text-ink">{previewImage.fileName}</div>
                {previewImage.origin === "generated" && formatGeneratedImageMetadata(previewImage) ? (
                  <div className="mt-0.5 truncate text-xs text-ink/55">{formatGeneratedImageMetadata(previewImage)}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {onUploadImageToCurrentFolder ? (
                  <button
                    aria-label="Upload image to current folder"
                    className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-white text-ink transition hover:bg-mist"
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
                  className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-white text-ink transition hover:bg-mist"
                  onClick={() => setPreviewImage(null)}
                  type="button"
                >
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="mt-2 flex justify-center overflow-auto rounded-[8px] bg-black/5 p-2">
              <img alt={previewImage.fileName} className="h-auto max-w-[90%] object-contain" src={previewImage.url} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
