"use client";

import { SignedIn, SignedOut, RedirectToSignIn, UserButton } from "@clerk/nextjs";
import { useEffect, useMemo, useRef, useState } from "react";

import { AIChatPanel } from "@/components/chat/ai-chat-panel";
import { RichEditor, type RichEditorHandle } from "@/components/editor/rich-editor";
import { useErrorToast } from "@/components/notifications/error-toast";
import { ProviderSettingsForm } from "@/components/settings/provider-settings-form";
import { Panel } from "@/components/ui/panel";
import { apiClient } from "@/lib/api/client";
import type { EditorCommand } from "@/lib/editor/commands";
import { clerkConfigured } from "@/lib/auth/config";
import { createStarterDocument } from "@/lib/editor/html";
import { useServiceWorker } from "@/lib/hooks/use-service-worker";
import { createDefaultSettings } from "@/lib/providers/defaults";
import { getDeviceId } from "@/lib/storage/device";
import {
  loadCachedDocument,
  loadRecentDocumentIds,
  saveCachedDocument,
  saveRecentDocumentIds,
} from "@/lib/storage/local-cache";
import { applySubstitutions } from "@/shared/substitutions";
import { buildSyncPayload, shouldApplyRemote } from "@/shared/sync";
import type { AIMessage, DocumentRecord, FolderAsset, FolderRecord, ProviderSettings, TextSubstitution } from "@/shared/types";

type WorkspaceWindow = "library" | "format" | "create" | "settings" | "ai" | "info" | null;
type AssetInsertionPlacement = "cursor" | "top";
const RECENT_NOTE_LIMIT = 5;
const RECENT_NOTE_HISTORY_LIMIT = 20;

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
    title: "Untitled note",
    bodyHtml: createStarterDocument(),
    folderId,
    revision: 0,
    deviceId,
    updatedAt: now,
    createdAt: now,
    assets: [],
  };
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
    ? "border-ink bg-ink text-white shadow-[0_10px_25px_rgba(15,23,42,0.14)]"
    : "border-transparent bg-transparent text-ink hover:border-ink/10 hover:bg-black/[0.04]";
}

function noteButtonClass(active: boolean) {
  return active
    ? "border-ink/20 bg-mist text-ink"
    : "border-ink/10 bg-white text-ink hover:border-ink/20 hover:bg-mist";
}

function actionButtonClass(active: boolean) {
  return active
    ? "border-ink bg-ink text-white shadow-[0_8px_18px_rgba(15,23,42,0.16)]"
    : "border-ink/10 bg-white text-ink hover:border-ink/20 hover:bg-mist";
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
      className={`flex h-8 w-8 items-center justify-center rounded-full border text-ink transition ${actionButtonClass(active)}`}
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
      className={`flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-medium transition ${menuButtonClass(active)}`}
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
  return (
    <Panel className="absolute left-0 right-0 top-full z-40 mt-2 border-transparent bg-[#fffdf8]/96 p-0 shadow-[0_20px_48px_rgba(15,23,42,0.14)] backdrop-blur">
      <div className="flex items-center justify-between gap-3 border-b border-ink/10 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.24em] text-ink/55">{title}</h2>
        <button
          aria-label={`Close ${title}`}
          className={`flex h-8 w-8 items-center justify-center rounded-full border text-ink transition ${actionButtonClass(false)}`}
          onClick={onClose}
          type="button"
        >
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          </svg>
        </button>
      </div>
      <div className="max-h-[70vh] overflow-auto p-3">{children}</div>
    </Panel>
  );
}

export function WorkspaceClient() {
  if (!clerkConfigured) {
    return (
      <Panel>
        <h1 className="text-2xl font-semibold">Auth setup required</h1>
        <p className="mt-2 text-sm text-ink/60">
          Add Clerk publishable and secret keys to enable the protected workspace, then restart the app.
        </p>
      </Panel>
    );
  }

  useServiceWorker();
  const { pushError } = useErrorToast();
  const deviceId = useMemo(() => getDeviceId(), []);
  const editorRef = useRef<RichEditorHandle>(null);
  const [cachedDocument] = useState<DocumentRecord | null>(() => loadCachedDocument());
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [folderAssets, setFolderAssets] = useState<FolderAsset[]>([]);
  const [document, setDocument] = useState<DocumentRecord>(() => cachedDocument ?? emptyDocument(deviceId, null));
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [settings, setSettings] = useState<ProviderSettings>(createDefaultSettings());
  const [recentDocumentIds, setRecentDocumentIds] = useState<string[]>(() => loadRecentDocumentIds());
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(cachedDocument?.folderId ?? null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<string[]>([]);
  const [selectedFolderAsset, setSelectedFolderAsset] = useState<FolderAsset | null>(null);
  const [assetPickerKind, setAssetPickerKind] = useState<FolderAsset["kind"] | null>(null);
  const [assetPickerFolderId, setAssetPickerFolderId] = useState<string | null>(null);
  const [assetInsertionPlacement, setAssetInsertionPlacement] = useState<AssetInsertionPlacement>("cursor");
  const [syncStatus, setSyncStatus] = useState("Loading");
  const [uploading, setUploading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [folderCreateParentId, setFolderCreateParentId] = useState<string | null>(null);
  const [folderCreateName, setFolderCreateName] = useState("");
  const [activeWindow, setActiveWindow] = useState<WorkspaceWindow>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [recentOpen, setRecentOpen] = useState(true);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const folderCreateInputRef = useRef<HTMLInputElement>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const [previewUrlCopied, setPreviewUrlCopied] = useState(false);

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
  const visibleRecentDocuments = showAllRecent ? recentDocuments : recentDocuments.slice(0, RECENT_NOTE_LIMIT);
  const currentFolderDocuments = currentFolder ? documentsByFolder.get(currentFolder.id) ?? [] : documentsByFolder.get("root") ?? [];
  const selectedFolderName = currentFolder?.name ?? "Workspace";
  const currentFolderOpen = currentFolder ? expandedFolderIds.includes(currentFolder.id) : true;
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
  const currentFolderStorageBytes = currentFolder ? folderStorageBytesById.get(currentFolder.id) ?? 0 : workspaceStorageBytes;
  const currentFolderAssetCount = useMemo(() => {
    if (!currentFolder) return folderAssets.length;
    let count = 0;
    for (const folderId of currentFolderBranchIds) {
      count += folderAssetsByFolder.get(folderId)?.length ?? 0;
    }
    return count;
  }, [currentFolder, currentFolderBranchIds, folderAssets, folderAssetsByFolder]);
  const currentFolderAssets = currentFolder ? folderAssetsByFolder.get(currentFolder.id) ?? [] : folderAssetsByFolder.get(null) ?? [];
  const currentFolderChildFolders = currentFolder ? foldersByParent.get(currentFolder.id) ?? [] : foldersByParent.get(null) ?? [];
  const workspaceRootFolders = foldersByParent.get(null) ?? [];
  const workspaceFolders = currentFolder
    ? [currentFolder, ...workspaceRootFolders.filter((folder) => folder.id !== currentFolder.id)]
    : workspaceRootFolders;
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

  const markRecentDocument = (id: string) => {
    setRecentDocumentIds((current) => {
      const next = [id, ...current.filter((item) => item !== id)].slice(0, RECENT_NOTE_HISTORY_LIMIT);
      saveRecentDocumentIds(next);
      return next;
    });
  };

  const selectDocument = (next: DocumentRecord) => {
    setDocument(next);
    setSelectedFolderId(next.folderId);
    setSelectedFolderAsset(null);
    setSelectedText("");
    saveCachedDocument(next);
    markRecentDocument(next.id);
    const folderId = next.folderId;
    if (folderId) {
      setExpandedFolderIds((current) => (current.includes(folderId) ? current : [folderId, ...current]));
    }
    setActiveWindow(null);
  };

  const toggleWindow = (windowName: WorkspaceWindow) => {
    setActiveWindow((current) => (current === windowName ? null : windowName));
  };

  const runEditorCommand = (command: EditorCommand) => {
    editorRef.current?.runCommand(command);
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
        setFolders(sortFolders(remoteFolders));
        setSettings(remoteSettings);
        setDocuments(sortDocuments(remoteDocs));
        setFolderAssets(remoteFolderAssets);

        if (remoteDocs[0]) {
          const initialDocument = (cachedDocument && remoteDocs.find((item) => item.id === cachedDocument.id)) ?? remoteDocs[0];
          selectDocument(initialDocument);
          setSyncStatus("Live");
          return;
        }

        const created = await apiClient.createDocument({
          title: cachedDocument?.title ?? "Untitled note",
          bodyHtml: cachedDocument?.bodyHtml ?? createStarterDocument(),
          deviceId,
          folderId: cachedDocument?.folderId ?? null,
        });
        setDocuments([created]);
        selectDocument(created);
        setSyncStatus("Live");
      } catch (error) {
        setSyncStatus("Offline");
        pushError(error instanceof Error ? error.message : "Failed to load workspace");
      }
    })();
  }, [cachedDocument, deviceId, pushError]);

  useEffect(() => {
    saveCachedDocument(document);
  }, [document]);

  useEffect(() => {
    if (!document.id) return;
    const interval = window.setInterval(async () => {
      try {
        if (dirty) {
          const result = await apiClient.syncDocument(document.id, buildSyncPayload(document, deviceId));
          setDocument(result.document);
          setDocuments((current) => upsertDocument(current, result.document));
          setDirty(false);
          setSyncStatus(result.conflict ? "Conflict" : "Synced");
          saveCachedDocument(result.document);
          if (result.conflict) pushError(result.message ?? "Sync conflict detected");
          return;
        }

        const remoteDocs = await apiClient.listDocuments();
        setDocuments(sortDocuments(remoteDocs));
        const latest = remoteDocs.find((item) => item.id === document.id);
        if (latest && shouldApplyRemote(dirty, latest.revision, document.revision)) {
          setDocument(latest);
          saveCachedDocument(latest);
          setSyncStatus("Updated");
        }
      } catch (error) {
        setSyncStatus("Offline");
        pushError(error instanceof Error ? error.message : "Sync failed");
      }
    }, 12000);

    return () => window.clearInterval(interval);
  }, [deviceId, dirty, document, pushError]);

  const updateDocument = (next: Partial<DocumentRecord>) => {
    setDocument((current) => {
      const updated = { ...current, ...next, updatedAt: new Date().toISOString() };
      setDocuments((currentDocuments) => upsertDocument(currentDocuments, updated));
      saveCachedDocument(updated);
      return updated;
    });
    setDirty(true);
    setSyncStatus("Pending");
  };

  const applyAiEdits = (edits: TextSubstitution[]) => {
    const bodyHtml = applySubstitutions(document.bodyHtml, edits);
    updateDocument({ bodyHtml });
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
      if (parentFolderId) {
        setExpandedFolderIds((current) => (current.includes(parentFolderId) ? current : [parentFolderId, ...current]));
      }
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

  const createNote = async (folderId: string | null) => {
    setCreatingNote(true);
    try {
      const created = await apiClient.createDocument({
        title: "Untitled note",
        bodyHtml: createStarterDocument(),
        deviceId,
        folderId,
      });
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

  const uploadFolderAsset = async (folderId: string | null, file: File) => {
    const kind = inferAssetKind(file);
    if (!kind) {
      pushError("Only image, audio, and video files are supported.");
      return;
    }
    setUploading(true);
    try {
      const asset = await apiClient.uploadFolderAsset(folderId, file, kind);
      setFolderAssets((current) => [asset, ...current]);
      if (assetPickerFolderId === folderId && assetPickerKind === kind) {
        setAssetPickerKind(kind);
      }
    } catch (error) {
      pushError(error instanceof Error ? error.message : "Media upload failed");
    } finally {
      setUploading(false);
    }
  };

  const pickFolderUpload = (folderId: string | null) => {
    const input = window.document.createElement("input");
    input.type = "file";
    input.accept = "image/*,audio/*,video/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await uploadFolderAsset(folderId, file);
    };
    input.click();
  };

  const openAssetPicker = (kind: FolderAsset["kind"]) => {
    setAssetPickerKind(kind);
    setAssetPickerFolderId(selectedFolderId);
    setAssetInsertionPlacement("cursor");
    setActiveWindow("create");
  };

  const askAi = async (prompt: string) => {
    setThinking(true);
    const userMessage: AIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage]);
    try {
      const reply = await apiClient.askAi({
        prompt,
        title: document.title,
        bodyHtml: document.bodyHtml,
      });
      const assistantText = `${reply.answer}\n\n\`\`\`json\n${JSON.stringify({ substitutions: reply.substitutions }, null, 2)}\n\`\`\``;
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantText,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (error) {
      pushError(error instanceof Error ? error.message : "AI request failed");
    } finally {
      setThinking(false);
    }
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolderIds((current) =>
      current.includes(folderId) ? current.filter((item) => item !== folderId) : [folderId, ...current],
    );
  };

  const renderDocumentRow = (item: DocumentRecord, depth = 0) => {
    const active = document.id === item.id;
    return (
      <button
        className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-left text-sm transition ${noteButtonClass(active)}`}
        key={item.id}
        onClick={() => selectDocument(item)}
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
        <span className="min-w-0 flex-1 truncate">{item.title || "Untitled note"}</span>
      </button>
    );
  };

  const openFolderAsset = (asset: FolderAsset) => {
    setSelectedFolderAsset(asset);
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
      const fullUrl = new URL(selectedFolderAsset.url, window.location.origin).toString();
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

  const renderFolderAssetRow = (asset: FolderAsset, depth = 0) => {
    const active = selectedFolderAsset?.id === asset.id;
    return (
      <button
        key={asset.id}
        className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-3 py-2 text-left text-sm transition ${
          active ? "border-ink bg-ink/5" : "border-ink/10 bg-white hover:border-ink/25 hover:bg-mist"
        }`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        type="button"
        onClick={() => openFolderAsset(asset)}
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
    );
  };

  const renderFolderNode = (folder: FolderRecord, depth = 0, hideCurrentBranch = false): React.ReactNode => {
    if (hideCurrentBranch && currentFolderBranchIds.has(folder.id)) return null;

    const isOpen = expandedFolderIds.includes(folder.id);
    const folderNotes = documentsByFolder.get(folder.id) ?? [];
    const folderAssetsInFolder = folderAssetsByFolder.get(folder.id) ?? [];
    const childFolders = foldersByParent.get(folder.id) ?? [];
    const folderStorage = folderStorageBytesById.get(folder.id) ?? 0;

    return (
      <div key={folder.id} className="grid gap-1">
        <div className="flex items-center gap-1">
            <button
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-2xl border px-3 py-2 text-left text-sm transition ${
              selectedFolderId === folder.id ? "border-sky-200 bg-sky-50 text-sky-950" : "border-ink/10 bg-white text-ink hover:border-ink/20 hover:bg-mist"
            }`}
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
            <span className="min-w-0 flex-1 truncate text-lg font-bold text-[#163a6b]">{folder.name}</span>
          </button>
          <div className="rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55">
            {formatBytes(folderStorage)}
          </div>
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
          <div className="grid gap-1">
            {folderNotes.map((item) => renderDocumentRow(item, depth + 1))}
            {folderAssetsInFolder.map((asset) => renderFolderAssetRow(asset, depth + 1))}
            {childFolders.map((child) => renderFolderNode(child, depth + 1, hideCurrentBranch))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
      <SignedIn>
        <div className="min-h-screen bg-white/80 pb-8">
          <div className="sticky top-0 z-50">
            <div className="relative overflow-visible bg-[rgba(255,251,244,0.94)] px-3 py-2 backdrop-blur">
              <div className="flex flex-wrap items-center gap-2">
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
                <MenuTriggerButton active={activeWindow === "info"} label="Note info" onClick={() => toggleWindow("info")}>
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <path d="M12 16v-5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
                    <circle cx="12" cy="8" fill="currentColor" r="1" />
                    <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
                  </svg>
                </MenuTriggerButton>
                <div className="ml-auto flex items-center gap-2">
                  <div className="hidden rounded-full bg-black/[0.04] px-3 py-1.5 text-xs text-ink/60 sm:block">{selectedFolderName}</div>
                  <UserButton />
                </div>
              </div>

              {activeWindow === "library" ? (
                <Panel className="absolute left-3 right-3 top-full z-40 mt-2 !bg-white !p-0 shadow-[0_20px_48px_rgba(15,23,42,0.14)]">
                  <div className="flex items-center justify-start gap-2 border-b border-ink/10 px-4 py-3">
                    <IconActionButton label="New note in workspace root" onClick={() => void createNote(null)}>
                      <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
                      </svg>
                    </IconActionButton>
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
                  <div className="grid gap-3 p-3">
                    {folderCreateOpen ? (
                      <section className="rounded-[20px] border border-ink/10 bg-white p-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-ink/45">
                          New folder {folderCreateParentId ? `in ${folderById.get(folderCreateParentId)?.name ?? "folder"}` : "in workspace root"}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            ref={folderCreateInputRef}
                            className="min-w-0 flex-1 rounded-2xl border border-ink/10 bg-white px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/35 focus:border-ink/30"
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
                            className="rounded-2xl border border-ink/10 bg-ink px-3 py-2 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={creatingFolder || !folderCreateName.trim()}
                            onClick={() => void submitFolderCreate()}
                            type="button"
                          >
                            OK
                          </button>
                          <button
                            className="rounded-2xl border border-ink/10 bg-white px-3 py-2 text-sm font-semibold text-ink transition hover:bg-mist disabled:cursor-not-allowed disabled:opacity-60"
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
                      <section className="fixed left-1/2 top-3 z-50 w-[600px] max-w-[100vw] -translate-x-1/2 rounded-[24px] border border-ink/10 bg-white p-3 shadow-[0_18px_42px_rgba(15,23,42,0.16)]">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold uppercase tracking-[0.24em] text-ink/45">Preview</div>
                            <div className="mt-1 max-w-full truncate text-sm font-medium text-ink">
                              {shortenMiddle(selectedFolderAsset.url, 10, 10)}
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
                          className="mt-3 overflow-hidden rounded-[20px] border border-ink/10 bg-black/5"
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

                    <section className="rounded-[24px] border border-ink/10 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          className="flex min-w-0 items-center gap-2 text-left text-xs font-semibold uppercase tracking-[0.24em] text-ink/45 transition hover:text-ink/70"
                          onClick={() => setRecentOpen((current) => !current)}
                          aria-expanded={recentOpen}
                          type="button"
                        >
                          <svg
                            aria-hidden="true"
                            className={`h-4 w-4 shrink-0 transition ${recentOpen ? "rotate-90" : "rotate-0"}`}
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <path
                              d="M9 6l6 6-6 6"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="1.8"
                            />
                          </svg>
                          <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">
                            <path
                              d="M7 4h10l2 3H5l2-3Zm-2 4h14v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8Z"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="1.5"
                            />
                          </svg>
                          Recent
                        </button>
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55">
                            {visibleRecentDocuments.length}
                          </span>
                          {recentDocuments.length > RECENT_NOTE_LIMIT ? (
                            <IconActionButton
                              active={showAllRecent}
                              label={showAllRecent ? "Show fewer recent notes" : "Show more recent notes"}
                              onClick={() => setShowAllRecent((current) => !current)}
                            >
                              <svg
                                aria-hidden="true"
                                className={`h-4 w-4 transition ${showAllRecent ? "rotate-180" : ""}`}
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
                        </div>
                      </div>
                      {recentOpen ? (
                        <div className="mt-2 grid gap-1">
                          {visibleRecentDocuments.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-ink/10 px-3 py-2 text-sm text-ink/45">
                              No recent notes.
                            </div>
                          ) : (
                            visibleRecentDocuments.map((item) => renderDocumentRow(item))
                          )}
                        </div>
                      ) : null}
                    </section>

                    <section className="rounded-[24px] border border-ink/10 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <svg aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">
                            <path
                              d="M3.5 8.5v7A2.5 2.5 0 0 0 6 18h12a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 18 7h-6l-1.5-1.5H6A2.5 2.5 0 0 0 3.5 8.5Z"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="1.5"
                            />
                          </svg>
                          {currentFolder ? (
                            <button
                              className="flex min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 text-left text-sm font-semibold text-ink transition hover:bg-black/[0.04]"
                              onClick={() => toggleAndSelectFolder(currentFolder.id)}
                              type="button"
                            >
                              <svg
                                aria-hidden="true"
                                className={`h-3.5 w-3.5 shrink-0 transition ${currentFolderOpen ? "rotate-90" : "rotate-0"}`}
                                fill="none"
                                viewBox="0 0 24 24"
                              >
                                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                              </svg>
                              <span className="min-w-0 truncate text-lg">{selectedFolderName}</span>
                            </button>
                          ) : (
                            <span className="min-w-0 truncate text-lg font-semibold text-ink">{selectedFolderName}</span>
                          )}
                          <span className="rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55">
                            {formatBytes(currentFolderStorageBytes)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <IconActionButton
                            disabled={creatingNote}
                            label="New note in current folder"
                            onClick={() => void createNote(selectedFolderId)}
                          >
                            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                              <path d="M12 6v12M6 12h12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
                            </svg>
                          </IconActionButton>
                          <IconActionButton
                            disabled={creatingFolder}
                            label="New folder"
                            onClick={() => openFolderCreateForm(selectedFolderId)}
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
                          <IconActionButton
                            disabled={uploading}
                            label="Upload media"
                            onClick={() => pickFolderUpload(selectedFolderId)}
                          >
                            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                              <path d="M12 16V6M8.5 9.5 12 6l3.5 3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                              <path d="M5 16.5V19h14v-2.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                            </svg>
                          </IconActionButton>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 rounded-[20px] border border-dashed border-ink/10 bg-ink/[0.02] p-3">
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
                          <span className="rounded-full bg-black/[0.04] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-ink/55">
                            {workspaceRootFolders.length}
                          </span>
                        </div>
                        <div className="grid gap-1">
                          {workspaceFolders.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-ink/10 px-3 py-2 text-sm text-ink/45">
                              No folders yet.
                            </div>
                          ) : (
                            workspaceFolders.map((folder) => renderFolderNode(folder))
                          )}
                        </div>
                      </div>
                      {currentFolderOpen ? (
                        <div className="mt-2 grid gap-1">
                          {currentFolderDocuments.length === 0 && currentFolderAssets.length === 0 && currentFolderChildFolders.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-ink/10 px-3 py-2 text-sm text-ink/45">Empty.</div>
                          ) : (
                            <>
                              {currentFolderDocuments.map((item) => renderDocumentRow(item))}
                              {currentFolderAssets.map((asset) => renderFolderAssetRow(asset))}
                            </>
                          )}
                          {currentFolderChildFolders.map((folder) => renderFolderNode(folder))}
                        </div>
                      ) : null}
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
                        className="flex h-12 w-12 items-center justify-center rounded-2xl border border-ink/10 bg-white text-ink transition hover:border-ink/25 hover:bg-mist"
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
                        className="flex h-12 w-12 items-center justify-center rounded-2xl border border-ink/10 bg-white text-ink transition hover:border-ink/25 hover:bg-mist disabled:cursor-not-allowed disabled:opacity-60"
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
                        className="flex h-12 w-12 items-center justify-center rounded-2xl border border-ink/10 bg-white text-ink transition hover:border-ink/25 hover:bg-mist"
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
                        className="flex h-12 w-12 items-center justify-center rounded-2xl border border-ink/10 bg-white text-ink transition hover:border-ink/25 hover:bg-mist"
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
                        className="flex h-12 w-12 items-center justify-center rounded-2xl border border-ink/10 bg-white text-ink transition hover:border-ink/25 hover:bg-mist"
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
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                              assetInsertionPlacement === "cursor"
                                ? "border-ink bg-ink text-white"
                                : "border-ink/10 bg-white text-ink hover:border-ink/20 hover:bg-mist"
                            }`}
                            onClick={() => setAssetInsertionPlacement("cursor")}
                            type="button"
                          >
                            Last cursor
                          </button>
                          <button
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                              assetInsertionPlacement === "top"
                                ? "border-ink bg-ink text-white"
                                : "border-ink/10 bg-white text-ink hover:border-ink/20 hover:bg-mist"
                            }`}
                            onClick={() => setAssetInsertionPlacement("top")}
                            type="button"
                          >
                            At top
                          </button>
                        </div>
                        <div className="grid gap-1">
                          {assetPickerAssets.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-ink/10 px-3 py-2 text-sm text-ink/45">
                              No files yet.
                            </div>
                          ) : (
                            assetPickerAssets.map((asset) => (
                              <button
                                className="flex items-center justify-between gap-3 rounded-2xl border border-ink/10 bg-white px-4 py-3 text-left transition hover:border-ink/25 hover:bg-mist"
                                key={asset.id}
                                onClick={() => {
                                  editorRef.current?.insertAsset(asset, assetInsertionPlacement);
                                  setActiveWindow(null);
                                  setAssetPickerKind(null);
                                }}
                                type="button"
                              >
                                <span className="min-w-0 flex-1 truncate font-medium text-ink">{asset.fileName}</span>
                                <span className="text-xs uppercase tracking-[0.18em] text-ink/45">{formatBytes(asset.sizeBytes)}</span>
                              </button>
                            ))
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
                        const saved = await apiClient.saveSettings(value);
                        setSettings(saved);
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
                    <div className="rounded-[20px] border border-ink/10 bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Title</div>
                      <div className="mt-2 font-medium text-ink">{document.title || "Untitled note"}</div>
                    </div>
                    <div className="rounded-[20px] border border-ink/10 bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Folder</div>
                      <div className="mt-2 font-medium text-ink">{selectedFolderName}</div>
                    </div>
                    <div className="rounded-[20px] border border-ink/10 bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Revision</div>
                      <div className="mt-2 font-medium text-ink">{document.revision}</div>
                    </div>
                    <div className="rounded-[20px] border border-ink/10 bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Files</div>
                      <div className="mt-2 font-medium text-ink">{currentFolderAssetCount}</div>
                    </div>
                    <div className="rounded-[20px] border border-ink/10 bg-white px-4 py-3">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Storage</div>
                      <div className="mt-2 font-medium text-ink">{formatBytes(currentFolderStorageBytes)}</div>
                    </div>
                    <div className="rounded-[20px] border border-ink/10 bg-white px-4 py-3 sm:col-span-2 lg:col-span-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-ink/45">Updated</div>
                      <div className="mt-2 text-sm font-medium text-ink">{new Date(document.updatedAt).toLocaleString()}</div>
                    </div>
                  </div>
                </MenuDropdown>
              ) : null}
            </div>
          </div>

          <RichEditor
            ref={editorRef}
            bodyHtml={document.bodyHtml}
            onSelectionChange={setSelectedText}
            overlay={activeWindow === "ai" ? (
              <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="pointer-events-auto w-[500px] max-w-[100vw] rounded-[4px] bg-[#fff9ef] shadow-[0_16px_36px_rgba(15,23,42,0.08)]">
                  <AIChatPanel busy={thinking} messages={messages} onApply={applyAiEdits} onAsk={askAi} selectedText={selectedText} />
                </div>
              </div>
            ) : null}
            onBodyChange={(bodyHtml) => updateDocument({ bodyHtml })}
            onTitleChange={(title) => updateDocument({ title })}
            title={document.title}
            topRight={
              <button
                aria-label="AI"
                className={`flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-medium transition ${menuButtonClass(activeWindow === "ai")}`}
                onClick={() => toggleWindow("ai")}
                title="AI"
                type="button"
              >
                <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Zm6 11l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14ZM6 14l.9 2.1L9 17l-2.1.9L6 20l-.9-2.1L3 17l2.1-.9L6 14Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                  />
                </svg>
                <span className="sr-only">AI</span>
              </button>
            }
          />

          <div className="fixed bottom-4 right-4 z-40 rounded-full bg-ink px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white shadow-[0_14px_32px_rgba(15,23,42,0.2)]">
            {syncStatus}
          </div>
        </div>
      </SignedIn>
    </>
  );
}
