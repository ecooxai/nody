import type { DocumentRecord } from "@/shared/types";

const CACHE_KEY = "nody.active-document";
const RECENT_DOCUMENT_IDS_KEY = "nody.recent-documents";

export function loadCachedDocument() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DocumentRecord;
  } catch {
    return null;
  }
}

export function saveCachedDocument(document: DocumentRecord) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CACHE_KEY, JSON.stringify(document));
}

export function loadRecentDocumentIds() {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(RECENT_DOCUMENT_IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function saveRecentDocumentIds(ids: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(RECENT_DOCUMENT_IDS_KEY, JSON.stringify(ids));
}
