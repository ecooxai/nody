import { getEffectiveUserId } from "@/lib/auth/user";
import type { FolderAsset } from "@/shared/types";

async function redirectToFolderAsset(request: Request, path: string[]) {
  const userId = await getEffectiveUserId(request);

  const baseUrl = process.env.WORKER_API_BASE_URL;
  if (!baseUrl) {
    return Response.json({ error: "WORKER_API_BASE_URL is not configured" }, { status: 500 });
  }

  const workerUrl = new URL(`${baseUrl}/folder-url/${path.map(encodeURIComponent).join("/")}`);
  const response = await fetch(workerUrl, {
    headers: { "x-user-id": userId },
  });

  if (!response.ok) {
    return Response.json({ error: response.status === 404 ? "Not found" : "Failed to resolve file URL" }, { status: response.status });
  }

  const asset = (await response.json()) as FolderAsset;
  return Response.redirect(new URL(asset.url, request.url), 307);
}

export const GET = async (request: Request, context: { params: Promise<{ path: string[] }> }) => {
  const params = await context.params;
  return redirectToFolderAsset(request, params.path);
};

export const HEAD = async (request: Request, context: { params: Promise<{ path: string[] }> }) => {
  const params = await context.params;
  return redirectToFolderAsset(request, params.path);
};
