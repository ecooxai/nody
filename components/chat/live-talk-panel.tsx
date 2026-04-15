"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { stripHtml } from "@/lib/editor/html";
import type { ProviderSettings } from "@/shared/types";

type LiveTurn = {
  id: string;
  role: "user" | "assistant" | "status";
  content: string;
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
    }
  | {
      error?: { message?: string };
    };

type LiveSessionState = {
  connecting: boolean;
  ready: boolean;
  status: string;
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

function buildLiveWebSocketUrl(apiUrl: string, apiKey: string) {
  const base = apiUrl.replace(/\/$/, "");
  const wsBase = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${wsBase}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}&alt=ws`;
}

function buildNoteContext(title: string, bodyHtml: string) {
  const noteText = stripHtml(bodyHtml);
  const content = noteText ? `${title}\n\n${noteText}` : `${title}\n\nThis note is currently empty.`;
  return [
    "You are a live voice assistant inside a note editor.",
    "Use the current note as the active context for the conversation.",
    "Keep responses concise, conversational, and helpful.",
    "When the note content is shared, respond with a spoken-style answer that helps the user explore it.",
    "",
    "Current note:",
    content,
  ].join("\n");
}

async function readWebSocketMessageText(data: MessageEvent["data"]) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data);
}

export function LiveTalkPanel({
  active,
  currentNoteBodyHtml,
  currentNoteTitle,
  onError,
  onRegisterSend,
  onSessionStateChange,
  providerSettings,
}: {
  active: boolean;
  currentNoteBodyHtml: string;
  currentNoteTitle: string;
  onError: (message: string) => void;
  onRegisterSend?: ((send: ((text: string) => boolean) | null) => void) | undefined;
  onSessionStateChange?: ((state: LiveSessionState) => void) | undefined;
  providerSettings: ProviderSettings;
}) {
  const [sessionRequested, setSessionRequested] = useState(active);
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Open the Live tab to start a session.");
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneAudioContextRef = useRef<AudioContext | null>(null);
  const microphoneSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const microphoneProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const microphoneSinkRef = useRef<GainNode | null>(null);
  const nextAudioTimeRef = useRef(0);
  const liveAssistantTurnIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const microphoneCaptureEnabledRef = useRef(active);
  const noteContext = useMemo(() => buildNoteContext(currentNoteTitle, currentNoteBodyHtml), [currentNoteBodyHtml, currentNoteTitle]);
  const noteContextRef = useRef(noteContext);
  const noteTitleRef = useRef(currentNoteTitle);
  const noteBodyHtmlRef = useRef(currentNoteBodyHtml);
  const sendLiveTextRef = useRef<(text: string) => boolean>(() => false);
  const socketSessionIdRef = useRef(0);
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useEffect(() => {
    noteContextRef.current = noteContext;
    noteTitleRef.current = currentNoteTitle;
    noteBodyHtmlRef.current = currentNoteBodyHtml;
  }, [noteContext]);

  useEffect(() => {
    if (active) {
      setSessionRequested(true);
    }
    microphoneCaptureEnabledRef.current = active;
  }, [active]);

  useEffect(() => {
    onSessionStateChange?.({ connecting, ready, status });
  }, [connecting, onSessionStateChange, ready, status]);

  useEffect(() => {
    if (!onRegisterSend) return;
    onRegisterSend((text) => sendLiveTextRef.current(text));
    return () => onRegisterSend(null);
  }, [onRegisterSend]);

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

    const requestMicrophone = async () => {
      if (microphoneStreamRef.current) {
        return microphoneStreamRef.current;
      }
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        return null;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        microphoneStreamRef.current = stream;
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

          socketConnection.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: float32ToBase64Pcm16(resampled),
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

    const appendTurn = (role: LiveTurn["role"], content: string) => {
      if (!content.trim()) return;
      setTurns((current) => [...current, { id: crypto.randomUUID(), role, content }]);
    };

    const updateAssistantTurn = (content: string) => {
      if (!content.trim()) return;
      setTurns((current) => {
        const existingId = liveAssistantTurnIdRef.current;
        if (!existingId) {
          const id = crypto.randomUUID();
          liveAssistantTurnIdRef.current = id;
          return [...current, { id, role: "assistant", content }];
        }

        let updated = false;
        const next = current.map((turn) => {
          if (turn.id !== existingId) return turn;
          updated = true;
          return { ...turn, content: `${turn.content}${content}` };
        });
        return updated ? next : [...current, { id: existingId, role: "assistant", content }];
      });
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
          },
        }),
      );
    };

    const sendLiveText = (text: string) => {
      const socketConnection = socketRef.current;
      const trimmedText = text.trim();
      if (!socketConnection || socketConnection.readyState !== WebSocket.OPEN || !readyRef.current || !trimmedText) {
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

    sendLiveTextRef.current = sendLiveText;

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
            appendTurn("user", serverContent.inputTranscription.text);
          }
          if (serverContent.outputTranscription?.text) {
            updateAssistantTurn(serverContent.outputTranscription.text);
          }
          for (const part of serverContent.modelTurn?.parts ?? []) {
            if (part.text) {
              updateAssistantTurn(part.text);
            }
            if (part.inlineData?.data) {
              playAudioChunk(part.inlineData.data);
            }
          }
          if (serverContent.interrupted) {
            setStatus("Live response interrupted.");
            resetAssistantTurn();
          }
          if (serverContent.turnComplete) {
            resetAssistantTurn();
          }
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
      microphoneCaptureEnabledRef.current = false;
      microphoneProcessorRef.current?.disconnect();
      microphoneProcessorRef.current = null;
      microphoneSourceRef.current?.disconnect();
      microphoneSourceRef.current = null;
      microphoneSinkRef.current?.disconnect();
      microphoneSinkRef.current = null;
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      microphoneAudioContextRef.current?.close().catch(() => undefined);
      microphoneAudioContextRef.current = null;
      nextAudioTimeRef.current = 0;
      liveAssistantTurnIdRef.current = null;
      sendLiveTextRef.current = () => false;
      onRegisterSend?.(null);
    };
  }, [
    onError,
    onRegisterSend,
    providerSettings.apiKey,
    providerSettings.apiUrl,
    providerSettings.liveModel,
    providerSettings.model,
    sessionRequested,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 rounded-[4px] border border-ink/10 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.24em] text-ink/55">Live Talk</div>
          <p className="mt-1 text-sm text-ink/60">Open the Live tab to start the session. The shared composer below sends text into the same live room.</p>
        </div>
        <div className="rounded-full bg-black/[0.04] px-3 py-1 text-xs font-medium text-ink/70">
          {connecting ? "Connecting" : ready ? "Ready" : "Idle"}
        </div>
      </div>

      <div className="rounded-[4px] border border-ink/10 bg-mist/60 px-3 py-2 text-sm text-ink/70">{status}</div>

      <div className="min-h-0 flex-1 overflow-auto rounded-[4px] border border-ink/10 bg-[#fffdf8] p-3">
        <div className="flex flex-col gap-2">
          {turns.length === 0 ? (
            <div className="rounded-[4px] border border-dashed border-ink/10 px-3 py-4 text-sm text-ink/45">
              The conversation will appear here once Gemini starts speaking.
            </div>
          ) : null}
          {turns.map((turn) => (
            <div
              className={`max-w-[92%] rounded-[4px] px-3 py-2 text-sm ${
                turn.role === "assistant" ? "bg-white" : turn.role === "user" ? "self-end bg-ink text-white" : "bg-mist text-ink/60"
              }`}
              key={turn.id}
            >
              <div className="whitespace-pre-wrap break-words">{turn.content}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
