import type { DocumentRecord, SyncPayload, SyncResult } from "./types";

export function buildSyncPayload(document: DocumentRecord, deviceId: string): SyncPayload {
  return {
    title: document.title,
    bodyMarkdown: document.bodyMarkdown,
    baseRevision: document.revision,
    deviceId,
  };
}

export function shouldApplyRemote(localDirty: boolean, remoteRevision: number, localRevision: number) {
  return !localDirty && remoteRevision > localRevision;
}

export function normalizeConflict(document: DocumentRecord, message = "Sync conflict detected"): SyncResult {
  return {
    ok: false,
    conflict: true,
    document,
    serverRevision: document.revision,
    message,
  };
}
