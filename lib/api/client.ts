import type {
  AIRequest,
  AIResponse,
  DocumentAsset,
  DocumentRecord,
  FolderAsset,
  FolderRecord,
  PromptTemplate,
  ProviderSettings,
  SyncPayload,
  SyncResult,
} from "@/shared/types";

type AIStreamHandlers = {
  onDelta: (delta: string) => void;
  onDone: (response: AIResponse) => Promise<void> | void;
  signal?: AbortSignal;
};

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

function parseSseEvent(block: string) {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    event,
    data: dataLines.join("\n"),
  };
}

export const apiClient = {
  listFolders: () => request<FolderRecord[]>("/folders"),
  listFolderAssets: () => request<FolderAsset[]>("/folder-assets"),
  listPrompts: () => request<PromptTemplate[]>("/prompts"),
  createFolder: (payload: { name: string; parentFolderId?: string | null }) =>
    request<FolderRecord>("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  createPrompt: (payload: Pick<PromptTemplate, "name" | "content">) =>
    request<PromptTemplate>("/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  updatePrompt: (id: string, payload: Pick<PromptTemplate, "name" | "content">) =>
    request<PromptTemplate>(`/prompts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  listDocuments: () => request<DocumentRecord[]>("/documents"),
  createDocument: (payload: Pick<DocumentRecord, "title" | "bodyMarkdown" | "deviceId" | "folderId">) =>
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
  renameFolderAsset: (id: string, fileName: string) =>
    request<FolderAsset>(`/folder-assets/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName }),
    }),
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
  askAiStream: async (payload: AIRequest, handlers: AIStreamHandlers) => {
    const response = await fetch("/api/proxy/ai/ask?stream=1", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: handlers.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let parsedError: string | null = null;
      try {
        const data = JSON.parse(text) as { error?: string };
        parsedError = data.error ?? null;
      } catch {}
      throw new Error(parsedError ?? text ?? `Request failed: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("AI stream did not return a readable body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let donePayload: AIResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (!rawEvent) continue;

        const { event, data } = parseSseEvent(rawEvent);
        if (event === "delta") {
          const payload = JSON.parse(data) as { delta?: string };
          if (payload.delta) handlers.onDelta(payload.delta);
          continue;
        }
        if (event === "done") {
          donePayload = JSON.parse(data) as AIResponse;
          await handlers.onDone(donePayload);
          continue;
        }
        if (event === "error") {
          const payload = JSON.parse(data) as { error?: string };
          throw new Error(payload.error ?? "AI stream failed.");
        }
      }

      if (done) break;
    }

    if (!donePayload) {
      throw new Error("AI stream ended before completion.");
    }
  },
};
