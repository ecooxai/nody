import type {
  AIRequest,
  AIResponse,
  DocumentAsset,
  DocumentRecord,
  FolderAsset,
  FolderRecord,
  ProviderSettings,
  SyncPayload,
  SyncResult,
} from "@/shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/proxy${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: "Unknown error" }))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const apiClient = {
  listFolders: () => request<FolderRecord[]>("/folders"),
  listFolderAssets: () => request<FolderAsset[]>("/folder-assets"),
  createFolder: (payload: { name: string; parentFolderId?: string | null }) =>
    request<FolderRecord>("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  listDocuments: () => request<DocumentRecord[]>("/documents"),
  createDocument: (payload: Pick<DocumentRecord, "title" | "bodyHtml" | "deviceId" | "folderId">) =>
    request<DocumentRecord>("/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  uploadFolderAsset: async (folderId: string | null, file: File, kind: FolderAsset["kind"]) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("kind", kind);
    return request<FolderAsset>(`/folders/${folderId ?? "root"}/assets`, {
      method: "POST",
      body: formData,
    });
  },
  syncDocument: (id: string, payload: SyncPayload) =>
    request<SyncResult>(`/documents/${id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  uploadAsset: async (id: string, file: File, kind: DocumentAsset["kind"]) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("kind", kind);
    return request<DocumentAsset>(`/documents/${id}/assets`, {
      method: "POST",
      body: formData,
    });
  },
  getSettings: () => request<ProviderSettings>("/settings"),
  saveSettings: (payload: ProviderSettings) =>
    request<ProviderSettings>("/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  askAi: (payload: AIRequest) =>
    request<AIResponse>("/ai/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
};
