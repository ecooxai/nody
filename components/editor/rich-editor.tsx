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
  scrollToLine: (lineNumber: number, position?: "top" | "middle" | "bottom") => void;
  scrollByPixels: (pixels: number) => void;
  findText: (query: string, occurrence?: "first" | "next" | "previous") => void;
  insertAsset: (asset: DocumentAsset, position?: "cursor" | "top") => void;
  insertAssetAtLine: (asset: DocumentAsset, lineNumber: number) => void;
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

type LineTopMap = Record<number, number>;

type LineLayout = {
  heights: number[];
  tops: LineTopMap;
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
  kind: "image" | "audio" | "video";
};

const EDITOR_PREVIEW_VERTICAL_GAP_PX = 8;
const EDITOR_PREVIEW_SIZE_PX = 200;
const EDITOR_TEXT_LINE_HEIGHT_PX = 28;
const EDITOR_AUDIO_PREVIEW_HEIGHT_PX = 48;

function compactMediaTags(value: string) {
  return value.replace(/<img\b[\s\S]*?>|<(audio|video)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/\1>)/gi, (match) =>
    match.replace(/\s+/g, " ").trim(),
  );
}

function extractMediaTagPreviews(value: string) {
  const previews: MediaTagPreview[] = [];
  const tagPattern = /<img\b[\s\S]*?>|<(audio|video)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/\1>)/gi;

  for (const match of value.matchAll(tagPattern)) {
    const rawTag = match[0] ?? "";
    const kind = /^<video\b/i.test(rawTag) ? "video" : /^<audio\b/i.test(rawTag) ? "audio" : "image";
    previews.push({ kind });
  }

  return previews;
}

function mediaPreviewVisualHeight(kind: MediaTagPreview["kind"]) {
  return kind === "audio" ? EDITOR_AUDIO_PREVIEW_HEIGHT_PX : EDITOR_PREVIEW_SIZE_PX;
}

function mediaLineExtraLineCount(line: string, lineHeight = EDITOR_TEXT_LINE_HEIGHT_PX) {
  const media = extractMediaTagPreviews(line);
  if (media.length === 0) return 0;

  const mediaHeight = media.reduce(
    (height, preview) => height + mediaPreviewVisualHeight(preview.kind) + EDITOR_PREVIEW_VERTICAL_GAP_PX,
    0,
  );
  return Math.max(0, Math.ceil((mediaHeight - lineHeight) / lineHeight));
}

function cssPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sameLineLayout(left: LineLayout, right: LineLayout) {
  if (left.heights.length !== right.heights.length) return false;

  for (let index = 0; index < left.heights.length; index += 1) {
    if (left.heights[index] !== right.heights[index]) return false;
    const lineNumber = index + 1;
    if (left.tops[lineNumber] !== right.tops[lineNumber]) return false;
  }

  return true;
}

function measureTextareaLineLayout(textarea: HTMLTextAreaElement, value: string): LineLayout {
  const computed = window.getComputedStyle(textarea);
  const lineHeight = cssPixelValue(computed.lineHeight, EDITOR_TEXT_LINE_HEIGHT_PX);
  const mirror = document.createElement("div");
  const markers: Array<{ lineNumber: number; element: HTMLSpanElement }> = [];

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
  mirror.style.overflowWrap = computed.overflowWrap;
  mirror.style.wordBreak = computed.wordBreak;
  mirror.style.wordSpacing = computed.wordSpacing;
  mirror.style.tabSize = computed.tabSize;

  const lines = value.split("\n");
  for (const [index, line] of lines.entries()) {
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    markers.push({ lineNumber: index + 1, element: marker });
    mirror.appendChild(document.createTextNode(line));
    if (index < lines.length - 1) {
      mirror.appendChild(document.createTextNode("\n"));
    }
  }

  document.body.appendChild(mirror);

  const markerTops = markers.map((marker) => marker.element.offsetTop);
  const tops: LineTopMap = {};
  const heights = markerTops.map((top, index) => {
    const lineNumber = index + 1;
    tops[lineNumber] = top;
    const nextTop = markerTops[index + 1];
    return Math.max(lineHeight, nextTop === undefined ? lineHeight : nextTop - top);
  });

  mirror.remove();

  return { heights, tops };
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

function formatFileSize(bytes: number | null) {
  if (bytes === null) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function absoluteMediaUrl(url: string) {
  if (typeof window === "undefined") return url;
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

function findLineStartOffset(value: string, lineNumber: number) {
  const targetLine = Math.max(1, Math.floor(lineNumber));
  if (targetLine <= 1) return 0;

  let line = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n") continue;
    line += 1;
    if (line === targetLine) {
      return index + 1;
    }
  }

  return value.length;
}

function insertBlockAtLine(value: string, block: string, lineNumber: number) {
  const start = findLineStartOffset(value, lineNumber);
  const before = value.slice(0, start);
  const after = value.slice(start);
  const spacerBefore = before && !before.endsWith("\n") ? "\n" : "";
  const spacerAfter = after ? (block.endsWith("\n\n") ? "" : "\n\n") : value.endsWith("\n") ? "\n" : "";
  const inserted = `${spacerBefore}${block}${spacerAfter}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
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
  const bodyChangeTimerRef = useRef<number | null>(null);
  const lastPublishedBodyRef = useRef(bodyMarkdown);
  const viewerCopyTimerRef = useRef<number | null>(null);
  const editorMeasureWidthRef = useRef(0);
  const lineTapRef = useRef<{ key: string | null; count: number; startedAt: number }>({
    key: null,
    count: 0,
    startedAt: 0,
  });
  const [activeMedia, setActiveMedia] = useState<(EmbeddedMedia & { x: number; y: number }) | null>(null);
  const [textareaScrollTop, setTextareaScrollTop] = useState(0);
  const [editorLineLayout, setEditorLineLayout] = useState<LineLayout>({ heights: [], tops: {} });
  const [lineStartTops, setLineStartTops] = useState<LineTopMap>({});
  const [viewerMedia, setViewerMedia] = useState<EmbeddedMedia | null>(null);
  const [viewerImageInfo, setViewerImageInfo] = useState<{
    copied: boolean;
    fileSize: number | null;
    height: number | null;
    loadingSize: boolean;
    width: number | null;
  }>({ copied: false, fileSize: null, height: null, loadingSize: false, width: null });
  const [bodyDraft, setBodyDraft] = useState(() => compactMediaTags(bodyMarkdown));
  const bodyDraftRef = useRef(compactMediaTags(bodyMarkdown));
  const noteBodyMarkdown = useMemo(() => ensureTrailingNewlines(bodyDraft), [bodyDraft]);
  const previewHtml = useMemo(() => (editable ? "" : markdownToHtml(noteBodyMarkdown)), [editable, noteBodyMarkdown]);
  const viewerLineHeights = useMemo(
    () => noteBodyMarkdown.split("\n").map((line) => (mediaLineExtraLineCount(line) + 1) * EDITOR_TEXT_LINE_HEIGHT_PX),
    [noteBodyMarkdown],
  );
  const lineNumbers = useMemo(() => {
    const lineCount = Math.max(1, noteBodyMarkdown.split("\n").length);
    return Array.from({ length: lineCount }, (_, index) => index + 1);
  }, [noteBodyMarkdown]);
  const lineNumberFontClass = lineNumbers.length >= 1000 ? "text-[8px]" : lineNumbers.length >= 100 ? "text-[9px]" : "text-[10px]";

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

  const clearBodyChangeTimer = () => {
    if (bodyChangeTimerRef.current) {
      window.clearTimeout(bodyChangeTimerRef.current);
      bodyChangeTimerRef.current = null;
    }
  };

  const clearViewerCopyTimer = () => {
    if (viewerCopyTimerRef.current) {
      window.clearTimeout(viewerCopyTimerRef.current);
      viewerCopyTimerRef.current = null;
    }
  };

  const publishBodyChange = (value: string) => {
    const compactedValue = compactMediaTags(value);
    clearBodyChangeTimer();
    if (compactedValue !== bodyDraftRef.current) {
      bodyDraftRef.current = compactedValue;
      setBodyDraft(compactedValue);
    }
    if (compactedValue === lastPublishedBodyRef.current) return;
    lastPublishedBodyRef.current = compactedValue;
    bodyDraftRef.current = compactedValue;
    onBodyChange(compactedValue);
  };

  const scheduleBodyChange = (value: string) => {
    if (value === lastPublishedBodyRef.current) return;
    clearBodyChangeTimer();
    bodyChangeTimerRef.current = window.setTimeout(() => {
      bodyChangeTimerRef.current = null;
      publishBodyChange(value);
    }, 350);
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

  const measureLineStartTops = (preview: HTMLElement, value: string) => {
    const computed = window.getComputedStyle(preview);
    const mirror = document.createElement("div");
    const markers: Array<{ lineNumber: number; element: HTMLSpanElement }> = [];

    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.left = "-9999px";
    mirror.style.top = "0";
    mirror.style.width = `${preview.clientWidth}px`;
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

    const lines = value.split("\n");
    for (const [index, line] of lines.entries()) {
      const marker = document.createElement("span");
      marker.textContent = "\u200b";
      mirror.appendChild(marker);
      markers.push({ lineNumber: index + 1, element: marker });
      mirror.appendChild(document.createTextNode(`${line}${"\n".repeat(mediaLineExtraLineCount(line) + 1)}`));
    }

    document.body.appendChild(mirror);
    const tops: LineTopMap = {};
    for (const marker of markers) {
      tops[marker.lineNumber] = marker.element.offsetTop;
    }
    mirror.remove();
    return tops;
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

  const updateEditorLineLayout = () => {
    const textarea = textareaRef.current;
    if (!editable || !textarea) {
      editorMeasureWidthRef.current = 0;
      setEditorLineLayout((current) => (current.heights.length === 0 ? current : { heights: [], tops: {} }));
      return;
    }

    resizeTextareaToContent();
    editorMeasureWidthRef.current = textarea.clientWidth;
    const nextLayout = measureTextareaLineLayout(textarea, noteBodyMarkdown);
    setEditorLineLayout((current) => (sameLineLayout(current, nextLayout) ? current : nextLayout));
    setTextareaScrollTop(textarea.scrollTop);
  };

  useEffect(
    () => () => {
      clearActiveMediaHideTimer();
      clearPreviewSelectionTimer();
      clearBodyChangeTimer();
      clearViewerCopyTimer();
      if (bodyDraftRef.current !== lastPublishedBodyRef.current) {
        onBodyChange(compactMediaTags(bodyDraftRef.current));
      }
    },
    [],
  );

  useEffect(() => {
    const compactedBodyMarkdown = compactMediaTags(bodyMarkdown);
    if (compactedBodyMarkdown !== bodyMarkdown) {
      lastPublishedBodyRef.current = compactedBodyMarkdown;
      bodyDraftRef.current = compactedBodyMarkdown;
      setBodyDraft(compactedBodyMarkdown);
      clearBodyChangeTimer();
      onBodyChange(compactedBodyMarkdown);
      return;
    }
    if (compactedBodyMarkdown === lastPublishedBodyRef.current) return;
    lastPublishedBodyRef.current = compactedBodyMarkdown;
    bodyDraftRef.current = compactedBodyMarkdown;
    setBodyDraft(compactedBodyMarkdown);
    clearBodyChangeTimer();
  }, [bodyMarkdown]);

  useEffect(() => {
    lastPreviewSelectionRef.current = "";
    previewPointerSelectingRef.current = false;
    clearPreviewSelectionTimer();

    if (!editable) {
      publishBodyChange(bodyDraft);
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

  useEffect(() => {
    clearViewerCopyTimer();
    setViewerImageInfo({ copied: false, fileSize: null, height: null, loadingSize: viewerMedia?.kind === "image", width: null });

    if (viewerMedia?.kind !== "image") return;

    const controller = new AbortController();
    fetch(viewerMedia.previewUrl, { method: "HEAD", signal: controller.signal })
      .then((response) => {
        const contentLength = response.headers.get("content-length");
        const fileSize = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
        setViewerImageInfo((current) => ({
          ...current,
          fileSize: Number.isFinite(fileSize) ? fileSize : null,
          loadingSize: false,
        }));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setViewerImageInfo((current) => ({ ...current, fileSize: null, loadingSize: false }));
      });

    return () => controller.abort();
  }, [viewerMedia?.kind, viewerMedia?.previewUrl]);

  useLayoutEffect(() => {
    updateEditorLineLayout();
  }, [noteBodyMarkdown, editable]);

  useEffect(() => {
    if (!editable) return;
    const textarea = textareaRef.current;
    const updateAfterWidthChange = () => updateEditorLineLayout();
    const resizeObserver = textarea
      ? new ResizeObserver(() => {
          if (textarea.clientWidth !== editorMeasureWidthRef.current) {
            updateEditorLineLayout();
          }
        })
      : null;

    if (resizeObserver && textarea) {
      resizeObserver.observe(textarea);
    }
    window.addEventListener("resize", updateAfterWidthChange);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateAfterWidthChange);
    };
  }, [editable, noteBodyMarkdown]);

  useLayoutEffect(() => {
    if (editable) {
      setLineStartTops({});
      return;
    }
    const preview = previewRef.current;
    if (!preview) {
      setLineStartTops({});
      return;
    }
    const updateLineTops = () => setLineStartTops(measureLineStartTops(preview, noteBodyMarkdown));
    updateLineTops();
    const resizeObserver = new ResizeObserver(updateLineTops);
    resizeObserver.observe(preview);
    window.addEventListener("resize", updateLineTops);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateLineTops);
    };
  }, [editable, noteBodyMarkdown]);

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

  const syncTextareaSelection = (target = textareaRef.current) => {
    const textarea = target;
    if (!textarea) return;
    selectionRef.current = {
      start: textarea.selectionStart ?? 0,
      end: textarea.selectionEnd ?? 0,
    };
    const noteValue = ensureTrailingNewlines(textarea.value);
    onSelectionChange?.(noteValue.slice(selectionRef.current.start, selectionRef.current.end).trim());
  };

  const handleBodyTextareaChange = (value: string) => {
    bodyDraftRef.current = value;
    setBodyDraft(value);
    scheduleBodyChange(value);
  };

  const applyTextareaMutation = (nextValue: string, nextSelection: TextSelection) => {
    bodyDraftRef.current = nextValue;
    setBodyDraft(nextValue);
    publishBodyChange(nextValue);
    selectionRef.current = nextSelection;
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextSelection.start, nextSelection.end);
    });
  };

  const getTextareaOffsetTop = (textarea: HTMLTextAreaElement, offset: number) => {
    const clampedOffset = Math.max(0, Math.min(offset, textarea.value.length));
    const lineNumber = textarea.value.slice(0, clampedOffset).split("\n").length;
    const measuredTop = editorLineLayout.tops[lineNumber];
    if (measuredTop !== undefined) return measuredTop;

    const lineHeight = cssPixelValue(window.getComputedStyle(textarea).lineHeight, EDITOR_TEXT_LINE_HEIGHT_PX);
    return (lineNumber - 1) * lineHeight;
  };

  const scrollTextareaOffsetNearTop = (offset: number) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const clampedOffset = Math.max(0, Math.min(offset, textarea.value.length));
        const offsetTop = getTextareaOffsetTop(textarea, clampedOffset);
        window.scrollTo({
          top: Math.max(textarea.getBoundingClientRect().top + window.scrollY + offsetTop - 100, 0),
          behavior: "smooth",
        });
      });
    });
  };

  const scrollTextareaOffsetToLine = (offset: number, position: "top" | "middle" | "bottom" = "top") => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const clampedOffset = Math.max(0, Math.min(offset, textarea.value.length));
        const offsetTop = getTextareaOffsetTop(textarea, clampedOffset);
        const viewportHeight = window.innerHeight;
        const positionOffset =
          position === "middle" ? viewportHeight / 2 : position === "bottom" ? viewportHeight - 140 : 96;
        window.scrollTo({
          top: Math.max(textarea.getBoundingClientRect().top + window.scrollY + offsetTop - positionOffset, 0),
          behavior: "smooth",
        });
      });
    });
  };

  const copyViewerImageUrl = async () => {
    if (!viewerMedia || viewerMedia.kind !== "image") return;
    try {
      await navigator.clipboard.writeText(absoluteMediaUrl(viewerMedia.assetUrl));
      clearViewerCopyTimer();
      setViewerImageInfo((current) => ({ ...current, copied: true }));
      viewerCopyTimerRef.current = window.setTimeout(() => {
        setViewerImageInfo((current) => ({ ...current, copied: false }));
        viewerCopyTimerRef.current = null;
      }, 1600);
    } catch {
      setViewerImageInfo((current) => ({ ...current, copied: false }));
    }
  };

  const focusTextareaRange = (start: number, end: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const clampedStart = Math.max(0, Math.min(start, textarea.value.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, textarea.value.length));
    const offsetTop = getTextareaOffsetTop(textarea, clampedStart);
    textarea.focus();
    textarea.setSelectionRange(clampedStart, clampedEnd);
    textarea.scrollTop = 0;
    setTextareaScrollTop(0);
    window.scrollTo({
      top: Math.max(textarea.getBoundingClientRect().top + window.scrollY + offsetTop - 96, 0),
      behavior: "smooth",
    });
  };

  const findTextRange = (query: string, occurrence: "first" | "next" | "previous" = "next") => {
    const textarea = textareaRef.current;
    const needle = query.trim();
    if (!needle) return;
    if (!textarea) {
      const preview = previewRef.current;
      if (!preview) return;
      const text = preview.textContent?.toLowerCase() ?? "";
      const match = text.indexOf(needle.toLowerCase());
      if (match < 0) return;
      const walker = document.createTreeWalker(preview, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let traversed = 0;
      let node = walker.nextNode();
      while (node) {
        const nodeText = node.textContent ?? "";
        const nextTraversed = traversed + nodeText.length;
        if (match >= traversed && match < nextTraversed) {
          if (node instanceof HTMLElement) {
            node.scrollIntoView({ behavior: "smooth", block: "center" });
          } else {
            (node.parentElement ?? preview).scrollIntoView({ behavior: "smooth", block: "center" });
          }
          return;
        }
        traversed = nextTraversed;
        node = walker.nextNode();
      }
      preview.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const haystack = textarea.value.toLowerCase();
    const search = needle.toLowerCase();
    const matches: Array<{ start: number; end: number }> = [];
    let index = haystack.indexOf(search);
    while (index >= 0) {
      matches.push({ start: index, end: index + search.length });
      index = haystack.indexOf(search, index + search.length);
    }
    if (matches.length === 0) return;
    const currentStart = textarea.selectionStart ?? 0;
    const currentEnd = textarea.selectionEnd ?? 0;
    const currentIndex = matches.findIndex((match) => match.start === currentStart && match.end === currentEnd);
    let targetIndex = 0;
    if (occurrence === "previous") {
      targetIndex = currentIndex > 0 ? currentIndex - 1 : matches.length - 1;
    } else if (occurrence === "next") {
      targetIndex = currentIndex >= 0 ? (currentIndex + 1) % matches.length : 0;
    }
    const target = matches[targetIndex];
    focusTextareaRange(target.start, target.end);
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
          x: Math.max(0, preview.offsetLeft + mediaRect.right - previewRect.left - 108),
          y: Math.max(0, preview.offsetTop + mediaRect.top - previewRect.top + 6),
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
        x: Math.max(0, preview.offsetLeft + mediaRect.right - previewRect.left - 64),
        y: Math.max(0, preview.offsetTop + mediaRect.top - previewRect.top + 6),
      });
    }
  };

  const renderLineNumberGutter = (scrollTop = 0, options?: { everyTenOnly?: boolean; lineHeights?: number[] }) => (
    <div
      aria-hidden="true"
      className={`hide-scrollbar overflow-hidden border-r border-ink/10 py-[5px] pr-1 text-right leading-7 text-ink/35 select-none ${lineNumberFontClass}`}
    >
      <div style={scrollTop ? { transform: `translateY(-${scrollTop}px)` } : undefined}>
        {lineNumbers.map((lineNumber) => {
          const rowHeight = options?.lineHeights?.[lineNumber - 1] ?? EDITOR_TEXT_LINE_HEIGHT_PX;
          return (
            <div className="tabular-nums" key={lineNumber} style={{ height: `${rowHeight}px`, lineHeight: `${EDITOR_TEXT_LINE_HEIGHT_PX}px` }}>
              {options?.everyTenOnly && lineNumber % 10 !== 0 ? "" : lineNumber}
            </div>
          );
        })}
      </div>
    </div>
  );

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
      scrollToLine: (lineNumber, position = "top") => {
        const textarea = textareaRef.current;
        if (!textarea) {
          const preview = previewRef.current;
          if (!preview) return;
          const line = Math.max(1, Math.floor(lineNumber));
          const top = lineStartTops[line] ?? 0;
          const viewportHeight = window.innerHeight;
          const offset = position === "middle" ? viewportHeight / 2 : position === "bottom" ? viewportHeight - 140 : 96;
          window.scrollTo({
            top: Math.max(preview.getBoundingClientRect().top + window.scrollY + top - offset, 0),
            behavior: "smooth",
          });
          return;
        }
        const lineStart = findLineStartOffset(noteBodyMarkdown, lineNumber);
        scrollTextareaOffsetToLine(lineStart, position);
      },
      scrollByPixels: (pixels) => {
        window.scrollBy({ top: pixels, behavior: "smooth" });
      },
      findText: (query, occurrence = "next") => {
        findTextRange(query, occurrence);
      },
      insertAsset: (asset, position = "cursor") => {
        if (!editable) return;
        const snippet = assetToMarkdown(asset);
        const value = noteBodyMarkdown;
        if (position === "top") {
          applyTextareaMutation(`${snippet}\n\n${value}`, { start: 0, end: 0 });
          scrollTextareaOffsetNearTop(0);
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
        scrollTextareaOffsetNearTop(start + spacerBefore.length);
      },
      insertAssetAtLine: (asset, lineNumber) => {
        if (!editable) return;
        const snippet = assetToMarkdown(asset);
        const next = insertBlockAtLine(noteBodyMarkdown, snippet, lineNumber);
        applyTextareaMutation(next.value, { start: next.caret, end: next.caret });
        scrollTextareaOffsetNearTop(findLineStartOffset(noteBodyMarkdown, lineNumber));
      },
      runCommand: (command) => {
        if (!editable) return;
        const next = applyCommand(noteBodyMarkdown, selectionRef.current, command);
        applyTextareaMutation(next.value, next.selection);
      },
    }),
    [noteBodyMarkdown, editable, lineStartTops, editorLineLayout],
  );

  return (
    <div className="relative min-h-[calc(100vh-4rem)] bg-[linear-gradient(180deg,rgba(255,251,244,0.9),rgba(255,255,255,0.96))] pr-[5px] pb-10 pt-[5px]">
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

        <div className="pr-[5px] py-[5px]">
          {editable ? (
            <div className="grid gap-3">
              <div className="relative grid grid-cols-[20px_minmax(0,1fr)]">
                {renderLineNumberGutter(textareaScrollTop, { lineHeights: editorLineLayout.heights })}
                <textarea
                  className="min-h-[34rem] w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent px-[10px] py-[5px] text-[15px] leading-7 text-ink outline-none"
                  onChange={(event) => handleBodyTextareaChange(event.target.value)}
                  onFocus={onNoteInteract}
                  onKeyUp={(event) => syncTextareaSelection(event.currentTarget)}
                  onMouseUp={(event) => syncTextareaSelection(event.currentTarget)}
                  onPointerDown={onNoteInteract}
                  onScroll={(event) => setTextareaScrollTop(event.currentTarget.scrollTop)}
                  onSelect={(event) => syncTextareaSelection(event.currentTarget)}
                  placeholder="Write in markdown..."
                  ref={textareaRef}
                  value={noteBodyMarkdown}
                  wrap="soft"
                />
              </div>
              <div aria-hidden="true" className="h-[90vh]" />
            </div>
          ) : (
            <div className="relative">
              <div className="relative grid grid-cols-[20px_minmax(0,1fr)]">
                {renderLineNumberGutter(0, { everyTenOnly: true, lineHeights: viewerLineHeights })}
                <div
                  className="markdown-preview min-h-[34rem] cursor-text px-[10px] py-[5px]"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                  onClick={handlePreviewClick}
                  onPointerDown={handlePreviewPointerDown}
                  onPlay={handlePreviewPlay}
                  ref={previewRef}
                />
              </div>
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
          <div className="relative max-h-[92vh] w-auto max-w-[94vw] overflow-auto rounded-[20px] bg-[#fffdf8] p-4">
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
            <div className="flex max-h-[calc(92vh-12rem)] items-center justify-center overflow-auto">
              {viewerMedia.kind === "image" ? (
                <img
                  alt={viewerMedia.fileName}
                  className="h-auto max-h-[70vh] max-w-[90vw] object-contain"
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    setViewerImageInfo((current) => ({
                      ...current,
                      height: image.naturalHeight || null,
                      width: image.naturalWidth || null,
                    }));
                  }}
                  src={viewerMedia.previewUrl}
                />
              ) : (
                <video className="max-h-[80vh] max-w-full" controls src={viewerMedia.previewUrl} />
              )}
            </div>
            {viewerMedia.kind === "image" ? (
              <div className="mt-4 grid gap-2 text-xs text-ink/70">
                <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
                  <div className="font-medium text-ink">Resolution</div>
                  <div>
                    {viewerImageInfo.width && viewerImageInfo.height
                      ? `${viewerImageInfo.width} x ${viewerImageInfo.height}`
                      : "Loading"}
                  </div>
                </div>
                <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
                  <div className="font-medium text-ink">File size</div>
                  <div>{viewerImageInfo.loadingSize ? "Loading" : formatFileSize(viewerImageInfo.fileSize)}</div>
                </div>
                <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
                  <div className="font-medium text-ink">URL</div>
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="min-w-0 flex-1 truncate rounded-md bg-black/[0.04] px-2 py-1 font-mono text-[11px] text-ink/75">
                      {absoluteMediaUrl(viewerMedia.assetUrl)}
                    </div>
                    <button
                      className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-ink/10 bg-white px-3 text-xs font-medium text-ink transition hover:border-ink/20 hover:bg-mist"
                      onClick={() => void copyViewerImageUrl()}
                      type="button"
                    >
                      <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                        <path d="M8 8V5.5A1.5 1.5 0 019.5 4h9A1.5 1.5 0 0120 5.5v9a1.5 1.5 0 01-1.5 1.5H16M5.5 8h9A1.5 1.5 0 0116 9.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 014 18.5v-9A1.5 1.5 0 015.5 8z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                      </svg>
                      {viewerImageInfo.copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});

RichEditor.displayName = "RichEditor";
