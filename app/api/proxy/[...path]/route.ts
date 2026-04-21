import { getEffectiveUserId } from "@/lib/auth/user";

const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": methods.join(", "),
    "access-control-allow-headers": "*",
  };
}

function sanitizeProxyResponseHeaders(response: Response, options?: { preserveContentLength?: boolean }) {
  const headers = new Headers(response.headers);

  // `fetch()` transparently decodes gzip/br content but may leave the original
  // transport headers behind. Forwarding those stale headers causes the browser
  // to attempt a second decode and fail.
  headers.delete("content-encoding");
  if (!options?.preserveContentLength) {
    headers.delete("content-length");
  }
  headers.delete("transfer-encoding");
  headers.delete("connection");
  headers.delete("keep-alive");
  headers.delete("proxy-authenticate");
  headers.delete("proxy-authorization");
  headers.delete("te");
  headers.delete("trailer");
  headers.delete("upgrade");

  return headers;
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
    userId = await getEffectiveUserId(request);
  }

  const baseUrl = process.env.WORKER_API_BASE_URL;
  if (!baseUrl) {
    return Response.json({ error: "WORKER_API_BASE_URL is not configured" }, { status: 500 });
  }

  const url = new URL(`${baseUrl}/${params.path.join("/")}`);
  const sourceUrl = new URL(request.url);
  sourceUrl.searchParams.forEach((value, key) => url.searchParams.set(key, value));

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const headers = new Headers();
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  if (userId) headers.set("x-user-id", userId);
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const ifRange = request.headers.get("if-range");
  if (ifRange) headers.set("if-range", ifRange);

  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      body,
      headers,
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

  const responseHeaders = sanitizeProxyResponseHeaders(response, { preserveContentLength: isMediaRequest });
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }
  if (params.path[0] === "media") {
    for (const [key, value] of Object.entries(corsHeaders())) {
      responseHeaders.set(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}

export const GET = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const HEAD = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const OPTIONS = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const POST = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const PUT = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const PATCH = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
export const DELETE = async (request: Request, context: { params: Promise<{ path: string[] }> }) => forward(request, await context.params);
