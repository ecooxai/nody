import { auth } from "@clerk/nextjs/server";

const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": methods.join(", "),
    "access-control-allow-headers": "*",
  };
}

async function forward(request: Request, params: { path: string[] }) {
  const isMediaRequest = params.path[0] === "media" && (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS");
  if (request.method === "OPTIONS" && params.path[0] === "media") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(),
        "access-control-max-age": "86400",
      },
    });
  }

  let userId: string | null = null;
  if (!isMediaRequest) {
    const result = await auth();
    userId = result.userId ?? null;
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const baseUrl = process.env.WORKER_API_BASE_URL;
  if (!baseUrl) {
    return Response.json({ error: "WORKER_API_BASE_URL is not configured" }, { status: 500 });
  }

  const url = new URL(`${baseUrl}/${params.path.join("/")}`);
  const sourceUrl = new URL(request.url);
  sourceUrl.searchParams.forEach((value, key) => url.searchParams.set(key, value));

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      body,
      headers: {
        "content-type": request.headers.get("content-type") ?? "application/json",
        ...(userId ? { "x-user-id": userId } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown proxy error";
    const isConnectionRefused =
      message.includes("ECONNREFUSED") ||
      (typeof error === "object" &&
        error !== null &&
        "cause" in error &&
        error.cause instanceof Error &&
        error.cause.message.includes("ECONNREFUSED"));

    if (isConnectionRefused) {
      return Response.json(
        {
          error: `Worker API is unreachable at ${baseUrl}. Start the Cloudflare worker dev server and try again.`,
        },
        { status: 503 },
      );
    }

    return Response.json(
      {
        error: `Proxy request failed: ${message}`,
      },
      { status: 502 },
    );
  }

  const buffer = await response.arrayBuffer();
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json",
  });
  if (params.path[0] === "media") {
    for (const [key, value] of Object.entries(corsHeaders())) {
      headers.set(key, value);
    }
  }
  return new Response(buffer, {
    status: response.status,
    headers,
  });
}

export const GET = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const HEAD = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const OPTIONS = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const POST = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const PUT = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const PATCH = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const DELETE = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
