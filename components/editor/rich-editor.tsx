"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";

import type { EditorCommand } from "@/lib/editor/commands";
import { assetToMarkdown } from "@/lib/editor/media";
import { ensureTrailingNewlines, markdownToHtml } from "@/lib/editor/markdown";
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
  onRevealEditButton?: () => void;
  onNoteInteract?: () => void;
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

type PreviewSelectionSnapshot = {
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
  endIndex: number;
  kind: "image" | "video";
  matchIndex: number;
  tagText: string;
  src: string;
};

const EDITOR_PREVIEW_VERTICAL_GAP_PX = 8;
const EDITOR_PREVIEW_SIZE_PX = 200;

function extractMediaTagPreviews(value: string) {
  const previews: MediaTagPreview[] = [];
  const tagPattern = /<(img|video)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/video>)/gi;

  for (const match of value.matchAll(tagPattern)) {
    const rawTag = match[0] ?? "";
    const tagText = rawTag.trim();
    const srcMatch = rawTag.match(/\ssrc=(?:"([^"]+)"|'([^']+)')/i);
    const src = srcMatch?.[1] || srcMatch?.[2] || "";
    const kind = /^<video\b/i.test(rawTag) ? "video" : "image";
    if (!src) continue;
    const matchIndex = match.index ?? 0;
    previews.push({
      endIndex: matchIndex + rawTag.length,
      kind,
      matchIndex,
      tagText,
      src,
    });
  }

  return previews;
}

function measureMediaPreviewTops(textarea: HTMLTextAreaElement, value: string, previews: MediaTagPreview[]) {
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const markers: Array<{ matchIndex: number; element: HTMLSpanElement }> = [];

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.left = "-9999px";
  mirror.style.top = "0";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.boxSizing = computed.boxSizing;
  mirror.style.paddingTop = computed.paddingTop;
  mirror.style.paddingRight = computed.paddingRight;
  mirror.style.paddingBottom = computed.paddingBottom;
  mirror.style.paddingLeft = computed.paddingLeft;
  mirror.style.borderTopWidth = computed.borderTopWidth;
  mirror.style.borderRightWidth = computed.borderRightWidth;
  mirror.style.borderBottomWidth = computed.borderBottomWidth;
  mirror.style.borderLeftWidth = computed.borderLeftWidth;
  mirror.style.fontFamily = computed.fontFamily;
  mirror.style.fontSize = computed.fontSize;
  mirror.style.fontStyle = computed.fontStyle;
  mirror.style.fontVariant = computed.fontVariant;
  mirror.style.fontWeight = computed.fontWeight;
  mirror.style.letterSpacing = computed.letterSpacing;
  mirror.style.lineHeight = computed.lineHeight;
  mirror.style.textAlign = computed.textAlign;
  mirror.style.textIndent = computed.textIndent;
  mirror.style.textTransform = computed.textTransform;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.wordBreak = computed.wordBreak;
  mirror.style.wordSpacing = computed.wordSpacing;
  mirror.style.tabSize = computed.tabSize;

  let cursor = 0;
  for (const preview of previews) {
    mirror.appendChild(document.createTextNode(value.slice(cursor, preview.matchIndex)));
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    markers.push({ matchIndex: preview.matchIndex, element: marker });
    cursor = preview.matchIndex;
  }
  mirror.appendChild(document.createTextNode(value.slice(cursor)));

  document.body.appendChild(mirror);
  const slotsByLine = new Map<number, number>();
  const tops: Record<number, number> = {};

  for (const marker of markers) {
    const top = marker.element.offsetTop;
    const lineKey = Math.round(top / (Number.parseFloat(computed.lineHeight || "28") || 28));
    const slot = slotsByLine.get(lineKey) ?? 0;
    slotsByLine.set(lineKey, slot + 1);
    tops[marker.matchIndex] = top + slot * (EDITOR_PREVIEW_SIZE_PX + EDITOR_PREVIEW_VERTICAL_GAP_PX);
  }

  mirror.remove();
  return tops;
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
  onRevealEditButton,
  onNoteInteract,
  onAddMediaToAi,
  inlineNotice,
  overlay,
  topRight,
}, ref) {
  const titleInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<TextSelection>({ start: 0, end: 0 });
  const activeMediaHideTimerRef = useRef<number | null>(null);
  const previewSelectionTimerRef = useRef<number | null>(null);
  const previewPointerSelectingRef = useRef(false);
  const previewSelectionJustFinishedRef = useRef(false);
  const previewPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastPreviewSelectionRef = useRef("");
  const lineTapRef = useRef<{ key: string | null; count: number; startedAt: number }>({
    key: null,
    count: 0,
    startedAt: 0,
  });
  const [activeMedia, setActiveMedia] = useState<(EmbeddedMedia & { x: number; y: number }) | null>(null);
  const [textareaScrollTop, setTextareaScrollTop] = useState(0);
  const [mediaPreviewTops, setMediaPreviewTops] = useState<Record<number, number>>({});
  const [viewerMedia, setViewerMedia] = useState<EmbeddedMedia | null>(null);
  const noteBodyMarkdown = useMemo(() => ensureTrailingNewlines(bodyMarkdown), [bodyMarkdown]);
  const previewHtml = useMemo(() => markdownToHtml(noteBodyMarkdown), [noteBodyMarkdown]);
  const mediaTagPreviews = useMemo(() => extractMediaTagPreviews(noteBodyMarkdown), [noteBodyMarkdown]);

  const resizeTextareaToContent = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
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

  const clearPreviewSelectionTimer = () => {
    if (previewSelectionTimerRef.current) {
      window.clearTimeout(previewSelectionTimerRef.current);
      previewSelectionTimerRef.current = null;
    }
  };

  const readPreviewSelection = () => {
    const preview = previewRef.current;
    const selection = window.getSelection();
    if (!preview || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return "";
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode || !preview.contains(anchorNode) || !preview.contains(focusNode)) {
      return "";
    }

    return selection.toString().trim();
  };

  const getPreviewTextOffset = (container: Node, offset: number) => {
    const preview = previewRef.current;
    if (!preview || !preview.contains(container)) {
      return null;
    }

    const range = document.createRange();
    range.selectNodeContents(preview);
    try {
      range.setEnd(container, offset);
    } catch {
      range.detach();
      return null;
    }

    const textOffset = range.toString().length;
    range.detach();
    return textOffset;
  };

  const findPreviewTextPosition = (targetOffset: number) => {
    const preview = previewRef.current;
    if (!preview) return null;

    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    let traversed = 0;
    let node = walker.nextNode();
    while (node) {
      const textLength = node.textContent?.length ?? 0;
      if (traversed + textLength >= targetOffset) {
        return {
          node,
          offset: Math.max(0, Math.min(targetOffset - traversed, textLength)),
        };
      }
      traversed += textLength;
      node = walker.nextNode();
    }

    return preview.lastChild ? { node: preview.lastChild, offset: preview.lastChild.textContent?.length ?? 0 } : null;
  };

  const capturePreviewSelectionSnapshot = (): PreviewSelectionSnapshot | null => {
    const preview = previewRef.current;
    const selection = window.getSelection();
    if (!preview || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!preview.contains(range.startContainer) || !preview.contains(range.endContainer)) {
      return null;
    }

    const start = getPreviewTextOffset(range.startContainer, range.startOffset);
    const end = getPreviewTextOffset(range.endContainer, range.endOffset);
    if (start === null || end === null || start === end) {
      return null;
    }

    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
  };

  const restorePreviewSelectionSnapshot = (snapshot: PreviewSelectionSnapshot | null) => {
    if (!snapshot) return;

    const restore = () => {
      const preview = previewRef.current;
      const selection = window.getSelection();
      if (!preview || !selection) return;
      const start = findPreviewTextPosition(snapshot.start);
      const end = findPreviewTextPosition(snapshot.end);
      if (!start || !end) return;

      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    window.requestAnimationFrame(() => {
      restore();
      window.setTimeout(restore, 0);
    });
  };

  const publishPreviewSelection = () => {
    if (!onSelectionChange || editable) return;
    const nextSelection = readPreviewSelection();
    if (nextSelection === lastPreviewSelectionRef.current) return;
    const selectedSnapshot = nextSelection ? capturePreviewSelectionSnapshot() : null;
    lastPreviewSelectionRef.current = nextSelection;
    onSelectionChange(nextSelection);
    restorePreviewSelectionSnapshot(selectedSnapshot);
  };

  const revealEditButton = () => {
    if (editable || typeof window === "undefined") return;
    onRevealEditButton?.();
  };

  useEffect(
    () => () => {
      clearActiveMediaHideTimer();
      clearPreviewSelectionTimer();
    },
    [],
  );

  useEffect(() => {
    lastPreviewSelectionRef.current = "";
    previewPointerSelectingRef.current = false;
    clearPreviewSelectionTimer();

    if (!editable) {
      selectionRef.current = { start: 0, end: 0 };
      return;
    }
    clearActiveMediaHideTimer();
    setActiveMedia(null);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      resizeTextareaToContent();
      textarea?.focus();
      setTextareaScrollTop(textarea?.scrollTop ?? 0);
    });
  }, [editable]);

  useLayoutEffect(() => {
    if (!editable) return;
    resizeTextareaToContent();
  }, [noteBodyMarkdown, editable]);

  useEffect(() => {
    if (!editable) return;
    window.addEventListener("resize", resizeTextareaToContent);
    return () => window.removeEventListener("resize", resizeTextareaToContent);
  }, [editable]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!editable || !textarea || mediaTagPreviews.length === 0) {
      setMediaPreviewTops({});
      return;
    }

    const updatePreviewTops = () => {
      setMediaPreviewTops(measureMediaPreviewTops(textarea, noteBodyMarkdown, mediaTagPreviews));
      setTextareaScrollTop(textarea.scrollTop);
    };

    updatePreviewTops();
    const resizeObserver = new ResizeObserver(updatePreviewTops);
    resizeObserver.observe(textarea);
    window.addEventListener("resize", updatePreviewTops);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePreviewTops);
    };
  }, [noteBodyMarkdown, editable, mediaTagPreviews]);

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

      if (previewPointerSelectingRef.current) {
        return;
      }

      clearPreviewSelectionTimer();
      previewSelectionTimerRef.current = window.setTimeout(() => {
        previewSelectionTimerRef.current = null;
        publishPreviewSelection();
      }, 80);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!previewPointerSelectingRef.current) return;
      previewPointerSelectingRef.current = false;
      const start = previewPointerStartRef.current;
      previewPointerStartRef.current = null;
      const moved =
        start ? Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4 : false;
      const hasSelection = Boolean(readPreviewSelection());
      previewSelectionJustFinishedRef.current = moved || hasSelection;
      clearPreviewSelectionTimer();
      previewSelectionTimerRef.current = window.setTimeout(() => {
        previewSelectionTimerRef.current = null;
        publishPreviewSelection();
        window.setTimeout(() => {
          previewSelectionJustFinishedRef.current = false;
        }, 0);
      }, 0);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerUp, true);
    return () => {
      clearPreviewSelectionTimer();
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointercancel", handlePointerUp, true);
    };
  }, [editable, onSelectionChange]);

  const handlePreviewPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (editable) return;
    previewPointerSelectingRef.current = true;
    previewSelectionJustFinishedRef.current = false;
    previewPointerStartRef.current = { x: event.clientX, y: event.clientY };
  };

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

  const updateMediaTagText = (preview: MediaTagPreview, nextTagText: string) => {
    const nextValue = `${noteBodyMarkdown.slice(0, preview.matchIndex)}${nextTagText}${noteBodyMarkdown.slice(preview.endIndex)}`;
    const caret = preview.matchIndex + nextTagText.length;
    onBodyChange(nextValue);
    selectionRef.current = { start: caret, end: caret };
  };

  const syncMediaTagSelection = (preview: MediaTagPreview, target: HTMLTextAreaElement) => {
    selectionRef.current = {
      start: preview.matchIndex + (target.selectionStart ?? 0),
      end: preview.matchIndex + (target.selectionEnd ?? 0),
    };
    onSelectionChange?.(target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0).trim());
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
    textarea.scrollTop = 0;
    setTextareaScrollTop(0);
    window.scrollTo({
      top: Math.max(textarea.getBoundingClientRect().top + window.scrollY + linesBefore * lineHeight - 96, 0),
      behavior: "smooth",
    });
  };

  const handlePreviewClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (editable) return;
    if (previewSelectionJustFinishedRef.current || readPreviewSelection()) {
      return;
    }
    onNoteInteract?.();
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
        const value = noteBodyMarkdown;
        if (position === "top") {
          applyTextareaMutation(`${snippet}\n\n${value}`, { start: 0, end: 0 });
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
        const next = applyCommand(noteBodyMarkdown, selectionRef.current, command);
        applyTextareaMutation(next.value, next.selection);
      },
    }),
    [noteBodyMarkdown, editable],
  );

  return (
    <div className="relative min-h-[calc(100vh-4rem)] bg-[linear-gradient(180deg,rgba(255,251,244,0.9),rgba(255,255,255,0.96))] px-[5px] pb-10 pt-[5px]">
      <section className="overflow-visible bg-transparent">
        <div className="flex items-start justify-between gap-3 px-[5px] py-[5px]">
          <div className="min-w-0 flex-1">
            {editable ? (
              <input
                className="w-full bg-transparent font-display text-3xl text-ink outline-none sm:text-4xl"
                onChange={(event) => onTitleChange(event.target.value)}
                onFocus={onNoteInteract}
                onPointerDown={onNoteInteract}
                placeholder="Untitled"
                ref={titleInputRef}
                value={title}
              />
            ) : (
              <button
                className="block w-full truncate bg-transparent text-left font-display text-3xl text-ink outline-none sm:text-4xl"
                onClick={handlePreviewClick}
                onFocus={onNoteInteract}
                type="button"
              >
                {title || "Untitled"}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {topRight}
          </div>
        </div>

        {overlay ? <div className="bg-[#fffbf3]">{overlay}</div> : null}
        {inlineNotice ? (
          <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3 sm:bottom-6">
            <div className="pointer-events-auto w-full max-w-[34rem]">{inlineNotice}</div>
          </div>
        ) : null}

        <div className="px-[5px] py-[5px]">
          {editable ? (
            <div className="grid gap-3">
              <div className="relative">
                <textarea
                  className="min-h-[34rem] w-full resize-none overflow-hidden bg-transparent px-[5px] py-[5px] text-[15px] leading-7 text-ink outline-none"
                  onChange={(event) => onBodyChange(event.target.value)}
                  onFocus={onNoteInteract}
                  onKeyUp={syncTextareaSelection}
                  onMouseUp={syncTextareaSelection}
                  onPointerDown={onNoteInteract}
                  onScroll={(event) => setTextareaScrollTop(event.currentTarget.scrollTop)}
                  onSelect={syncTextareaSelection}
                  placeholder="Write in markdown..."
                  ref={textareaRef}
                  value={noteBodyMarkdown}
                />
                {mediaTagPreviews.length > 0 ? (
                  <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="Media tag previews">
                    {mediaTagPreviews.map((preview) => (
                      <div
                        className="pointer-events-auto absolute left-[5px] right-[5px] grid min-h-[200px] grid-cols-[200px_minmax(0,1fr)] items-start gap-3 bg-[#fffbf4]"
                        key={`${preview.kind}:${preview.src}:${preview.matchIndex}`}
                        style={{
                          top: (mediaPreviewTops[preview.matchIndex] ?? 0) - textareaScrollTop,
                        }}
                        title={preview.tagText}
                      >
                        <div className="flex h-[200px] w-[200px] items-start justify-start overflow-hidden">
                          {preview.kind === "image" ? (
                            <img alt="" className="max-h-[200px] max-w-[200px] rounded-xl object-cover" src={preview.src} />
                          ) : (
                            <video className="max-h-[200px] max-w-[200px] rounded-xl bg-black" controls muted playsInline src={preview.src} />
                          )}
                        </div>
                        <textarea
                          aria-label="Media tag"
                          className="hide-scrollbar min-h-[200px] w-full resize-none bg-transparent px-[5px] py-[5px] text-[15px] leading-7 text-ink outline-none"
                          onChange={(event) => updateMediaTagText(preview, event.target.value)}
                          onFocus={onNoteInteract}
                          onKeyUp={(event) => syncMediaTagSelection(preview, event.currentTarget)}
                          onMouseUp={(event) => syncMediaTagSelection(preview, event.currentTarget)}
                          onPointerDown={onNoteInteract}
                          onSelect={(event) => syncMediaTagSelection(preview, event.currentTarget)}
                          spellCheck={false}
                          value={preview.tagText}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div aria-hidden="true" className="h-[90vh]" />
            </div>
          ) : (
            <div className="relative">
              <div
                className="markdown-preview min-h-[34rem] cursor-text"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
                onClick={handlePreviewClick}
                onPointerDown={handlePreviewPointerDown}
                onPlay={handlePreviewPlay}
                ref={previewRef}
              />
              <div aria-hidden="true" className="h-[90vh]" />
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
