"use client";

import { useEffect, useRef, useState } from "react";

import { Panel } from "@/components/ui/panel";
import type {
  AIMessage,
  AIMessageAttachment,
  AIMessagePrompt,
  AIRequestAttachment,
  AIMediaKind,
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

function inferMediaKind(mimeType: string): AIMediaKind | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
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

function getPreferredRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/x-m4a",
    "audio/webm;codecs=opus",
    "audio/webm",
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

export function AIChatPanel({
  messages,
  busy,
  currentFolderFiles,
  currentFolderName,
  onAsk,
  onApply,
  onCreatePrompt,
  onUpdatePrompt,
  onError,
  prompts,
  provider,
  selectedText,
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
  }) => Promise<boolean>;
  onApply: (edits: TextSubstitution[]) => void;
  onCreatePrompt: (value: Pick<PromptTemplate, "name" | "content">) => Promise<PromptTemplate>;
  onUpdatePrompt: (id: string, value: Pick<PromptTemplate, "name" | "content">) => Promise<PromptTemplate>;
  onError: (message: string) => void;
  prompts: PromptTemplate[];
  provider: ProviderName;
  selectedText?: string;
}) {
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<PreviewAttachment | null>(null);
  const [previewPrompt, setPreviewPrompt] = useState<AIMessagePrompt | null>(null);
  const [prompt, setPrompt] = useState("");
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [selectedPrompts, setSelectedPrompts] = useState<PromptTemplate[]>([]);
  const [promptCreateOpen, setPromptCreateOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [promptNameDraft, setPromptNameDraft] = useState("");
  const [promptContentDraft, setPromptContentDraft] = useState("");
  const [creatingPrompt, setCreatingPrompt] = useState(false);
  const [recording, setRecording] = useState(false);
  const [preparingRecording, setPreparingRecording] = useState(false);
  const [cameraPreparing, setCameraPreparing] = useState(false);
  const [cameraRecording, setCameraRecording] = useState(false);
  const attachmentsRef = useRef<LocalAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordHoldActiveRef = useRef(false);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraRecorderRef = useRef<MediaRecorder | null>(null);
  const cameraChunksRef = useRef<Blob[]>([]);
  const cameraHoldActiveRef = useRef(false);
  const cameraLongPressTimerRef = useRef<number | null>(null);
  const cameraCaptureHandledRef = useRef(false);
  const supportsMedia = provider === "gemini";
  const availablePrompts = [...builtInPrompts, ...prompts];

  useEffect(() => {
    const trimmedSelection = selectedText?.trim();
    if (!trimmedSelection) return;
    setPrompt(`\n${trimmedSelection}\n`);
  }, [selectedText]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(
    () => () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
      mediaRecorderRef.current?.stop?.();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (cameraLongPressTimerRef.current) {
        window.clearTimeout(cameraLongPressTimerRef.current);
      }
      cameraRecorderRef.current?.stop?.();
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const stopRecordingStream = () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  };

  const clearCameraLongPressTimer = () => {
    if (cameraLongPressTimerRef.current) {
      window.clearTimeout(cameraLongPressTimerRef.current);
      cameraLongPressTimerRef.current = null;
    }
  };

  const stopCameraStream = () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
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

  const createFileAttachment = (file: File, kind: AIMediaKind): LocalAttachment => ({
    id: crypto.randomUUID(),
    kind,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
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
      const kind = inferMediaKind(file.type);
      if (!kind) return [];
      return [
        {
          id: crypto.randomUUID(),
          kind,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
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

    setAttachments((current) => [...current, ...nextAttachments]);
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

  const addPromptTemplate = (template: PromptTemplate) => {
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

  const clearComposer = () => {
    attachments.forEach(revokeAttachmentPreview);
    setAttachments([]);
    setPreviewAttachment(null);
    setPreviewPrompt(null);
    setSelectedPrompts([]);
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

  const submitPrompt = async (items: LocalAttachment[], transientItems: LocalAttachment[] = []) => {
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

      const sent = await onAsk({
        prompt: finalPrompt,
        attachments: requestAttachments,
        messageAttachments: items.map(buildMessageAttachment),
        prompts: selectedMessagePrompts,
      });

      if (sent) {
        clearComposer();
        setFolderPickerOpen(false);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to prepare attachments.");
    } finally {
      transientItems.forEach(revokeAttachmentPreview);
    }
  };

  const handleSend = async () => {
    if (busy || (!prompt.trim() && attachments.length === 0 && selectedPrompts.length === 0)) return;
    await submitPrompt(attachments);
  };

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
          const recordedAttachment = createFileAttachment(file, "audio");
          await submitPrompt([...attachmentsRef.current, recordedAttachment], [recordedAttachment]);
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
    if (busy || recording || preparingRecording) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onError("Audio recording is not supported in this browser.");
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType });
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
    if (preparingRecording) return;
    if (mediaRecorderRef.current?.state === "recording") {
      await stopRecordingAndSend();
    }
  };

  const capturePhotoAndSend = async () => {
    const video = cameraVideoRef.current;
    if (!video || !cameraStreamRef.current) return;
    if (!lockCameraCapture()) return;

    try {
      await waitForCameraFrame(video);
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
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((nextBlob) => {
          if (!nextBlob) {
            reject(new Error("Failed to capture photo."));
            return;
          }
          resolve(nextBlob);
        }, "image/jpeg", 0.92);
      });
      const file = new File([blob], `photo-${Date.now()}.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
      const photoAttachment = createFileAttachment(file, "image");
      await submitPrompt([...attachmentsRef.current, photoAttachment], [photoAttachment]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to capture photo.");
    } finally {
      setCameraPreparing(false);
      setCameraRecording(false);
      stopCameraStream();
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
          await submitPrompt([...attachmentsRef.current, videoAttachment], [videoAttachment]);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          cameraRecorderRef.current = null;
          setCameraPreparing(false);
          setCameraRecording(false);
          stopCameraStream();
        }
      };

      recorder.onerror = () => {
        cameraRecorderRef.current = null;
        cameraChunksRef.current = [];
        setCameraPreparing(false);
        setCameraRecording(false);
        stopCameraStream();
        reject(new Error("Video recording failed."));
      };

      recorder.stop();
    }).catch((error) => {
      onError(error instanceof Error ? error.message : "Video recording failed.");
    });
  };

  const startVideoRecording = () => {
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
    recorder.start();
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
      clearCameraLongPressTimer();
      cameraLongPressTimerRef.current = window.setTimeout(() => {
        cameraLongPressTimerRef.current = null;
        if (!cameraHoldActiveRef.current) return;
        startVideoRecording();
      }, 2000);

      if (!cameraHoldActiveRef.current && !cameraRecording) {
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
    if (cameraRecording && cameraRecorderRef.current?.state === "recording") {
      await stopVideoRecordingAndSend();
      return;
    }
    if (cameraStreamRef.current) {
      await capturePhotoAndSend();
    }
  };

  return (
    <Panel className="relative z-0 flex h-[460px] w-full flex-col overflow-visible overscroll-contain border-0 p-0 shadow-none">
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
        className="w-full resize-none overflow-y-auto rounded-[10px] border border-pine/40 bg-[#fffdf8] px-4 py-3 text-sm leading-6 overscroll-contain transition-[height] duration-200 ease-out"
        onChange={(event) => setPrompt(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file))
            .filter((file) => Boolean(inferMediaKind(file.type)));
          if (files.length === 0) return;
          event.preventDefault();
          appendFiles(files);
        }}
        placeholder={
          supportsMedia
            ? "Ask Gemini about this note and attach images, audio, or video."
            : "Send the whole document, ask questions, or switch to Gemini to attach media."
        }
        style={{ height: promptExpanded ? 300 : 130 }}
        value={prompt}
      />

      {selectedPrompts.length > 0 ? (
        <div className="mt-3 max-h-[220px] overflow-y-auto overscroll-contain rounded-[12px] border border-ink/10 bg-[#fffdf8] p-2 touch-pan-y">
          <div className="flex flex-wrap gap-2">
            {selectedPrompts.map((selectedPrompt) => (
              <div className="relative h-[30px] w-[80px] min-w-[80px]" key={selectedPrompt.id}>
                <button
                  className="group flex h-[30px] w-[80px] flex-col overflow-hidden rounded-[10px] border border-ink/10 bg-white px-1.5 py-1 text-left transition hover:border-ink/25 hover:bg-mist"
                  onClick={() => setPreviewPrompt(buildMessagePrompt(selectedPrompt))}
                  type="button"
                >
                  <div className="min-w-0 text-[9px] font-semibold leading-3 text-ink">{selectedPrompt.name}</div>
                  <div className="min-h-0 text-[8px] leading-3 text-ink/55">
                    <div className="max-h-8 overflow-hidden break-words">{selectedPrompt.content}</div>
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
          </div>
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="mt-3 flex gap-2 overflow-x-auto overscroll-contain pb-1">
          {attachments.map((attachment) => (
            <div className="relative shrink-0" key={attachment.id}>
              <button
                className="group flex h-20 w-24 flex-col overflow-hidden rounded-[10px] border border-ink/10 bg-white text-left transition hover:border-ink/25 hover:bg-mist"
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
                  <img alt={attachment.fileName} className="h-12 w-full object-cover" src={attachment.previewUrl} />
                ) : attachment.kind === "video" ? (
                  <video className="h-12 w-full object-cover" muted playsInline preload="metadata" src={attachment.previewUrl} />
                ) : (
                  <div className="flex h-12 w-full items-center justify-center bg-mist text-ink/70">
                    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                      <path d="M9 15V9l8-2v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                      <circle cx="7.5" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                      <circle cx="16.5" cy="14.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                    </svg>
                  </div>
                )}
                <div className="flex min-h-0 flex-1 flex-col px-2 py-1">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-ink/45">{attachmentBadge(attachment.kind)}</span>
                  <span className="truncate text-xs font-medium text-ink">{attachment.fileName}</span>
                </div>
              </button>
              <button
                aria-label={`Remove ${attachment.fileName}`}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-ink shadow-sm transition hover:bg-white"
                onClick={() => removeAttachment(attachment.id)}
                type="button"
              >
                <svg aria-hidden="true" className="h-3 w-3" fill="none" viewBox="0 0 24 24">
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
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label={recording ? "Release to stop recording" : "Hold to record audio"}
            className={`flex h-10 w-10 items-center justify-center rounded-[4px] border transition disabled:cursor-not-allowed disabled:opacity-50 ${
              recording
                ? "border-[#bb3e2d] bg-[#bb3e2d] text-white"
                : "border-ink/10 bg-white text-ink hover:border-ink/30 hover:bg-mist"
            }`}
            disabled={!supportsMedia || busy || cameraPreparing || cameraRecording}
            onPointerCancel={() => void releaseRecording()}
            onPointerDown={(event) => {
              recordHoldActiveRef.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              void startRecording();
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              void releaseRecording();
            }}
            title={
              supportsMedia
                ? recording
                  ? "Release to stop and send audio"
                  : "Hold to record and send audio"
                : "Switch to Gemini to record audio"
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
          <button
            aria-label="Ask"
            className="flex h-10 w-10 items-center justify-center rounded-[4px] bg-ember text-ink transition hover:bg-ember/90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || preparingRecording || recording || cameraPreparing || cameraRecording || (!prompt.trim() && attachments.length === 0 && selectedPrompts.length === 0)}
            onClick={() => void handleSend()}
            type="button"
          >
            {busy ? (
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
          <div className="absolute bottom-[calc(100%+8px)] left-0 z-[80] flex h-[360px] w-full flex-col overflow-hidden rounded-[12px] border border-ink/10 bg-white p-2 shadow-[0_18px_32px_rgba(15,23,42,0.12)]">
            <div className="mb-2 shrink-0 flex items-center justify-between gap-2 px-1">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">Prompt Library</div>
                <div className="text-xs text-ink/55">Built-ins and synced prompts</div>
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
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1 touch-pan-y">
              {availablePrompts.map((item) => {
                const selected = selectedPrompts.some((promptItem) => promptItem.id === item.id);
                return (
                  <div className="flex items-start gap-2" key={item.id}>
                    <button
                      className={`flex min-w-0 flex-1 items-start justify-between gap-3 rounded-[10px] border px-3 py-2 text-left transition ${
                        selected ? "border-ink bg-mist" : "border-ink/10 bg-white hover:border-ink/20 hover:bg-mist"
                      }`}
                      onClick={() => addPromptTemplate(item)}
                      type="button"
                    >
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="break-words text-sm font-medium text-ink">{item.name}</div>
                        <div className="mt-1 max-h-12 overflow-hidden break-words text-xs leading-5 text-ink/55">{item.content}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/55">
                        {item.builtin ? "Built-in" : "Cloud"}
                      </span>
                    </button>
                    {!item.builtin ? (
                      <button
                        aria-label={`Edit ${item.name}`}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                        onClick={() => openPromptEditor(item)}
                        type="button"
                      >
                        <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
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
        ) : null}

        {folderPickerOpen ? (
          <div className="absolute bottom-[calc(100%+8px)] left-0 z-[80] w-full rounded-[12px] border border-ink/10 bg-white p-2 shadow-[0_18px_32px_rgba(15,23,42,0.12)]">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
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
            <div className="max-h-52 space-y-2 overflow-auto overscroll-contain pr-1">
              {currentFolderFiles.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-ink/10 px-3 py-4 text-sm text-ink/45">
                  No image, audio, or video files in this folder yet.
                </div>
              ) : (
                currentFolderFiles.map((asset) => (
                  <button
                    className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-ink/10 bg-white px-3 py-2 text-left transition hover:border-ink/20 hover:bg-mist"
                    key={asset.id}
                    onClick={() => addFolderAsset(asset)}
                    type="button"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-ink">{asset.fileName}</span>
                    <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink/55">
                      {attachmentBadge(asset.kind)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-2 text-[11px] text-ink/45">
        {supportsMedia
          ? "Add prompts, paste or capture media, and Gemini will receive everything with your request."
          : "Media attachments are enabled when Gemini is selected in Settings."}
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto overscroll-contain rounded-[4px] bg-mist/80 p-3">
        <div className="flex flex-col gap-3">
          {messages.map((message) => {
            const edits = message.substitutions ?? [];
            return (
              <div
                className={`max-w-[92%] rounded-[4px] px-3 py-2 text-sm ${message.role === "assistant" ? "bg-white" : "self-end bg-ink text-white"}`}
                key={message.id}
              >
                <div className="whitespace-pre-wrap break-words">{message.content}</div>
                {message.prompts?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {message.prompts.map((promptItem) => (
                      <button
                        className={`rounded-[10px] border px-3 py-2 text-left text-xs transition ${
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
                  </div>
                ) : null}
                {message.attachments?.length ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {message.attachments.map((attachment) => {
                      const cardTone =
                        message.role === "assistant"
                          ? "border-ink/10 bg-mist/70 text-ink"
                          : "border-white/10 bg-white/10 text-white";
                      const metaTone = message.role === "assistant" ? "text-ink/55" : "text-white/65";
                      return (
                        <div className={`rounded-[10px] border p-2 ${cardTone}`} key={attachment.id}>
                          <button
                            className="w-full text-left"
                            disabled={!attachment.url}
                            onClick={() => {
                              const preview = toPreviewAttachment(attachment);
                              if (preview) setPreviewAttachment(preview);
                            }}
                            type="button"
                          >
                            {attachment.kind === "image" && attachment.url ? (
                              <img alt={attachment.fileName} className="mb-2 h-24 w-full rounded-[8px] object-cover" src={attachment.url} />
                            ) : null}
                            {attachment.kind === "video" && attachment.url ? (
                              <video className="mb-2 h-24 w-full rounded-[8px] object-cover" muted playsInline preload="metadata" src={attachment.url} />
                            ) : null}
                            {attachment.kind === "audio" ? (
                              <div className="mb-2 flex h-24 items-center justify-center rounded-[8px] bg-black/5">
                                <svg aria-hidden="true" className="h-7 w-7" fill="none" viewBox="0 0 24 24">
                                  <path d="M9 15V9l8-2v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                                  <circle cx="7.5" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                                  <circle cx="16.5" cy="14.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                                </svg>
                              </div>
                            ) : null}
                            <div className="text-[10px] font-semibold uppercase tracking-[0.14em]">{attachmentBadge(attachment.kind)}</div>
                            <div className="truncate text-sm font-medium">{attachment.fileName}</div>
                          </button>
                          <div className={`mt-2 flex items-center justify-between gap-2 text-xs ${metaTone}`}>
                            <span>{attachment.mimeType || "file"}</span>
                            {attachment.url ? (
                              <a
                                className="rounded-full border border-current/20 px-2 py-1 font-semibold uppercase tracking-[0.14em] hover:bg-black/5"
                                download={attachment.fileName}
                                href={attachment.url}
                                onClick={(event) => event.stopPropagation()}
                                rel="noreferrer"
                                target="_blank"
                              >
                                Download
                              </a>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {message.role === "assistant" && edits.length > 0 ? (
                  <div className="mt-3 flex justify-end">
                    <button
                      aria-label="Apply AI edits"
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-mist text-ink transition hover:border-ink/25 hover:bg-[#efe5d3]"
                      onClick={() => onApply(edits)}
                      title="Apply AI edits"
                      type="button"
                    >
                      <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <path
                          d="M7 12.5l3.2 3.2L17 9"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.8"
                        />
                      </svg>
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {previewAttachment ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-[16px] border border-white/10 bg-[#fff9ef] p-4 shadow-[0_20px_42px_rgba(15,23,42,0.24)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/45">{attachmentBadge(previewAttachment.kind)}</div>
                <div className="truncate text-sm font-medium text-ink">{previewAttachment.fileName}</div>
              </div>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                onClick={() => setPreviewAttachment(null)}
                type="button"
              >
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
            <div className="mt-3 overflow-hidden rounded-[12px] border border-ink/10 bg-black/5 p-2">
              {previewAttachment.kind === "image" ? (
                <img alt={previewAttachment.fileName} className="max-h-[320px] w-full object-contain" src={previewAttachment.previewUrl} />
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
      <video className="hidden" muted playsInline ref={cameraVideoRef} />
    </Panel>
  );
}
