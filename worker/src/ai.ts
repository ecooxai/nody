import type {
  AIRequest,
  AIRequestAttachment,
  AIResponse,
  AIResponseAttachment,
  AIResponseAction,
  ProviderSettings,
} from "../../shared/types";
import { safeJsonParse } from "../../shared/substitutions";
import type { Env } from "./env";

const systemPrompt =
  [
    "You are a writing assistant inside a note editor.",
    "Reply with JSON only using this shape: {\"answer\":\"...\",\"substitutions\":[{\"find\":\"...\",\"replace\":\"...\",\"all\":false}],\"actions\":[{\"type\":\"open_note\",\"noteId\":\"...\",\"title\":\"...\"}]}",
    "Use the selection as the primary editing target when it is provided.",
    "Only propose substitutions when the user asks to rewrite, edit, fix, shorten, expand, or transform text.",
    "Each substitution must use exact source text from the document or selection.",
    "Keep substitutions minimal, precise, and safe to apply mechanically.",
    "When the user asks to open or switch to a note by name, add one open_note action using an exact note id from Available notes. Do not invent note ids.",
    "When the user asks to scroll within the note, add a scroll_note action. Use target top, middle, bottom, line, up, or down. Include lineNumber for line scrolling and pixels for up/down scrolling when helpful.",
    "When the user asks to find text in the note or move to the next match, add a find_note action with the search query and occurrence set to first, next, or previous when relevant.",
    "When the user asks to create or edit an image, first ask for a spoken confirmation such as 'generate image' or 'do not generate' and do not call any image tool until the user confirms.",
    "When the user asks to upload the latest generated image, add one upload_latest_image action.",
    "When the user asks to insert the latest generated image into the note, add one insert_latest_image action. Include lineNumber only when the user gives a line number.",
    "Do not include markdown fences or extra keys.",
  ].join(" ");

const streamHeaders = {
  "cache-control": "no-cache, no-transform",
  "content-type": "text/event-stream; charset=utf-8",
};

const geminiTtsModel = "gemini-3.1-flash-tts-preview";
const defaultGeminiImageModel = "gemini-3.1-flash-image-preview";
const defaultGeminiImageAspectRatio = "1:1";
const defaultGeminiImageSize = "1K";
const supportedGeminiImageAspectRatios = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
const supportedGeminiImageAspectRatioSet = new Set<string>(supportedGeminiImageAspectRatios);
const geminiImageDimensions1k: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "2:3": { width: 848, height: 1264 },
  "3:2": { width: 1264, height: 848 },
  "3:4": { width: 896, height: 1200 },
  "4:3": { width: 1200, height: 896 },
  "4:5": { width: 928, height: 1152 },
  "5:4": { width: 1152, height: 928 },
  "9:16": { width: 768, height: 1376 },
  "16:9": { width: 1376, height: 768 },
  "21:9": { width: 1584, height: 672 },
};
const gemini25ImageDimensions: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "2:3": { width: 832, height: 1248 },
  "3:2": { width: 1248, height: 832 },
  "3:4": { width: 864, height: 1184 },
  "4:3": { width: 1184, height: 864 },
  "4:5": { width: 896, height: 1152 },
  "5:4": { width: 1152, height: 896 },
  "9:16": { width: 768, height: 1344 },
  "16:9": { width: 1344, height: 768 },
  "21:9": { width: 1536, height: 672 },
};

type GeminiImageRequestConfig = {
  model: string;
  aspectRatio: string;
  imageSize?: string;
  fallbackWidth: number;
  fallbackHeight: number;
  fallbackResolution: string;
};

export async function askProvider(env: Env, userId: string, settings: ProviderSettings, request: AIRequest): Promise<AIResponse> {
  if (!settings.apiKey) {
    throw new Error("Missing API key. Save provider settings first.");
  }
  if (request.mode === "tts") {
    if (settings.provider !== "gemini") {
      throw new Error("Text-to-speech is currently supported only with the Gemini provider.");
    }
    return askGeminiTts(settings, request);
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
  if (request.mode === "image" || request.mode === "tts") {
    const response = await askProvider(env, userId, settings, request);
    return doneStream(response);
  }

  const upstream =
    settings.provider === "gemini"
      ? await askGeminiStream(env, userId, settings, request)
      : await askOpenAIStream(settings, request);

  if (!upstream.ok) {
    const streamError = await readProviderError(upstream, `${settings.provider === "gemini" ? "Gemini" : "OpenAI"} streaming request failed`);
    try {
      return doneStream(await askProvider(env, userId, settings, request));
    } catch (error) {
      const fallbackError = error instanceof Error ? error.message : "Fallback request failed";
      throw new Error(`${streamError}; fallback failed: ${fallbackError}`);
    }
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

function doneStream(response: AIResponse) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify(response)}\n\n`));
      controller.close();
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
  const imageRequest = buildGeminiImageRequestConfig(settings, request);
  const response = await fetch(buildGeminiImageUrl(settings, imageRequest.model), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await buildGeminiImagePayload(env, userId, request, imageRequest)),
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
      const dimensions = readImageDimensionsFromBase64(inlineData.data, mimeType) ?? {
        width: imageRequest.fallbackWidth,
        height: imageRequest.fallbackHeight,
      };
      const resolution = `${dimensions.width}x${dimensions.height}`;
      return [
        {
          kind: "image",
          fileName: `generated-image-${index + 1}.${extension}`,
          mimeType,
          dataBase64: inlineData.data,
          model: imageRequest.model,
          width: dimensions.width,
          height: dimensions.height,
          resolution,
          aspectRatio: imageRequest.aspectRatio,
          imageSize: imageRequest.imageSize ?? defaultGeminiImageSize,
        },
      ];
    });
  const answer = parts
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");

  return normalizeAiResponse({
    answer: withImageGenerationSummary(answer || (attachments.length > 0 ? "Generated image." : "No answer"), attachments, imageRequest),
    substitutions: [],
    attachments,
  });
}

async function askGeminiTts(settings: ProviderSettings, request: AIRequest) {
  const text = request.selection?.trim() || request.prompt.trim();
  if (!text) {
    throw new Error("Select text to read aloud first.");
  }

  const response = await fetch(buildGeminiTtsUrl(settings), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: buildTtsPromptText(text),
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Kore",
            },
          },
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(await readProviderError(response, "Gemini TTS request failed"));
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { data?: string; mimeType?: string };
        }>;
      };
    }>;
  };
  const inlineData = data.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!inlineData?.data) {
    throw new Error("Gemini TTS returned no audio.");
  }

  const sampleRate = parsePcmSampleRate(inlineData.mimeType) ?? 24000;
  return normalizeAiResponse({
    answer: "Read-aloud audio.",
    substitutions: [],
    attachments: [
      {
        kind: "audio",
        fileName: `read-aloud-${Date.now()}.wav`,
        mimeType: "audio/wav",
        dataBase64: pcm16Base64ToWavBase64(inlineData.data, sampleRate),
      },
    ],
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

async function buildGeminiImagePayload(env: Env, userId: string, request: AIRequest, imageRequest: GeminiImageRequestConfig) {
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
    generationConfig: {
      imageConfig: {
        aspectRatio: imageRequest.aspectRatio,
        ...(imageRequest.imageSize ? { imageSize: imageRequest.imageSize } : {}),
      },
    },
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
    actions: Array.isArray(response.actions)
      ? response.actions.flatMap<AIResponseAction>((action) => {
          if (!action || typeof action.type !== "string") return [];
          if (action.type === "open_note") {
            const noteId = typeof action.noteId === "string" ? action.noteId.trim() : "";
            const title = typeof action.title === "string" ? action.title.trim() : "";
            if (!noteId && !title) return [];
            return [
              {
                type: "open_note" as const,
                ...(noteId ? { noteId } : {}),
                ...(title ? { title } : {}),
              },
            ];
          }
          if (action.type === "scroll_note") {
            const target = typeof action.target === "string" ? action.target.trim() : "";
            if (!["top", "middle", "bottom", "line", "up", "down"].includes(target)) return [];
            const rawLineNumber = "lineNumber" in action ? action.lineNumber : undefined;
            const lineNumber = typeof rawLineNumber === "number" && Number.isFinite(rawLineNumber) ? Math.max(1, Math.floor(rawLineNumber)) : undefined;
            const rawPixels = "pixels" in action ? action.pixels : undefined;
            const pixels = typeof rawPixels === "number" && Number.isFinite(rawPixels) ? Math.max(1, Math.floor(rawPixels)) : undefined;
            return [
              {
                type: "scroll_note" as const,
                target: target as "top" | "middle" | "bottom" | "line" | "up" | "down",
                ...(lineNumber ? { lineNumber } : {}),
                ...(pixels ? { pixels } : {}),
              },
            ];
          }
          if (action.type === "find_note") {
            const query = typeof action.query === "string" ? action.query.trim() : "";
            const occurrence = typeof action.occurrence === "string" ? action.occurrence.trim() : "";
            if (!query) return [];
            return [
              {
                type: "find_note" as const,
                query,
                ...(occurrence === "first" || occurrence === "next" || occurrence === "previous" ? { occurrence } : {}),
              },
            ];
          }
          if (action.type === "insert_latest_image") {
            const rawLineNumber = "lineNumber" in action ? action.lineNumber : undefined;
            const lineNumber = typeof rawLineNumber === "number" && Number.isFinite(rawLineNumber) ? Math.max(1, Math.floor(rawLineNumber)) : undefined;
            return [
              {
                type: "insert_latest_image" as const,
                ...(lineNumber ? { lineNumber } : {}),
              },
            ];
          }
          if (action.type === "upload_latest_image") {
            return [{ type: "upload_latest_image" as const }];
          }
          return [];
        })
      : [],
    attachments: Array.isArray(response.attachments)
      ? response.attachments
          .filter(
            (attachment) =>
              typeof attachment?.dataBase64 === "string" &&
              Boolean(attachment.dataBase64.trim()) &&
              typeof attachment?.fileName === "string" &&
              typeof attachment?.mimeType === "string" &&
              (attachment.kind === "image" || attachment.kind === "audio" || attachment.kind === "video") &&
              attachment.mimeType.startsWith(`${attachment.kind}/`),
          )
          .map((attachment) => ({
            kind: attachment.kind,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            dataBase64: attachment.dataBase64,
            ...normalizeImageMetadata(attachment),
          }))
      : [],
  };
}

function normalizeImageMetadata(attachment: AIResponseAttachment) {
  const width = normalizePositiveInteger(attachment.width);
  const height = normalizePositiveInteger(attachment.height);
  const resolution = typeof attachment.resolution === "string" && attachment.resolution.trim()
    ? attachment.resolution.trim()
    : width && height
      ? `${width}x${height}`
      : "";
  return {
    ...(typeof attachment.model === "string" && attachment.model.trim() ? { model: attachment.model.trim() } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(resolution ? { resolution } : {}),
    ...(typeof attachment.aspectRatio === "string" && attachment.aspectRatio.trim() ? { aspectRatio: attachment.aspectRatio.trim() } : {}),
    ...(typeof attachment.imageSize === "string" && attachment.imageSize.trim() ? { imageSize: attachment.imageSize.trim() } : {}),
  };
}

function normalizePositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

async function readProviderError(response: Response, fallback: string) {
  const body = await response.text();
  return body ? `${fallback}: ${body}` : fallback;
}

function buildPromptText(request: AIRequest) {
  return [
    `Title: ${request.title}`,
    `Available notes:\n${formatAvailableNotes(request.availableNotes ?? [])}`,
    `Document Markdown:\n${request.bodyMarkdown}`,
    `Selection:\n${request.selection ?? ""}`,
    `Prompt:\n${request.prompt}`,
  ].join("\n\n");
}

function formatAvailableNotes(notes: NonNullable<AIRequest["availableNotes"]>) {
  if (notes.length === 0) return "No other notes are available.";
  return notes
    .map((note, index) => {
      const folder = note.folderName?.trim() ? `, folder: ${note.folderName.trim()}` : "";
      return `${index + 1}. id: ${note.id}, title: ${note.title}${folder}`;
    })
    .join("\n");
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

function buildGeminiImageRequestConfig(settings: ProviderSettings, request: AIRequest): GeminiImageRequestConfig {
  const model = effectiveGeminiImageModel(settings);
  const promptText = buildImagePromptText(request);
  const aspectRatio = parseRequestedImageAspectRatio(promptText) ?? defaultGeminiImageAspectRatio;
  const imageSize = supportsGeminiImageSize(model) ? parseRequestedImageSize(promptText) ?? defaultGeminiImageSize : undefined;
  const fallbackDimensions = estimateGeminiImageDimensions(model, aspectRatio, imageSize);
  return {
    model,
    aspectRatio,
    imageSize,
    fallbackWidth: fallbackDimensions.width,
    fallbackHeight: fallbackDimensions.height,
    fallbackResolution: `${fallbackDimensions.width}x${fallbackDimensions.height}`,
  };
}

function effectiveGeminiImageModel(settings: ProviderSettings) {
  return settings.imageModel.trim() || defaultGeminiImageModel;
}

function supportsGeminiImageSize(model: string) {
  return /\bgemini-3(?:[.-]|$)/i.test(model);
}

function parseRequestedImageAspectRatio(text: string) {
  const dimensionMatch = text.match(/\b(\d{3,5})\s*[x×]\s*(\d{3,5})\b/i);
  if (dimensionMatch) {
    const width = Number.parseInt(dimensionMatch[1] ?? "", 10);
    const height = Number.parseInt(dimensionMatch[2] ?? "", 10);
    const aspectRatio = inferSupportedAspectRatio(width, height);
    if (aspectRatio) return aspectRatio;
  }

  const ratioMatches = text.matchAll(/\b(\d{1,2})\s*[:/]\s*(\d{1,2})\b/g);
  for (const match of ratioMatches) {
    const aspectRatio = `${Number.parseInt(match[1] ?? "", 10)}:${Number.parseInt(match[2] ?? "", 10)}`;
    if (supportedGeminiImageAspectRatioSet.has(aspectRatio)) return aspectRatio;
  }

  const normalized = text.toLowerCase();
  if (/\b(square|square-format|square format)\b/.test(normalized)) return "1:1";
  if (/\b(portrait aspect|vertical aspect|phone wallpaper|mobile wallpaper|story format)\b/.test(normalized)) return "9:16";
  if (/\b(landscape aspect|horizontal aspect|widescreen|desktop wallpaper)\b/.test(normalized)) return "16:9";
  return null;
}

function parseRequestedImageSize(text: string) {
  const normalized = text.toLowerCase();
  if (/\b4\s*k\b/.test(normalized)) return "4K";
  if (/\b2\s*k\b/.test(normalized)) return "2K";

  const dimensionMatch = normalized.match(/\b(\d{3,5})\s*[x×]\s*(\d{3,5})\b/);
  if (!dimensionMatch) return null;
  const width = Number.parseInt(dimensionMatch[1] ?? "", 10);
  const height = Number.parseInt(dimensionMatch[2] ?? "", 10);
  const largestSide = Math.max(width, height);
  if (largestSide >= 3500) return "4K";
  if (largestSide >= 1600) return "2K";
  return "1K";
}

function inferSupportedAspectRatio(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const requested = width / height;
  const closest = supportedGeminiImageAspectRatios
    .map((aspectRatio) => {
      const [aspectWidth, aspectHeight] = aspectRatio.split(":").map((part) => Number.parseInt(part, 10));
      return {
        aspectRatio,
        distance: Math.abs(Math.log(requested / ((aspectWidth ?? 1) / (aspectHeight ?? 1)))),
      };
    })
    .sort((a, b) => a.distance - b.distance)[0];
  return closest && closest.distance < 0.08 ? closest.aspectRatio : null;
}

function estimateGeminiImageDimensions(model: string, aspectRatio: string, imageSize?: string) {
  const baseDimensions = model.toLowerCase().includes("gemini-2.5")
    ? gemini25ImageDimensions[aspectRatio]
    : geminiImageDimensions1k[aspectRatio];
  const dimensions = baseDimensions ?? geminiImageDimensions1k[defaultGeminiImageAspectRatio];
  const scale = imageSize === "4K" ? 4 : imageSize === "2K" ? 2 : 1;
  return {
    width: dimensions.width * scale,
    height: dimensions.height * scale,
  };
}

function withImageGenerationSummary(answer: string, attachments: AIResponseAttachment[], imageRequest: GeminiImageRequestConfig) {
  if (attachments.length === 0) return answer;
  const details = attachments.map((attachment, index) => {
    const label = attachments.length > 1 ? `Image ${index + 1}: ` : "";
    const resolution = attachment.resolution || imageRequest.fallbackResolution;
    const model = attachment.model || imageRequest.model;
    return `${label}Resolution: ${resolution}. Model: ${model}.`;
  });
  return `${answer.trim()}\n\n${details.join("\n")}`;
}

function buildTtsPromptText(text: string) {
  return [
    "Read the following selected note text aloud exactly as written.",
    "Do not summarize, translate, explain, or add commentary.",
    "Use any bracketed audio tags as delivery directions.",
    "",
    text,
  ].join("\n");
}

function buildGeminiUrl(settings: ProviderSettings, stream = false) {
  const base = settings.apiUrl.replace(/\/$/, "");
  const key = encodeURIComponent(settings.apiKey);
  return stream
    ? `${base}/v1beta/models/${settings.model}:streamGenerateContent?alt=sse&key=${key}`
    : `${base}/v1beta/models/${settings.model}:generateContent?key=${key}`;
}

function buildGeminiTtsUrl(settings: ProviderSettings) {
  const base = settings.apiUrl.replace(/\/$/, "");
  const key = encodeURIComponent(settings.apiKey);
  return `${base}/v1beta/models/${geminiTtsModel}:generateContent?key=${key}`;
}

function buildGeminiImageUrl(settings: ProviderSettings, imageModel = effectiveGeminiImageModel(settings)) {
  const base = settings.apiUrl.replace(/\/$/, "");
  const key = encodeURIComponent(settings.apiKey);
  const model = encodeURIComponent(imageModel);
  return `${base}/v1beta/models/${model}:generateContent?key=${key}`;
}

function parsePcmSampleRate(mimeType?: string) {
  const match = mimeType?.match(/rate=(\d+)/i);
  if (!match) return null;
  const rate = Number.parseInt(match[1], 10);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function readImageDimensionsFromBase64(base64: string, mimeType: string) {
  try {
    const bytes = base64ToUint8Array(base64);
    if (mimeType.includes("png")) return readPngDimensions(bytes);
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return readJpegDimensions(bytes);
    if (mimeType.includes("gif")) return readGifDimensions(bytes);
    if (mimeType.includes("webp")) return readWebpDimensions(bytes);
  } catch {}
  return null;
}

function readPngDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  return {
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20),
  };
}

function readJpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let index = 2;
  while (index + 9 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }
    const marker = bytes[index + 1];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    const segmentLength = readUint16BE(bytes, index + 2);
    if (segmentLength < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: readUint16BE(bytes, index + 5),
        width: readUint16BE(bytes, index + 7),
      };
    }
    index += 2 + segmentLength;
  }
  return null;
}

function readGifDimensions(bytes: Uint8Array) {
  if (bytes.length < 10 || byteString(bytes, 0, 3) !== "GIF") return null;
  return {
    width: readUint16LE(bytes, 6),
    height: readUint16LE(bytes, 8),
  };
}

function readWebpDimensions(bytes: Uint8Array) {
  if (bytes.length < 30 || byteString(bytes, 0, 4) !== "RIFF" || byteString(bytes, 8, 4) !== "WEBP") return null;
  const chunk = byteString(bytes, 12, 4);
  if (chunk === "VP8X") {
    return {
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      width: readUint16LE(bytes, 26) & 0x3fff,
      height: readUint16LE(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function readUint32BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
}

function readUint16BE(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function byteString(bytes: Uint8Array, offset: number, length: number) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function pcm16Base64ToWavBase64(pcmBase64: string, sampleRate: number) {
  const pcmBytes = base64ToUint8Array(pcmBase64);
  const channels = 1;
  const bytesPerSample = 2;
  const headerSize = 44;
  const wavBytes = new Uint8Array(headerSize + pcmBytes.byteLength);
  const view = new DataView(wavBytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcmBytes.byteLength, true);
  wavBytes.set(pcmBytes, headerSize);

  return uint8ArrayToBase64(wavBytes);
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function base64ToUint8Array(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
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
