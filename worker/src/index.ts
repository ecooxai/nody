import type { AIRequest, ProviderSettings } from "../../shared/types";
import { createDefaultSettings } from "../../lib/providers/defaults";
import { askProvider, streamProvider } from "./ai";
import {
  createPromptTemplate,
  createFolder,
  createDocument,
  findFolderAssetByPath,
  getDocument,
  listFolders,
  listFolderAssets,
  listPromptTemplates,
  moveDocument,
  moveFolder,
  moveFolderAsset,
  updatePromptTemplate,
  getSettings,
  listDocuments,
  saveAsset,
  saveFolderAsset,
  saveSettings,
  syncDocument,
  updateFolderAssetName,
} from "./db";
import type { Env } from "./env";
import { json } from "./json";

function requireUserId(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

function decodePathSegments(parts: string[]) {
  try {
    return parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function normalizeFileName(value: unknown) {
  if (typeof value !== "string") return null;
  const fileName = value.trim();
  if (!fileName || fileName.length > 180 || /[\\/]/.test(fileName)) return null;
  return fileName;
}

function normalizeNullableId(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id || null;
}

type ParsedByteRange = {
  end: number;
  length: number;
  offset: number;
};

function parseByteRange(rangeHeader: string | null, size: number): ParsedByteRange | "invalid" | null {
  if (!rangeHeader) return null;
  if (size <= 0) return "invalid";
  const normalized = rangeHeader.trim();
  if (!normalized.startsWith("bytes=") || normalized.includes(",")) return "invalid";

  const range = normalized.slice("bytes=".length).trim();
  const separator = range.indexOf("-");
  if (separator < 0) return "invalid";

  const startText = range.slice(0, separator).trim();
  const endText = range.slice(separator + 1).trim();
  if (!startText && !endText) return "invalid";

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    const length = Math.min(suffixLength, size);
    const offset = Math.max(0, size - length);
    return { offset, length, end: size > 0 ? size - 1 : 0 };
  }

  const offset = Number(startText);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) return "invalid";
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return "invalid";
  const end = Math.min(requestedEnd, size - 1);
  return { offset, end, length: end - offset + 1 };
}

function mediaHeaders(object: R2Object, contentLength: number, range?: ParsedByteRange) {
  const headers = new Headers({
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(contentLength),
    "accept-ranges": "bytes",
    "etag": object.httpEtag,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "*",
  });
  object.writeHttpMetadata(headers);
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.end}/${object.size}`);
  }
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.replace(/^\/v1\//, "").split("/").filter(Boolean);

      if (request.method === "OPTIONS" && parts[0] === "media" && parts[1]) {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "*",
            "access-control-max-age": "86400",
          },
        });
      }

      if ((request.method === "GET" || request.method === "HEAD") && parts[0] === "media" && parts[1]) {
        const key = parts.slice(1).join("/");
        const head = await env.MEDIA_BUCKET.head(key);
        if (!head) return json({ error: "Not found" }, { status: 404 });

        const range = parseByteRange(request.headers.get("range"), head.size);
        if (range === "invalid") {
          return new Response(null, {
            status: 416,
            headers: {
              "content-range": `bytes */${head.size}`,
              "accept-ranges": "bytes",
              "access-control-allow-origin": "*",
              "access-control-allow-methods": "GET, HEAD, OPTIONS",
              "access-control-allow-headers": "*",
            },
          });
        }

        if (request.method === "HEAD") {
          return new Response(null, {
            status: range ? 206 : 200,
            headers: mediaHeaders(head, range?.length ?? head.size, range ?? undefined),
          });
        }

        const object = await env.MEDIA_BUCKET.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
        if (!object) return json({ error: "Not found" }, { status: 404 });
        return new Response(object.body, {
          status: range ? 206 : 200,
          headers: mediaHeaders(head, range?.length ?? head.size, range ?? undefined),
        });
      }

      if (url.pathname === "/v1/health") return json({ ok: true });

      const userId = requireUserId(request);
      if (request.method === "GET" && parts[0] === "documents" && parts.length === 1) {
        return json(await listDocuments(env.DB, userId));
      }
      if (request.method === "POST" && parts[0] === "documents" && parts.length === 1) {
        const payload = await request.json() as { title: string; bodyMarkdown: string; deviceId: string; folderId?: string | null };
        return json(await createDocument(env.DB, userId, payload), { status: 201 });
      }
      if (request.method === "GET" && parts[0] === "folders" && parts.length === 1) {
        return json(await listFolders(env.DB, userId));
      }
      if (request.method === "GET" && parts[0] === "folder-assets" && parts.length === 1) {
        return json(await listFolderAssets(env.DB, userId));
      }
      if (request.method === "GET" && parts[0] === "folder-url" && parts.length >= 2) {
        const pathSegments = decodePathSegments(parts.slice(1));
        if (!pathSegments) return json({ error: "Invalid folder path" }, { status: 400 });
        const asset = await findFolderAssetByPath(env.DB, userId, pathSegments);
        return asset ? json(asset) : json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "GET" && parts[0] === "prompts" && parts.length === 1) {
        return json(await listPromptTemplates(env.DB, userId));
      }
      if (request.method === "POST" && parts[0] === "folders" && parts.length === 1) {
        const payload = await request.json() as { name: string; parentFolderId?: string | null };
        return json(await createFolder(env.DB, userId, payload), { status: 201 });
      }
      if (request.method === "PUT" && parts[0] === "folders" && parts[2] === "move") {
        const payload = await request.json() as { parentFolderId?: unknown };
        const parentFolderId = normalizeNullableId(payload.parentFolderId);
        if (parentFolderId === undefined) return json({ error: "Invalid target folder" }, { status: 400 });
        const folder = await moveFolder(env.DB, userId, parts[1], parentFolderId);
        return folder ? json(folder) : json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "POST" && parts[0] === "prompts" && parts.length === 1) {
        const payload = await request.json() as { name: string; content: string };
        return json(await createPromptTemplate(env.DB, userId, payload), { status: 201 });
      }
      if (request.method === "PUT" && parts[0] === "prompts" && parts.length === 2) {
        const payload = await request.json() as { name: string; content: string };
        return json(await updatePromptTemplate(env.DB, userId, parts[1], payload));
      }
      if (request.method === "PUT" && parts[0] === "folder-assets" && parts.length === 2) {
        const payload = await request.json() as { fileName?: unknown };
        const fileName = normalizeFileName(payload.fileName);
        if (!fileName) return json({ error: "Use a file name without slashes." }, { status: 400 });
        const asset = await updateFolderAssetName(env.DB, userId, parts[1], fileName);
        return asset ? json(asset) : json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "PUT" && parts[0] === "folder-assets" && parts[2] === "move") {
        const payload = await request.json() as { folderId?: unknown };
        const folderId = normalizeNullableId(payload.folderId);
        if (folderId === undefined) return json({ error: "Invalid target folder" }, { status: 400 });
        const asset = await moveFolderAsset(env.DB, userId, parts[1], folderId);
        return asset ? json(asset) : json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "POST" && parts[0] === "folders" && parts[2] === "assets") {
        const formData = await request.formData();
        const file = formData.get("file");
        const kind = String(formData.get("kind"));
        if (!(file instanceof File)) return json({ error: "Missing file" }, { status: 400 });
        const folderId = parts[1] === "root" ? null : parts[1];
        const assetId = crypto.randomUUID();
        const key = `${userId}/folders/${folderId ?? "root"}/upload/${assetId}-${file.name}`;
        await env.MEDIA_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        });
        const asset = await saveFolderAsset(env.DB, userId, folderId, {
          id: assetId,
          kind: kind as "image" | "audio" | "video",
          url: `/api/proxy/media/${key}`,
          mimeType: file.type,
          fileName: file.name,
          sizeBytes: file.size,
        });
        return json(asset, { status: 201 });
      }
      if (request.method === "POST" && parts[0] === "documents" && parts[2] === "sync") {
        const payload = await request.json() as { title: string; bodyMarkdown: string; baseRevision: number; deviceId: string };
        const result = await syncDocument(env.DB, userId, parts[1], payload);
        return result ? json(result, { status: result.conflict ? 409 : 200 }) : json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "PUT" && parts[0] === "documents" && parts[2] === "move") {
        const payload = await request.json() as { folderId?: unknown };
        const folderId = normalizeNullableId(payload.folderId);
        if (folderId === undefined) return json({ error: "Invalid target folder" }, { status: 400 });
        const document = await moveDocument(env.DB, userId, parts[1], folderId);
        return document ? json(document) : json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "POST" && parts[0] === "documents" && parts[2] === "assets") {
        const formData = await request.formData();
        const file = formData.get("file");
        const kind = String(formData.get("kind"));
        if (!(file instanceof File)) return json({ error: "Missing file" }, { status: 400 });
        const assetId = crypto.randomUUID();
        const key = `${userId}/${parts[1]}/upload/${assetId}-${file.name}`;
        await env.MEDIA_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        });
        const asset = await saveAsset(env.DB, userId, parts[1], {
          id: assetId,
          kind: kind as "image" | "audio" | "video",
          url: `/api/proxy/media/${key}`,
          mimeType: file.type,
          fileName: file.name,
        });
        return json(asset, { status: 201 });
      }
      if (request.method === "GET" && parts[0] === "settings") {
        const settings = (await getSettings(env.DB, userId)) ?? createDefaultSettings();
        return json(settings);
      }
      if (request.method === "PUT" && parts[0] === "settings") {
        const settings = await request.json() as ProviderSettings;
        return json(await saveSettings(env.DB, userId, settings));
      }
      if (request.method === "POST" && parts[0] === "ai" && parts[1] === "ask") {
        const requestPayload = await request.json() as AIRequest;
        const settings = (await getSettings(env.DB, userId)) ?? createDefaultSettings();
        if (url.searchParams.get("stream") === "1") {
          return await streamProvider(env, userId, settings, requestPayload);
        }
        return json(await askProvider(env, userId, settings, requestPayload));
      }
      if (request.method === "GET" && parts[0] === "documents" && parts[1]) {
        const document = await getDocument(env.DB, parts[1], userId);
        return document ? json(document) : json({ error: "Not found" }, { status: 404 });
      }
      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected worker error";
      const status = message === "Unauthorized" ? 401 : 500;
      return json({ error: message }, { status });
    }
  },
};
