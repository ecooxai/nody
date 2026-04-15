import type {
  DocumentAsset,
  DocumentRecord,
  FolderAsset,
  FolderRecord,
  PromptTemplate,
  ProviderName,
  ProviderSettings,
  SyncResult,
} from "../../shared/types";
import { providerDefaults } from "../../lib/providers/defaults";

type DB = D1Database;

const defaultGeminiLiveModel = "gemini-3.1-flash-live-preview";
const defaultGeminiImageModel = "gemini-2.5-flash-image";
const deprecatedGeminiLiveModels = new Set([
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-live-2.5-flash-preview",
]);

function isMissingTableError(error: unknown, tableName: string) {
  return error instanceof Error && error.message.includes(`no such table: ${tableName}`);
}

function mapDocument(row: Record<string, unknown>, assets: DocumentAsset[]): DocumentRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    bodyHtml: String(row.body_html),
    folderId: row.folder_id ? String(row.folder_id) : null,
    revision: Number(row.revision),
    deviceId: String(row.device_id),
    updatedAt: String(row.updated_at),
    createdAt: String(row.created_at),
    assets,
  };
}

function mapFolder(row: Record<string, unknown>): FolderRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    parentFolderId: row.parent_folder_id ? String(row.parent_folder_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapFolderAsset(row: Record<string, unknown>): FolderAsset {
  return {
    id: String(row.id),
    folderId: row.folder_id ? String(row.folder_id) : null,
    kind: row.kind as FolderAsset["kind"],
    url: String(row.url),
    mimeType: String(row.mime_type),
    fileName: String(row.file_name),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: String(row.created_at),
  };
}

function mapPromptTemplate(row: Record<string, unknown>): PromptTemplate {
  return {
    id: String(row.id),
    name: String(row.name),
    content: String(row.content),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listFolders(db: DB, userId: string) {
  const rows = await db
    .prepare("SELECT * FROM folders WHERE user_id = ? ORDER BY updated_at DESC, name COLLATE NOCASE ASC")
    .bind(userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapFolder);
}

export async function createFolder(
  db: DB,
  userId: string,
  payload: { name: string; parentFolderId?: string | null },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO folders (id, user_id, name, parent_folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, payload.name, payload.parentFolderId ?? null, now, now)
    .run();
  return {
    id,
    name: payload.name,
    parentFolderId: payload.parentFolderId ?? null,
    createdAt: now,
    updatedAt: now,
  } satisfies FolderRecord;
}

export async function listDocuments(db: DB, userId: string) {
  const rows = await db
    .prepare("SELECT * FROM documents WHERE user_id = ? ORDER BY updated_at DESC, title COLLATE NOCASE ASC")
    .bind(userId)
    .all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return Promise.all(items.map(async (row: Record<string, unknown>) => mapDocument(row, await listAssets(db, String(row.id), userId))));
}

export async function createDocument(
  db: DB,
  userId: string,
  payload: { title: string; bodyHtml: string; deviceId: string; folderId?: string | null },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO documents (id, user_id, folder_id, title, body_html, revision, device_id, updated_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
    )
    .bind(id, userId, payload.folderId ?? null, payload.title, payload.bodyHtml, payload.deviceId, now, now)
    .run();
  return getDocument(db, id, userId);
}

export async function listFolderAssets(db: DB, userId: string) {
  const rows = await db
    .prepare("SELECT * FROM folder_assets WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapFolderAsset);
}

export async function saveFolderAsset(
  db: DB,
  userId: string,
  folderId: string | null,
  asset: Omit<FolderAsset, "folderId" | "createdAt">,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO folder_assets (id, folder_id, user_id, kind, url, mime_type, file_name, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(asset.id, folderId, userId, asset.kind, asset.url, asset.mimeType, asset.fileName, asset.sizeBytes, now)
    .run();
  return {
    ...asset,
    folderId,
    createdAt: now,
  } satisfies FolderAsset;
}

export async function getDocument(db: DB, id: string, userId: string) {
  const row = await db.prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?").bind(id, userId).first<Record<string, unknown>>();
  if (!row) return null;
  return mapDocument(row, await listAssets(db, id, userId));
}

export async function listAssets(db: DB, documentId: string, userId: string) {
  const rows = await db
    .prepare("SELECT * FROM document_assets WHERE document_id = ? AND user_id = ? ORDER BY created_at DESC")
    .bind(documentId, userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    kind: row.kind as DocumentAsset["kind"],
    url: String(row.url),
    mimeType: String(row.mime_type),
    fileName: String(row.file_name),
    createdAt: String(row.created_at),
  }));
}

export async function saveAsset(db: DB, userId: string, documentId: string, asset: Omit<DocumentAsset, "createdAt">) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO document_assets (id, document_id, user_id, kind, url, mime_type, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(asset.id, documentId, userId, asset.kind, asset.url, asset.mimeType, asset.fileName, now)
    .run();
  return { ...asset, createdAt: now };
}

export async function syncDocument(
  db: DB,
  userId: string,
  id: string,
  payload: { title: string; bodyHtml: string; baseRevision: number; deviceId: string },
): Promise<SyncResult | null> {
  const current = await getDocument(db, id, userId);
  if (!current) return null;
  if (payload.baseRevision !== current.revision) {
    return {
      ok: false,
      conflict: true,
      document: current,
      serverRevision: current.revision,
      message: "Remote version changed on another device. Review and re-apply local edits.",
    };
  }
  const nextRevision = current.revision + 1;
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE documents SET title = ?, body_html = ?, revision = ?, device_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(payload.title, payload.bodyHtml, nextRevision, payload.deviceId, now, id, userId)
    .run();
  await db
    .prepare(
      "INSERT INTO sync_events (id, document_id, user_id, device_id, base_revision, next_revision, event_type, created_at) VALUES (?, ?, ?, ?, ?, ?, 'sync', ?)",
    )
    .bind(crypto.randomUUID(), id, userId, payload.deviceId, payload.baseRevision, nextRevision, now)
    .run();
  const document = await getDocument(db, id, userId);
  return {
    ok: true,
    conflict: false,
    document: document!,
    serverRevision: nextRevision,
  };
}

export async function getSettings(db: DB, userId: string): Promise<ProviderSettings | null> {
  const row = await db
    .prepare(
      "SELECT provider, api_url, api_key, model, COALESCE(live_model, '') AS live_model, COALESCE(image_model, '') AS image_model FROM provider_settings WHERE user_id = ?",
    )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const liveModel = String(row.live_model);
  const imageModel = String(row.image_model);
  const provider = row.provider as ProviderSettings["provider"];
  const fallbackModel = providerDefaults[provider as ProviderName]?.model ?? "";
  const normalizedLiveModel = liveModel.trim();
  return {
    provider,
    apiUrl: String(row.api_url),
    apiKey: String(row.api_key),
    model: String(row.model).trim() ? String(row.model) : fallbackModel,
    liveModel:
      provider === "gemini"
        ? normalizedLiveModel && !deprecatedGeminiLiveModels.has(normalizedLiveModel)
          ? normalizedLiveModel
          : defaultGeminiLiveModel
        : "",
    imageModel: imageModel.trim() ? imageModel : provider === "gemini" ? defaultGeminiImageModel : "",
  };
}

export async function saveSettings(db: DB, userId: string, settings: ProviderSettings) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO provider_settings (user_id, provider, api_url, api_key, model, live_model, image_model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, api_url = excluded.api_url, api_key = excluded.api_key, model = excluded.model, live_model = excluded.live_model, image_model = excluded.image_model, updated_at = excluded.updated_at",
    )
    .bind(
      userId,
      settings.provider,
      settings.apiUrl,
      settings.apiKey,
      settings.model,
      settings.liveModel ?? "",
      settings.imageModel ?? "",
      now,
    )
    .run();
  return settings;
}

export async function listPromptTemplates(db: DB, userId: string) {
  try {
    const rows = await db
      .prepare("SELECT * FROM prompt_templates WHERE user_id = ? ORDER BY updated_at DESC, name COLLATE NOCASE ASC")
      .bind(userId)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapPromptTemplate);
  } catch (error) {
    if (isMissingTableError(error, "prompt_templates")) {
      return [];
    }
    throw error;
  }
}

export async function createPromptTemplate(db: DB, userId: string, payload: { name: string; content: string }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO prompt_templates (id, user_id, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, payload.name, payload.content, now, now)
    .run();
  return {
    id,
    name: payload.name,
    content: payload.content,
    createdAt: now,
    updatedAt: now,
  } satisfies PromptTemplate;
}

export async function updatePromptTemplate(
  db: DB,
  userId: string,
  promptId: string,
  payload: { name: string; content: string },
) {
  const existing = await db
    .prepare("SELECT created_at FROM prompt_templates WHERE id = ? AND user_id = ?")
    .bind(promptId, userId)
    .first<Record<string, unknown>>();

  if (!existing) {
    throw new Error("Prompt not found");
  }

  const now = new Date().toISOString();
  await db
    .prepare("UPDATE prompt_templates SET name = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(payload.name, payload.content, now, promptId, userId)
    .run();

  return {
    id: promptId,
    name: payload.name,
    content: payload.content,
    createdAt: String(existing.created_at),
    updatedAt: now,
  } satisfies PromptTemplate;
}
