export type ProviderName = "openai" | "gemini";
export type AIMediaKind = "image" | "audio" | "video";

export type LiveRecordingSettings = {
  autoGainControl: boolean;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  recordingGain: number;
  standbyEnabled: boolean;
};

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
  bodyMarkdown: string;
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
  liveApiKey: string;
  liveModel: string;
  imageApiKey: string;
  imageModel: string;
  liveRecording: LiveRecordingSettings;
};

export type SyncPayload = {
  title: string;
  bodyMarkdown: string;
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

export type AIRequestMode = "chat" | "image" | "tts";

export type AIMessageAttachment = Pick<AIRequestAttachment, "id" | "kind" | "fileName" | "mimeType"> & {
  url?: string;
  origin?: "uploaded" | "generated";
  model?: string;
  width?: number;
  height?: number;
  resolution?: string;
  aspectRatio?: string;
  imageSize?: string;
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

export type AINoteReference = {
  id: string;
  title: string;
  folderName?: string | null;
};

export type AIResponseAction =
  | {
      type: "open_note";
      noteId?: string;
      title?: string;
    }
  | {
      type: "scroll_note";
      target: "top" | "middle" | "bottom" | "line" | "up" | "down";
      lineNumber?: number;
      pixels?: number;
    }
  | {
      type: "find_note";
      query: string;
      occurrence?: "first" | "next" | "previous";
    }
  | {
      type: "insert_latest_image";
      lineNumber?: number;
    }
  | {
      type: "upload_latest_image";
    };

export type AIRequest = {
  prompt: string;
  title: string;
  bodyMarkdown: string;
  selection?: string;
  attachments?: AIRequestAttachment[];
  availableNotes?: AINoteReference[];
  mode?: AIRequestMode;
};

export type AIResponseAttachment = {
  kind: AIMediaKind;
  fileName: string;
  mimeType: string;
  dataBase64: string;
  model?: string;
  width?: number;
  height?: number;
  resolution?: string;
  aspectRatio?: string;
  imageSize?: string;
};

export type AIResponse = {
  answer: string;
  substitutions: TextSubstitution[];
  attachments?: AIResponseAttachment[];
  actions?: AIResponseAction[];
};
