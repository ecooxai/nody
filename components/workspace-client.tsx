"use client";

import { UserButton, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type TouchEvent, type WheelEvent } from "react";

import { AIChatPanel } from "@/components/chat/ai-chat-panel";
import { RichEditor, type RichEditorBodyChangeReason, type RichEditorHandle } from "@/components/editor/rich-editor";
import { useErrorToast } from "@/components/notifications/error-toast";
import { Panel } from "@/components/ui/panel";
import { ProviderSettingsForm } from "@/components/settings/provider-settings-form";
import { apiClient } from "@/lib/api/client";
import { clerkClientConfigured } from "@/lib/auth/config";
import type { EditorCommand } from "@/lib/editor/commands";
import { createStarterMarkdown, ensureTrailingNewlines, normalizeStoredMarkdown } from "@/lib/editor/markdown";
import { useServiceWorker } from "@/lib/hooks/use-service-worker";
import { createDefaultSettings } from "@/lib/providers/defaults";
import { getDeviceId } from "@/lib/storage/device";
import { DEFAULT_FOLDER_NAME, UNTITLED_NOTE_TITLE, WELCOME_NOTE_TITLE, loadNoteTemplate } from "@/lib/templates/notes";
import {
  loadCachedDocument,
  loadAiPanelHeight,
  loadLiveRecordingSettings,
  loadRecentDocumentIds,
  saveCachedDocument,
  saveAiPanelHeight,
  saveLiveRecordingSettings,
  saveRecentDocumentIds,
} from "@/lib/storage/local-cache";
import { buildSubstitutionReplay, type TextSubstitutionReplayStep } from "@/shared/substitutions";
import { buildSyncPayload, shouldApplyRemote } from "@/shared/sync";
import type {
  AIMessage,
  AIMessageAttachment,
  AIMediaKind,
  AIMessagePrompt,
  AINoteReference,
  AIRequestAttachment,
  AIRequestMode,
  AIResponseAttachment,
  AIResponseAction,
  DocumentRecord,
  FolderAsset,
  FolderRecord,
  PromptTemplate,
  ProviderSettings,
  TextSubstitution,
} from "@/shared/types";

type WorkspaceWindow = "library" | "format" | "create" | "settings" | "ai" | "info" | null;
type AssetInsertionPlacement = "cursor" | "top";
type PendingAiAttachment = {
  id: string;
  kind: AIMediaKind;
  fileName: string;
  mimeType: string;
  assetUrl: string;
  previewUrl: string;
};
type PendingAiEditPreview = {
  nextBodyMarkdown: string;
  stepCount: number;
  firstStep: TextSubstitutionReplayStep;
  skippedCount: number;
};
type PendingEditorInsert = {
  asset: FolderAsset;
  lineNumber?: number;
};
type PendingAiScroll = {
  lineNumber: number;
  position: "top" | "middle" | "bottom";
  restoreView: boolean;
};
type WorkspaceDragItem =
  | { kind: "asset"; id: string }
  | { kind: "document"; id: string }
  | { kind: "folder"; id: string };
type BodyHistoryReason = RichEditorBodyChangeReason | "ai";
type NoteHistorySnapshot = {
  bodyMarkdown: string;
};

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

function normalizeWheelDeltaY(event: WheelEvent<HTMLElement>) {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function containBoundaryWheel(event: WheelEvent<HTMLElement>) {
  if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;

  event.stopPropagation();
  const deltaY = normalizeWheelDeltaY(event);
  const scrollContainer = findVerticalScrollContainer(event.target, event.currentTarget);
  if (scrollContainer) {
    scrollContainer.scrollTop += deltaY;
  }
  if (event.cancelable) {
    event.preventDefault();
  }
}

function containBoundaryTouch(event: TouchEvent<HTMLElement>, previousY: number | null) {
  if (event.touches.length !== 1) return event.touches[0]?.clientY ?? null;

  event.stopPropagation();
  const currentY = event.touches[0].clientY;
  if (previousY === null) return currentY;

  const deltaY = previousY - currentY;
  if (deltaY === 0) return currentY;

  const scrollContainer = findVerticalScrollContainer(event.target, event.currentTarget);
  if (scrollContainer) {
    scrollContainer.scrollTop += deltaY;
  }
  if (event.cancelable) {
    event.preventDefault();
  }

  return currentY;
}
type NoteHistoryState = {
  redo: NoteHistorySnapshot[];
  undo: NoteHistorySnapshot[];
};
type NoteTypingHistoryTracker = {
  baselineBodyMarkdown: string;
  changedCharacters: number;
};
const RECENT_NOTE_INLINE_LIMIT = 3;
const RECENT_NOTE_HISTORY_LIMIT = 20;
const NOTE_HISTORY_LIMIT = 80;
const NOTE_TYPING_CHECKPOINT_CHARS = 5;
const UNDO_LONG_PRESS_MS = 550;
const UNDO_NOTICE_MS = 1800;
const NOTE_CHANGE_SYNC_DELAY_MS = 10000;
const BACKGROUND_SYNC_INTERVAL_MS = 12000;

const formatCommands: Array<{ label: string; command: EditorCommand }> = [
  { label: "Bold", command: "bold" },
  { label: "Italic", command: "italic" },
  { label: "Underline", command: "underline" },
  { label: "List", command: "insertUnorderedList" },
  { label: "Heading 1", command: "formatBlock:h1" },
  { label: "Heading 2", command: "formatBlock:h2" },
  { label: "Quote", command: "formatBlock:blockquote" },
];

function emptyDocument(deviceId: string, folderId: string | null): DocumentRecord {
  const now = new Date().toISOString();
  return {
    id: "",
    title: UNTITLED_NOTE_TITLE,
    bodyMarkdown: createStarterMarkdown(),
    folderId,
    revision: 0,
    deviceId,
    updatedAt: now,
    createdAt: now,
    assets: [],
  };
}

function normalizeDocumentRecord(document: DocumentRecord & { bodyHtml?: string }) {
  return {
    ...document,
    bodyMarkdown: normalizeStoredMarkdown(document.bodyMarkdown ?? document.bodyHtml ?? ""),
  } satisfies DocumentRecord;
}

function sortDocuments(documents: DocumentRecord[]) {
  return [...documents].sort((left, right) => {
    const byUpdatedAt = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    if (byUpdatedAt !== 0) return byUpdatedAt;
    return left.title.localeCompare(right.title);
  });
}

function sortFolders(folders: FolderRecord[]) {
  return [...folders].sort((left, right) => {
    const byUpdatedAt = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    if (byUpdatedAt !== 0) return byUpdatedAt;
    return left.name.localeCompare(right.name);
  });
}

function findFolderByName(folders: FolderRecord[], name: string, parentFolderId: string | null) {
  const normalizedName = name.toLowerCase();
  return (
    folders.find(
      (folder) => folder.parentFolderId === parentFolderId && folder.name.trim().toLowerCase() === normalizedName,
    ) ?? null
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatAssetKind(kind: FolderAsset["kind"]) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function shortenMiddle(value: string, start = 10, end = 10) {
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function base64ToFile(base64: string, fileName: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

function imageGenerationMetadata(attachment: AIResponseAttachment) {
  return {
    ...(attachment.model ? { model: attachment.model } : {}),
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
    ...(attachment.resolution ? { resolution: attachment.resolution } : {}),
    ...(attachment.aspectRatio ? { aspectRatio: attachment.aspectRatio } : {}),
    ...(attachment.imageSize ? { imageSize: attachment.imageSize } : {}),
  };
}

function formatCommandIcon(command: EditorCommand) {
  switch (command) {
    case "bold":
      return (
        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
          <path
            d="M8 5h5a3 3 0 0 1 0 6H8V5Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
          <path
            d="M8 11h6a3 3 0 0 1 0 6H8v-6Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      );
    case "italic":
      return (
        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
          <path d="M14 5H10M14 19H10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path d="M15 5 9 19" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "underline":
      return (
        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
          <path d="M8 5v5a4 4 0 0 0 8 0V5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M6 19h12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "insertUnorderedList":
      return (
        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
          <circle cx="6" cy="7" fill="currentColor" r="1.2" />
          <circle cx="6" cy="12" fill="currentColor" r="1.2" />
          <circle cx="6" cy="17" fill="currentColor" r="1.2" />
          <path d="M10 7h8M10 12h8M10 17h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "formatBlock:h1":
      return (
        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
          <path d="M5 6v12M13 6v12M5 12h8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M17 9.5V8.2l2.2-1.2V17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "formatBlock:h2":
      return (
        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
          <path d="M5 6v12M13 6v12M5 12h8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M16 10a2 2 0 0 1 4 0c0 1.2-2 2.3-4 4h4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "formatBlock:blockquote":
      return (
        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
          <path
            d="M7 8h3v3H8c-1.1 0-2 .9-2 2v1h4v-6Zm7 0h3v3h-2c-1.1 0-2 .9-2 2v1h4v-6Z"
            fill="currentColor"
          />
        </svg>
      );
    default:
      return null;
  }
}

function upsertDocument(documents: DocumentRecord[], next: DocumentRecord) {
  return sortDocuments([next, ...documents.filter((document) => document.id !== next.id)]);
}

function menuButtonClass(active: boolean) {
  return active
    ? "bg-ink text-white shadow-[0_10px_25px_rgba(15,23,42,0.14)]"
    : "bg-transparent text-ink hover:bg-black/[0.04]";
}

function noteButtonClass(active: boolean, nested = false) {
  if (nested) {
    return active ? "bg-transparent text-ink" : "bg-transparent text-ink/80 hover:bg-black/[0.025] hover:text-ink";
  }
  return active ? "bg-mist text-ink" : "bg-white text-ink hover:bg-mist";
}

function actionButtonClass(active: boolean) {
  return active
    ? "bg-ink text-white shadow-[0_8px_18px_rgba(15,23,42,0.16)]"
    : "bg-white text-ink hover:bg-mist";
}

function normalizeSearchNeedle(query: string) {
  return query.trim().toLowerCase();
}

function documentHistoryKey(document: Pick<DocumentRecord, "id">) {
  return document.id || "__active-draft__";
}

function countChangedCharacters(before: string, after: string) {
  if (before === after) return 0;

  let prefixLength = 0;
  while (
    prefixLength < before.length &&
    prefixLength < after.length &&
    before[prefixLength] === after[prefixLength]
  ) {
    prefixLength += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= prefixLength && afterEnd >= prefixLength && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const removed = Math.max(0, beforeEnd - prefixLength + 1);
  const added = Math.max(0, afterEnd - prefixLength + 1);
  return Math.max(removed, added);
}

function IconActionButton({
  active = false,
  children,
  disabled,
  label,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-full text-ink transition ${actionButtonClass(active)}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function MenuTriggerButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-medium transition ${menuButtonClass(active)}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function MenuDropdown({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const lastTouchYRef = useRef<number | null>(null);
  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    lastTouchYRef.current = containBoundaryTouch(event, lastTouchYRef.current);
  }, []);

  return (
    <Panel
      className="absolute left-0 right-0 top-full z-40 mt-2 overscroll-contain bg-[#fffdf8]/96 p-0 shadow-[0_20px_48px_rgba(15,23,42,0.14)] backdrop-blur"
      onTouchEndCapture={() => {
        lastTouchYRef.current = null;
      }}
      onTouchMoveCapture={handleTouchMove}
      onTouchStartCapture={(event) => {
        lastTouchYRef.current = event.touches[0]?.clientY ?? null;
      }}
      onWheelCapture={containBoundaryWheel}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.24em] text-ink/55">{title}</h2>
        <button
          aria-label={`Close ${title}`}
          className={`flex h-8 w-8 items-center justify-center rounded-full text-ink transition ${actionButtonClass(false)}`}
          onClick={onClose}
          type="button"
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          </svg>
        </button>
      </div>
      <div className="max-h-[70vh] overflow-auto overscroll-contain p-3 touch-pan-y">{children}</div>
    </Panel>
  );
}

function WorkspaceClientContent() {
  useServiceWorker();
  const { pushError } = useErrorToast();
  const deviceId = useMemo(() => getDeviceId(), []);
  const editorRef = useRef<RichEditorHandle>(null);
  const menuTouchYRef = useRef<number | null>(null);
  const noteSearchRef = useRef<{ noteId: string; query: string; index: number } | null>(null);
  const noteHistoryRef = useRef<Map<string, NoteHistoryState>>(new Map());
  const typingHistoryTrackerRef = useRef<Map<string, NoteTypingHistoryTracker>>(new Map());
  const cachedDocumentRef = useRef<DocumentRecord | null>(null);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [folderAssets, setFolderAssets] = useState<FolderAsset[]>([]);
  const [document, setDocument] = useState<DocumentRecord>(() => emptyDocument(deviceId, null));
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [settings, setSettings] = useState<ProviderSettings>(createDefaultSettings());
  const [recentDocumentIds, setRecentDocumentIds] = useState<string[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<string[]>([]);
  const [selectedFolderAsset, setSelectedFolderAsset] = useState<FolderAsset | null>(null);
  const [activeFolderAssetMenuId, setActiveFolderAssetMenuId] = useState<string | null>(null);
  const [renamingFolderAssetId, setRenamingFolderAssetId] = useState<string | null>(null);
  const [folderAssetRenameValue, setFolderAssetRenameValue] = useState("");
  const [renamingFolderAsset, setRenamingFolderAsset] = useState(false);
  const [activeAssetPickerMenuId, setActiveAssetPickerMenuId] = useState<string | null>(null);
  const [assetPickerKind, setAssetPickerKind] = useState<FolderAsset["kind"] | null>(null);
  const [assetPickerFolderId, setAssetPickerFolderId] = useState<string | null>(null);
  const [assetInsertionPlacement, setAssetInsertionPlacement] = useState<AssetInsertionPlacement>("cursor");
  const [syncStatus, setSyncStatus] = useState("Loading");
  const [uploading, setUploading] = useState(false);
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    setSettings((current) => ({ ...current, liveRecording: loadLiveRecordingSettings() }));
  }, []);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [folderCreateParentId, setFolderCreateParentId] = useState<string | null>(null);
  const [folderCreateName, setFolderCreateName] = useState("");
  const [activeWindow, setActiveWindow] = useState<WorkspaceWindow>(null);
  const [aiPanelMounted, setAiPanelMounted] = useState(false);
  const [aiPanelCompact, setAiPanelCompact] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [pendingAiAttachment, setPendingAiAttachment] = useState<PendingAiAttachment | null>(null);
  const [pendingAiEditPreview, setPendingAiEditPreview] = useState<PendingAiEditPreview | null>(null);
  const [pendingAiScroll, setPendingAiScroll] = useState<PendingAiScroll | null>(null);
  const [pendingEditorInsert, setPendingEditorInsert] = useState<PendingEditorInsert | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [headerRecentOpen, setHeaderRecentOpen] = useState(false);
  const [draggingItem, setDraggingItem] = useState<WorkspaceDragItem | null>(null);
  const [dragTargetFolderId, setDragTargetFolderId] = useState<string | null | undefined>(undefined);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const editorShellRef = useRef<HTMLDivElement>(null);
  const folderCreateInputRef = useRef<HTMLInputElement>(null);
  const documentRowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const copyResetTimerRef = useRef<number | null>(null);
  const messagesRef = useRef<AIMessage[]>([]);
  const idleTimerRef = useRef<number | null>(null);
  const undoNoticeTimerRef = useRef<number | null>(null);
  const undoLongPressTimerRef = useRef<number | null>(null);
  const handleMenuTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    menuTouchYRef.current = containBoundaryTouch(event, menuTouchYRef.current);
  }, []);
  const undoLongPressTriggeredRef = useRef(false);
  const wasIdleRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const syncDelayTimerRef = useRef<number | null>(null);
  const lastNoteChangeAtRef = useRef(0);
  const isEditingStateRef = useRef(isEditing);
  const documentStateRef = useRef(document);
  const dirtyStateRef = useRef(dirty);
  const skippedInitialCacheSaveRef = useRef(false);
  const refreshDocumentsFromServerRef = useRef<(statusWhenFresh?: string) => Promise<void>>(async () => {});
  const [previewUrlCopied, setPreviewUrlCopied] = useState(false);
  const [undoNoticeVisible, setUndoNoticeVisible] = useState(false);

  useEffect(() => {
    const cachedDocument = loadCachedDocument();
    cachedDocumentRef.current = cachedDocument;
    setRecentDocumentIds(loadRecentDocumentIds());

    if (cachedDocument) {
      documentStateRef.current = cachedDocument;
      setDocument(cachedDocument);
      setSelectedFolderId(cachedDocument.folderId);
    }
  }, []);

  useEffect(() => {
    if (!isEditing || !pendingEditorInsert) return;
    if (pendingEditorInsert.lineNumber) {
      editorRef.current?.insertAssetAtLine(pendingEditorInsert.asset, pendingEditorInsert.lineNumber);
    } else {
      editorRef.current?.insertAsset(pendingEditorInsert.asset, "cursor");
    }
    setPendingEditorInsert(null);
  }, [isEditing, pendingEditorInsert]);

  useEffect(() => {
    if (!isEditing || !pendingAiEditPreview) return;
    editorShellRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    editorRef.current?.focusRange(pendingAiEditPreview.firstStep.start, pendingAiEditPreview.firstStep.end);
  }, [isEditing, pendingAiEditPreview]);

  useEffect(() => {
    if (!isEditing || !pendingAiScroll) return;
    let restoreTimer: number | null = null;
    const scrollFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        editorRef.current?.scrollToLine(pendingAiScroll.lineNumber, pendingAiScroll.position);
        if (pendingAiScroll.restoreView) {
          restoreTimer = window.setTimeout(() => {
            setIsEditing(false);
            setPendingAiScroll(null);
          }, 700);
          return;
        }
        setPendingAiScroll(null);
      });
    });
    return () => {
      window.cancelAnimationFrame(scrollFrame);
      if (restoreTimer) window.clearTimeout(restoreTimer);
    };
  }, [isEditing, pendingAiScroll]);

  const documentsByFolder = useMemo(() => {
    const grouped = new Map<string, DocumentRecord[]>();
    grouped.set("root", []);
    for (const item of documents) {
      const key = item.folderId ?? "root";
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return grouped;
  }, [documents]);

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder] as const)), [folders]);
  const foldersByParent = useMemo(() => {
    const grouped = new Map<string | null, FolderRecord[]>();
    for (const folder of folders) {
      const key = folder.parentFolderId ?? null;
      grouped.set(key, [...(grouped.get(key) ?? []), folder]);
    }
    for (const [key, items] of grouped) {
      grouped.set(key, sortFolders(items));
    }
    return grouped;
  }, [folders]);
  const folderAssetsByFolder = useMemo(() => {
    const grouped = new Map<string | null, FolderAsset[]>();
    for (const asset of folderAssets) {
      const key = asset.folderId ?? null;
      grouped.set(key, [...(grouped.get(key) ?? []), asset]);
    }
    return grouped;
  }, [folderAssets]);
  const currentFolder = selectedFolderId ? folderById.get(selectedFolderId) ?? null : null;
  const recentDocuments = useMemo(
    () => recentDocumentIds.map((id) => documents.find((item) => item.id === id)).filter((item): item is DocumentRecord => Boolean(item)),
    [documents, recentDocumentIds],
  );
  const headerRecentDocuments = useMemo(
    () => recentDocuments.filter((item) => item.id !== document.id),
    [document.id, recentDocuments],
  );
  const inlineRecentDocuments = headerRecentDocuments.slice(0, RECENT_NOTE_INLINE_LIMIT);
  const dropdownRecentDocuments = headerRecentDocuments.slice(RECENT_NOTE_INLINE_LIMIT);
  const aiAvailableNotes = useMemo<AINoteReference[]>(
    () =>
      documents.map((item) => ({
        id: item.id,
        title: item.title || UNTITLED_NOTE_TITLE,
        folderName: item.folderId ? folderById.get(item.folderId)?.name ?? null : "Workspace",
      })),
    [documents, folderById],
  );
  const selectedFolderName = currentFolder?.name ?? "Workspace";
  const folderStorageBytesById = useMemo(() => {
    const cache = new Map<string, number>();
    const sumAssets = (assets: FolderAsset[]) => assets.reduce((total, asset) => total + asset.sizeBytes, 0);
    const compute = (folderId: string | null): number => {
      if (folderId === null) {
        return sumAssets(folderAssetsByFolder.get(null) ?? []) + (foldersByParent.get(null) ?? []).reduce((total, folder) => total + compute(folder.id), 0);
      }
      if (cache.has(folderId)) return cache.get(folderId) ?? 0;
      const total =
        sumAssets(folderAssetsByFolder.get(folderId) ?? []) +
        (foldersByParent.get(folderId) ?? []).reduce((nextTotal, child) => nextTotal + compute(child.id), 0);
      cache.set(folderId, total);
      return total;
    };

    for (const folder of folders) {
      compute(folder.id);
    }
    return cache;
  }, [folderAssetsByFolder, folders, foldersByParent]);
  const workspaceStorageBytes = useMemo(() => {
    const sumAssets = (assets: FolderAsset[]) => assets.reduce((total, asset) => total + asset.sizeBytes, 0);
    const compute = (folderId: string | null): number => {
      if (folderId === null) {
        return sumAssets(folderAssetsByFolder.get(null) ?? []) + (foldersByParent.get(null) ?? []).reduce((total, folder) => total + compute(folder.id), 0);
      }
      return (
        sumAssets(folderAssetsByFolder.get(folderId) ?? []) +
        (foldersByParent.get(folderId) ?? []).reduce((total, child) => total + compute(child.id), 0)
      );
    };
    return compute(null);
  }, [folderAssetsByFolder, foldersByParent]);

  const currentFolderBranchIds = useMemo(() => {
    if (!currentFolder) return new Set<string>();
    const branch = new Set<string>();
    const stack = [currentFolder.id];
    while (stack.length > 0) {
      const folderId = stack.pop();
      if (!folderId || branch.has(folderId)) continue;
      branch.add(folderId);
      for (const child of foldersByParent.get(folderId) ?? []) {
        stack.push(child.id);
      }
    }
    return branch;
  }, [currentFolder, foldersByParent]);
  const aiCurrentFolderFiles = useMemo(
    () =>
      folderAssets
        .filter((asset) => (currentFolder ? asset.folderId !== null && currentFolderBranchIds.has(asset.folderId) : true))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [currentFolder, currentFolderBranchIds, folderAssets],
  );
  const currentFolderStorageBytes = currentFolder ? folderStorageBytesById.get(currentFolder.id) ?? 0 : workspaceStorageBytes;
  const currentFolderAssetCount = useMemo(() => {
    if (!currentFolder) return folderAssets.length;
    let count = 0;
    for (const folderId of currentFolderBranchIds) {
      count += folderAssetsByFolder.get(folderId)?.length ?? 0;
    }
    return count;
  }, [currentFolder, currentFolderBranchIds, folderAssets, folderAssetsByFolder]);
  const workspaceRootFolders = foldersByParent.get(null) ?? [];
  const workspaceRootNotes = documentsByFolder.get("root") ?? [];
  const workspaceRootAssets = folderAssetsByFolder.get(null) ?? [];
  const hasWorkspaceRootItems = workspaceRootFolders.length + workspaceRootNotes.length + workspaceRootAssets.length > 0;
  const libraryFolders = workspaceRootFolders;
  const assetPickerBranchIds = useMemo(() => {
    if (!assetPickerFolderId) return new Set<string>();
    const branch = new Set<string>();
    const stack = [assetPickerFolderId];
    while (stack.length > 0) {
      const folderId = stack.pop();
      if (!folderId || branch.has(folderId)) continue;
      branch.add(folderId);
      for (const child of foldersByParent.get(folderId) ?? []) {
        stack.push(child.id);
      }
    }
    return branch;
  }, [assetPickerFolderId, foldersByParent]);
  const assetPickerAssets = useMemo(() => {
    if (!assetPickerKind) return [];
    const scopeFolderId = assetPickerFolderId;
    return folderAssets
      .filter((asset) => asset.kind === assetPickerKind)
      .filter((asset) =>
        scopeFolderId === null ? asset.folderId === null : asset.folderId !== null && assetPickerBranchIds.has(asset.folderId),
      );
  }, [assetPickerBranchIds, assetPickerFolderId, assetPickerKind, folderAssets]);
  const currentHistoryStatus = useMemo(() => {
    const history = noteHistoryRef.current.get(documentHistoryKey(document));
    return {
      canRedo: Boolean(history?.redo.length),
      canUndo: Boolean(history?.undo.length),
    };
  }, [document.id, historyVersion]);

  useEffect(() => {
    documentStateRef.current = document;
  }, [document]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    dirtyStateRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    isEditingStateRef.current = isEditing;
  }, [isEditing]);

  useEffect(
    () => () => {
      if (undoNoticeTimerRef.current) {
        window.clearTimeout(undoNoticeTimerRef.current);
        undoNoticeTimerRef.current = null;
      }
      if (undoLongPressTimerRef.current) {
        window.clearTimeout(undoLongPressTimerRef.current);
        undoLongPressTimerRef.current = null;
      }
      if (syncDelayTimerRef.current) {
        window.clearTimeout(syncDelayTimerRef.current);
        syncDelayTimerRef.current = null;
      }
    },
    [],
  );

  const markRecentDocument = (id: string) => {
    setRecentDocumentIds((current) => {
      const next = [id, ...current.filter((item) => item !== id)].slice(0, RECENT_NOTE_HISTORY_LIMIT);
      saveRecentDocumentIds(next);
      return next;
    });
  };

  const expandFolderPath = (folderId: string | null) => {
    if (!folderId) return;
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      let cursor: string | null = folderId;

      while (cursor) {
        next.add(cursor);
        cursor = folderById.get(cursor)?.parentFolderId ?? null;
      }

      return Array.from(next);
    });
  };

  const syncDocumentSnapshot = async (snapshot: DocumentRecord) => {
    if (!snapshot.id) return false;
    if (syncInFlightRef.current) {
      window.setTimeout(() => void syncDocumentSnapshot(snapshot), 300);
      return false;
    }

    syncInFlightRef.current = true;
    setSyncStatus("Syncing");
    try {
      const result = await apiClient.syncDocument(snapshot.id, buildSyncPayload(snapshot, deviceId));
      const normalizedDocument = normalizeDocumentRecord(result.document);
      setDocuments((current) => upsertDocument(current, normalizedDocument));

      if (documentStateRef.current.id === normalizedDocument.id) {
        documentStateRef.current = normalizedDocument;
        dirtyStateRef.current = false;
        setDocument(normalizedDocument);
        setDirty(false);
        saveCachedDocument(normalizedDocument);
        setSyncStatus(result.conflict ? "Conflict" : "Synced");
      } else {
        setSyncStatus(result.conflict ? "Conflict" : "Live");
      }

      if (result.conflict) pushError(result.message ?? "Sync conflict detected");
      return true;
    } catch (error) {
      setSyncStatus("Offline");
      pushError(error instanceof Error ? error.message : "Sync failed");
      return false;
    } finally {
      syncInFlightRef.current = false;
    }
  };

  const selectDocument = (next: DocumentRecord, options?: { preserveActiveWindow?: boolean }) => {
    editorRef.current?.flushBodyChanges();
    const previousDocument = documentStateRef.current;
    const shouldSyncPrevious = dirtyStateRef.current && previousDocument.id !== next.id;

    clearDelayedSync();
    documentStateRef.current = next;
    dirtyStateRef.current = false;
    setDocument(next);
    setDirty(false);
    setIsEditing(false);
    setPendingAiEditPreview(null);
    setSelectedFolderId(next.folderId);
    setSelectedFolderAsset(null);
    setSelectedText("");
    setSyncStatus("Live");
    saveCachedDocument(next);
    markRecentDocument(next.id);
    expandFolderPath(next.folderId);
    if (!options?.preserveActiveWindow) {
      setActiveWindow(null);
    }

    if (shouldSyncPrevious) {
      void syncDocumentSnapshot(previousDocument);
    }
  };

  const toggleWindow = (windowName: WorkspaceWindow) => {
    setActiveWindow((current) => {
      const nextWindow = current === windowName ? null : windowName;
      if (nextWindow === "ai") {
        setAiPanelCompact(false);
      }
      return nextWindow;
    });
  };

  useEffect(() => {
    if (activeWindow !== "library") return;
    expandFolderPath(document.folderId);
    const firstFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        documentRowRefs.current.get(document.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
    return () => window.cancelAnimationFrame(firstFrame);
  }, [activeWindow, document.folderId, document.id]);

  useEffect(() => {
    if (activeWindow === "ai") {
      setAiPanelMounted(true);
    }
  }, [activeWindow]);

  const enterEditMode = () => {
    const currentDocument = documentStateRef.current;
    const paddedBodyMarkdown = ensureTrailingNewlines(currentDocument.bodyMarkdown);
    if (paddedBodyMarkdown !== currentDocument.bodyMarkdown) {
      updateDocument({ bodyMarkdown: paddedBodyMarkdown });
    }
    setIsEditing(true);
  };

  const compactAiPanelForNote = () => {
    if (activeWindow === "ai") {
      setAiPanelCompact(true);
    }
  };

  useEffect(() => {
    noteSearchRef.current = null;
  }, [document.id]);

  const expandAiPanelToUserHeight = () => {
    setAiPanelCompact(false);
  };

  const exitEditMode = () => {
    setIsEditing(false);
    setPendingAiEditPreview(null);
    setActiveWindow((current) => (current === "format" || current === "create" ? null : current));
  };

  const runEditorCommand = (command: EditorCommand) => {
    if (!isEditing) {
      pushError("Click the edit button on the note to enter edit mode.");
      return;
    }
    editorRef.current?.runCommand(command);
  };

  const clearDelayedSync = () => {
    if (!syncDelayTimerRef.current) return;
    window.clearTimeout(syncDelayTimerRef.current);
    syncDelayTimerRef.current = null;
  };

  const isNoteChangeSyncPaused = () => Date.now() - lastNoteChangeAtRef.current < NOTE_CHANGE_SYNC_DELAY_MS;

  const markNoteChangeForSyncDelay = () => {
    lastNoteChangeAtRef.current = Date.now();
  };

  const shouldDelaySyncForBodyChange = (reason?: BodyHistoryReason) =>
    !reason || reason === "typing" || reason === "paste" || reason === "cut" || reason === "delete";

  const syncDirtyDocument = async () => {
    if (!dirtyStateRef.current) return false;
    if (syncInFlightRef.current) {
      scheduleDelayedSync();
      return false;
    }
    if (isNoteChangeSyncPaused()) {
      scheduleDelayedSync();
      return false;
    }

    syncInFlightRef.current = true;
    try {
      const currentDocument = documentStateRef.current;
      if (!currentDocument.id) return false;
      const shouldRestoreEditorFocus = isEditingStateRef.current && Boolean(editorRef.current?.isBodyFocused());
      const restoreLineNumber = shouldRestoreEditorFocus ? editorRef.current?.getCursorLineNumber() ?? null : null;
      const result = await apiClient.syncDocument(currentDocument.id, buildSyncPayload(currentDocument, deviceId));
      const normalizedDocument = normalizeDocumentRecord(result.document);
      documentStateRef.current = normalizedDocument;
      dirtyStateRef.current = false;
      setDocument(normalizedDocument);
      setDocuments((current) => upsertDocument(current, normalizedDocument));
      setDirty(false);
      setSyncStatus(result.conflict ? "Conflict" : "Synced");
      saveCachedDocument(normalizedDocument);
      if (restoreLineNumber !== null) {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (!editorRef.current?.isBodyFocused()) {
              editorRef.current?.focusLineEnd(restoreLineNumber);
            }
          });
        });
      }
      if (result.conflict) pushError(result.message ?? "Sync conflict detected");
      return true;
    } catch (error) {
      setSyncStatus("Offline");
      pushError(error instanceof Error ? error.message : "Sync failed");
      return false;
    } finally {
      syncInFlightRef.current = false;
    }
  };

  function scheduleDelayedSync(delayMs = NOTE_CHANGE_SYNC_DELAY_MS) {
    clearDelayedSync();
    const elapsedSinceChange = Date.now() - lastNoteChangeAtRef.current;
    const nextDelayMs =
      elapsedSinceChange < NOTE_CHANGE_SYNC_DELAY_MS ? Math.max(NOTE_CHANGE_SYNC_DELAY_MS - elapsedSinceChange, delayMs) : delayMs;

    syncDelayTimerRef.current = window.setTimeout(() => {
      syncDelayTimerRef.current = null;
      void syncDirtyDocument();
    }, nextDelayMs);
  }

  refreshDocumentsFromServerRef.current = async (statusWhenFresh = "Live") => {
    if (syncInFlightRef.current) return;
    if (isNoteChangeSyncPaused()) return;
    syncInFlightRef.current = true;
    try {
      const remoteDocs = (await apiClient.listDocuments()).map(normalizeDocumentRecord);
      setDocuments(sortDocuments(remoteDocs));

      const currentDocument = documentStateRef.current;
      const latest = remoteDocs.find((item) => item.id === currentDocument.id);

      if (latest && shouldApplyRemote(dirtyStateRef.current, latest.revision, currentDocument.revision)) {
        documentStateRef.current = latest;
        setDocument(latest);
        saveCachedDocument(latest);
        setSyncStatus("Updated");
        return;
      }

      if (!dirtyStateRef.current) {
        setSyncStatus(statusWhenFresh);
      }
    } catch (error) {
      setSyncStatus("Offline");
      pushError(error instanceof Error ? error.message : "Sync failed");
    } finally {
      syncInFlightRef.current = false;
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const [remoteFolders, remoteDocs, remoteFolderAssets, remoteSettings] = await Promise.all([
          apiClient.listFolders(),
          apiClient.listDocuments(),
          apiClient.listFolderAssets(),
          apiClient.getSettings(),
        ]);
        const normalizedRemoteDocs = remoteDocs.map(normalizeDocumentRecord);
        setFolders(sortFolders(remoteFolders));
        setSettings({ ...remoteSettings, liveRecording: loadLiveRecordingSettings() });
        setDocuments(sortDocuments(normalizedRemoteDocs));
        setFolderAssets(remoteFolderAssets);

        void apiClient
          .listPrompts()
          .then((remotePrompts) => setPromptTemplates(remotePrompts))
          .catch(() => setPromptTemplates([]));

        if (normalizedRemoteDocs[0]) {
          const cachedDocument = cachedDocumentRef.current;
          const initialDocument =
            (cachedDocument && normalizedRemoteDocs.find((item) => item.id === cachedDocument.id)) ?? normalizedRemoteDocs[0];
          selectDocument(initialDocument);
          setSyncStatus("Live");
          return;
        }

        const defaultFolder =
          findFolderByName(remoteFolders, DEFAULT_FOLDER_NAME, null) ??
          (await apiClient.createFolder({
            name: DEFAULT_FOLDER_NAME,
            parentFolderId: null,
          }));
        const nextFolders = remoteFolders.some((folder) => folder.id === defaultFolder.id) ? remoteFolders : [...remoteFolders, defaultFolder];
        setFolders(sortFolders(nextFolders));

        const created = normalizeDocumentRecord(await apiClient.createDocument({
          title: WELCOME_NOTE_TITLE,
          bodyMarkdown: await loadNoteTemplate("welcome"),
          deviceId,
          folderId: defaultFolder.id,
        }));
        setDocuments([created]);
        selectDocument(created);
        setSyncStatus("Live");
      } catch (error) {
        setSyncStatus("Offline");
        pushError(error instanceof Error ? error.message : "Failed to load workspace");
      }
    })();
  }, [deviceId, pushError]);

  useEffect(() => {
    if (!skippedInitialCacheSaveRef.current) {
      skippedInitialCacheSaveRef.current = true;
      return;
    }
    saveCachedDocument(document);
  }, [document]);

  useEffect(() => {
    if (!document.id) return;
    const interval = window.setInterval(async () => {
      if (syncInFlightRef.current) return;
      if (isNoteChangeSyncPaused()) return;

      try {
        if (dirtyStateRef.current) {
          await syncDirtyDocument();
          return;
        }

        await refreshDocumentsFromServerRef.current();
      } catch (error) {
        setSyncStatus("Offline");
        pushError(error instanceof Error ? error.message : "Sync failed");
      } finally {
        syncInFlightRef.current = false;
      }
    }, BACKGROUND_SYNC_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [deviceId, document.id, pushError]);

  useEffect(() => {
    const scheduleIdle = () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        wasIdleRef.current = true;
      }, 10000);
    };

    const handleInteraction = () => {
      const shouldRefresh = wasIdleRef.current;
      wasIdleRef.current = false;
      scheduleIdle();

      if (shouldRefresh) {
        void refreshDocumentsFromServerRef.current();
      }
    };

    scheduleIdle();
    window.addEventListener("pointerdown", handleInteraction);
    window.addEventListener("keydown", handleInteraction);
    window.addEventListener("focus", handleInteraction);

    return () => {
      window.removeEventListener("pointerdown", handleInteraction);
      window.removeEventListener("keydown", handleInteraction);
      window.removeEventListener("focus", handleInteraction);
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, []);

  const updateDocument = (next: Partial<DocumentRecord>) => {
    markNoteChangeForSyncDelay();
    const updated = { ...documentStateRef.current, ...next, updatedAt: new Date().toISOString() };
    documentStateRef.current = updated;
    setDocument(updated);
    setDocuments((currentDocuments) => upsertDocument(currentDocuments, updated));
    saveCachedDocument(updated);
    dirtyStateRef.current = true;
    setDirty(true);
    setSyncStatus("Pending");
    scheduleDelayedSync();
  };

  const getNoteHistory = (noteId: string) => {
    const existing = noteHistoryRef.current.get(noteId);
    if (existing) return existing;
    const created: NoteHistoryState = { redo: [], undo: [] };
    noteHistoryRef.current.set(noteId, created);
    return created;
  };

  const bumpHistoryVersion = () => setHistoryVersion((current) => current + 1);

  const clearRedoHistory = (noteId: string) => {
    const history = noteHistoryRef.current.get(noteId);
    if (!history || history.redo.length === 0) return;
    history.redo = [];
    bumpHistoryVersion();
  };

  const clearTypingHistoryTracker = (noteId: string) => {
    typingHistoryTrackerRef.current.delete(noteId);
  };

  const pushUndoSnapshot = (noteId: string, bodyMarkdown: string) => {
    const history = getNoteHistory(noteId);
    let changed = false;
    if (history.undo[history.undo.length - 1]?.bodyMarkdown !== bodyMarkdown) {
      history.undo = [...history.undo, { bodyMarkdown }].slice(-NOTE_HISTORY_LIMIT);
      changed = true;
    }
    if (history.redo.length > 0) {
      history.redo = [];
      changed = true;
    }
    if (changed) bumpHistoryVersion();
  };

  const pushRedoSnapshot = (noteId: string, bodyMarkdown: string) => {
    const history = getNoteHistory(noteId);
    history.redo = [...history.redo, { bodyMarkdown }].slice(-NOTE_HISTORY_LIMIT);
  };

  const prepareBodyHistory = (nextBodyMarkdown: string, reason: BodyHistoryReason = "typing") => {
    const currentDocument = documentStateRef.current;
    const currentBodyMarkdown = currentDocument.bodyMarkdown;
    if (nextBodyMarkdown === currentBodyMarkdown || reason === "normalize") return;

    const noteId = documentHistoryKey(currentDocument);
    if (reason === "typing") {
      const changedCharacters = countChangedCharacters(currentBodyMarkdown, nextBodyMarkdown);
      if (changedCharacters <= 0) return;

      const existingTracker = typingHistoryTrackerRef.current.get(noteId);
      const tracker =
        existingTracker ??
        ({
          baselineBodyMarkdown: currentBodyMarkdown,
          changedCharacters: 0,
        } satisfies NoteTypingHistoryTracker);

      tracker.changedCharacters += changedCharacters;
      if (tracker.changedCharacters >= NOTE_TYPING_CHECKPOINT_CHARS) {
        pushUndoSnapshot(noteId, tracker.baselineBodyMarkdown);
        typingHistoryTrackerRef.current.set(noteId, {
          baselineBodyMarkdown: nextBodyMarkdown,
          changedCharacters: 0,
        });
        return;
      }

      typingHistoryTrackerRef.current.set(noteId, tracker);
      clearRedoHistory(noteId);
      return;
    }

    clearTypingHistoryTracker(noteId);
    pushUndoSnapshot(noteId, currentBodyMarkdown);
  };

  const updateDocumentBody = (bodyMarkdown: string, reason: BodyHistoryReason = "typing") => {
    prepareBodyHistory(bodyMarkdown, reason);
    if (shouldDelaySyncForBodyChange(reason)) {
      markNoteChangeForSyncDelay();
    }
    updateDocument({ bodyMarkdown });
  };

  const showUndoNotice = () => {
    setUndoNoticeVisible(true);
    if (undoNoticeTimerRef.current) {
      window.clearTimeout(undoNoticeTimerRef.current);
    }
    undoNoticeTimerRef.current = window.setTimeout(() => {
      setUndoNoticeVisible(false);
      undoNoticeTimerRef.current = null;
    }, UNDO_NOTICE_MS);
  };

  const undoCurrentNoteEdit = () => {
    editorRef.current?.flushBodyChanges();
    const currentDocument = documentStateRef.current;
    const noteId = documentHistoryKey(currentDocument);
    const history = getNoteHistory(noteId);
    let snapshot = history.undo.pop();

    while (snapshot && snapshot.bodyMarkdown === currentDocument.bodyMarkdown) {
      snapshot = history.undo.pop();
    }

    if (!snapshot) {
      bumpHistoryVersion();
      pushError("Nothing to undo for this note.");
      return;
    }

    pushRedoSnapshot(noteId, currentDocument.bodyMarkdown);
    clearTypingHistoryTracker(noteId);
    bumpHistoryVersion();
    updateDocument({ bodyMarkdown: snapshot.bodyMarkdown });
  };

  const redoCurrentNoteEdit = () => {
    editorRef.current?.flushBodyChanges();
    const currentDocument = documentStateRef.current;
    const noteId = documentHistoryKey(currentDocument);
    const history = getNoteHistory(noteId);
    let snapshot = history.redo.pop();

    while (snapshot && snapshot.bodyMarkdown === currentDocument.bodyMarkdown) {
      snapshot = history.redo.pop();
    }

    if (!snapshot) {
      bumpHistoryVersion();
      pushError("Nothing to redo for this note.");
      return;
    }

    history.undo = [...history.undo, { bodyMarkdown: currentDocument.bodyMarkdown }].slice(-NOTE_HISTORY_LIMIT);
    clearTypingHistoryTracker(noteId);
    bumpHistoryVersion();
    updateDocument({ bodyMarkdown: snapshot.bodyMarkdown });
  };

  const clearUndoLongPressTimer = () => {
    if (!undoLongPressTimerRef.current) return;
    window.clearTimeout(undoLongPressTimerRef.current);
    undoLongPressTimerRef.current = null;
  };

  const startUndoLongPressTimer = () => {
    clearUndoLongPressTimer();
    undoLongPressTriggeredRef.current = false;
    undoLongPressTimerRef.current = window.setTimeout(() => {
      undoLongPressTimerRef.current = null;
      undoLongPressTriggeredRef.current = true;
      redoCurrentNoteEdit();
    }, UNDO_LONG_PRESS_MS);
  };

  const handleUndoButtonClick = () => {
    if (undoLongPressTriggeredRef.current) {
      undoLongPressTriggeredRef.current = false;
      return;
    }
    showUndoNotice();
    undoCurrentNoteEdit();
  };

  const applyAiEdits = (edits: TextSubstitution[]) => {
    if (edits.length === 0) return;
    const replay = buildSubstitutionReplay(document.bodyMarkdown, edits);
    if (replay.steps.length === 0) {
      pushError("The suggested edit text could not be found in this note.");
      return;
    }
    setPendingAiEditPreview({
      nextBodyMarkdown: replay.next,
      stepCount: replay.steps.length,
      firstStep: replay.steps[0],
      skippedCount: replay.unapplied.length,
    });
    enterEditMode();
  };

  const confirmAiEdits = () => {
    if (!pendingAiEditPreview) return;
    const { firstStep, nextBodyMarkdown } = pendingAiEditPreview;
    updateDocumentBody(ensureTrailingNewlines(nextBodyMarkdown), "ai");
    setPendingAiEditPreview(null);
    window.requestAnimationFrame(() => {
      editorRef.current?.focusRange(firstStep.start, firstStep.start + firstStep.replace.length);
    });
  };

  useEffect(() => {
    if (!folderCreateOpen) return;
    const timer = window.setTimeout(() => {
      folderCreateInputRef.current?.focus();
      folderCreateInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [folderCreateOpen, folderCreateParentId]);

  const openFolderCreateForm = (parentFolderId: string | null) => {
    setFolderCreateParentId(parentFolderId);
    setFolderCreateName("");
    setFolderCreateOpen(true);
    setActiveWindow("library");
  };

  const cancelFolderCreate = () => {
    setFolderCreateOpen(false);
    setFolderCreateName("");
    setFolderCreateParentId(null);
  };

  const createFolder = async (parentFolderId: string | null, name: string) => {
    if (!name) return;
    setCreatingFolder(true);
    try {
      const created = await apiClient.createFolder({ name, parentFolderId });
      setFolders((current) => sortFolders([...current, created]));
      setSelectedFolderId(created.id);
      expandFolderPath(created.id);
      if (folderCreateOpen && folderCreateParentId === parentFolderId) {
        cancelFolderCreate();
      }
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Failed to create folder");
    } finally {
      setCreatingFolder(false);
    }
  };

  const submitFolderCreate = async () => {
    await createFolder(folderCreateParentId, folderCreateName.trim());
  };

  const expandUploadFolderPath = (uploadFolder: FolderRecord) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      next.add(uploadFolder.id);

      let cursor = uploadFolder.parentFolderId;
      while (cursor) {
        next.add(cursor);
        cursor = folderById.get(cursor)?.parentFolderId ?? null;
      }

      return Array.from(next);
    });
  };

  const isInUploadFolderPath = (folderId: string | null) => {
    let cursor = folderId;
    while (cursor) {
      const folder = folderById.get(cursor);
      if (!folder) return false;
      if (folder.name.toLowerCase() === "upload") return true;
      cursor = folder.parentFolderId;
    }
    return false;
  };

  const ensureUploadFolder = async (parentFolderId: string | null) => {
    const currentFolder = parentFolderId ? folderById.get(parentFolderId) ?? null : null;
    if (currentFolder && isInUploadFolderPath(parentFolderId)) {
      expandFolderPath(parentFolderId);
      return currentFolder;
    }

    const existing = (foldersByParent.get(parentFolderId) ?? []).find((folder) => folder.name.toLowerCase() === "upload");
    if (existing) {
      expandFolderPath(existing.id);
      return existing;
    }

    const created = await apiClient.createFolder({ name: "upload", parentFolderId });
    setFolders((current) => sortFolders([...current, created]));
    expandUploadFolderPath(created);
    return created;
  };

  const createNote = async (folderId: string | null) => {
    setCreatingNote(true);
    try {
      const created = normalizeDocumentRecord(await apiClient.createDocument({
        title: UNTITLED_NOTE_TITLE,
        bodyMarkdown: await loadNoteTemplate("untitled"),
        deviceId,
        folderId,
      }));
      setDocuments((current) => upsertDocument(current, created));
      setMessages([]);
      setSelectedText("");
      setDirty(false);
      setSyncStatus("Live");
      selectDocument(created);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Failed to create note");
    } finally {
      setCreatingNote(false);
    }
  };

  const inferAssetKind = (file: File): FolderAsset["kind"] | null => {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("audio/")) return "audio";
    if (file.type.startsWith("video/")) return "video";
    return null;
  };

  const uploadFolderAsset = async (folderId: string | null, file: File, options?: { insertIntoNote?: boolean }) => {
    const kind = inferAssetKind(file);
    if (!kind) {
      pushError("Only image, audio, and video files are supported.");
      return null;
    }
    setUploading(true);
    try {
      const uploadFolder = await ensureUploadFolder(folderId);
      const asset = await apiClient.uploadFolderAsset(uploadFolder.id, file, kind);
      setFolderAssets((current) => [asset, ...current]);
      if (assetPickerKind === kind && (assetPickerFolderId === folderId || assetPickerFolderId === uploadFolder.id)) {
        setAssetPickerKind(kind);
      }
      if (options?.insertIntoNote) {
        editorRef.current?.insertAsset(asset, "cursor");
      }
      return asset;
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Media upload failed");
      return null;
    } finally {
      setUploading(false);
    }
  };

  const uploadAiImageToCurrentFolder = async (attachment: { fileName: string; mimeType: string; previewUrl: string }) => {
    try {
      const response = await fetch(attachment.previewUrl);
      if (!response.ok) {
        throw new Error(`Failed to load ${attachment.fileName}.`);
      }
      const blob = await response.blob();
      const file = new File([blob], attachment.fileName, {
        type: attachment.mimeType || blob.type || "image/png",
        lastModified: Date.now(),
      });
      return await uploadFolderAsset(selectedFolderId, file);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Failed to upload image to the current folder");
      return null;
    }
  };

  const pickFolderUpload = (folderId: string | null, options?: { accept?: string; insertIntoNote?: boolean }) => {
    const input = window.document.createElement("input");
    input.type = "file";
    input.accept = options?.accept ?? "image/*,audio/*,video/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await uploadFolderAsset(folderId, file, options);
    };
    input.click();
  };

  const openAssetPicker = (kind: FolderAsset["kind"]) => {
    if (!isEditing) {
      pushError("Click the edit button on the note to enter edit mode.");
      return;
    }
    setAssetPickerKind(kind);
    setAssetPickerFolderId(selectedFolderId);
    setAssetInsertionPlacement("cursor");
    setActiveAssetPickerMenuId(null);
    setActiveWindow("create");
  };

  const addNoteMediaToAi = (attachment: PendingAiAttachment) => {
    setPendingAiAttachment(attachment);
    setActiveWindow("ai");
  };

  const addAiAttachmentToNote = (attachment: AIMessageAttachment, options?: { lineNumber?: number }) => {
    if (attachment.kind !== "image" || !attachment.url) {
      pushError("Only generated images can be inserted into the note.");
      return;
    }

    const asset: FolderAsset = {
      id: attachment.id,
      folderId: selectedFolderId,
      kind: "image",
      url: attachment.url,
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      sizeBytes: 0,
      createdAt: new Date().toISOString(),
    };

    if (!isEditing) {
      setPendingEditorInsert({ asset, lineNumber: options?.lineNumber });
      enterEditMode();
      return;
    }

    if (options?.lineNumber) {
      editorRef.current?.insertAssetAtLine(asset, options.lineNumber);
      return;
    }

    editorRef.current?.insertAsset(asset, "cursor");
  };

  const insertAiImageFileIntoNote = async (attachment: { fileName: string; mimeType: string; previewUrl: string }, lineNumber?: number) => {
    const asset = await uploadAiImageToCurrentFolder(attachment);
    if (!asset) return false;

    if (!isEditing) {
      setPendingEditorInsert({ asset, lineNumber });
      enterEditMode();
      return true;
    }

    if (lineNumber) {
      editorRef.current?.insertAssetAtLine(asset, lineNumber);
    } else {
      editorRef.current?.insertAsset(asset, "cursor");
    }
    return true;
  };

  const appendAiSummaryToCurrentNote = (summaryMarkdown: string) => {
    const trimmedSummary = summaryMarkdown.trim();
    if (!trimmedSummary) return;
    const currentBody = documentStateRef.current.bodyMarkdown;
    const separator = currentBody.trim() ? "\n\n" : "";
    updateDocumentBody(ensureTrailingNewlines(`${currentBody.replace(/\s+$/g, "")}${separator}${trimmedSummary}`), "ai");
  };

  const latestGeneratedImageAttachment = (preferred: AIMessageAttachment[] = []) =>
    [...messagesRef.current.flatMap((message) => (message.role === "assistant" ? message.attachments ?? [] : [])), ...preferred]
      .reverse()
      .find((attachment) => attachment.kind === "image" && attachment.origin === "generated" && Boolean(attachment.url)) ?? null;

  const openNoteByAiAction = (action: { noteId?: string; title?: string }) => {
    const normalizedTitle = action.title?.trim().toLowerCase();
    const target =
      documents.find((item) => action.noteId && item.id === action.noteId) ??
      documents.find((item) => normalizedTitle && (item.title || UNTITLED_NOTE_TITLE).trim().toLowerCase() === normalizedTitle);

    if (!target) {
      pushError(action.title ? `Note not found: ${action.title}` : "The note requested by AI was not found.");
      return false;
    }

    selectDocument(target, { preserveActiveWindow: true });
    noteSearchRef.current = null;
    return true;
  };

  const scrollNoteByAiAction = (action: { target: "top" | "middle" | "bottom" | "line" | "up" | "down"; lineNumber?: number; pixels?: number }) => {
    if (action.target === "up" || action.target === "down") {
      const pixels = Math.max(1, Math.floor(action.pixels ?? 300));
      editorRef.current?.scrollByPixels(action.target === "up" ? -pixels : pixels);
      return true;
    }

    const lineCount = Math.max(1, document.bodyMarkdown.split("\n").length);
    const scrollToEditorLine = (lineNumber: number, position: "top" | "middle" | "bottom") => {
      const restoreView = !isEditing;
      setPendingAiScroll({ lineNumber, position, restoreView });
      if (restoreView) {
        setIsEditing(true);
        return;
      }
      editorRef.current?.scrollToLine(lineNumber, position);
    };

    if (action.target === "line") {
      const lineNumber = Math.max(1, Math.floor(action.lineNumber ?? 1));
      scrollToEditorLine(lineNumber, "top");
      return true;
    }

    const position = action.target;
    const lineNumber =
      position === "bottom" ? lineCount : position === "middle" ? Math.ceil(lineCount / 2) : 1;
    scrollToEditorLine(lineNumber, position);
    return true;
  };

  const findNoteByAiAction = (action: { query: string; occurrence?: "first" | "next" | "previous" }) => {
    const query = action.query.trim();
    if (!query) return false;
    const needle = normalizeSearchNeedle(query);
    const body = document.bodyMarkdown.toLowerCase();
    const matches: Array<{ start: number; end: number }> = [];
    let index = body.indexOf(needle);
    while (index >= 0) {
      matches.push({ start: index, end: index + needle.length });
      index = body.indexOf(needle, index + needle.length);
    }
    if (matches.length === 0) {
      pushError(`No match found for: ${query}`);
      return false;
    }

    const occurrence = action.occurrence ?? "next";
    const searchState = noteSearchRef.current;
    let targetIndex = 0;
    if (occurrence === "previous") {
      targetIndex = searchState?.query === needle ? (searchState.index - 1 + matches.length) % matches.length : matches.length - 1;
    } else if (occurrence === "next") {
      targetIndex = searchState?.query === needle ? (searchState.index + 1) % matches.length : 0;
    } else if (occurrence === "first") {
      targetIndex = 0;
    }
    const target = matches[targetIndex];
    noteSearchRef.current = { noteId: document.id, query: needle, index: targetIndex };
    editorRef.current?.focusRange(target.start, target.end);
    return true;
  };

  const handleAiActions = async (actions: AIResponseAction[] | undefined, generatedAttachments: AIMessageAttachment[]) => {
    if (!actions?.length) return;

    for (const action of actions) {
      if (action.type === "open_note") {
        openNoteByAiAction(action);
        continue;
      }

      if (action.type === "scroll_note") {
        scrollNoteByAiAction(action);
        continue;
      }

      if (action.type === "find_note") {
        findNoteByAiAction(action);
        continue;
      }

      const latestImage = latestGeneratedImageAttachment(generatedAttachments);
      if (!latestImage?.url) {
        pushError("No generated image is available for that AI action.");
        continue;
      }

      if (action.type === "upload_latest_image") {
        await uploadAiImageToCurrentFolder({
          fileName: latestImage.fileName,
          mimeType: latestImage.mimeType,
          previewUrl: latestImage.url,
        });
        continue;
      }

      if (action.type === "insert_latest_image") {
        addAiAttachmentToNote(latestImage, { lineNumber: action.lineNumber });
      }
    }
  };

  const askAi = async ({
    prompt,
    attachments,
    messageAttachments,
    mode,
    prompts,
    displayPrompt,
    signal,
  }: {
    prompt: string;
    attachments: AIRequestAttachment[];
    messageAttachments: AIMessage["attachments"];
    mode: AIRequestMode;
    prompts: AIMessagePrompt[];
    displayPrompt?: string;
    signal?: AbortSignal;
  }) => {
    setThinking(true);
    const promptSummary =
      displayPrompt?.trim() ||
      prompt.trim() ||
      (prompts.length > 0 ? `Use prompts: ${prompts.map((item) => item.name).join(", ")}` : "Analyze the attached media.");
    const userMessage: AIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: promptSummary,
      createdAt: new Date().toISOString(),
      attachments: messageAttachments,
      prompts,
    };
    const assistantMessageId = crypto.randomUUID();
    setMessages((current) => [...current, userMessage]);
    try {
      setMessages((current) => [
        ...current,
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          substitutions: [],
        },
      ]);

      await apiClient.askAiStream({
        prompt,
        title: document.title,
        bodyMarkdown: document.bodyMarkdown,
        mode,
        selection: selectedText.trim() || undefined,
        attachments,
        availableNotes: aiAvailableNotes,
      }, {
        signal,
        onDelta: (delta) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: `${message.content}${delta}`,
                  }
                : message,
            ),
          );
        },
        onDone: async (reply) => {
          const generatedAttachments: AIMessageAttachment[] = [];
          for (const attachment of reply.attachments ?? []) {
            if (attachment.kind !== "image" && attachment.kind !== "audio" && attachment.kind !== "video") continue;
            const file = base64ToFile(attachment.dataBase64, attachment.fileName, attachment.mimeType);
            try {
              const savedAsset = await uploadFolderAsset(selectedFolderId, file);
              if (savedAsset) {
                generatedAttachments.push({
                  id: savedAsset.id,
                  kind: savedAsset.kind,
                  fileName: savedAsset.fileName,
                  mimeType: savedAsset.mimeType,
                  origin: "generated",
                  url: savedAsset.url,
                  ...imageGenerationMetadata(attachment),
                });
                continue;
              }
            } catch {}

            generatedAttachments.push({
              id: crypto.randomUUID(),
              kind: attachment.kind,
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              origin: "generated",
              url: URL.createObjectURL(file),
              ...imageGenerationMetadata(attachment),
            });
          }

          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: reply.answer,
                    substitutions: reply.substitutions,
                    attachments: generatedAttachments.length > 0 ? generatedAttachments : message.attachments,
                  }
                : message,
            ),
          );
          if (reply.substitutions.length > 0) {
            applyAiEdits(reply.substitutions);
          }
          await handleAiActions(reply.actions, generatedAttachments);
        },
      });
      return true;
    } catch (error) {
      if (signal?.aborted) {
        setMessages((current) => current.filter((message) => message.id !== assistantMessageId && message.id !== userMessage.id));
        return false;
      }
      setMessages((current) => current.filter((message) => message.id !== assistantMessageId));
      pushError(error instanceof Error ? error.message : "AI request failed");
      return false;
    } finally {
      setThinking(false);
    }
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolderIds((current) =>
      current.includes(folderId) ? current.filter((item) => item !== folderId) : [folderId, ...current],
    );
  };

  const parseDragItem = (event: ReactDragEvent<HTMLElement>): WorkspaceDragItem | null => {
    const [kind, id] = event.dataTransfer.getData("text/plain").split(":");
    if (!id) return null;
    if (kind === "asset" || kind === "document" || kind === "folder") {
      return { kind, id } as WorkspaceDragItem;
    }
    return null;
  };

  const startWorkspaceDrag = (event: ReactDragEvent<HTMLElement>, item: WorkspaceDragItem) => {
    setDraggingItem(item);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${item.kind}:${item.id}`);
  };

  const clearWorkspaceDrag = () => {
    setDraggingItem(null);
    setDragTargetFolderId(undefined);
  };

  const canDropOnFolder = (targetFolderId: string | null, item = draggingItem) => {
    if (!item) return false;

    if (item.kind === "document") {
      const draggedDocument = documents.find((entry) => entry.id === item.id);
      return Boolean(draggedDocument && draggedDocument.folderId !== targetFolderId);
    }

    if (item.kind === "asset") {
      const draggedAsset = folderAssets.find((entry) => entry.id === item.id);
      return Boolean(draggedAsset && draggedAsset.folderId !== targetFolderId);
    }

    const draggedFolder = folderById.get(item.id);
    if (!draggedFolder || draggedFolder.parentFolderId === targetFolderId || targetFolderId === item.id) return false;

    let cursor = targetFolderId;
    while (cursor) {
      if (cursor === item.id) return false;
      cursor = folderById.get(cursor)?.parentFolderId ?? null;
    }
    return true;
  };

  const moveWorkspaceDragItem = async (item: WorkspaceDragItem, targetFolderId: string | null) => {
    try {
      if (item.kind === "folder") {
        const updated = await apiClient.moveFolder(item.id, targetFolderId);
        setFolders((current) => sortFolders(current.map((folder) => (folder.id === updated.id ? updated : folder))));
        expandFolderPath(updated.id);
        return;
      }

      if (item.kind === "document") {
        const updated = normalizeDocumentRecord(await apiClient.moveDocument(item.id, targetFolderId));
        setDocuments((current) => upsertDocument(current, updated));
        if (document.id === updated.id) {
          documentStateRef.current = updated;
          setDocument(updated);
          setSelectedFolderId(updated.folderId);
          saveCachedDocument(updated);
        }
        expandFolderPath(updated.folderId);
        return;
      }

      const updated = await apiClient.moveFolderAsset(item.id, targetFolderId);
      setFolderAssets((current) => current.map((asset) => (asset.id === updated.id ? updated : asset)));
      setSelectedFolderAsset((current) => (current?.id === updated.id ? updated : current));
      expandFolderPath(updated.folderId);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Failed to move item");
    } finally {
      clearWorkspaceDrag();
    }
  };

  const handleFolderDragOver = (event: ReactDragEvent<HTMLElement>, targetFolderId: string | null) => {
    const item = draggingItem ?? parseDragItem(event);
    if (!canDropOnFolder(targetFolderId, item)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDragTargetFolderId(targetFolderId);
  };

  const handleFolderDrop = (event: ReactDragEvent<HTMLElement>, targetFolderId: string | null) => {
    const item = draggingItem ?? parseDragItem(event);
    if (!item) return;
    if (!canDropOnFolder(targetFolderId, item)) return;
    event.preventDefault();
    event.stopPropagation();
    void moveWorkspaceDragItem(item, targetFolderId);
  };

  const renderDocumentRow = (item: DocumentRecord, depth = 0) => {
    const active = document.id === item.id;
    const nested = depth > 0;
    return (
      <button
        className={`flex items-center gap-2 rounded-2xl px-3 py-2 text-left transition ${
          nested ? "text-xs" : "text-sm"
        } ${noteButtonClass(active, nested)}`}
        draggable={Boolean(item.id)}
        key={item.id}
        onClick={() => selectDocument(item)}
        onDragEnd={clearWorkspaceDrag}
        onDragStart={(event) => startWorkspaceDrag(event, { kind: "document", id: item.id })}
        ref={(node) => {
          if (node) {
            documentRowRefs.current.set(item.id, node);
            return;
          }
          documentRowRefs.current.delete(item.id);
        }}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        type="button"
      >
        <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">
          <path
            d="M7 3.5h6.5L19 9v11.5A1.5 1.5 0 0 1 17.5 22h-10A1.5 1.5 0 0 1 6 20.5v-15A1.5 1.5 0 0 1 7.5 4H7"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
          <path d="M13 3.5V9h5.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        </svg>
        <span className={`min-w-0 flex-1 truncate ${nested && active ? "font-semibold text-ink" : ""}`}>
          {item.title || UNTITLED_NOTE_TITLE}
        </span>
      </button>
    );
  };

  const openFolderAsset = (asset: FolderAsset) => {
    setSelectedFolderAsset(asset);
    setActiveFolderAssetMenuId(null);
    setActiveAssetPickerMenuId(null);
  };

  const getFolderPathSegments = (folderId: string | null) => {
    const segments: string[] = [];
    const seen = new Set<string>();
    let cursor = folderId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = folderById.get(cursor);
      if (!folder) break;
      segments.unshift(folder.name);
      cursor = folder.parentFolderId;
    }
    return segments;
  };

  const getFolderAssetDirectPath = (asset: FolderAsset) => {
    const segments = [...getFolderPathSegments(asset.folderId), asset.fileName];
    return `/folder/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  };

  const normalizeFolderAssetFileName = (fileName: string) => {
    const trimmed = fileName.trim();
    if (!trimmed || trimmed.length > 180 || /[\\/]/.test(trimmed)) return null;
    return trimmed;
  };

  const beginFolderAssetRename = (asset: FolderAsset) => {
    setRenamingFolderAssetId(asset.id);
    setFolderAssetRenameValue(asset.fileName);
    setActiveFolderAssetMenuId(asset.id);
    setActiveAssetPickerMenuId(asset.id);
  };

  const cancelFolderAssetRename = () => {
    setRenamingFolderAssetId(null);
    setFolderAssetRenameValue("");
  };

  const renameFolderAsset = async (asset: FolderAsset) => {
    const fileName = normalizeFolderAssetFileName(folderAssetRenameValue);
    if (!fileName) {
      pushError("Use a file name without slashes.");
      return;
    }
    if (fileName === asset.fileName) {
      cancelFolderAssetRename();
      return;
    }

    setRenamingFolderAsset(true);
    try {
      const updated = await apiClient.renameFolderAsset(asset.id, fileName);
      setFolderAssets((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedFolderAsset((current) => (current?.id === updated.id ? updated : current));
      cancelFolderAssetRename();
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Failed to rename file");
    } finally {
      setRenamingFolderAsset(false);
    }
  };

  const toggleAndSelectFolder = (folderId: string) => {
    setSelectedFolderId(folderId);
    setExpandedFolderIds((current) =>
      current.includes(folderId) ? current.filter((item) => item !== folderId) : [folderId, ...current],
    );
  };

  const openPreviewFullscreen = async () => {
    try {
      await previewFrameRef.current?.requestFullscreen?.();
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Failed to open fullscreen preview");
    }
  };

  const copyPreviewUrl = async () => {
    if (!selectedFolderAsset) return;
    try {
      const fullUrl = new URL(getFolderAssetDirectPath(selectedFolderAsset), window.location.origin).toString();
      await navigator.clipboard.writeText(fullUrl);
      setPreviewUrlCopied(true);
      if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => {
        setPreviewUrlCopied(false);
        copyResetTimerRef.current = null;
      }, 1800);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Failed to copy file URL");
    }
  };

  useEffect(() => {
    setPreviewUrlCopied(false);
    if (copyResetTimerRef.current) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
  }, [selectedFolderAsset?.url]);

  const insertFolderAssetFromPicker = (asset: FolderAsset) => {
    editorRef.current?.insertAsset(asset, assetInsertionPlacement);
    setActiveWindow(null);
    setAssetPickerKind(null);
    setActiveAssetPickerMenuId(null);
  };

  const renderFolderAssetMiniMenu = (
    asset: FolderAsset,
    options: { selectLabel?: string; onSelect?: () => void },
  ) => {
    const renaming = renamingFolderAssetId === asset.id;
    return (
      <div className="grid gap-2 rounded-2xl bg-black/[0.035] p-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-ink/90"
            onClick={() => openFolderAsset(asset)}
            type="button"
          >
            View
          </button>
          {options.onSelect ? (
            <button
              className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist"
              onClick={options.onSelect}
              type="button"
            >
              {options.selectLabel ?? "Select"}
            </button>
          ) : null}
          <button
            className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist"
            onClick={() => beginFolderAssetRename(asset)}
            type="button"
          >
            Rename
          </button>
        </div>
        {renaming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void renameFolderAsset(asset);
            }}
          >
            <input
              autoFocus
              className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/35 focus:bg-white"
              disabled={renamingFolderAsset}
              onChange={(event) => setFolderAssetRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelFolderAssetRename();
                }
              }}
              value={folderAssetRenameValue}
            />
            <button
              className="rounded-xl bg-ink px-3 py-2 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={renamingFolderAsset || !folderAssetRenameValue.trim()}
              type="submit"
            >
              OK
            </button>
            <button
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-ink transition hover:bg-mist disabled:cursor-not-allowed disabled:opacity-60"
              disabled={renamingFolderAsset}
              onClick={cancelFolderAssetRename}
              type="button"
            >
              Cancel
            </button>
          </form>
        ) : null}
        <div className="truncate px-1 text-xs text-ink/45">{getFolderAssetDirectPath(asset)}</div>
        {asset.kind === "image" ? (
          <button
            className="w-fit overflow-hidden rounded-xl bg-white text-left"
            onClick={() => openFolderAsset(asset)}
            type="button"
          >
            <img alt={asset.fileName} className="h-20 w-28 object-cover" src={asset.url} />
          </button>
        ) : null}
      </div>
    );
  };

  const renderFolderAssetRow = (asset: FolderAsset, depth = 0) => {
    const active = selectedFolderAsset?.id === asset.id || activeFolderAssetMenuId === asset.id;
    const nested = depth > 0;
    return (
      <div key={asset.id} className="grid gap-1" style={{ paddingLeft: `${depth * 14}px` }}>
        <button
          className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl px-3 py-2 text-left transition ${
            nested ? "text-xs" : "text-sm"
          } ${
            active ? (nested ? "bg-black/[0.035]" : "bg-ink/5") : nested ? "bg-transparent hover:bg-black/[0.025]" : "bg-white hover:bg-mist"
          }`}
          draggable
          type="button"
          onDragEnd={clearWorkspaceDrag}
          onDragStart={(event) => startWorkspaceDrag(event, { kind: "asset", id: asset.id })}
          onClick={() => {
            setActiveFolderAssetMenuId((current) => (current === asset.id ? null : asset.id));
            setActiveAssetPickerMenuId(null);
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-ink/55" fill="none" viewBox="0 0 24 24">
              <path
                d="M6.5 4.5h5.7L17 9.3V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 19V6A1.5 1.5 0 0 1 6.5 4.5Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
              <path d="M12 4.5V9h4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
            </svg>
            <span className="min-w-0 truncate font-medium text-ink">{asset.fileName}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55">
            <span className="rounded-full bg-black/[0.04] px-2 py-1">{formatAssetKind(asset.kind)}</span>
            <span>{formatBytes(asset.sizeBytes)}</span>
          </div>
        </button>
        {activeFolderAssetMenuId === asset.id ? (
          <div style={{ paddingLeft: `${12 + depth * 14}px` }}>
            {renderFolderAssetMiniMenu(asset, {})}
          </div>
        ) : null}
      </div>
    );
  };

  const renderAssetPickerRow = (asset: FolderAsset) => (
    <div className="grid gap-1" key={asset.id}>
      <button
        className={`flex items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left transition ${
          activeAssetPickerMenuId === asset.id ? "bg-ink/5" : "bg-white hover:bg-mist"
        }`}
        onClick={() => {
          setActiveAssetPickerMenuId((current) => (current === asset.id ? null : asset.id));
          setActiveFolderAssetMenuId(null);
        }}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{asset.fileName}</span>
        <span className="text-xs uppercase tracking-[0.18em] text-ink/45">{formatBytes(asset.sizeBytes)}</span>
      </button>
      {activeAssetPickerMenuId === asset.id ? (
        <div className="px-1">
          {renderFolderAssetMiniMenu(asset, {
            selectLabel: "Select",
            onSelect: () => insertFolderAssetFromPicker(asset),
          })}
        </div>
      ) : null}
    </div>
  );

  const renderFolderNode = (folder: FolderRecord, depth = 0): React.ReactNode => {
    const isOpen = expandedFolderIds.includes(folder.id);
    const isDropTarget = dragTargetFolderId === folder.id;
    const nested = depth > 0;
    const folderNotes = documentsByFolder.get(folder.id) ?? [];
    const folderAssetsInFolder = folderAssetsByFolder.get(folder.id) ?? [];
    const childFolders = foldersByParent.get(folder.id) ?? [];
    const folderContentCount = folderNotes.length + folderAssetsInFolder.length + childFolders.length;

    return (
      <div key={folder.id} className="grid gap-1">
        <div className="flex items-center gap-1">
          <button
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left transition ${
              nested ? "text-xs" : "text-sm"
            } ${
              isDropTarget
                ? "bg-[#e8f4ed] text-[#174a32] shadow-[inset_0_0_0_1px_rgba(23,74,50,0.18)]"
                : selectedFolderId === folder.id
                  ? nested
                    ? "bg-black/[0.035] text-ink"
                    : "bg-sky-50 text-sky-950"
                  : nested
                    ? "bg-transparent text-ink hover:bg-black/[0.025]"
                    : "bg-white text-ink hover:bg-mist"
            }`}
            draggable
            onDragEnd={clearWorkspaceDrag}
            onDragOver={(event) => handleFolderDragOver(event, folder.id)}
            onDragStart={(event) => startWorkspaceDrag(event, { kind: "folder", id: folder.id })}
            onDrop={(event) => handleFolderDrop(event, folder.id)}
            onClick={() => toggleAndSelectFolder(folder.id)}
            style={{ paddingLeft: `${12 + depth * 12}px` }}
            type="button"
          >
            <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">
              <path
                d="M3.5 8.5v7A2.5 2.5 0 0 0 6 18h12a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 18 7h-6l-1.5-1.5H6A2.5 2.5 0 0 0 3.5 8Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            </svg>
            <svg
              aria-hidden="true"
              className={`h-3.5 w-3.5 shrink-0 transition ${isOpen ? "rotate-90" : "rotate-0"}`}
              fill="none"
              viewBox="0 0 24 24"
            >
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
            </svg>
            <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
            <span className="rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55">
              {folderContentCount}
            </span>
          </button>
          <IconActionButton
            disabled={creatingNote}
            label={`New note in ${folder.name}`}
            onClick={() => void createNote(folder.id)}
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path d="M12 6v12M6 12h12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
            </svg>
          </IconActionButton>
          <IconActionButton
            disabled={creatingFolder}
            label={`New folder in ${folder.name}`}
            onClick={() => openFolderCreateForm(folder.id)}
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path
                d="M3.5 8.5v7A2.5 2.5 0 0 0 6 18h12a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 18 7h-6l-1.5-1.5H6A2.5 2.5 0 0 0 3.5 8Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
              <path d="M12 10.25v5.5M9.25 13h5.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
            </svg>
          </IconActionButton>
          <IconActionButton disabled={uploading} label={`Upload to ${folder.name}`} onClick={() => pickFolderUpload(folder.id)}>
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path d="M12 16V6M8.5 9.5 12 6l3.5 3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
              <path d="M5 16.5V19h14v-2.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
            </svg>
          </IconActionButton>
        </div>
        {isOpen ? (
          <div className="ml-3 grid gap-1 rounded-xl border-l border-ink/10 bg-black/[0.045] py-1 pl-2 pr-1">
            {folderNotes.map((item) => renderDocumentRow(item, depth + 1))}
            {folderAssetsInFolder.map((asset) => renderFolderAssetRow(asset, depth + 1))}
            {childFolders.map((child) => renderFolderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  const renderHeaderRecentNotes = () => {
    if (headerRecentDocuments.length === 0) return null;

    const openRecentDocument = (item: DocumentRecord) => {
      setHeaderRecentOpen(false);
      selectDocument(item);
    };

    return (
      <div className="relative flex min-w-0 items-center gap-1">
        {inlineRecentDocuments.map((item) => (
          <button
            className="h-8 w-[20vw] min-w-0 truncate rounded-full bg-transparent px-3 text-left text-xs text-ink/50 transition hover:bg-black/[0.025] hover:text-ink/70"
            key={item.id}
            onClick={() => openRecentDocument(item)}
            title={item.title || UNTITLED_NOTE_TITLE}
            type="button"
          >
            {item.title || UNTITLED_NOTE_TITLE}
          </button>
        ))}
        {dropdownRecentDocuments.length > 0 ? (
          <IconActionButton
            active={headerRecentOpen}
            label={headerRecentOpen ? "Hide recent notes" : "Show more recent notes"}
            onClick={() => setHeaderRecentOpen((current) => !current)}
          >
            <svg
              aria-hidden="true"
              className={`h-4 w-4 transition ${headerRecentOpen ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
              />
            </svg>
          </IconActionButton>
        ) : null}
        {headerRecentOpen ? (
          <div className="absolute right-0 top-full z-30 mt-2 grid w-[min(22rem,calc(100vw-1rem))] gap-1 rounded-[14px] bg-white p-2 shadow-[0_16px_34px_rgba(15,23,42,0.15)]">
            {dropdownRecentDocuments.map((item) => (
              <button
                className="truncate rounded-[10px] px-3 py-2 text-left text-sm text-ink transition hover:bg-mist"
                key={item.id}
                onClick={() => openRecentDocument(item)}
                title={item.title || UNTITLED_NOTE_TITLE}
                type="button"
              >
                {item.title || UNTITLED_NOTE_TITLE}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const workspaceContent = (
    <div className="min-h-screen bg-white/80 pb-8">
          <div className="sticky top-0 z-50">
            <div className="relative overflow-visible bg-[rgba(255,251,244,0.94)] p-0 backdrop-blur">
              <div className="flex flex-wrap items-center gap-2">
                <MenuTriggerButton active={activeWindow === "ai"} label="AI" onClick={() => toggleWindow("ai")}>
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path
                      d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Zm6 11l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14ZM6 14l.9 2.1L9 17l-2.1.9L6 20l-.9-2.1L3 17l2.1-.9L6 14Z"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.5"
                    />
                  </svg>
                </MenuTriggerButton>
                <MenuTriggerButton active={activeWindow === "library"} label="Library" onClick={() => toggleWindow("library")}>
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
                  </svg>
                </MenuTriggerButton>
                <MenuTriggerButton active={activeWindow === "format"} label="Formatting" onClick={() => toggleWindow("format")}>
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path d="M6 18L12 6l6 12M8 14h8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                  </svg>
                </MenuTriggerButton>
                <MenuTriggerButton active={activeWindow === "create"} label="Add" onClick={() => toggleWindow("create")}>
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                  </svg>
                </MenuTriggerButton>
                <MenuTriggerButton active={activeWindow === "settings"} label="Settings" onClick={() => toggleWindow("settings")}>
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path
                      d="M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7Zm8 3.5l-1.85-.62a6.7 6.7 0 0 0-.46-1.12l.88-1.74l-1.9-1.9l-1.74.88c-.36-.18-.74-.33-1.12-.46L13 4h-2l-.62 1.85c-.38.13-.76.28-1.12.46l-1.74-.88l-1.9 1.9l.88 1.74c-.18.36-.33.74-.46 1.12L4 12v2l1.85.62c.13.38.28.76.46 1.12l-.88 1.74l1.9 1.9l1.74-.88c.36.18.74.33 1.12.46L11 20h2l.62-1.85c.38-.13.76-.28 1.12-.46l1.74.88l1.9-1.9l-.88-1.74c.18-.36.33-.74.46-1.12L20 14v-2Z"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.5"
                    />
                  </svg>
                </MenuTriggerButton>
                <MenuTriggerButton
                  active={!isEditing && activeWindow === "info"}
                  label={isEditing ? "Lock note" : "Note info"}
                  onClick={isEditing ? exitEditMode : () => toggleWindow("info")}
                >
                  {isEditing ? (
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path
                        d="M7.5 11V8.5a4.5 4.5 0 1 1 9 0V11M6.5 11h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.6"
                      />
                    </svg>
                  ) : (
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path d="M12 16v-5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
                      <circle cx="12" cy="8" fill="currentColor" r="1" />
                      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
                    </svg>
                  )}
                </MenuTriggerButton>
                <div className="relative">
                  <button
                    aria-label="Undo. Long press for redo"
                    className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-medium transition ${
                      currentHistoryStatus.canUndo || currentHistoryStatus.canRedo
                        ? "bg-white text-ink hover:bg-mist"
                        : "bg-transparent text-ink/45 hover:bg-black/[0.04]"
                    }`}
                    onBlur={clearUndoLongPressTimer}
                    onClick={handleUndoButtonClick}
                    onPointerCancel={clearUndoLongPressTimer}
                    onPointerDown={startUndoLongPressTimer}
                    onPointerLeave={clearUndoLongPressTimer}
                    onPointerUp={clearUndoLongPressTimer}
                    title="Undo. Press down for redo."
                    type="button"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <path
                        d="M9 7 5 11l4 4M5 11h8a5 5 0 0 1 5 5v1"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.7"
                      />
                    </svg>
                    <span className="sr-only">Undo. Press down for redo.</span>
                  </button>
                  {undoNoticeVisible ? (
                    <div className="absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink px-3 py-1.5 text-[11px] font-medium text-white shadow-[0_10px_24px_rgba(15,23,42,0.18)]">
                      undo, press down for redo
                    </div>
                  ) : null}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <div className="hidden rounded-full bg-black/[0.04] px-3 py-1.5 text-xs text-ink/60 sm:block">{selectedFolderName}</div>
                  {clerkClientConfigured ? (
                    <ClerkAccessControls />
                  ) : null}
                </div>
              </div>

              {activeWindow === "library" ? (
                <Panel
                  className="absolute left-3 right-3 top-full z-40 mt-2 max-h-[calc(100vh-5.5rem)] overflow-hidden overscroll-contain !bg-white !p-0 shadow-[0_20px_48px_rgba(15,23,42,0.14)]"
                  onTouchEndCapture={() => {
                    menuTouchYRef.current = null;
                  }}
                  onTouchMoveCapture={handleMenuTouchMove}
                  onTouchStartCapture={(event) => {
                    menuTouchYRef.current = event.touches[0]?.clientY ?? null;
                  }}
                  onWheelCapture={containBoundaryWheel}
                >
                  <div className="grid max-h-[calc(100vh-9.5rem)] gap-3 overflow-y-auto overscroll-contain p-3 touch-pan-y">
                    {folderCreateOpen ? (
                      <section className="rounded-[20px] bg-white p-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-ink/45">
                          New folder {folderCreateParentId ? `in ${folderById.get(folderCreateParentId)?.name ?? "folder"}` : "in workspace root"}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            ref={folderCreateInputRef}
                            className="min-w-0 flex-1 rounded-2xl bg-black/[0.04] px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/35 focus:bg-white"
                            disabled={creatingFolder}
                            onChange={(event) => setFolderCreateName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void submitFolderCreate();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelFolderCreate();
                              }
                            }}
                            placeholder="Folder name"
                            value={folderCreateName}
                          />
                          <button
                            className="rounded-2xl bg-ink px-3 py-2 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={creatingFolder || !folderCreateName.trim()}
                            onClick={() => void submitFolderCreate()}
                            type="button"
                          >
                            OK
                          </button>
                          <button
                            className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-ink transition hover:bg-mist disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={creatingFolder}
                            onClick={cancelFolderCreate}
                            type="button"
                          >
                            Cancel
                          </button>
                        </div>
                      </section>
                    ) : null}
                    {selectedFolderAsset ? (
                      <section className="fixed left-1/2 top-3 z-50 w-[600px] max-w-[100vw] -translate-x-1/2 rounded-[24px] bg-white p-3 shadow-[0_18px_42px_rgba(15,23,42,0.16)]">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold uppercase tracking-[0.24em] text-ink/45">Preview</div>
                            <div className="mt-1 max-w-full truncate text-sm font-medium text-ink">
                              {shortenMiddle(getFolderAssetDirectPath(selectedFolderAsset), 14, 18)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <IconActionButton
                              label={previewUrlCopied ? "Copied" : "Copy file URL"}
                              onClick={() => void copyPreviewUrl()}
                            >
                              {previewUrlCopied ? (
                                <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                                  <path
                                    d="M5 12.5 9.5 17 19 7.5"
                                    stroke="currentColor"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="1.8"
                                  />
                                </svg>
                              ) : (
                                <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                                  <path
                                    d="M9.5 7.5h6a1 1 0 0 1 1 1v6M7.5 9.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
                                    stroke="currentColor"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="1.8"
                                  />
                                </svg>
                              )}
                            </IconActionButton>
                            <IconActionButton label="Fullscreen preview" onClick={openPreviewFullscreen}>
                              <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                                <path
                                  d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"
                                  stroke="currentColor"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="1.7"
                                />
                              </svg>
                            </IconActionButton>
                            <IconActionButton label="Close preview" onClick={() => setSelectedFolderAsset(null)}>
                              <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                              </svg>
                            </IconActionButton>
                          </div>
                        </div>
                        <div
                          ref={previewFrameRef}
                          className="mt-3 overflow-hidden rounded-[20px] bg-black/5"
                          style={{ height: "500px", maxWidth: "100vw", width: "600px" }}
                        >
                          <iframe
                            allow="camera; microphone; clipboard-read; clipboard-write; geolocation; fullscreen; display-capture; autoplay"
                            allowFullScreen
                            className="h-full w-full"
                            src={selectedFolderAsset.url}
                            title={selectedFolderAsset.fileName}
                          />
                        </div>
                      </section>
                    ) : null}

                    <section
                      className={`rounded-[24px] bg-white p-3 transition ${
                        dragTargetFolderId === null ? "shadow-[inset_0_0_0_1px_rgba(23,74,50,0.24)]" : ""
                      }`}
                      onDragOver={(event) => handleFolderDragOver(event, null)}
                      onDrop={(event) => handleFolderDrop(event, null)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-ink/45">
                          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                            <path
                              d="M3.5 8.5v7A2.5 2.5 0 0 0 6 18h12a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 18 7h-6l-1.5-1.5H6A2.5 2.5 0 0 0 3.5 8.5Z"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="1.5"
                            />
                          </svg>
                          Workspace folders
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55">
                            {folders.length}
                          </span>
                          <div className="hidden rounded-full bg-black/[0.04] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55 sm:block">
                            {selectedFolderName}
                          </div>
                          <IconActionButton
                            disabled={creatingFolder}
                            label="New folder in workspace root"
                            onClick={() => openFolderCreateForm(null)}
                          >
                            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                              <path
                                d="M3.5 8.5v7A2.5 2.5 0 0 0 6 18h12a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 18 7h-6l-1.5-1.5H6A2.5 2.5 0 0 0 3.5 8.5Z"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="1.5"
                              />
                              <path d="M12 10.25v5.5M9.25 13h5.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
                            </svg>
                          </IconActionButton>
                        </div>
                      </div>
                      <div className="mt-3 max-h-[52vh] overflow-y-auto overscroll-contain pr-1 touch-pan-y">
                        <div className="grid gap-1">
                          {!hasWorkspaceRootItems ? (
                            <div className="rounded-2xl bg-black/[0.03] px-3 py-2 text-sm text-ink/45">
                              No folders yet.
                            </div>
                          ) : (
                            <>
                              {workspaceRootNotes.map((item) => renderDocumentRow(item))}
                              {workspaceRootAssets.map((asset) => renderFolderAssetRow(asset))}
                              {libraryFolders.map((folder) => renderFolderNode(folder))}
                            </>
                          )}
                        </div>
                      </div>
                    </section>
                  </div>
                </Panel>
              ) : null}

              {activeWindow === "format" ? (
                <Panel className="absolute left-3 top-full z-40 mt-2 w-fit max-w-[calc(100vw-1.5rem)] !p-3 shadow-[0_20px_48px_rgba(15,23,42,0.14)]">
                  <div className="flex flex-wrap gap-2">
                    {formatCommands.map((item) => (
                      <button
                        key={item.command}
                        className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-ink transition hover:bg-mist"
                        onClick={() => runEditorCommand(item.command)}
                        aria-label={item.label}
                        title={item.label}
                        type="button"
                      >
                        {formatCommandIcon(item.command)}
                        <span className="sr-only">{item.label}</span>
                      </button>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {activeWindow === "create" ? (
                <Panel className="absolute left-3 top-full z-40 mt-2 w-fit max-w-[calc(100vw-1.5rem)] !p-3 shadow-[0_20px_48px_rgba(15,23,42,0.14)]">
                  <div className="grid gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-ink transition hover:bg-mist disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={uploading}
                        onClick={() => pickFolderUpload(assetPickerFolderId ?? selectedFolderId)}
                        title="Upload to folder"
                        type="button"
                      >
                        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                          <path d="M12 16V6M8.5 9.5 12 6l3.5 3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                          <path d="M5 16.5V19h14v-2.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                        </svg>
                        <span className="sr-only">Upload to folder</span>
                      </button>
                      <button
                        className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-ink transition hover:bg-mist"
                        onClick={() => openAssetPicker("image")}
                        title="Insert image"
                        type="button"
                      >
                        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                          <path
                            d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11Z"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.5"
                          />
                          <path
                            d="M8 11.5a1.25 1.25 0 1 0 0-2.5a1.25 1.25 0 0 0 0 2.5Zm-3.5 5L9 11l3.5 4 2-2 4 3.5"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.5"
                          />
                        </svg>
                        <span className="sr-only">Insert image</span>
                      </button>
                      <button
                        className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-ink transition hover:bg-mist"
                        onClick={() => openAssetPicker("audio")}
                        title="Insert audio"
                        type="button"
                      >
                        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                          <path d="M9 15V9l8-2v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                          <circle cx="7.5" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                          <circle cx="16.5" cy="14.5" r="2.5" stroke="currentColor" strokeWidth="1.7" />
                        </svg>
                        <span className="sr-only">Insert audio</span>
                      </button>
                      <button
                        className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-ink transition hover:bg-mist"
                        onClick={() => openAssetPicker("video")}
                        title="Insert video"
                        type="button"
                      >
                        <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
                          <path
                            d="M4 8.5A1.5 1.5 0 0 1 5.5 7h9A1.5 1.5 0 0 1 16 8.5v7A1.5 1.5 0 0 1 14.5 17h-9A1.5 1.5 0 0 1 4 15.5v-7Z"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.5"
                          />
                          <path d="M16 10l4-2v8l-4-2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
                        </svg>
                        <span className="sr-only">Insert video</span>
                      </button>
                    </div>

                    {assetPickerKind ? (
                      <div className="grid gap-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <IconActionButton
                              label="Back"
                              onClick={() => setAssetPickerKind(null)}
                            >
                              <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                              </svg>
                            </IconActionButton>
                            <span className="text-sm font-medium capitalize text-ink">{assetPickerKind}</span>
                          </div>
                          <span className="rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55">
                            {formatBytes(assetPickerAssets.reduce((total, asset) => total + asset.sizeBytes, 0))}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                              assetInsertionPlacement === "cursor"
                                ? "bg-ink text-white"
                                : "bg-white text-ink hover:bg-mist"
                            }`}
                            onClick={() => setAssetInsertionPlacement("cursor")}
                            type="button"
                          >
                            Last cursor
                          </button>
                          <button
                            className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                              assetInsertionPlacement === "top"
                                ? "bg-ink text-white"
                                : "bg-white text-ink hover:bg-mist"
                            }`}
                            onClick={() => setAssetInsertionPlacement("top")}
                            type="button"
                          >
                            At top
                          </button>
                        </div>
                        <div className="grid gap-1">
                          {assetPickerAssets.length === 0 ? (
                            <div className="rounded-2xl bg-black/[0.03] px-3 py-2 text-sm text-ink/45">
                              No files yet.
                            </div>
                          ) : (
                            assetPickerAssets.map((asset) => renderAssetPickerRow(asset))
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </Panel>
              ) : null}

              {activeWindow === "settings" ? (
                <MenuDropdown onClose={() => setActiveWindow(null)} title="Settings">
                  <ProviderSettingsForm
                    initialValue={settings}
                    onSave={async (value) => {
                      try {
                        saveLiveRecordingSettings(value.liveRecording);
                        const saved = await apiClient.saveSettings({ ...value, liveRecording: settings.liveRecording });
                        setSettings({ ...saved, liveRecording: value.liveRecording });
                      } catch (error) {
                        pushError(error instanceof Error ? error.message : "Failed to save provider settings");
                      }
                    }}
                  />
                </MenuDropdown>
              ) : null}

              {activeWindow === "info" ? (
                <MenuDropdown onClose={() => setActiveWindow(null)} title="Note info">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-[20px] bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Title</div>
                      <div className="mt-2 font-medium text-ink">{document.title || UNTITLED_NOTE_TITLE}</div>
                    </div>
                    <div className="rounded-[20px] bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Folder</div>
                      <div className="mt-2 font-medium text-ink">{selectedFolderName}</div>
                    </div>
                    <div className="rounded-[20px] bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Revision</div>
                      <div className="mt-2 font-medium text-ink">{document.revision}</div>
                    </div>
                    <div className="rounded-[20px] bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Files</div>
                      <div className="mt-2 font-medium text-ink">{currentFolderAssetCount}</div>
                    </div>
                    <div className="rounded-[20px] bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Storage</div>
                      <div className="mt-2 font-medium text-ink">{formatBytes(currentFolderStorageBytes)}</div>
                    </div>
                    <div className="rounded-[20px] bg-white px-4 py-3 sm:col-span-2 lg:col-span-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Updated</div>
                      <div className="mt-2 text-sm font-medium text-ink">{new Date(document.updatedAt).toLocaleString()}</div>
                    </div>
                  </div>
                </MenuDropdown>
              ) : null}
            </div>
          </div>

          <div ref={editorShellRef}>
            <RichEditor
              ref={editorRef}
              bodyMarkdown={document.bodyMarkdown}
              editable={isEditing}
              noteId={document.id}
              inlineNotice={
                pendingAiEditPreview ? (
                  <div className="overflow-hidden rounded-[8px] bg-[#fff7e8] shadow-[0_16px_36px_rgba(15,23,42,0.14)]">
                    <div className="grid max-h-[40vh] gap-2 overflow-auto px-3 py-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink/45">Suggested replace</div>
                      <div className="whitespace-pre-wrap break-words text-sm text-[#8c5c54] line-through">
                        {pendingAiEditPreview.firstStep.find}
                      </div>
                      <div className="whitespace-pre-wrap break-words text-sm text-[#1f6f78]">
                        {pendingAiEditPreview.firstStep.replace}
                      </div>
                      {pendingAiEditPreview.stepCount > 1 || pendingAiEditPreview.skippedCount > 0 ? (
                        <div className="text-xs text-ink/50">
                          {pendingAiEditPreview.stepCount} replacement{pendingAiEditPreview.stepCount === 1 ? "" : "s"} ready
                          {pendingAiEditPreview.skippedCount > 0
                            ? `, ${pendingAiEditPreview.skippedCount} not found`
                            : ""}
                          .
                        </div>
                      ) : null}
                    </div>
                    <div className="flex justify-end gap-2 px-3 py-2">
                      <button
                        className="rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-ink transition hover:bg-white"
                        onClick={() => setPendingAiEditPreview(null)}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="rounded-full bg-ink px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-ink/90"
                        onClick={confirmAiEdits}
                        type="button"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                ) : null
              }
              onAddMediaToAi={addNoteMediaToAi}
              onNoteInteract={compactAiPanelForNote}
              onSelectionChange={setSelectedText}
              onRequestEdit={enterEditMode}
              overlay={
                aiPanelMounted ? (
                  <div
                    aria-hidden={activeWindow !== "ai"}
                    className="pointer-events-none fixed inset-x-0 bottom-0 top-0 z-40 flex items-end justify-center overscroll-contain p-0 sm:inset-0 sm:items-end sm:justify-end sm:p-2"
                    hidden={activeWindow !== "ai"}
                    style={activeWindow !== "ai" ? { display: "none" } : undefined}
                  >
                    <div
                      className="pointer-events-auto w-full max-w-[100vw] rounded-t-[10px] bg-[#fff9ef] shadow-[0_10px_26px_rgba(15,23,42,0.08)] sm:w-[560px] sm:rounded-[4px]"
                      data-ai-panel="true"
                      onFocusCapture={expandAiPanelToUserHeight}
                      onPointerDownCapture={expandAiPanelToUserHeight}
                    >
                      <AIChatPanel
                        busy={thinking}
                        compact={activeWindow === "ai" && aiPanelCompact}
                        currentFolderFiles={aiCurrentFolderFiles}
                        currentFolderName={selectedFolderName}
                        currentNoteBodyMarkdown={document.bodyMarkdown}
                        currentNoteId={document.id}
                        currentNoteTitle={document.title}
                        messages={messages}
                        noteCatalog={aiAvailableNotes}
                        onAddAttachmentToNote={addAiAttachmentToNote}
                        onAppendToCurrentNote={appendAiSummaryToCurrentNote}
                        onApply={applyAiEdits}
                        onAsk={askAi}
                        onCreatePrompt={async (value) => {
                          const created = await apiClient.createPrompt(value);
                          setPromptTemplates((current) => [created, ...current.filter((item) => item.id !== created.id)]);
                          return created;
                        }}
                        onUpdatePrompt={async (id, value) => {
                          const updated = await apiClient.updatePrompt(id, value);
                          setPromptTemplates((current) =>
                            current.map((item) => (item.id === updated.id ? updated : item)).sort((left, right) =>
                              new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
                            ),
                          );
                          return updated;
                        }}
                        onError={pushError}
                        onPendingExternalAttachmentHandled={() => setPendingAiAttachment(null)}
                        pendingExternalAttachment={pendingAiAttachment}
                        prompts={promptTemplates}
                        provider={settings.provider}
                        providerSettings={settings}
                        selectedText={selectedText}
                        storedPanelHeight={loadAiPanelHeight()}
                        onInsertGeneratedImageInNote={insertAiImageFileIntoNote}
                        onFindInNote={findNoteByAiAction}
                        onOpenNote={openNoteByAiAction}
                        onScrollNote={scrollNoteByAiAction}
                        onPanelHeightChange={saveAiPanelHeight}
                        onUploadImageToCurrentFolder={uploadAiImageToCurrentFolder}
                      />
                    </div>
                  </div>
                ) : null
              }
              onBodyChange={(bodyMarkdown, reason) => updateDocumentBody(bodyMarkdown, reason ?? "typing")}
              onBodyDraftChange={(reason) => {
                if (shouldDelaySyncForBodyChange(reason)) {
                  markNoteChangeForSyncDelay();
                  scheduleDelayedSync();
                }
              }}
              onTitleChange={(title) => {
                updateDocument({ title });
              }}
              title={document.title}
              topRight={renderHeaderRecentNotes()}
            />
          </div>

          <div className="fixed bottom-4 right-4 z-40 rounded-full bg-ink px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white shadow-[0_14px_32px_rgba(15,23,42,0.2)]">
            {syncStatus}
          </div>
        </div>
  );

  return workspaceContent;
}

export function WorkspaceClient() {
  return <WorkspaceClientContent />;
}

function ClerkAccessControls() {
  const { isLoaded, isSignedIn } = useAuth();

  if (isLoaded && isSignedIn) {
    return <UserButton />;
  }

  return (
    <>
      <Link className="rounded-full bg-white px-3 py-1.5 text-xs text-ink transition hover:bg-mist" href="/sign-in">
        Sign in
      </Link>
      <div className="rounded-full bg-black/[0.04] px-3 py-1.5 text-xs text-ink/60">Local mode</div>
    </>
  );
}
