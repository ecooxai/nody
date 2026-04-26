"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";

import type { EditorCommand } from "@/lib/editor/commands";
import {
  findLineStartOffset,
  getLineSourceRange,
  getSelectedLineText,
  sameLineNumberList,
  updateSelectedLineNumbers,
} from "@/lib/editor/line-selection";
import { assetToMarkdown } from "@/lib/editor/media";
import { ensureTrailingNewlines, markdownToHtml } from "@/lib/editor/markdown";
import type { AIMediaKind, DocumentAsset } from "@/shared/types";

export type RichEditorBodyChangeReason =
  | "typing"
  | "paste"
  | "cut"
  | "delete"
  | "media"
  | "format"
  | "remove-media"
  | "normalize";

export type RichEditorHandle = {
  focus: () => void;
  focusRange: (start: number, end: number) => void;
  focusLineEnd: (lineNumber: number) => void;
  flushBodyChanges: () => void;
  getCursorLineNumber: () => number;
  isBodyFocused: () => boolean;
  scrollToLine: (lineNumber: number, position?: "top" | "middle" | "bottom") => void;
  scrollByPixels: (pixels: number) => void;
  findText: (query: string, occurrence?: "first" | "next" | "previous") => void;
  insertAsset: (asset: DocumentAsset, position?: "cursor" | "top") => void;
  insertAssetAtLine: (asset: DocumentAsset, lineNumber: number) => void;
  runCommand: (command: EditorCommand) => void;
};

type RichEditorProps = {
  noteId?: string;
  title: string;
  bodyMarkdown: string;
  editable: boolean;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string, reason?: RichEditorBodyChangeReason) => void;
  onBodyDraftChange?: (reason?: RichEditorBodyChangeReason) => void;
  onSelectionChange?: (selectedText: string) => void;
  onRequestEdit?: () => void;
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
  endIndex: number;
  kind: "image" | "audio" | "video";
  matchIndex: number;
  src: string;
  tagText: string;
};

type EditorMediaPreview = EmbeddedMedia & {
  displayEnd: number;
  displayStart: number;
  key: string;
  lineNumber: number;
  sourceEnd: number;
  sourceStart: number;
  sourceText: string;
};

type OffsetSegment = {
  displayEnd: number;
  displayStart: number;
  kind: "media" | "text";
  sourceEnd: number;
  sourceStart: number;
};

type EditorDisplayModel = {
  media: EditorMediaPreview[];
  segments: OffsetSegment[];
  sourceLineDisplayCounts: number[];
  sourceLineDisplayStarts: number[];
  value: string;
};

const EDITOR_PREVIEW_VERTICAL_GAP_PX = 8;
const EDITOR_PREVIEW_SIZE_PX = 200;
const EDITOR_TEXT_LINE_HEIGHT_PX = 28;
const EDITOR_AUDIO_PREVIEW_HEIGHT_PX = 48;
const EDITOR_MEDIA_RESERVED_LINE_COUNT = 5;
const EDITOR_MEDIA_PLACEHOLDER = "\u001f";
const FLOATING_EDIT_BUTTON_HIDE_MS = 3000;
const FLOATING_EDIT_BUTTON_OFFSET_X_PX = 20;
const FLOATING_EDIT_BUTTON_OFFSET_Y_PX = 20;
const FLOATING_EDIT_BUTTON_SIZE_PX = 40;
const MEDIA_TAG_PATTERN = /<img\b[\s\S]*?>|<(audio|video)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/\1>)/gi;
const EDITOR_MEDIA_LINE_PATTERN = /^\s*(<img\b[\s\S]*?>|<video\b[\s\S]*?(?:\/>|>[\s\S]*?<\/video>))\s*$/i;

function compactMediaTags(value: string) {
  return value.replace(/<img\b[\s\S]*?>|<(audio|video)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/\1>)/gi, (match) =>
    match.replace(/\s+/g, " ").trim(),
  );
}

function extractMediaTagPreviews(value: string) {
  const previews: MediaTagPreview[] = [];

  for (const match of value.matchAll(MEDIA_TAG_PATTERN)) {
    const rawTag = match[0] ?? "";
    const kind = /^<video\b/i.test(rawTag) ? "video" : /^<audio\b/i.test(rawTag) ? "audio" : "image";
    const src = extractMediaTagSrc(rawTag);
    const matchIndex = match.index ?? 0;
    previews.push({
      endIndex: matchIndex + rawTag.length,
      kind,
      matchIndex,
      src,
      tagText: compactMediaTags(rawTag),
    });
  }

  return previews;
}

function extractMediaTagSrc(value: string) {
  const srcMatch = value.match(/\ssrc=(?:"([^"]+)"|'([^']+)')/i);
  return srcMatch?.[1] || srcMatch?.[2] || "";
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

function measureEditorLineLayout(textarea: HTMLTextAreaElement, model: EditorDisplayModel): LineLayout {
  const computed = window.getComputedStyle(textarea);
  const lineHeight = cssPixelValue(computed.lineHeight, EDITOR_TEXT_LINE_HEIGHT_PX);
  const mirror = document.createElement("div");
  const markers: HTMLSpanElement[] = [];

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

  const lines = model.value.split("\n");
  for (const [index, line] of lines.entries()) {
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    markers[index] = marker;
    mirror.appendChild(document.createTextNode(line));
    if (index < lines.length - 1) {
      mirror.appendChild(document.createTextNode("\n"));
    }
  }

  document.body.appendChild(mirror);

  const markerTops = markers.map((marker) => marker.offsetTop);
  const tops: LineTopMap = {};
  const heights = model.sourceLineDisplayStarts.map((displayLineStart, index) => {
    const lineNumber = index + 1;
    const top = markerTops[displayLineStart] ?? 0;
    const nextSourceDisplayLineStart =
      model.sourceLineDisplayStarts[index + 1] ?? displayLineStart + model.sourceLineDisplayCounts[index];
    const nextTop = markerTops[nextSourceDisplayLineStart] ?? top + model.sourceLineDisplayCounts[index] * lineHeight;
    tops[lineNumber] = top;
    return Math.max(lineHeight, nextTop - top);
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

function parseEditorMediaLine(line: string) {
  const match = line.match(EDITOR_MEDIA_LINE_PATTERN);
  const tagText = match?.[1] ? compactMediaTags(match[1]) : "";
  if (!tagText) return null;

  const kind: "image" | "video" = /^<video\b/i.test(tagText) ? "video" : "image";
  const src = extractMediaTagSrc(tagText);
  if (!src) return null;

  return {
    fileName: fileNameFromUrl(src),
    kind,
    mimeType: inferMimeFromUrl(src, kind),
    src,
    tagText,
  };
}

function buildEditorDisplayModel(sourceValue: string): EditorDisplayModel {
  const media: EditorMediaPreview[] = [];
  const segments: OffsetSegment[] = [];
  const sourceLineDisplayCounts: number[] = [];
  const sourceLineDisplayStarts: number[] = [];
  const displayParts: string[] = [];
  const lines = sourceValue.split("\n");
  let sourceOffset = 0;
  let displayOffset = 0;
  let displayLine = 0;

  const appendSegment = (value: string, sourceStart: number, sourceEnd: number, kind: OffsetSegment["kind"]) => {
    if (!value && sourceStart === sourceEnd) return;
    displayParts.push(value);
    segments.push({
      displayEnd: displayOffset + value.length,
      displayStart: displayOffset,
      kind,
      sourceEnd,
      sourceStart,
    });
    displayOffset += value.length;
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const hasLineBreak = index < lines.length - 1;
    const lineSourceStart = sourceOffset;
    const lineSourceEnd = lineSourceStart + line.length;
    const parsedMedia = parseEditorMediaLine(line);
    const displayLineStart = displayLine;
    sourceLineDisplayStarts.push(displayLineStart);

    if (parsedMedia) {
      const displayStart = displayOffset;
      const mediaPlaceholder = `${EDITOR_MEDIA_PLACEHOLDER}${"\n".repeat(EDITOR_MEDIA_RESERVED_LINE_COUNT - 1)}`;
      appendSegment(mediaPlaceholder, lineSourceStart, lineSourceEnd, "media");
      const displayEnd = displayOffset;
      const key = `${lineSourceStart}:${lineSourceEnd}:${parsedMedia.src}`;
      media.push({
        id: `${parsedMedia.kind}:${parsedMedia.src}`,
        kind: parsedMedia.kind,
        fileName: parsedMedia.fileName,
        mimeType: parsedMedia.mimeType,
        assetUrl: parsedMedia.src,
        previewUrl: parsedMedia.src,
        displayEnd,
        displayStart,
        key,
        lineNumber,
        sourceEnd: lineSourceEnd,
        sourceStart: lineSourceStart,
        sourceText: line,
      });
      sourceLineDisplayCounts.push(EDITOR_MEDIA_RESERVED_LINE_COUNT);
      displayLine += EDITOR_MEDIA_RESERVED_LINE_COUNT - 1;
    } else {
      appendSegment(line, lineSourceStart, lineSourceEnd, "text");
      sourceLineDisplayCounts.push(1);
    }

    sourceOffset = lineSourceEnd;
    if (hasLineBreak) {
      appendSegment("\n", sourceOffset, sourceOffset + 1, "text");
      sourceOffset += 1;
      displayLine += 1;
    }
  }

  return {
    media,
    segments,
    sourceLineDisplayCounts,
    sourceLineDisplayStarts,
    value: displayParts.join(""),
  };
}

function displayOffsetToSourceOffset(model: EditorDisplayModel, offset: number) {
  const clampedOffset = Math.max(0, Math.min(offset, model.value.length));
  for (const segment of model.segments) {
    if (clampedOffset < segment.displayStart || clampedOffset > segment.displayEnd) continue;
    if (segment.kind === "media") {
      return clampedOffset <= segment.displayStart ? segment.sourceStart : segment.sourceEnd;
    }
    return segment.sourceStart + Math.min(clampedOffset - segment.displayStart, segment.sourceEnd - segment.sourceStart);
  }
  const last = model.segments[model.segments.length - 1];
  return last?.sourceEnd ?? 0;
}

function sourceOffsetToDisplayOffset(model: EditorDisplayModel, sourceOffset: number) {
  const maxSourceOffset = model.segments[model.segments.length - 1]?.sourceEnd ?? 0;
  const clampedOffset = Math.max(0, Math.min(sourceOffset, maxSourceOffset));
  for (const segment of model.segments) {
    if (clampedOffset < segment.sourceStart || clampedOffset > segment.sourceEnd) continue;
    if (segment.kind === "media") {
      return clampedOffset <= segment.sourceStart ? segment.displayStart : segment.displayEnd;
    }
    return segment.displayStart + Math.min(clampedOffset - segment.sourceStart, segment.displayEnd - segment.displayStart);
  }
  const last = model.segments[model.segments.length - 1];
  return last?.displayEnd ?? 0;
}

function restoreEditorDisplayValue(displayValue: string, previousMedia: EditorMediaPreview[]) {
  let restored = "";
  let mediaIndex = 0;
  let index = 0;

  while (index < displayValue.length) {
    if (displayValue[index] === EDITOR_MEDIA_PLACEHOLDER && mediaIndex < previousMedia.length) {
      restored += previousMedia[mediaIndex].sourceText;
      mediaIndex += 1;
      index += 1;
      let skippedReservedBreaks = 0;
      while (skippedReservedBreaks < EDITOR_MEDIA_RESERVED_LINE_COUNT - 1 && displayValue[index] === "\n") {
        index += 1;
        skippedReservedBreaks += 1;
      }
      continue;
    }

    restored += displayValue[index];
    index += 1;
  }

  return restored;
}

function displaySelectionTouchesMedia(model: EditorDisplayModel, start: number, end: number) {
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  if (selectionStart === selectionEnd) return false;

  return model.media.some((media) => selectionStart < media.displayEnd && selectionEnd > media.displayStart);
}

function displayCaretIsInsideMedia(model: EditorDisplayModel, offset: number) {
  return model.media.some((media) => offset > media.displayStart && offset < media.displayEnd);
}

function shouldProtectEditorMediaKey(model: EditorDisplayModel, key: string, start: number, end: number) {
  const editingKey = key === "Backspace" || key === "Delete" || key === "Enter" || key === "Tab" || key.length === 1;
  if (displaySelectionTouchesMedia(model, start, end)) return editingKey;
  if (start !== end) return false;

  if (key === "Backspace") {
    return model.media.some((media) => start > media.displayStart && start <= media.displayEnd + 1);
  }
  if (key === "Delete") {
    return model.media.some((media) => start >= media.displayStart && start < media.displayEnd);
  }
  if (key === "Enter" || key === "Tab" || key.length === 1) {
    return displayCaretIsInsideMedia(model, start);
  }
  return false;
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

function getLineEndOffset(value: string, lineNumber: number) {
  const start = findLineStartOffset(value, lineNumber);
  const end = value.indexOf("\n", start);
  return end >= 0 ? end : value.length;
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
  noteId,
  title,
  bodyMarkdown,
  editable,
  onTitleChange,
  onBodyChange,
  onBodyDraftChange,
  onSelectionChange,
  onRequestEdit,
  onNoteInteract,
  onAddMediaToAi,
  inlineNotice,
  overlay,
  topRight,
}, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<TextSelection>({ start: 0, end: 0 });
  const activeMediaHideTimerRef = useRef<number | null>(null);
  const floatingEditButtonTimerRef = useRef<number | null>(null);
  const previewSelectionTimerRef = useRef<number | null>(null);
  const previewPointerSelectingRef = useRef(false);
  const previewSelectionJustFinishedRef = useRef(false);
  const previewPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastPreviewSelectionRef = useRef("");
  const bodyChangeTimerRef = useRef<number | null>(null);
  const lastNoteIdRef = useRef(noteId);
  const lastPublishedBodyRef = useRef(bodyMarkdown);
  const pendingBodyChangeReasonRef = useRef<RichEditorBodyChangeReason>("typing");
  const viewerCopyTimerRef = useRef<number | null>(null);
  const editorMeasureWidthRef = useRef(0);
  const lineTapRef = useRef<{ key: string | null; count: number; startedAt: number }>({
    key: null,
    count: 0,
    startedAt: 0,
  });
  const [activeMedia, setActiveMedia] = useState<(EmbeddedMedia & { x: number; y: number }) | null>(null);
  const [activeEditorMediaKey, setActiveEditorMediaKey] = useState<string | null>(null);
  const [textareaScrollTop, setTextareaScrollTop] = useState(0);
  const [editorLineLayout, setEditorLineLayout] = useState<LineLayout>({ heights: [], tops: {} });
  const [lineStartTops, setLineStartTops] = useState<LineTopMap>({});
  const [viewerMedia, setViewerMedia] = useState<EmbeddedMedia | null>(null);
  const [floatingEditButton, setFloatingEditButton] = useState<{ x: number; y: number } | null>(null);
  const [selectedGutterLines, setSelectedGutterLines] = useState<number[]>([]);
  const [activeEditorLineNumber, setActiveEditorLineNumber] = useState<number | null>(null);
  const selectedGutterLinesRef = useRef<number[]>([]);
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
  const editorDisplayModel = useMemo(() => buildEditorDisplayModel(noteBodyMarkdown), [noteBodyMarkdown]);
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

  const clearFloatingEditButtonTimer = () => {
    if (floatingEditButtonTimerRef.current) {
      window.clearTimeout(floatingEditButtonTimerRef.current);
      floatingEditButtonTimerRef.current = null;
    }
  };

  const hideFloatingEditButton = () => {
    clearFloatingEditButtonTimer();
    setFloatingEditButton(null);
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

  const syncSelectedGutterLines = (nextSelectedLines: number[]) => {
    selectedGutterLinesRef.current = nextSelectedLines;
    setSelectedGutterLines((current) => (sameLineNumberList(current, nextSelectedLines) ? current : nextSelectedLines));
  };

  const clearGutterLineSelection = (options?: { notify?: boolean }) => {
    if (selectedGutterLinesRef.current.length > 0) {
      syncSelectedGutterLines([]);
    }
    if (options?.notify !== false) {
      onSelectionChange?.("");
    }
  };

  const publishBodyChange = (value: string, reason: RichEditorBodyChangeReason = "typing") => {
    const compactedValue = compactMediaTags(value);
    clearBodyChangeTimer();
    if (compactedValue !== bodyDraftRef.current) {
      bodyDraftRef.current = compactedValue;
      setBodyDraft(compactedValue);
    }
    if (compactedValue === lastPublishedBodyRef.current) return;
    lastPublishedBodyRef.current = compactedValue;
    bodyDraftRef.current = compactedValue;
    onBodyChange(compactedValue, reason);
  };

  const scheduleBodyChange = (value: string, reason: RichEditorBodyChangeReason = "typing") => {
    if (value === lastPublishedBodyRef.current) return;
    clearBodyChangeTimer();
    bodyChangeTimerRef.current = window.setTimeout(() => {
      bodyChangeTimerRef.current = null;
      publishBodyChange(value, reason);
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
    if (!onSelectionChange || editable || selectedGutterLinesRef.current.length > 0) return;
    const nextSelection = readPreviewSelection();
    if (nextSelection === lastPreviewSelectionRef.current) return;
    const selectedSnapshot = nextSelection ? capturePreviewSelectionSnapshot() : null;
    lastPreviewSelectionRef.current = nextSelection;
    onSelectionChange(nextSelection);
    restorePreviewSelectionSnapshot(selectedSnapshot);
  };

  const revealEditButton = (event: ReactMouseEvent<HTMLElement>) => {
    if (editable || typeof window === "undefined" || !onRequestEdit) return;

    const root = rootRef.current;
    if (!root) return;

    const rootRect = root.getBoundingClientRect();
    const fallbackRect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX || fallbackRect.left + Math.min(fallbackRect.width, FLOATING_EDIT_BUTTON_SIZE_PX) / 2;
    const pointerY = event.clientY || fallbackRect.top + fallbackRect.height / 2;
    const x = Math.max(
      0,
      Math.min(pointerX - rootRect.left + FLOATING_EDIT_BUTTON_OFFSET_X_PX, root.clientWidth - FLOATING_EDIT_BUTTON_SIZE_PX),
    );
    const y = Math.max(
      0,
      Math.min(pointerY - rootRect.top + FLOATING_EDIT_BUTTON_OFFSET_Y_PX, root.clientHeight - FLOATING_EDIT_BUTTON_SIZE_PX),
    );

    setFloatingEditButton({ x, y });
    clearFloatingEditButtonTimer();
    floatingEditButtonTimerRef.current = window.setTimeout(() => {
      setFloatingEditButton(null);
      floatingEditButtonTimerRef.current = null;
    }, FLOATING_EDIT_BUTTON_HIDE_MS);
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
    const nextLayout = measureEditorLineLayout(textarea, editorDisplayModel);
    setEditorLineLayout((current) => (sameLineLayout(current, nextLayout) ? current : nextLayout));
    setTextareaScrollTop(textarea.scrollTop);
  };

  useEffect(
    () => () => {
      clearActiveMediaHideTimer();
      clearFloatingEditButtonTimer();
      clearPreviewSelectionTimer();
      clearBodyChangeTimer();
      clearViewerCopyTimer();
      if (bodyDraftRef.current !== lastPublishedBodyRef.current) {
        onBodyChange(compactMediaTags(bodyDraftRef.current), "typing");
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (lastNoteIdRef.current === noteId) return;
    lastNoteIdRef.current = noteId;
    const compactedBodyMarkdown = compactMediaTags(bodyMarkdown);
    lastPublishedBodyRef.current = compactedBodyMarkdown;
    bodyDraftRef.current = compactedBodyMarkdown;
    selectionRef.current = { start: 0, end: 0 };
    pendingBodyChangeReasonRef.current = "typing";
    clearBodyChangeTimer();
    clearActiveMediaHideTimer();
    clearFloatingEditButtonTimer();
    clearPreviewSelectionTimer();
    setBodyDraft(compactedBodyMarkdown);
    setActiveMedia(null);
    setActiveEditorMediaKey(null);
    setActiveEditorLineNumber(null);
    syncSelectedGutterLines([]);
    onSelectionChange?.("");
    setTextareaScrollTop(0);
    textareaRef.current?.setSelectionRange(0, 0);
  }, [bodyMarkdown, noteId, onSelectionChange]);

  useEffect(() => {
    const compactedBodyMarkdown = compactMediaTags(bodyMarkdown);
    if (compactedBodyMarkdown !== bodyMarkdown) {
      lastPublishedBodyRef.current = compactedBodyMarkdown;
      bodyDraftRef.current = compactedBodyMarkdown;
      setBodyDraft(compactedBodyMarkdown);
      clearBodyChangeTimer();
      onBodyChange(compactedBodyMarkdown, "normalize");
      return;
    }
    if (compactedBodyMarkdown === lastPublishedBodyRef.current) return;
    lastPublishedBodyRef.current = compactedBodyMarkdown;
    bodyDraftRef.current = compactedBodyMarkdown;
    setBodyDraft(compactedBodyMarkdown);
    clearBodyChangeTimer();
  }, [bodyMarkdown]);

  useEffect(() => {
    const next = selectedGutterLinesRef.current.filter((lineNumber) => lineNumber <= lineNumbers.length);
    if (!sameLineNumberList(selectedGutterLinesRef.current, next)) {
      syncSelectedGutterLines(next);
    }
  }, [lineNumbers.length]);

  useEffect(() => {
    lastPreviewSelectionRef.current = "";
    previewPointerSelectingRef.current = false;
    hideFloatingEditButton();
    clearPreviewSelectionTimer();
    syncSelectedGutterLines([]);

    if (!editable) {
      publishBodyChange(bodyDraft, "typing");
      selectionRef.current = { start: 0, end: 0 };
      return;
    }
    clearActiveMediaHideTimer();
    setActiveMedia(null);
    setActiveEditorMediaKey(null);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      resizeTextareaToContent();
      textarea?.focus();
      setTextareaScrollTop(textarea?.scrollTop ?? 0);
    });
  }, [editable]);

  useEffect(() => {
    if (!activeEditorMediaKey) return;
    if (!editorDisplayModel.media.some((media) => media.key === activeEditorMediaKey)) {
      setActiveEditorMediaKey(null);
    }
  }, [activeEditorMediaKey, editorDisplayModel.media]);

  useEffect(() => {
    if (selectedGutterLines.length === 0) return;
    onSelectionChange?.(getSelectedLineText(noteBodyMarkdown, selectedGutterLines).trim());
  }, [noteBodyMarkdown, onSelectionChange, selectedGutterLines]);

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
    if (selectedGutterLinesRef.current.length > 0) {
      clearGutterLineSelection();
    }
    previewPointerSelectingRef.current = true;
    previewSelectionJustFinishedRef.current = false;
    previewPointerStartRef.current = { x: event.clientX, y: event.clientY };
  };

  const syncTextareaSelection = (target = textareaRef.current) => {
    const textarea = target;
    if (!textarea) return;
    const nextSelection = {
      start: displayOffsetToSourceOffset(editorDisplayModel, textarea.selectionStart ?? 0),
      end: displayOffsetToSourceOffset(editorDisplayModel, textarea.selectionEnd ?? 0),
    };
    selectionRef.current = nextSelection;
    setActiveEditorLineNumber(Math.max(1, noteBodyMarkdown.slice(0, nextSelection.end).split("\n").length));
    onSelectionChange?.(noteBodyMarkdown.slice(selectionRef.current.start, selectionRef.current.end).trim());
  };

  const handleBodyTextareaChange = (target: HTMLTextAreaElement) => {
    if (selectedGutterLines.length > 0) {
      clearGutterLineSelection();
    }
    const displayValue = target.value;
    const displaySelection = {
      start: target.selectionStart ?? 0,
      end: target.selectionEnd ?? target.selectionStart ?? 0,
    };
    const reason = pendingBodyChangeReasonRef.current;
    pendingBodyChangeReasonRef.current = "typing";
    onBodyDraftChange?.(reason);
    const value = restoreEditorDisplayValue(displayValue, editorDisplayModel.media);
    const nextDisplayModel = buildEditorDisplayModel(ensureTrailingNewlines(value));
    const nextSelection = {
      start: displayOffsetToSourceOffset(nextDisplayModel, displaySelection.start),
      end: displayOffsetToSourceOffset(nextDisplayModel, displaySelection.end),
    };
    bodyDraftRef.current = value;
    setBodyDraft(value);
    selectionRef.current = nextSelection;
    setActiveEditorLineNumber(Math.max(1, value.slice(0, nextSelection.end).split("\n").length));
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.setSelectionRange(displaySelection.start, displaySelection.end);
    });
    if (reason === "paste" || reason === "cut" || reason === "delete") {
      publishBodyChange(value, reason);
      return;
    }
    scheduleBodyChange(value, reason);
  };

  const handleBodyTextareaKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey || event.altKey) && event.key !== "Backspace" && event.key !== "Delete") return;

    const selectionStart = event.currentTarget.selectionStart ?? 0;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
    const shouldProtectMedia = shouldProtectEditorMediaKey(editorDisplayModel, event.key, selectionStart, selectionEnd);
    if (!shouldProtectMedia) {
      if ((event.key === "Backspace" || event.key === "Delete") && selectionStart !== selectionEnd) {
        pendingBodyChangeReasonRef.current = "delete";
      }
      return;
    }

    event.preventDefault();
    event.currentTarget.setSelectionRange(selectionStart, selectionEnd);
  };

  const applyTextareaMutation = (
    nextValue: string,
    nextSelection: TextSelection,
    reason: RichEditorBodyChangeReason = "format",
  ) => {
    clearGutterLineSelection({ notify: false });
    bodyDraftRef.current = nextValue;
    setBodyDraft(nextValue);
    publishBodyChange(nextValue, reason);
    selectionRef.current = nextSelection;
    const nextDisplayModel = buildEditorDisplayModel(ensureTrailingNewlines(nextValue));
    const displaySelection = {
      start: sourceOffsetToDisplayOffset(nextDisplayModel, nextSelection.start),
      end: sourceOffsetToDisplayOffset(nextDisplayModel, nextSelection.end),
    };
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(displaySelection.start, displaySelection.end);
    });
  };

  const getTextareaSourceOffsetTop = (textarea: HTMLTextAreaElement, offset: number) => {
    const clampedOffset = Math.max(0, Math.min(offset, noteBodyMarkdown.length));
    const lineNumber = noteBodyMarkdown.slice(0, clampedOffset).split("\n").length;
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
        const clampedOffset = Math.max(0, Math.min(offset, noteBodyMarkdown.length));
        const offsetTop = getTextareaSourceOffsetTop(textarea, clampedOffset);
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
        const clampedOffset = Math.max(0, Math.min(offset, noteBodyMarkdown.length));
        const offsetTop = getTextareaSourceOffsetTop(textarea, clampedOffset);
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

  const removeEditorMedia = (media: EditorMediaPreview) => {
    let removeStart = media.sourceStart;
    let removeEnd = media.sourceEnd;
    if (noteBodyMarkdown[removeEnd] === "\n") {
      removeEnd += 1;
    } else if (removeStart > 0 && noteBodyMarkdown[removeStart - 1] === "\n") {
      removeStart -= 1;
    }
    const nextValue = `${noteBodyMarkdown.slice(0, removeStart)}${noteBodyMarkdown.slice(removeEnd)}`;
    setActiveEditorMediaKey(null);
    applyTextareaMutation(nextValue, { start: removeStart, end: removeStart }, "remove-media");
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

  const focusPreviewSelectionHost = () => {
    previewRef.current?.focus({ preventScroll: true });
  };

  const handleLineSelectionCopy = (event: ReactClipboardEvent<HTMLElement>) => {
    if (selectedGutterLinesRef.current.length === 0) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", getSelectedLineText(noteBodyMarkdown, selectedGutterLinesRef.current));
  };

  const focusTextareaRange = (start: number, end: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    clearGutterLineSelection({ notify: false });
    const clampedStart = Math.max(0, Math.min(start, noteBodyMarkdown.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, noteBodyMarkdown.length));
    const displayStart = sourceOffsetToDisplayOffset(editorDisplayModel, clampedStart);
    const displayEnd = sourceOffsetToDisplayOffset(editorDisplayModel, clampedEnd);
    const offsetTop = getTextareaSourceOffsetTop(textarea, clampedStart);
    textarea.focus();
    textarea.setSelectionRange(displayStart, displayEnd);
    textarea.scrollTop = 0;
    setTextareaScrollTop(0);
    window.scrollTo({
      top: Math.max(textarea.getBoundingClientRect().top + window.scrollY + offsetTop - 96, 0),
      behavior: "smooth",
    });
  };

  const focusTextareaLineSelection = (lineNumber: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const range = getLineSourceRange(noteBodyMarkdown, lineNumber);
    const displayStart = sourceOffsetToDisplayOffset(editorDisplayModel, range.start);
    const displayEnd = sourceOffsetToDisplayOffset(editorDisplayModel, range.end);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(displayStart, displayEnd);
    selectionRef.current = {
      start: range.start,
      end: range.end,
    };
  };

  const focusTextareaLineCaret = (lineNumber: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const lineStart = findLineStartOffset(noteBodyMarkdown, lineNumber);
    const displayStart = sourceOffsetToDisplayOffset(editorDisplayModel, lineStart);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(displayStart, displayStart);
    selectionRef.current = {
      start: lineStart,
      end: lineStart,
    };
  };

  const getEditorLineTop = (lineNumber: number) => {
    const measuredTop = editorLineLayout.tops[lineNumber];
    if (measuredTop !== undefined) return measuredTop;

    let top = 0;
    for (let index = 0; index < lineNumber - 1; index += 1) {
      top += editorLineLayout.heights[index] ?? EDITOR_TEXT_LINE_HEIGHT_PX;
    }
    return top;
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
    const haystack = noteBodyMarkdown.toLowerCase();
    const search = needle.toLowerCase();
    const matches: Array<{ start: number; end: number }> = [];
    let index = haystack.indexOf(search);
    while (index >= 0) {
      matches.push({ start: index, end: index + search.length });
      index = haystack.indexOf(search, index + search.length);
    }
    if (matches.length === 0) return;
    const currentStart = displayOffsetToSourceOffset(editorDisplayModel, textarea.selectionStart ?? 0);
    const currentEnd = displayOffsetToSourceOffset(editorDisplayModel, textarea.selectionEnd ?? 0);
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
    revealEditButton(event);

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

  const applyGutterLineSelection = (lineNumber: number, mode: "replace" | "toggle") => {
    const nextSelectedLines = updateSelectedLineNumbers(selectedGutterLinesRef.current, lineNumber, mode);
    syncSelectedGutterLines(nextSelectedLines);
    if (!editable) {
      lastPreviewSelectionRef.current = "";
      if (nextSelectedLines.length > 0) {
        window.getSelection()?.removeAllRanges();
      }
    }
    if (nextSelectedLines.length === 0) {
      onSelectionChange?.("");
      window.requestAnimationFrame(() => {
        if (editable) {
          focusTextareaLineCaret(lineNumber);
          return;
        }
        focusPreviewSelectionHost();
      });
      return;
    }

    const focusLineNumber = nextSelectedLines.includes(lineNumber)
      ? lineNumber
      : nextSelectedLines[nextSelectedLines.length - 1];
    window.requestAnimationFrame(() => {
      if (editable) {
        focusTextareaLineSelection(focusLineNumber);
        return;
      }
      focusPreviewSelectionHost();
    });
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

  const renderLineNumberGutter = (scrollTop = 0, options?: { everyTenOnly?: boolean; interactive?: boolean; lineHeights?: number[] }) => (
    <div
      className={`hide-scrollbar overflow-hidden border-r border-ink/10 py-[5px] pr-1 text-right leading-7 text-ink/35 select-none ${lineNumberFontClass}`}
    >
      <div style={scrollTop ? { transform: `translateY(-${scrollTop}px)` } : undefined}>
        {lineNumbers.map((lineNumber) => {
          const rowHeight = options?.lineHeights?.[lineNumber - 1] ?? EDITOR_TEXT_LINE_HEIGHT_PX;
          const selected = selectedGutterLines.includes(lineNumber);
          const lineLabel = options?.everyTenOnly && lineNumber % 10 !== 0 ? "" : lineNumber;

          if (!options?.interactive) {
            return (
              <div className="tabular-nums" key={lineNumber} style={{ height: `${rowHeight}px`, lineHeight: `${EDITOR_TEXT_LINE_HEIGHT_PX}px` }}>
                {lineLabel}
              </div>
            );
          }

          return (
            <button
              aria-label={`Select line ${lineNumber}`}
              aria-pressed={selected}
              className={`block w-full rounded-[6px] pr-1 text-right tabular-nums transition ${
                selected ? "bg-[#dbeafe] text-ink shadow-[inset_0_0_0_1px_rgba(59,130,246,0.22)]" : "hover:bg-[#eff6ff] hover:text-ink/60"
              }`}
              key={lineNumber}
              onClick={() => applyGutterLineSelection(lineNumber, "toggle")}
              onDoubleClick={() => applyGutterLineSelection(lineNumber, "replace")}
              onPointerDown={(event) => {
                event.preventDefault();
                onNoteInteract?.();
              }}
              style={{ height: `${rowHeight}px`, lineHeight: `${EDITOR_TEXT_LINE_HEIGHT_PX}px` }}
              tabIndex={-1}
              type="button"
            >
              {lineLabel}
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderEditorLineSelectionLayer = () => {
    if (selectedGutterLines.length === 0) return null;

    return (
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {selectedGutterLines.map((lineNumber) => {
          const rowHeight = editorLineLayout.heights[lineNumber - 1] ?? EDITOR_TEXT_LINE_HEIGHT_PX;
          const top = getEditorLineTop(lineNumber) - textareaScrollTop;
          return (
            <div
              className="absolute left-[6px] right-[6px] rounded-[8px] bg-[#dbeafe]/70 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.22)]"
              key={lineNumber}
              style={{ height: `${rowHeight}px`, top: `${top}px` }}
            />
          );
        })}
      </div>
    );
  };

  const renderEditorFocusLineLayer = () => {
    if (!activeEditorLineNumber) return null;

    const rowHeight = editorLineLayout.heights[activeEditorLineNumber - 1] ?? EDITOR_TEXT_LINE_HEIGHT_PX;
    const top = getEditorLineTop(activeEditorLineNumber) - textareaScrollTop;
    return (
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute left-[6px] right-[6px] rounded-[8px] bg-black/[0.035]"
          style={{ height: `${rowHeight}px`, top: `${top}px` }}
        />
      </div>
    );
  };

  const renderEditorMediaPreviewLayer = () => {
    if (editorDisplayModel.media.length === 0) return null;

    return (
      <div aria-label="Media previews" className="pointer-events-none absolute inset-0 overflow-hidden">
        {editorDisplayModel.media.map((media) => {
          const rowHeight = Math.max(
            editorLineLayout.heights[media.lineNumber - 1] ?? EDITOR_TEXT_LINE_HEIGHT_PX * EDITOR_MEDIA_RESERVED_LINE_COUNT,
            EDITOR_TEXT_LINE_HEIGHT_PX * EDITOR_MEDIA_RESERVED_LINE_COUNT,
          );
          const previewHeight = Math.max(92, rowHeight - 10);
          const top = (editorLineLayout.tops[media.lineNumber] ?? 0) - textareaScrollTop;
          const active = activeEditorMediaKey === media.key;

          return (
            <div
              className="pointer-events-auto absolute left-[10px] right-[10px] flex items-start gap-2 bg-[#fffbf4] py-[5px]"
              data-editor-media-preview="true"
              key={media.key}
              onClick={() => setActiveEditorMediaKey(media.key)}
              onPointerDown={(event) => {
                event.preventDefault();
                onNoteInteract?.();
              }}
              style={{ height: `${rowHeight}px`, top: `${top}px` }}
            >
              <button
                className="block h-full max-w-[240px] overflow-hidden rounded-[8px] border border-ink/10 bg-white text-left shadow-[0_8px_20px_rgba(15,23,42,0.08)]"
                onClick={(event) => {
                  event.stopPropagation();
                  setActiveEditorMediaKey(media.key);
                }}
                title={media.fileName}
                type="button"
              >
                {media.kind === "image" ? (
                  <img
                    alt={media.fileName}
                    className="h-full w-auto max-w-[240px] object-contain"
                    loading="lazy"
                    src={media.previewUrl}
                    style={{ height: `${previewHeight}px` }}
                  />
                ) : (
                  <video
                    className="h-full w-auto max-w-[240px] bg-black object-contain"
                    muted
                    playsInline
                    preload="metadata"
                    src={media.previewUrl}
                    style={{ height: `${previewHeight}px` }}
                  />
                )}
              </button>
              {active ? (
                <div className="flex shrink-0 flex-col gap-2 pt-1" data-note-media-actions="true">
                  <button
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-[#bb3e2d] shadow-[0_8px_20px_rgba(15,23,42,0.08)] transition hover:border-[#bb3e2d]/30 hover:bg-[#fff0ed]"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeEditorMedia(media);
                    }}
                    title={`Delete ${media.kind}`}
                    type="button"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path d="M9 4h6M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                    </svg>
                  </button>
                  <button
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink shadow-[0_8px_20px_rgba(15,23,42,0.08)] transition hover:border-ink/20 hover:bg-mist"
                    onClick={(event) => {
                      event.stopPropagation();
                      setViewerMedia(media);
                    }}
                    title="View large"
                    type="button"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path d="M14 4h6v6M10 20H4v-6M20 10V4h-6M4 14v6h6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                    </svg>
                  </button>
                  {onAddMediaToAi ? (
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-white text-ink shadow-[0_8px_20px_rgba(15,23,42,0.08)] transition hover:border-ink/20 hover:bg-mist"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAddMediaToAi(media);
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
          );
        })}
      </div>
    );
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
      focusLineEnd: (lineNumber) => {
        if (!editable) return;
        window.requestAnimationFrame(() => {
          const lineEnd = getLineEndOffset(noteBodyMarkdown, lineNumber);
          focusTextareaRange(lineEnd, lineEnd);
        });
      },
      getCursorLineNumber: () => Math.max(1, noteBodyMarkdown.slice(0, selectionRef.current.end).split("\n").length),
      isBodyFocused: () => textareaRef.current !== null && globalThis.document.activeElement === textareaRef.current,
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
          applyTextareaMutation(`${snippet}\n\n${value}`, { start: 0, end: 0 }, "media");
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
        applyTextareaMutation(nextValue, { start: caret, end: caret }, "media");
        scrollTextareaOffsetNearTop(start + spacerBefore.length);
      },
      insertAssetAtLine: (asset, lineNumber) => {
        if (!editable) return;
        const snippet = assetToMarkdown(asset);
        const next = insertBlockAtLine(noteBodyMarkdown, snippet, lineNumber);
        applyTextareaMutation(next.value, { start: next.caret, end: next.caret }, "media");
        scrollTextareaOffsetNearTop(findLineStartOffset(noteBodyMarkdown, lineNumber));
      },
      runCommand: (command) => {
        if (!editable) return;
        const next = applyCommand(noteBodyMarkdown, selectionRef.current, command);
        applyTextareaMutation(next.value, next.selection, "format");
      },
      flushBodyChanges: () => {
        publishBodyChange(bodyDraftRef.current, "typing");
      },
    }),
    [noteBodyMarkdown, editable, lineStartTops, editorLineLayout, editorDisplayModel, noteId],
  );

  return (
    <div
      className="relative min-h-[calc(100vh-4rem)] bg-[linear-gradient(180deg,rgba(255,251,244,0.9),rgba(255,255,255,0.96))] pr-[5px] pb-10 pt-[5px]"
      ref={rootRef}
    >
      <section className="overflow-visible bg-transparent">
        <div className="flex items-start justify-between gap-3 px-[5px] py-[5px]">
          <div className="min-w-0 flex-1">
            {editable ? (
              <input
                className="w-full bg-transparent pl-[10px] font-display text-[18px] leading-8 text-ink outline-none sm:text-[19px]"
                onChange={(event) => onTitleChange(event.target.value)}
                onFocus={onNoteInteract}
                onPointerDown={onNoteInteract}
                placeholder="Untitled"
                ref={titleInputRef}
                value={title}
              />
            ) : (
              <button
                className="block w-full truncate bg-transparent pl-[10px] text-left font-display text-[18px] leading-8 text-ink outline-none sm:text-[19px]"
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
                {renderLineNumberGutter(textareaScrollTop, { interactive: true, lineHeights: editorLineLayout.heights })}
                <div className="relative min-w-0">
                  {renderEditorFocusLineLayer()}
                  {renderEditorLineSelectionLayer()}
                  <textarea
                    className="relative min-h-[34rem] w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent py-0 pl-[5px] pr-0 text-[15px] leading-7 text-ink outline-none"
                    onBlur={() => setActiveEditorLineNumber(null)}
                    onCopy={handleLineSelectionCopy}
                    onChange={(event) => handleBodyTextareaChange(event.currentTarget)}
                    onCut={(event) => {
                      if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
                        pendingBodyChangeReasonRef.current = "cut";
                      }
                    }}
                    onFocus={(event) => {
                      onNoteInteract?.();
                      syncTextareaSelection(event.currentTarget);
                    }}
                    onKeyDown={handleBodyTextareaKeyDown}
                    onKeyUp={(event) => syncTextareaSelection(event.currentTarget)}
                    onMouseUp={(event) => syncTextareaSelection(event.currentTarget)}
                    onPaste={() => {
                      pendingBodyChangeReasonRef.current = "paste";
                      window.setTimeout(() => {
                        if (pendingBodyChangeReasonRef.current === "paste") {
                          pendingBodyChangeReasonRef.current = "typing";
                        }
                      }, 0);
                    }}
                    onPointerDown={() => {
                      onNoteInteract?.();
                      if (selectedGutterLines.length > 0) {
                        clearGutterLineSelection();
                      }
                    }}
                    onScroll={(event) => setTextareaScrollTop(event.currentTarget.scrollTop)}
                    onSelect={(event) => syncTextareaSelection(event.currentTarget)}
                    placeholder="Write in markdown..."
                    ref={textareaRef}
                    value={editorDisplayModel.value}
                    wrap="soft"
                  />
                  {renderEditorMediaPreviewLayer()}
                </div>
              </div>
              <div aria-hidden="true" className="h-[90vh]" />
            </div>
          ) : (
            <div className="relative">
              <div className="relative grid grid-cols-[20px_minmax(0,1fr)]">
                {renderLineNumberGutter(0, { everyTenOnly: true, interactive: true, lineHeights: viewerLineHeights })}
                <div
                  className="markdown-preview min-h-[34rem] cursor-text py-0 pl-[5px] pr-0"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                  onClick={handlePreviewClick}
                  onCopy={handleLineSelectionCopy}
                  onPointerDown={handlePreviewPointerDown}
                  onPlay={handlePreviewPlay}
                  ref={previewRef}
                  tabIndex={-1}
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
        {!editable && floatingEditButton ? (
          <button
            aria-label="Edit note"
            className="absolute z-30 flex h-10 w-10 items-center justify-center rounded-full bg-ink text-white shadow-[0_12px_28px_rgba(15,23,42,0.18)] transition hover:bg-ink/90"
            onClick={() => {
              hideFloatingEditButton();
              onRequestEdit?.();
            }}
            style={{ left: floatingEditButton.x, top: floatingEditButton.y }}
            title="Edit note"
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path
                d="M4 20h4l10-10-4-4L4 16v4Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
              <path d="m12.5 7.5 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
            </svg>
          </button>
        ) : null}
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
