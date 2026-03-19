import type { AIRequest, ProviderSettings } from "../../shared/types";
import { createDefaultSettings } from "../../lib/providers/defaults";
import { askProvider } from "./ai";
import {
  createFolder,
  createDocument,
  getDocument,
  listFolders,
  listFolderAssets,
  getSettings,
  listDocuments,
  saveAsset,
  saveFolderAsset,
  saveSettings,
  syncDocument,
} from "./db";
import type { Env } from "./env";
import { json } from "./json";

function requireUserId(request: Request) {
  const userId = request.headers.get("x-user-id");
  if (!userId) throw new Error("Unauthorized");
  return userId;
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
        const object = await env.MEDIA_BUCKET.get(parts.slice(1).join("/"));
        if (!object) return json({ error: "Not found" }, { status: 404 });
        return new Response(request.method === "HEAD" ? null : object.body, {
          headers: {
            "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "*",
          },
        });
      }

      if (url.pathname === "/v1/health") return json({ ok: true });

      const userId = requireUserId(request);
      if (request.method === "GET" && parts[0] === "documents" && parts.length === 1) {
        return json(await listDocuments(env.DB, userId));
      }
      if (request.method === "POST" && parts[0] === "documents" && parts.length === 1) {
        const payload = await request.json() as { title: string; bodyHtml: string; deviceId: string; folderId?: string | null };
        return json(await createDocument(env.DB, userId, payload), { status: 201 });
      }
      if (request.method === "GET" && parts[0] === "folders" && parts.length === 1) {
        return json(await listFolders(env.DB, userId));
      }
      if (request.method === "GET" && parts[0] === "folder-assets" && parts.length === 1) {
        return json(await listFolderAssets(env.DB, userId));
      }
      if (request.method === "POST" && parts[0] === "folders" && parts.length === 1) {
        const payload = await request.json() as { name: string; parentFolderId?: string | null };
        return json(await createFolder(env.DB, userId, payload), { status: 201 });
      }
      if (request.method === "POST" && parts[0] === "folders" && parts[2] === "assets") {
        const formData = await request.formData();
        const file = formData.get("file");
        const kind = String(formData.get("kind"));
        if (!(file instanceof File)) return json({ error: "Missing file" }, { status: 400 });
        const folderId = parts[1] === "root" ? null : parts[1];
        const assetId = crypto.randomUUID();
        const key = `${userId}/folders/${folderId ?? "root"}/${assetId}-${file.name}`;
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
        const payload = await request.json() as { title: string; bodyHtml: string; baseRevision: number; deviceId: string };
        const result = await syncDocument(env.DB, userId, parts[1], payload);
        return result ? json(result, { status: result.conflict ? 409 : 200 }) : json({ error: "Not found" }, { status: 404 });
      }
      if (request.method === "POST" && parts[0] === "documents" && parts[2] === "assets") {
        const formData = await request.formData();
        const file = formData.get("file");
        const kind = String(formData.get("kind"));
        if (!(file instanceof File)) return json({ error: "Missing file" }, { status: 400 });
        const assetId = crypto.randomUUID();
        const key = `${userId}/${parts[1]}/${assetId}-${file.name}`;
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
        return json(await askProvider(settings, requestPayload));
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
