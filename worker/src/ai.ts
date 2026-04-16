import type {
  AIRequest,
  AIRequestAttachment,
  AIResponse,
  AIResponseAttachment,
  ProviderSettings,
} from "../../shared/types";
import { safeJsonParse } from "../../shared/substitutions";
import type { Env } from "./env";

const systemPrompt =
  [
    "You are a writing assistant inside a note editor.",
    "Reply with JSON only using this shape: {\"answer\":\"...\",\"substitutions\":[{\"find\":\"...\",\"replace\":\"...\",\"all\":false}]}",
    "Use the selection as the primary editing target when it is provided.",
    "Only propose substitutions when the user asks to rewrite, edit, fix, shorten, expand, or transform text.",
    "Each substitution must use exact source text from the document or selection.",
    "Keep substitutions minimal, precise, and safe to apply mechanically.",
    "Do not include markdown fences or extra keys.",
  ].join(" ");

const streamHeaders = {
  "cache-control": "no-cache, no-transform",
  "content-type": "text/event-stream; charset=utf-8",
};

export async function askProvider(env: Env, userId: string, settings: ProviderSettings, request: AIRequest): Promise<AIResponse> {
  if (!settings.apiKey) {
    throw new Error("Missing API key. Save provider settings first.");
  }
  if (request.mode === "image") {
    if (settings.provider !== "gemini") {
      throw new Error("Image generation is currently supported only with the Gemini provider.");
    }
    return askGeminiImage(env, userId, settings, request);
  }
  return settings.provider === "gemini" ? askGemini(env, userId, settings, request) : askOpenAI(settings, request);
}

export async function streamProvider(env: Env, userId: string, settings: ProviderSettings, request: AIRequest): Promise<Response> {
  if (!settings.apiKey) {
    throw new Error("Missing API key. Save provider settings first.");
  }
  if (request.mode === "image") {
    const response = await askProvider(env, userId, settings, request);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify(response)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: streamHeaders });
  }

  const upstream =
    settings.provider === "gemini"
      ? await askGeminiStream(env, userId, settings, request)
      : await askOpenAIStream(settings, request);

  if (!upstream.ok) {
    throw new Error(await readProviderError(upstream, `${settings.provider === "gemini" ? "Gemini" : "OpenAI"} request failed`));
  }
  if (!upstream.body) {
    throw new Error("Provider stream did not return a readable body.");
  }
  const upstreamBody = upstream.body;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const text =
          settings.provider === "gemini"
            ? await pumpProviderStream(upstreamBody, readGeminiStreamChunk, send)
            : await pumpProviderStream(upstreamBody, readOpenAIStreamChunk, send);
        const finalResponse = normalizeAiResponse(safeJsonParse<AIResponse>(text, { answer: "No answer", substitutions: [] }));
        send("done", finalResponse);
        controller.close();
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : "AI stream failed." });
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: streamHeaders });
}

async function askOpenAI(settings: ProviderSettings, request: AIRequest) {
  if (request.attachments?.length) {
    throw new Error("Media attachments are currently supported only with the Gemini provider.");
  }
  const response = await fetch(`${settings.apiUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildPromptText(request) },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    throw new Error(await readProviderError(response, "OpenAI request failed"));
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return normalizeAiResponse(safeJsonParse<AIResponse>(data.choices?.[0]?.message?.content ?? "", { answer: "No answer", substitutions: [] }));
}

async function askOpenAIStream(settings: ProviderSettings, request: AIRequest) {
  if (request.attachments?.length) {
    throw new Error("Media attachments are currently supported only with the Gemini provider.");
  }
  return fetch(`${settings.apiUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.4,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildPromptText(request) },
      ],
      response_format: { type: "json_object" },
    }),
  });
}

async function askGemini(env: Env, userId: string, settings: ProviderSettings, request: AIRequest) {
  const response = await fetch(buildGeminiUrl(settings), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await buildGeminiPayload(env, userId, request)),
  });
  if (!response.ok) {
    throw new Error(await readProviderError(response, "Gemini request failed"));
  }
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return normalizeAiResponse(safeJsonParse<AIResponse>(text, { answer: "No answer", substitutions: [] }));
}

async function askGeminiImage(env: Env, userId: string, settings: ProviderSettings, request: AIRequest) {
  const response = await fetch(buildGeminiImageUrl(settings), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await buildGeminiImagePayload(env, userId, request)),
  });
  if (!response.ok) {
    throw new Error(await readProviderError(response, "Gemini image generation failed"));
  }
  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inlineData?: { data?: string; mimeType?: string };
        }>;
      };
    }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const attachments = parts
    .flatMap((part, index): AIResponseAttachment[] => {
      const inlineData = part.inlineData;
      if (!inlineData?.data) return [];
      const mimeType = inlineData.mimeType?.trim() || "image/png";
      if (!mimeType.startsWith("image/")) return [];
      const extension = imageExtensionForMimeType(mimeType);
      return [
        {
          kind: "image",
          fileName: `generated-image-${index + 1}.${extension}`,
          mimeType,
          dataBase64: inlineData.data,
        },
      ];
    });
  const answer = parts
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");

  return normalizeAiResponse({
    answer: answer || (attachments.length > 0 ? "Generated image." : "No answer"),
    substitutions: [],
    attachments,
  });
}

async function askGeminiStream(env: Env, userId: string, settings: ProviderSettings, request: AIRequest) {
  return fetch(buildGeminiUrl(settings, true), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await buildGeminiPayload(env, userId, request)),
  });
}

async function buildGeminiPayload(env: Env, userId: string, request: AIRequest) {
  return {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: buildPromptText(request),
          },
          ...(await buildGeminiAttachmentParts(env, userId, request.attachments ?? [])),
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
    },
  };
}

async function buildGeminiImagePayload(env: Env, userId: string, request: AIRequest) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: buildImagePromptText(request),
          },
          ...(await buildGeminiAttachmentParts(env, userId, request.attachments ?? [])),
        ],
      },
    ],
  };
}

async function buildGeminiAttachmentParts(env: Env, userId: string, attachments: AIRequestAttachment[]) {
  const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

  for (const attachment of attachments) {
    const inlineData = attachment.dataBase64?.trim();
    if (inlineData) {
      parts.push({
        inlineData: {
          mimeType: attachment.mimeType,
          data: inlineData,
        },
      });
      continue;
    }

    if (!attachment.assetUrl) {
      throw new Error(`Attachment "${attachment.fileName}" is missing file data.`);
    }

    const key = extractMediaKey(attachment.assetUrl, userId);
    const object = await env.MEDIA_BUCKET.get(key);
    if (!object) {
      throw new Error(`Attachment "${attachment.fileName}" could not be found.`);
    }

    const buffer = await object.arrayBuffer();
    parts.push({
      inlineData: {
        mimeType: attachment.mimeType || object.httpMetadata?.contentType || "application/octet-stream",
        data: arrayBufferToBase64(buffer),
      },
    });
  }

  return parts;
}

async function pumpProviderStream(
  body: ReadableStream<Uint8Array>,
  readChunk: (payload: string) => string,
  send: (event: string, data: unknown) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let rawJson = "";
  let streamedAnswer = "";

  while (true) {
    const { done, value } = await reader.read();
    sseBuffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let boundary = findEventBoundary(sseBuffer);
    while (boundary >= 0) {
      const block = sseBuffer.slice(0, boundary).trim();
      sseBuffer = sseBuffer.slice(boundary + eventBoundaryLength(sseBuffer, boundary));
      boundary = findEventBoundary(sseBuffer);
      if (!block) continue;

      const data = readSseData(block);
      if (!data || data === "[DONE]") continue;
      const chunk = readChunk(data);
      if (!chunk) continue;

      rawJson += chunk;
      const answerPreview = extractAnswerPreview(rawJson);
      if (answerPreview.startsWith(streamedAnswer) && answerPreview.length > streamedAnswer.length) {
        const delta = answerPreview.slice(streamedAnswer.length);
        streamedAnswer = answerPreview;
        send("delta", { delta });
      }
    }

    if (done) break;
  }

  return rawJson;
}

function readOpenAIStreamChunk(payload: string) {
  const data = safeJsonParse<{ choices?: Array<{ delta?: { content?: string } }> }>(payload, {});
  return (data.choices ?? []).map((choice) => choice.delta?.content ?? "").join("");
}

function readGeminiStreamChunk(payload: string) {
  const data = safeJsonParse<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(payload, {});
  return (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
}

function readSseData(block: string) {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function findEventBoundary(buffer: string) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function eventBoundaryLength(buffer: string, index: number) {
  return buffer.slice(index).startsWith("\r\n\r\n") ? 4 : 2;
}

function extractAnswerPreview(rawJson: string) {
  const match = /"answer"\s*:\s*"/.exec(rawJson);
  if (!match) return "";

  let decoded = "";
  let index = match.index + match[0].length;
  while (index < rawJson.length) {
    const char = rawJson[index];
    if (char === "\"") {
      return decoded;
    }
    if (char !== "\\") {
      decoded += char;
      index += 1;
      continue;
    }

    const next = rawJson[index + 1];
    if (!next) return decoded;
    if (next === "u") {
      const unicode = rawJson.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(unicode)) return decoded;
      decoded += String.fromCharCode(Number.parseInt(unicode, 16));
      index += 6;
      continue;
    }

    const escapes: Record<string, string> = {
      "\"": "\"",
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (!(next in escapes)) return decoded;
    decoded += escapes[next];
    index += 2;
  }

  return decoded;
}

function normalizeAiResponse(response: AIResponse): AIResponse {
  return {
    answer: typeof response.answer === "string" && response.answer.trim() ? response.answer.trim() : "No answer",
    substitutions: Array.isArray(response.substitutions)
      ? response.substitutions
          .filter((edit) => typeof edit?.find === "string" && typeof edit?.replace === "string")
          .map((edit) => ({
            find: edit.find,
            replace: edit.replace,
            all: Boolean(edit.all),
          }))
      : [],
    attachments: Array.isArray(response.attachments)
      ? response.attachments
          .filter(
            (attachment) =>
              typeof attachment?.dataBase64 === "string" &&
              Boolean(attachment.dataBase64.trim()) &&
              typeof attachment?.fileName === "string" &&
              typeof attachment?.mimeType === "string" &&
              attachment.kind === "image",
          )
          .map((attachment) => ({
            kind: "image",
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            dataBase64: attachment.dataBase64,
          }))
      : [],
  };
}

async function readProviderError(response: Response, fallback: string) {
  const body = await response.text();
  return body ? `${fallback}: ${body}` : fallback;
}

function buildPromptText(request: AIRequest) {
  return `Title: ${request.title}\n\nDocument Markdown:\n${request.bodyMarkdown}\n\nSelection:\n${request.selection ?? ""}\n\nPrompt:\n${request.prompt}`;
}

function buildImagePromptText(request: AIRequest) {
  return [
    request.prompt.trim(),
    request.selection?.trim() ? `Selected note text:\n${request.selection.trim()}` : "",
    request.title.trim() ? `Note title:\n${request.title.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildGeminiUrl(settings: ProviderSettings, stream = false) {
  const base = settings.apiUrl.replace(/\/$/, "");
  const key = encodeURIComponent(settings.apiKey);
  return stream
    ? `${base}/v1beta/models/${settings.model}:streamGenerateContent?alt=sse&key=${key}`
    : `${base}/v1beta/models/${settings.model}:generateContent?key=${key}`;
}

function buildGeminiImageUrl(settings: ProviderSettings) {
  const base = settings.apiUrl.replace(/\/$/, "");
  const key = encodeURIComponent(settings.apiKey);
  const model = encodeURIComponent(settings.imageModel || "gemini-3.1-flash-image-preview");
  return `${base}/v1beta/models/${model}:generateContent?key=${key}`;
}

function imageExtensionForMimeType(mimeType: string) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "jpg";
}

function extractMediaKey(url: string, userId: string) {
  const pathname = new URL(url, "https://workspace.local").pathname;
  const proxyPrefix = "/api/proxy/media/";
  const workerPrefix = "/v1/media/";
  const key = pathname.startsWith(proxyPrefix)
    ? pathname.slice(proxyPrefix.length)
    : pathname.startsWith(workerPrefix)
      ? pathname.slice(workerPrefix.length)
      : null;

  if (!key) {
    throw new Error("Unsupported attachment URL.");
  }
  if (!key.startsWith(`${userId}/`)) {
    throw new Error("Attachment URL does not belong to the current user.");
  }
  return decodeURIComponent(key);
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
