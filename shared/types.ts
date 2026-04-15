export type ProviderName = "openai" | "gemini";
export type AIMediaKind = "image" | "audio" | "video";

export type DocumentAsset = {
  id: string;
  kind: AIMediaKind;
  url: string;
  mimeType: string;
  fileName: string;
  createdAt: string;
};

export type FolderAsset = {
  id: string;
  folderId: string | null;
  kind: AIMediaKind;
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
  liveModel: string;
  imageModel: string;
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

export type PromptTemplate = {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  builtin?: boolean;
};

export type AIRequestAttachment = {
  id: string;
  kind: AIMediaKind;
  fileName: string;
  mimeType: string;
  source: "upload" | "folder";
  dataBase64?: string;
  assetUrl?: string;
};

export type AIMessageAttachment = Pick<AIRequestAttachment, "id" | "kind" | "fileName" | "mimeType"> & {
  url?: string;
};

export type AIMessagePrompt = Pick<PromptTemplate, "id" | "name" | "content">;

export type AIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  substitutions?: TextSubstitution[];
  attachments?: AIMessageAttachment[];
  prompts?: AIMessagePrompt[];
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
  attachments?: AIRequestAttachment[];
};

export type AIResponse = {
  answer: string;
  substitutions: TextSubstitution[];
};
