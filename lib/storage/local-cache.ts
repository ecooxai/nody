import type { DocumentRecord } from "@/shared/types";
import { normalizeStoredMarkdown } from "@/lib/editor/markdown";

const CACHE_KEY = "nody.active-document";
const RECENT_DOCUMENT_IDS_KEY = "nody.recent-documents";
const AI_PANEL_HEIGHT_KEY = "nody.ai-panel-height";

export function loadCachedDocument() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DocumentRecord & { bodyHtml?: string };
    return {
      ...parsed,
      bodyMarkdown: normalizeStoredMarkdown(parsed.bodyMarkdown ?? parsed.bodyHtml ?? ""),
    } satisfies DocumentRecord;
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

export function loadAiPanelHeight() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(AI_PANEL_HEIGHT_KEY);
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function saveAiPanelHeight(height: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AI_PANEL_HEIGHT_KEY, String(height));
}
