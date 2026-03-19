export type ProviderName = "openai" | "gemini";

export type DocumentAsset = {
  id: string;
  kind: "image" | "audio" | "video";
  url: string;
  mimeType: string;
  fileName: string;
  createdAt: string;
};

export type FolderAsset = {
  id: string;
  folderId: string | null;
  kind: "image" | "audio" | "video";
  url: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
};

export type DocumentRecord = {
  id: string;
  title: string;
  bodyHtml: string;
  folderId: string | null;
  revision: number;
  deviceId: string;
  updatedAt: string;
  createdAt: string;
  assets: DocumentAsset[];
};

export type FolderRecord = {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderSettings = {
  provider: ProviderName;
  apiUrl: string;
  apiKey: string;
  model: string;
};

export type SyncPayload = {
  title: string;
  bodyHtml: string;
  baseRevision: number;
  deviceId: string;
};

export type SyncResult = {
  ok: boolean;
  conflict: boolean;
  document: DocumentRecord;
  serverRevision: number;
  message?: string;
};

export type AIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type TextSubstitution = {
  find: string;
  replace: string;
  all?: boolean;
};

export type AIRequest = {
  prompt: string;
  title: string;
  bodyHtml: string;
  selection?: string;
};

export type AIResponse = {
  answer: string;
  substitutions: TextSubstitution[];
};
