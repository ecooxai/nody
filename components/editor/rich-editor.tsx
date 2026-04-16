"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from "react";

import type { EditorCommand } from "@/lib/editor/commands";
import { assetToMarkdown } from "@/lib/editor/media";
import { markdownToHtml } from "@/lib/editor/markdown";
import type { AIMediaKind, DocumentAsset } from "@/shared/types";

export type RichEditorHandle = {
  focus: () => void;
  focusRange: (start: number, end: number) => void;
  insertAsset: (asset: DocumentAsset, position?: "cursor" | "top") => void;
  runCommand: (command: EditorCommand) => void;
};

type RichEditorProps = {
  title: string;
  bodyMarkdown: string;
  editable: boolean;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onSelectionChange?: (selectedText: string) => void;
  onRequestEdit?: () => void;
  onAddMediaToAi?: (media: {
    id: string;
    kind: AIMediaKind;
    fileName: string;
    mimeType: string;
    assetUrl: string;
    previewUrl: string;
  }) => void;
  inlineNotice?: React.ReactNode;
  overlay?: React.ReactNode;
  topRight?: React.ReactNode;
};

type TextSelection = {
  start: number;
  end: number;
};

function wrapSelection(
  value: string,
  selection: TextSelection,
  before: string,
  after = before,
  fallback = "text",
) {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const selected = value.slice(start, end);
  const content = selected || fallback;
  const nextValue = `${value.slice(0, start)}${before}${content}${after}${value.slice(end)}`;
  const caretStart = start + before.length;
  const caretEnd = caretStart + content.length;
  return {
    value: nextValue,
    selection: {
      start: caretStart,
      end: caretEnd,
    },
  };
}

function prefixLines(value: string, selection: TextSelection, prefix: string, fallback: string) {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const lineStart = value.lastIndexOf("\n", Math.max(start - 1, 0));
  const lineEndIndex = value.indexOf("\n", end);
  const sliceStart = lineStart >= 0 ? lineStart + 1 : 0;
  const sliceEnd = lineEndIndex >= 0 ? lineEndIndex : value.length;
  const segment = value.slice(sliceStart, sliceEnd) || fallback;
  const lines = segment.split("\n");
  const nextSegment = lines.map((line) => `${prefix}${line || fallback}`).join("\n");
  return {
    value: `${value.slice(0, sliceStart)}${nextSegment}${value.slice(sliceEnd)}`,
    selection: {
      start: sliceStart,
      end: sliceStart + nextSegment.length,
    },
  };
}

function applyCommand(value: string, selection: TextSelection, command: EditorCommand) {
  switch (command) {
    case "bold":
      return wrapSelection(value, selection, "**");
    case "italic":
      return wrapSelection(value, selection, "*");
    case "underline":
      return wrapSelection(value, selection, "<u>", "</u>");
    case "insertUnorderedList":
      return prefixLines(value, selection, "- ", "List item");
    case "formatBlock:h1":
      return prefixLines(value, selection, "# ", "Heading");
    case "formatBlock:h2":
      return prefixLines(value, selection, "## ", "Heading");
    case "formatBlock:blockquote":
      return prefixLines(value, selection, "> ", "Quote");
    default:
      return { value, selection };
  }
}

type EmbeddedMedia = {
  id: string;
  kind: AIMediaKind;
  fileName: string;
  mimeType: string;
  assetUrl: string;
  previewUrl: string;
};

type MediaTagPreview = {
  kind: "image" | "video";
  tagText: string;
  src: string;
};

function extractMediaTagPreviews(value: string) {
  const previews: MediaTagPreview[] = [];
  const tagPattern = /<(img|video)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/video>)/gi;

  for (const match of value.matchAll(tagPattern)) {
    const rawTag = match[0]?.trim() ?? "";
    const srcMatch = rawTag.match(/\ssrc=(?:"([^"]+)"|'([^']+)')/i);
    const src = srcMatch?.[1] || srcMatch?.[2] || "";
    const kind = rawTag.startsWith("<video") ? "video" : "image";
    if (!src) continue;
    previews.push({
      kind,
      tagText: rawTag,
      src,
    });
  }

  return previews;
}

function fileNameFromUrl(url: string) {
  try {
    const pathname = new URL(url, "https://workspace.local").pathname;
    const segment = pathname.split("/").pop() ?? "media";
    return decodeURIComponent(segment);
  } catch {
    return "media";
  }
}

function inferMimeFromUrl(url: string, kind: AIMediaKind) {
  const lower = url.toLowerCase();
  if (kind === "image") {
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    return "image/jpeg";
  }
  if (kind === "audio") {
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
    return "audio/webm";
  }
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return "video/webm";
}

function extractEmbeddedMedia(target: EventTarget | null): EmbeddedMedia | null {
  const element = target instanceof HTMLElement ? target.closest("img,video,audio") : null;
  if (!(element instanceof HTMLElement)) return null;

  const tag = element.tagName.toLowerCase();
  const kind = tag === "img" ? "image" : tag === "audio" ? "audio" : tag === "video" ? "video" : null;
  if (!kind) return null;

  const sourceElement = element as HTMLImageElement | HTMLAudioElement | HTMLVideoElement;
  const assetUrl = ("currentSrc" in sourceElement && sourceElement.currentSrc) || sourceElement.getAttribute("src") || "";
  if (!assetUrl) return null;

  const fileName = element.dataset.fileName || element.getAttribute("alt") || fileNameFromUrl(assetUrl);
  const mimeType = element.dataset.mimeType || inferMimeFromUrl(assetUrl, kind);

  return {
    id: `${kind}:${assetUrl}`,
    kind,
    fileName,
    mimeType,
    assetUrl,
    previewUrl: assetUrl,
  };
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor({
  title,
  bodyMarkdown,
  editable,
  onTitleChange,
  onBodyChange,
  onSelectionChange,
  onRequestEdit,
  onAddMediaToAi,
  inlineNotice,
  overlay,
  topRight,
}, ref) {
  const titleInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<TextSelection>({ start: 0, end: 0 });
  const editButtonTimerRef = useRef<number | null>(null);
  const activeMediaHideTimerRef = useRef<number | null>(null);
  const lineTapRef = useRef<{ key: string | null; count: number; startedAt: number }>({
    key: null,
    count: 0,
    startedAt: 0,
  });
  const [editButtonVisible, setEditButtonVisible] = useState(false);
  const [activeMedia, setActiveMedia] = useState<(EmbeddedMedia & { x: number; y: number }) | null>(null);
  const [viewerMedia, setViewerMedia] = useState<EmbeddedMedia | null>(null);
  const previewHtml = useMemo(() => markdownToHtml(bodyMarkdown), [bodyMarkdown]);
  const mediaTagPreviews = useMemo(() => extractMediaTagPreviews(bodyMarkdown), [bodyMarkdown]);

  const clearEditButtonTimer = () => {
    if (editButtonTimerRef.current) {
      window.clearTimeout(editButtonTimerRef.current);
      editButtonTimerRef.current = null;
    }
  };

  const clearActiveMediaHideTimer = () => {
    if (activeMediaHideTimerRef.current) {
      window.clearTimeout(activeMediaHideTimerRef.current);
      activeMediaHideTimerRef.current = null;
    }
  };

  const scheduleActiveMediaHide = () => {
    clearActiveMediaHideTimer();
    activeMediaHideTimerRef.current = window.setTimeout(() => {
      setActiveMedia(null);
      activeMediaHideTimerRef.current = null;
    }, 2000);
  };

  const revealEditButton = () => {
    if (editable || typeof window === "undefined") return;
    setEditButtonVisible(true);
    clearEditButtonTimer();
    editButtonTimerRef.current = window.setTimeout(() => {
      setEditButtonVisible(false);
      editButtonTimerRef.current = null;
    }, 3000);
  };

  useEffect(
    () => () => {
      clearEditButtonTimer();
      clearActiveMediaHideTimer();
    },
    [],
  );

  useEffect(() => {
    if (!editable) {
      selectionRef.current = { start: 0, end: 0 };
      return;
    }
    setEditButtonVisible(false);
    clearActiveMediaHideTimer();
    setActiveMedia(null);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [editable]);

  useEffect(() => {
    if (!activeMedia) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        scheduleActiveMediaHide();
        return;
      }
      if (target.closest("[data-note-media-actions='true']")) {
        clearActiveMediaHideTimer();
        return;
      }
      if (target.closest("img,video,audio")) {
        clearActiveMediaHideTimer();
        return;
      }
      scheduleActiveMediaHide();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [activeMedia]);

  useEffect(() => {
    const handleSelectionChange = () => {
      if (!onSelectionChange || editable) return;

      const preview = previewRef.current;
      const selection = window.getSelection();
      if (!preview || !selection || selection.rangeCount === 0) {
        onSelectionChange("");
        return;
      }

      const anchorNode = selection.anchorNode;
      if (!anchorNode || !preview.contains(anchorNode)) {
        onSelectionChange("");
        return;
      }

      onSelectionChange(selection.toString().trim());
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [editable, onSelectionChange]);

  const syncTextareaSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    selectionRef.current = {
      start: textarea.selectionStart ?? 0,
      end: textarea.selectionEnd ?? 0,
    };
    onSelectionChange?.(textarea.value.slice(selectionRef.current.start, selectionRef.current.end).trim());
  };

  const applyTextareaMutation = (nextValue: string, nextSelection: TextSelection) => {
    onBodyChange(nextValue);
    selectionRef.current = nextSelection;
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextSelection.start, nextSelection.end);
    });
  };

  const focusTextareaRange = (start: number, end: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const clampedStart = Math.max(0, Math.min(start, textarea.value.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, textarea.value.length));
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight || "28") || 28;
    const linesBefore = textarea.value.slice(0, clampedStart).split("\n").length - 1;
    textarea.focus();
    textarea.setSelectionRange(clampedStart, clampedEnd);
    textarea.scrollTop = Math.max(linesBefore * lineHeight - lineHeight * 2, 0);
  };

  const handlePreviewClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (editable) return;
    revealEditButton();

    const media = extractEmbeddedMedia(event.target);
    if (media) {
      clearActiveMediaHideTimer();
      const preview = previewRef.current;
      const mediaElement = event.target instanceof HTMLElement ? event.target.closest("img,video,audio") : null;
      if (preview && mediaElement instanceof HTMLElement) {
        const previewRect = preview.getBoundingClientRect();
        const mediaRect = mediaElement.getBoundingClientRect();
        setActiveMedia({
          ...media,
          x: Math.max(0, mediaRect.right - previewRect.left - 108),
          y: Math.max(0, mediaRect.top - previewRect.top + 6),
        });
      }
      return;
    }

    const line = (event.target as HTMLElement | null)?.closest("p, h1, h2, h3, h4, h5, h6, blockquote, li");
    if (!line) return;

    const key = `${line.tagName}:${line.textContent?.trim() ?? ""}:${line.getBoundingClientRect().top.toFixed(0)}`;
    const now = Date.now();
    const current = lineTapRef.current;
    if (current.key === key && now - current.startedAt <= 3000) {
      current.count += 1;
    } else {
      current.key = key;
      current.count = 1;
      current.startedAt = now;
    }

    if (current.count >= 4) {
      current.key = null;
      current.count = 0;
      current.startedAt = 0;
      onRequestEdit?.();
    }
  };

  const handlePreviewPlay = (event: SyntheticEvent<HTMLElement>) => {
    if (editable) return;
    const media = extractEmbeddedMedia(event.target);
    if (!media || media.kind !== "audio") return;
    clearActiveMediaHideTimer();
    const preview = previewRef.current;
    const mediaElement = event.target instanceof HTMLElement ? event.target.closest("audio") : null;
    if (preview && mediaElement instanceof HTMLElement) {
      const previewRect = preview.getBoundingClientRect();
      const mediaRect = mediaElement.getBoundingClientRect();
      setActiveMedia({
        ...media,
        x: Math.max(0, mediaRect.right - previewRect.left - 64),
        y: Math.max(0, mediaRect.top - previewRect.top + 6),
      });
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (editable) {
          textareaRef.current?.focus();
          return;
        }
        titleInputRef.current?.focus();
      },
      focusRange: (start, end) => {
        if (!editable) return;
        window.requestAnimationFrame(() => focusTextareaRange(start, end));
      },
      insertAsset: (asset, position = "cursor") => {
        if (!editable) return;
        const snippet = assetToMarkdown(asset);
        const value = bodyMarkdown;
        if (position === "top") {
          applyTextareaMutation(`${snippet}\n\n${value}`.trim(), { start: 0, end: 0 });
          return;
        }

        const selection = selectionRef.current;
        const start = Math.min(selection.start, selection.end);
        const end = Math.max(selection.start, selection.end);
        const spacerBefore = start > 0 && !value.slice(0, start).endsWith("\n\n") ? "\n\n" : "";
        const spacerAfter = end < value.length && !value.slice(end).startsWith("\n\n") ? "\n\n" : "";
        const inserted = `${spacerBefore}${snippet}${spacerAfter}`;
        const nextValue = `${value.slice(0, start)}${inserted}${value.slice(end)}`;
        const caret = start + inserted.length;
        applyTextareaMutation(nextValue, { start: caret, end: caret });
      },
      runCommand: (command) => {
        if (!editable) return;
        const next = applyCommand(bodyMarkdown, selectionRef.current, command);
        applyTextareaMutation(next.value, next.selection);
      },
    }),
    [bodyMarkdown, editable],
  );

  return (
    <div className="relative min-h-[calc(100vh-4rem)] bg-[linear-gradient(180deg,rgba(255,251,244,0.9),rgba(255,255,255,0.96))] px-[5px] pb-10 pt-[5px]">
      <section className="overflow-visible bg-transparent">
        <div className="flex items-start justify-between gap-3 px-[5px] py-[5px]">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-ink/45">
              {editable ? "Markdown editor" : "Rendered note"}
            </div>
            {editable ? (
              <input
                className="mt-2 w-full bg-transparent font-display text-3xl text-ink outline-none sm:text-4xl"
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder="Untitled note"
                ref={titleInputRef}
                value={title}
              />
            ) : (
              <button
                className="mt-2 block w-full truncate bg-transparent text-left font-display text-3xl text-ink outline-none sm:text-4xl"
                onClick={handlePreviewClick}
                type="button"
              >
                {title || "Untitled note"}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">{topRight}</div>
        </div>

        {overlay ? <div className="bg-[#fffbf3]">{overlay}</div> : null}
        {inlineNotice ? <div className="px-[5px] py-[5px]">{inlineNotice}</div> : null}

        <div className="px-[5px] py-[5px]">
          {editable ? (
            <div className="grid gap-3">
              <div className={`grid gap-3 ${mediaTagPreviews.length > 0 ? "lg:grid-cols-[minmax(0,1fr)_minmax(220px,30%)]" : ""}`}>
                <textarea
                  className="min-h-[34rem] w-full resize-none bg-transparent px-[5px] py-[5px] font-mono text-[15px] leading-7 text-ink outline-none"
                  onChange={(event) => onBodyChange(event.target.value)}
                  onKeyUp={syncTextareaSelection}
                  onMouseUp={syncTextareaSelection}
                  onSelect={syncTextareaSelection}
                  placeholder="Write in markdown..."
                  ref={textareaRef}
                  value={bodyMarkdown}
                />
                {mediaTagPreviews.length > 0 ? (
                  <div className="grid content-start gap-3">
                    {mediaTagPreviews.map((preview) => (
                      <div className="flex items-start justify-between gap-3 rounded-[16px] border border-ink/10 bg-white/80 p-3" key={`${preview.kind}:${preview.src}:${preview.tagText}`}>
                        <code className="w-1/2 break-all font-mono text-[11px] leading-5 text-ink/70">{preview.tagText}</code>
                        <div className="w-[30%] min-w-[90px] overflow-hidden rounded-[12px] border border-ink/10 bg-mist/60">
                          {preview.kind === "image" ? (
                            <img alt="" className="h-20 w-full object-cover" src={preview.src} />
                          ) : (
                            <video className="h-20 w-full object-cover" controls muted playsInline src={preview.src} />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="px-[5px] py-[5px] text-sm text-ink/45">
                Markdown is saved directly. Images render from markdown syntax or inserted media blocks. Audio and video render as embedded players.
              </div>
              <div aria-hidden="true" className="h-[110vh]" />
            </div>
          ) : (
            <div className="relative">
              <div
                className="markdown-preview min-h-[34rem] cursor-text"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
                onClick={handlePreviewClick}
                onPlay={handlePreviewPlay}
                ref={previewRef}
              />
              <div aria-hidden="true" className="h-[110vh]" />
              {activeMedia ? (
                <div
                  className="absolute z-20 flex items-center gap-2 rounded-full bg-white/96 px-2 py-1 shadow-[0_12px_28px_rgba(15,23,42,0.14)]"
                  data-note-media-actions="true"
                  style={{ left: activeMedia.x, top: activeMedia.y }}
                >
                  {activeMedia.kind !== "audio" ? (
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                      onClick={() => {
                        clearActiveMediaHideTimer();
                        setViewerMedia(activeMedia);
                      }}
                      title="Zoom"
                      type="button"
                    >
                      <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <path d="M14 4h6v6M10 20H4v-6M20 10V4h-6M4 14v6h6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                      </svg>
                    </button>
                  ) : null}
                  {activeMedia.assetUrl.includes("/api/proxy/media/") || activeMedia.assetUrl.includes("/v1/media/") ? (
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                      onClick={() => {
                        clearActiveMediaHideTimer();
                        onAddMediaToAi?.(activeMedia);
                      }}
                      title="Add to AI"
                      type="button"
                    >
                      <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
      {!editable && editButtonVisible ? (
        <button
          className="fixed right-4 top-4 z-40 rounded-full border border-ink bg-ink px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition hover:bg-ink/90"
          onClick={() => onRequestEdit?.()}
          type="button"
        >
          Edit
        </button>
      ) : null}
      {viewerMedia ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="relative max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-[20px] bg-[#fffdf8] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0 truncate text-sm font-medium text-ink">{viewerMedia.fileName}</div>
              <button
                className="flex h-9 w-9 items-center justify-center rounded-full border border-ink/10 bg-white text-ink transition hover:border-ink/20 hover:bg-mist"
                onClick={() => setViewerMedia(null)}
                type="button"
              >
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
            <div className="flex max-h-[calc(90vh-4rem)] items-center justify-center overflow-auto">
              {viewerMedia.kind === "image" ? (
                <img alt={viewerMedia.fileName} className="max-h-[80vh] max-w-full object-contain" src={viewerMedia.previewUrl} />
              ) : (
                <video className="max-h-[80vh] max-w-full" controls src={viewerMedia.previewUrl} />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

RichEditor.displayName = "RichEditor";
